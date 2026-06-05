/* Wayland socket proxy that intercepts xdg_toplevel.set_app_id messages
 * and replaces the app_id string "blossomos-webapps" with the real appid.
 *
 * Usage: wayland-appid-proxy <proxy-socket-name> <real-wayland-display> <new-appid>
 *
 * Creates a UNIX socket at $XDG_RUNTIME_DIR/<proxy-socket-name>, accepts
 * connections from Electron (and all its subprocesses), connects each to the
 * real compositor, and proxies all Wayland traffic bidirectionally.
 * Only the client→compositor direction is inspected; compositor→client is
 * forwarded as-is.  SCM_RIGHTS file-descriptor passing is preserved intact.
 *
 * Prints "ready\n" to stdout once the listening socket is bound so the
 * parent process can set WAYLAND_DISPLAY and launch Electron.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/epoll.h>
#include <signal.h>

#define MAX_EVENTS   64
/* Max Wayland message size is 65535 (16-bit size field); use 128 KiB to
 * handle the case where recvmsg returns multiple messages in one call. */
#define MSG_BUF      (128 * 1024)
#define MAX_FD       4096
/* Up to 28 SCM_RIGHTS fds per ancillary message */
#define CMSG_BUF_SZ  (CMSG_SPACE(28 * sizeof(int)))

static const char *old_appid_str;
static const char *new_appid_str;
static char        proxy_path[256];
static int         listen_fd = -1;
static int         epoll_fd  = -1;

typedef struct {
    int peer;       /* paired fd (-1 = slot unused) */
    int is_client;  /* 1 = accepted from Electron, 0 = connected to compositor */
} Slot;

static Slot slots[MAX_FD];

/* cleanup */

static void cleanup(void) {
    if (listen_fd >= 0) { close(listen_fd); listen_fd = -1; }
    unlink(proxy_path);
}

static void sig_handler(int s) { (void)s; cleanup(); _exit(0); }

/* appid patching */

/* Scan data[0..n) for a Wayland-encoded string matching old_appid_str.
 * Wayland string encoding: [uint32 len (incl NUL)][bytes padded to 4].
 * If found, rebuild the buffer with new_appid_str, update the enclosing
 * message's size field, and return a malloc'd replacement (caller frees).
 * Returns data unchanged (no malloc) if the pattern is not present. */
static uint8_t *patch(uint8_t *data, size_t *sz) {
    size_t n = *sz;

    int olen  = (int)strlen(old_appid_str) + 1;  /* includes NUL */
    int opad  = (olen + 3) & ~3;                  /* padded length */
    int oenc  = 4 + opad;                         /* total encoded size */

    /* Build search pattern */
    uint8_t pat[272];
    if ((size_t)oenc > sizeof(pat)) return data;
    uint32_t owlen = (uint32_t)olen;
    memcpy(pat, &owlen, 4);
    memset(pat + 4, 0, (size_t)opad);
    memcpy(pat + 4, old_appid_str, (size_t)olen);

    /* Find pattern */
    ssize_t off = -1;
    for (size_t i = 0; i + (size_t)oenc <= n; i++) {
        if (memcmp(data + i, pat, (size_t)oenc) == 0) { off = (ssize_t)i; break; }
    }
    if (off < 0) return data;

    int nlen  = (int)strlen(new_appid_str) + 1;
    int npad  = (nlen + 3) & ~3;
    int nenc  = 4 + npad;
    int delta = nenc - oenc;

    /* Find the Wayland message header that contains offset 'off', so we can
     * update its size field.  Wayland header: [obj_id:4][size<<16|op:4]. */
    size_t msg_start = 0;
    while (msg_start + 8 <= n) {
        uint32_t w;
        memcpy(&w, data + msg_start + 4, 4);
        uint16_t msz = (uint16_t)(w >> 16);
        if (msz < 8) break;
        if ((size_t)off >= msg_start && (size_t)off < msg_start + msz) break;
        msg_start += msz;
    }

    size_t new_n = n + (size_t)delta;
    uint8_t *nb = malloc(new_n);
    if (!nb) return data;

    /* prefix | new encoded string | suffix */
    memcpy(nb, data, (size_t)off);
    uint32_t nwlen = (uint32_t)nlen;
    memcpy(nb + off, &nwlen, 4);
    memset(nb + off + 4, 0, (size_t)npad);
    memcpy(nb + off + 4, new_appid_str, (size_t)nlen);
    size_t sfx = (size_t)off + (size_t)oenc;
    memcpy(nb + (size_t)off + (size_t)nenc, data + sfx, n - sfx);

    /* Update message size */
    if (msg_start + 8 <= new_n) {
        uint32_t w;
        memcpy(&w, nb + msg_start + 4, 4);
        uint16_t osz = (uint16_t)(w >> 16);
        uint16_t nsz = (uint16_t)((int)osz + delta);
        w = ((uint32_t)nsz << 16) | (w & 0xFFFF);
        memcpy(nb + msg_start + 4, &w, 4);
    }

    *sz = new_n;
    return nb;
}

/* connection lifecycle */

