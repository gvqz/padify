/**
 * The Markdown HTML policy — the allowlist that decides which raw HTML a
 * note's source may become (GitHub's own reading: sanitize, then render).
 *
 * THE MODEL. Raw HTML in a Markdown note is DATA the note's author wrote,
 * rendered for the reader the way GitHub renders a README: benign tags
 * survive (REBUILT, never echoed — only the tags and attributes on these
 * lists are ever emitted, every value escaped, every URL gated), and
 * everything else shows as the escaped text it is. The rebuilt tag is a
 * new string this file constructed; nothing from the source rides into
 * the output unexamined. The one-escape guarantee holds by construction:
 * a tag that fails here never reaches the output as markup at all.
 *
 * THE LISTS follow GitHub's sanitizer (github/markup's HTML pipeline
 * whitelist): classic formatting, structure, tables, and the semantic
 * extras READMEs actually use — details/summary, ruby/rt/rp, kbd, mark,
 * figure/figcaption, dl/dt/dd, abbr, dfn, var, samp, wbr. NOT included,
 * ever: script, style, iframe, object, embed, form/input/button, meta,
 * link, base, svg, math, template — the injection surface and the
 * "encoded using <" list the torture documents describe.
 *
 * Pure string functions only: no DOM, no state — the module runs in the
 * app, in jsdom tests, and in the share viewer's generated bundle alike.
 */
import { sanitizeHref } from '../storage-subset';
import { escapeHtmlAttr } from '../../lib/escape';
import { NAMED_ENTITIES } from './entities.generated';

/**
 * The Markdown URL gate — the one the anchors' hrefs already pass. A
 * scheme-less value is RELATIVE (no scheme, no danger: it can only ever
 * resolve against the app's own origin); a value with a scheme prefix
 * must carry http/https/mailto or the gate refuses it (javascript:,
 * data:, vbscript:, file:, … never render as URLs).
 */
export function safeHrefForMarkdown(dest: string): string | null {
  const colon = dest.indexOf(':');
  const slash = dest.indexOf('/');
  if (colon === -1 || (slash !== -1 && slash < colon)) {
    return dest; // scheme-less relative — no scheme, no danger
  }
  return sanitizeHref(dest);
}

/** The tags raw HTML may become (lowercase; matched case-insensitively). */
const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

/**
 * The attributes a rebuilt tag may carry, beyond the per-kind rules
 * below. `title` is the universal tooltip — harmless, escaped, GitHub
 * keeps it.
 */
const GLOBAL_ATTRS = new Set(['title']);

/** Attributes whose values must pass the safe-href gate. */
const URL_ATTRS = new Set(['href', 'src']);

/** Attributes whose values must be plain non-negative integers. */
const NUMERIC_ATTRS = new Set(['width', 'height', 'colspan', 'rowspan']);

/**
 * Boolean-valued attributes: present with any value (or bare), they
 * re-emit as the bare attribute name — the value never rides along.
 */
const BOOLEAN_ATTRS = new Set(['open']);

/** True when the (case-insensitive) tag name may be rebuilt. */
export function markdownTagAllowed(name: string): boolean {
  return ALLOWED_TAGS.has(name.toLowerCase());
}

/**
 * Rebuilds one raw tag — `<a href=…>`, `</div>`, `<img … />` — as the
 * policy's own markup. Returns null when the tag is not on the list (the
 * caller shows the bytes as escaped text) or the shape does not parse as
 * a tag at all (defensive: the callers only hand over shapes the inline
 * grammar already recognized).
 *
 * The rebuilt tag: lowercase name, allowlisted attributes only, values
 * double-quoted and escaped, URLs through sanitizeHref (entities decoded
 * first — `jav&#x09;ascript:` meets the gate as its decoded bytes),
 * numeric attributes reduced to canonical digits, booleans bare. A
 * repeated attribute name emits once (first wins — the rebuild is
 * deterministic; the browser's last-wins reading never sees a race).
 */
