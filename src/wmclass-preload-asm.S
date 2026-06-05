/* x86-64 SysV ABI trampoline for wl_proxy_marshal_flags.
 * Intercepts opcode 3 (xdg_toplevel set_app_id) and optionally
 * replaces the app_id arg (r9) before forwarding to the real function.
 *
 * Signature: void *wl_proxy_marshal_flags(void *proxy, uint32_t opcode,
 *                const void *iface, uint32_t ver, uint32_t flags, ...app_id)
 * Registers on entry:
 *   rdi=proxy, esi=opcode, rdx=iface, ecx=ver, r8d=flags, r9=app_id
 */

    .section .text
    .globl  wl_proxy_marshal_flags
    .type   wl_proxy_marshal_flags, @function

wl_proxy_marshal_flags:
    /* Fast path: not the set_app_id opcode, jump straight through */
    cmpl    $3, %esi
    jne     .Ljump

    /* Preserve all argument registers + caller-saved scratch.
     * On entry RSP%16 == 8 (return address on stack).
     * 8 pushes → RSP%16 == 8 again; subtract 8 more → RSP%16 == 0
     * (required alignment before the call instruction). */
    pushq   %rdi
    pushq   %rsi
    pushq   %rdx
    pushq   %rcx
    pushq   %r8
    pushq   %r9
    pushq   %r10
    pushq   %r11
    subq    $8, %rsp

    /* rdi still holds proxy, pass it to maybe_override(proxy) */
    call    maybe_override@PLT

    addq    $8, %rsp
    popq    %r11
    popq    %r10
    popq    %r9
    popq    %r8
    popq    %rcx
    popq    %rdx
    popq    %rsi
    popq    %rdi

    /* If maybe_override returned non-NULL, replace app_id in r9 */
    testq   %rax, %rax
    jz      .Ljump
    movq    %rax, %r9

.Ljump:
    /* Tail-call the real wl_proxy_marshal_flags via GOT */
    movq    orig_marshal@GOTPCREL(%rip), %rax
    movq    (%rax), %rax
    jmpq    *%rax

    .size   wl_proxy_marshal_flags, .-wl_proxy_marshal_flags
