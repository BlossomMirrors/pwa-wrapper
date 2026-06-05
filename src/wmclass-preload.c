/* Helper for wmclass-preload-asm.S */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <stdlib.h>

void  *orig_marshal   = NULL;
void  *orig_get_class = NULL;

__attribute__((constructor))
static void init(void) {
    /* Strip LD_PRELOAD early so Chromium's fork+exec subprocesses
     * (zygote, renderer, GPU) don't inherit the override. */
    unsetenv("LD_PRELOAD");
    orig_marshal   = dlsym(RTLD_NEXT, "wl_proxy_marshal_flags");
    orig_get_class = dlsym(RTLD_NEXT, "wl_proxy_get_class");
}

/* Called from the asm trampoline when opcode==3.
 * Returns the override string, or NULL to leave arg unchanged. */
const char *maybe_override(void *proxy)
{
    const char *appid = getenv("BLOSSOMOS_APPID");
    if (!appid || !appid[0] || !orig_get_class) return NULL;
    typedef const char *(*gcfn)(void *);
    const char *cls = ((gcfn)orig_get_class)(proxy);
    if (cls && strcmp(cls, "xdg_toplevel") == 0)
        return appid;
    return NULL;
}