export function sanitizeHtmlTag(raw: string): string | null {
  const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*)$/.exec(raw);
  if (!match || !raw.endsWith('>')) {
    return null;
  }
  const closing = match[1] === '/';
  const name = match[2]!.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) {
    return null;
  }
  if (closing) {
    return `</${name}>`;
  }
  // The interior: everything between the name and the final bracket —
  // a trailing self-closing slash is decoration HTML ignores for
  // non-void elements, and the rebuild never re-emits it.
  const rest = match[3]!.slice(0, -1).replace(/\/\s*$/, '');

  const kept: string[] = [];
  const seen = new Set<string>();
  let at = 0;
  while (at < rest.length) {
    // Whitespace between attributes.
    while (at < rest.length && /\s/.test(rest[at]!)) {
      at += 1;
    }
    if (at >= rest.length) {
      break;
    }
    // The attribute's name.
    const nameStart = at;
    while (at < rest.length && /[^\s=/>]/.test(rest[at]!)) {
      at += 1;
    }
    const attrName = rest.slice(nameStart, at).toLowerCase();
    if (attrName === '') {
      // A stray character that is not an attribute (a bare `/` say) —
      // step past it; nothing it could carry survives the rebuild.
      at += 1;
      continue;
    }
    // The optional value: ="…" | ='…' | =bare | bare.
    let value: string | null = null;
    if (rest[at] === '=') {
      at += 1;
      const quote = rest[at];
      if (quote === '"' || quote === "'") {
        at += 1;
        const close = rest.indexOf(quote, at);
        if (close === -1) {
          return null; // unterminated value — not a tag worth keeping
        }
        value = rest.slice(at, close);
        at = close + 1;
      } else {
        const valueStart = at;
        while (at < rest.length && !/\s/.test(rest[at]!)) {
          at += 1;
        }
        value = rest.slice(valueStart, at);
      }
    }
    if (seen.has(attrName)) {
      continue;
    }
    if (
      GLOBAL_ATTRS.has(attrName) ||
      URL_ATTRS.has(attrName) ||
      NUMERIC_ATTRS.has(attrName) ||
      BOOLEAN_ATTRS.has(attrName)
    ) {
      seen.add(attrName);
      const emitted = emitAttr(attrName, value);
      if (emitted !== '') {
        kept.push(emitted);
      }
    }
  }

  const attrs = kept.length > 0 ? ` ${kept.join(' ')}` : '';
  // The policy's own hardening, mirroring the renderer's markdown-side
  // anchors and images: rebuilt anchors open walled-off (noopener,
  // referrer-stripped), rebuilt images fetch lazy/async without a
  // referrer. The source's tag never carries these — the rebuild ADDS
  // them, exactly like the `[text](url)` path does.
  if (name === 'a') {
    return `<a${attrs} rel="noopener noreferrer">`;
  }
  if (name === 'img') {
    return `<img${attrs} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  }
  return `<${name}${attrs}>`;
}

/**
 * The per-tag attribute rule for a REBUILT tag — the invariant walk's
 * mirror of the policy (the walk judges the OUTPUT; this answers what
 * the policy could have written on the tag).
 */
export function markdownHtmlAttrAllowed(tag: string, attr: string): boolean {
  if (attr === 'title') {
    return true;
  }
  if (tag === 'a') {
    return attr === 'href' || attr === 'rel';
  }
  if (tag === 'img') {
    return (
      attr === 'src' ||
      attr === 'alt' ||
      attr === 'width' ||
      attr === 'height' ||
      attr === 'loading' ||
      attr === 'decoding' ||
      attr === 'referrerpolicy'
    );
  }
  if (tag === 'ol') {
    return attr === 'start';
  }
  if (tag === 'td' || tag === 'th') {
    return attr === 'colspan' || attr === 'rowspan';
  }
  if (tag === 'details') {
    return attr === 'open';
  }
  return false;
}

/** One attribute's emission (empty string drops it silently). */
function emitAttr(attrName: string, value: string | null): string {
  if (value === null) {
    // Bare attribute: booleans emit their name, everything else drops
    // (an href-less anchor, an alt-less img — the tag stands).
    return BOOLEAN_ATTRS.has(attrName) ? attrName : '';
  }
  if (URL_ATTRS.has(attrName)) {
    const safe = safeHrefForMarkdown(decodeEntities(value));
    if (safe === null) {
      // The gate refused (javascript:, data:, …) — drop the attribute;
      // the tag survives without it, exactly like the anchor gate.
      return '';
    }
    return `${attrName}="${escapeHtmlAttr(safe)}"`;
  }
  if (NUMERIC_ATTRS.has(attrName)) {
    const digits = /^\d{1,6}$/.exec(value.trim());
    return digits ? `${attrName}="${digits[0]}"` : '';
  }
  return `${attrName}="${escapeHtmlAttr(decodeEntities(value))}"`;
}

/**
 * Decodes the numeric + named entities an attribute value may carry —
 * `href="jav&#x09;ascript:…"` must meet the gate as its decoded bytes.
 * A lone `&` stays a lone `&` (the browser's own reading).
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[a-zA-Z][a-zA-Z0-9]*;)/g,
    (all: string, body: string) => {
      if (body.startsWith('#')) {
        const hex = /^[xX]/.test(body);
        const digits = body.replace(/;$/, '').slice(hex ? 2 : 1);
        const code = parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) {
          return all;
        }
        try {
          return String.fromCodePoint(code);
        } catch {
          return all;
        }
      }
      return NAMED_ENTITIES[body.slice(0, -1)] ?? all;
    },
  );
}
