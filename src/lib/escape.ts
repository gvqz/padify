/**
 * HTML escaping — the one implementation.
 *
 * Escaping a string for HTML text and escaping one for a double-quoted
 * attribute are different jobs (the attribute form must bind `&` and `"`
 * first; the text form also guards quotes for belt-and-braces), and for
 * years this repo carried three byte-identical copies of the text form
 * (tabs.ts, the music player helpers, the unicode picker) plus a private
 * attribute variant in editor/math.ts. They now live here, beside each
 * other, so the next escape need imports instead of re-implementing.
 */

/** Escapes a plain-text string so it can be embedded as HTML text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes a string for safe use inside a double-quoted HTML attribute —
 * the insertHTML path (math shells build their own markup strings).
 */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
