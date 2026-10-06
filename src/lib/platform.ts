/**
 * Platform detection — which modifier keys does THIS device use?
 *
 * The app used to hedge everywhere: "Ctrl/Cmd", "ctrl/command", a `<kbd>Ctrl</kbd>
 * / <kbd>⌘</kbd>` pair — both spellings shown to every user, which is noise on
 * 100% of devices since a keyboard only has one of the two. This module is the
 * single place that answers "which one", and every runtime surface — toasts,
 * tooltips, modal copy, the shortcuts reference — asks it instead of guessing.
 *
 * Static documentation (README, markdownreports) keeps the dual spelling on
 * purpose: prose cannot know the reader's keyboard; UI can.
 *
 * Apple detection reads navigator.platform AND the user agent (either may
 * carry "Mac"/"iPhone"/"iPad"/"iPod"): platform alone misses iPads reporting
 * "Macintosh" in desktop mode, and the UA alone misses browsers that trim it.
 * Testing both is the belt-and-braces standard.
 */

/** True when the strings look like an Apple platform (macOS, iOS, iPadOS). */
export function detectApplePlatform(platform: string, userAgent: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`);
}

/**
 * Test seam: force the answer while set, so vitest can pin BOTH branches of
 * every label on one machine and Playwright can flip a Linux runner into
 * Apple mode. `null` restores live detection.
 */
let platformOverride: boolean | null = null;

export function setPlatformOverrideForTests(value: boolean | null): void {
  platformOverride = value;
}

/** True on the Apple platforms, which use ⌘/⌥/⇧ symbols for modifiers. */
export function isApplePlatform(): boolean {
  if (platformOverride !== null) {
    return platformOverride;
  }
  if (typeof navigator === 'undefined') {
    return false;
  }
  // navigator.platform is deprecated but universally present; the UA catches
  // what it misses. navigator.platform's type is string, but jsdom and some
  // embedded webviews leave it undefined — coerce, never trust.
  const platform = typeof navigator.platform === 'string' ? navigator.platform : '';
  return detectApplePlatform(platform, navigator.userAgent);
}

/** The primary modifier: ⌘ on Apple, Ctrl everywhere else. */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

/** The secondary modifier: ⌥ on Apple, Alt everywhere else. */
export function altKeyLabel(): string {
  return isApplePlatform() ? '⌥' : 'Alt';
}

/** The shift modifier: ⇧ on Apple, Shift everywhere else. */
export function shiftKeyLabel(): string {
  return isApplePlatform() ? '⇧' : 'Shift';
}

/**
 * Renders a shortcut spec for THIS platform, e.g. 'mod+shift+o' becomes
 * "Ctrl + Shift + O" or "⌘ + Shift + O". Recognized tokens: mod, alt,
 * shift (and their ctrl/cmd/option aliases); anything else is a key name,
 * upper-cased when it is a single letter ('mod+,' stays "Ctrl + ,").
 * This is the one renderer for prose hints (toasts, titles) so the
 * punctuation style never drifts between call sites.
 */
export function shortcutLabel(spec: string): string {
  return spec
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => {
      switch (token.toLowerCase()) {
        case 'mod':
        case 'ctrl':
        case 'cmd':
        case 'command':
          return modKeyLabel();
        case 'alt':
        case 'option':
          return altKeyLabel();
        case 'shift':
          return shiftKeyLabel();
        default:
          return token.length === 1 ? token.toUpperCase() : token;
      }
    })
    .join(' + ');
}
