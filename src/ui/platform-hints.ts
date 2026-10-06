/**
 * Platform hint hydration — the bridge between static markup and the
 * platform module (see lib/platform.ts).
 *
 * HTML partials cannot ask a function which modifier key to draw, so they
 * declare intent with data attributes and this pass resolves it once at
 * boot, AFTER mountModals() has put every partial in the document:
 *
 *   <kbd data-mod-key>Ctrl</kbd>   →  textContent becomes ⌘ or Ctrl
 *   <kbd data-alt-key>Alt</kbd>   →  textContent becomes ⌥ or Alt
 *   <span title="Preferences" data-shortcut-title="mod+,">
 *                                  →  title becomes "Preferences [Ctrl + ,]"
 *                                     (or "Preferences [⌘ + ,]")
 *
 * The written-in text is always the non-Apple spelling: it is the correct
 * default for the majority, for crawlers and for the no-JS window. The
 * swap happens before any modal can be seen (modals open after boot), so
 * Apple users never observe the wrong glyph.
 *
 * `data-search` attributes deliberately keep BOTH spellings ("ctrl cmd s")
 * — that is search metadata for the shortcuts filter, not display copy,
 * and a Mac user may well type either word into the box.
 */
import { altKeyLabel, modKeyLabel, shortcutLabel } from '../lib/platform';

/** Resolves every data-mod-key / data-alt-key element in the document. */
export function hydrateModifierKeyElements(root: Document | HTMLElement = document): void {
  root.querySelectorAll<HTMLElement>('[data-mod-key]').forEach((el) => {
    el.textContent = modKeyLabel();
  });
  root.querySelectorAll<HTMLElement>('[data-alt-key]').forEach((el) => {
    el.textContent = altKeyLabel();
  });
}

/**
 * Rewrites titles that carry a `data-shortcut-title` spec, appending the
 * rendered shortcut in brackets to the human-readable base title.
 */
export function hydrateShortcutTitles(root: Document | HTMLElement = document): void {
  root.querySelectorAll<HTMLElement>('[data-shortcut-title]').forEach((el) => {
    const spec = el.getAttribute('data-shortcut-title');
    if (!spec) return;
    const base = el.getAttribute('title') ?? '';
    el.setAttribute('title', `${base} [${shortcutLabel(spec)}]`.trim());
  });
}

/** The boot pass: both hydrations, one call site (see boot.ts). */
export function hydratePlatformShortcuts(root: Document | HTMLElement = document): void {
  hydrateModifierKeyElements(root);
  hydrateShortcutTitles(root);
}
