/**
 * CSP-safe placeholder links.
 *
 * The shell markup has always had "do nothing on its own" anchors —
 * <a href="javascript:void(0);"> placeholders whose real behavior lives in
 * delegated click handlers (topbar buttons, timer controls, the install
 * button, …). Under the content security policy a javascript: URL violates
 * script-src on every click, so the placeholders moved to href="#" and this
 * guard replaces the void(0) semantics document-wide: clicking (or
 * keyboard-activating) an <a href="#"> must not navigate, scroll to the top
 * or push a history entry — the handlers do the actual work.
 *
 * Registered at boot, before the shell markup is wired, so every anchor —
 * present or injected later — is covered by one listener instead of
 * thirteen per-feature preventDefault calls.
 */
export function installPlaceholderLinkGuard(): void {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href="#"]');
    if (anchor) event.preventDefault();
  });
}