static void close_conn(int fd) {
    if (fd < 0 || fd >= MAX_FD || slots[fd].peer < 0) return;
    int peer = slots[fd].peer;
    slots[fd].peer = -1;
    epoll_ctl(epoll_fd, EPOLL_CTL_DEL, fd, NULL);
    close(fd);
    if (peer >= 0 && peer < MAX_FD && slots[peer].peer >= 0) {
        slots[peer].peer = -1;
        epoll_ctl(epoll_fd, EPOLL_CTL_DEL, peer, NULL);
        close(peer);
    }
}

/* message forwarding */

/* Buffers are static and safe because this is single-threaded. */
static uint8_t fwd_data[MSG_BUF];
static uint8_t fwd_cmsg[CMSG_BUF_SZ];

static void forward(int src, int dst, int is_client) {
    struct iovec iov = { .iov_base = fwd_data, .iov_len = sizeof(fwd_data) };
    struct msghdr mh = {
        .msg_iov        = &iov,
        .msg_iovlen     = 1,
        .msg_control    = fwd_cmsg,
        .msg_controllen = sizeof(fwd_cmsg),
    };

    ssize_t n = recvmsg(src, &mh, MSG_DONTWAIT);
    if (n < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK) return; close_conn(src); return; }
    if (n == 0) { close_conn(src); return; }

    uint8_t *send_data = fwd_data;
    size_t   send_n    = (size_t)n;
    uint8_t *patched   = NULL;

    if (is_client) {
        size_t sz = send_n;
        uint8_t *p = patch(fwd_data, &sz);
        if (p != fwd_data) { patched = p; send_data = p; send_n = sz; }
    }

    struct iovec siov = { .iov_base = send_data, .iov_len = send_n };
    struct msghdr smh = {
        .msg_iov        = &siov,
        .msg_iovlen     = 1,
        .msg_control    = mh.msg_controllen > 0 ? fwd_cmsg : NULL,
        .msg_controllen = mh.msg_controllen,
    };
    sendmsg(dst, &smh, MSG_NOSIGNAL);
    free(patched);
}

/* accept new client */

static void accept_client(const char *real_path) {
    int cfd = accept4(listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (cfd < 0) return;

    int sfd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (sfd < 0) { close(cfd); return; }

    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    strncpy(sa.sun_path, real_path, sizeof(sa.sun_path) - 1);

    if (connect(sfd, (struct sockaddr *)&sa, sizeof(sa)) < 0) {
        close(cfd); close(sfd); return;
    }

    if (cfd >= MAX_FD || sfd >= MAX_FD) { close(cfd); close(sfd); return; }

    slots[cfd].peer = sfd; slots[cfd].is_client = 1;
    slots[sfd].peer = cfd; slots[sfd].is_client = 0;

    struct epoll_event ev = { .events = EPOLLIN | EPOLLERR | EPOLLHUP };
    ev.data.fd = cfd; epoll_ctl(epoll_fd, EPOLL_CTL_ADD, cfd, &ev);
    ev.data.fd = sfd; epoll_ctl(epoll_fd, EPOLL_CTL_ADD, sfd, &ev);
}

/* main */

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: %s <proxy-socket-name> <real-wayland-display> <new-appid>\n", argv[0]);
        return 1;
    }

    const char *proxy_name   = argv[1];
    const char *real_display = argv[2];
    new_appid_str = argv[3];
    old_appid_str = "blossomos-webapps";

    const char *run = getenv("XDG_RUNTIME_DIR");
    if (!run) run = "/tmp";

    snprintf(proxy_path, sizeof(proxy_path), "%s/%s", run, proxy_name);

    char real_path[256];
    if (real_display[0] == '/')
        snprintf(real_path, sizeof(real_path), "%s", real_display);
    else
        snprintf(real_path, sizeof(real_path), "%s/%s", run, real_display);

    /* Create listening socket */
    listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listen_fd < 0) { perror("socket"); return 1; }

    unlink(proxy_path);
    struct sockaddr_un sa = { .sun_family = AF_UNIX };
    strncpy(sa.sun_path, proxy_path, sizeof(sa.sun_path) - 1);
    if (bind(listen_fd, (struct sockaddr *)&sa, sizeof(sa)) < 0) { perror("bind"); return 1; }
    if (listen(listen_fd, 32) < 0) { perror("listen"); return 1; }

    /* Tell parent we're ready */
    printf("ready\n"); fflush(stdout);

    signal(SIGTERM, sig_handler);
    signal(SIGINT,  sig_handler);
    signal(SIGPIPE, SIG_IGN);

    for (int i = 0; i < MAX_FD; i++) slots[i].peer = -1;

    epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (epoll_fd < 0) { perror("epoll_create1"); return 1; }

    struct epoll_event ev = { .events = EPOLLIN, .data.fd = listen_fd };
    epoll_ctl(epoll_fd, EPOLL_CTL_ADD, listen_fd, &ev);

    struct epoll_event events[MAX_EVENTS];
    for (;;) {
        int n = epoll_wait(epoll_fd, events, MAX_EVENTS, -1);
        if (n < 0) { if (errno == EINTR) continue; break; }
        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;
            if (fd == listen_fd) { accept_client(real_path); continue; }
            if (events[i].events & (EPOLLERR | EPOLLHUP)) { close_conn(fd); continue; }
            if (events[i].events & EPOLLIN) {
                if (fd < 0 || fd >= MAX_FD || slots[fd].peer < 0) continue;
                forward(fd, slots[fd].peer, slots[fd].is_client);
            }
        }
    }

    cleanup();
    return 0;
}
