/**
 * The storage format subset — the single definition of what a note's
 * HTML may be.
 *
 * Every layer that interprets note content reads the format from here:
 * storage load (tabs.ts), the cloud round trip, the share viewer's
 * server-side twin — and the editor itself. The document-model engine
 * parses its live surface through these same rules, so the engine's
 * model can only ever occupy the subset: anything outside it is not
 * representable, which is what makes the engine's output canonical
 * without a cleanup pass.
 *
 * The rules are pure functions over markup — they work identically in
 * the browser, in jsdom (the unit suite) and in a detached document,
 * because they only ever use DOMParser, createElement and innerHTML.
 *
 * The corpus contract for this subset lives in storage-format.test.ts:
 * the canonical form of every construct the subset admits is pinned
 * there as a fixed point of sanitizeNoteHtml. Anything that serializes
 * a note — today the storage sanitizer, tomorrow the model engine's
 * serializer — must emit exactly those forms.
 */

/**
 * The tags a note may contain. Inline tags are the classic formatting
 * subset; the block + link tags are the rich text note vocabulary; sup/sub/
 * hr serve the scripts and rules; the checklist data attributes and the
 * table subset (table/thead/tbody/tr/td/th) complete the Docs-style
 * controls. Everything else is unwrapped to its text on load.
 */
const ALLOWED_TAGS = new Set([
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'S',
  'STRIKE',
  'DEL',
  'BR',
  'DIV',
  'SPAN',
  'P',
  'H1',
  'H2',
  'H3',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'SUP',
  'SUB',
  'HR',
  'A',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
]);

/**
 * Tags whose CONTENT is code or metadata, never displayable text — the
 * walk drops the element AND its children instead of unwrapping. The
 * paste path now feeds foreign markup through this sanitizer (styled
 * paste — see app.ts), and unwrapping <script>/<style> would paste the
 * program text itself into the note.
 */
const DROP_CONTENT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TITLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'XMP',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'INPUT',
]);

/**
 * Attributes a surviving tag may keep. Everything else is stripped — the
 * editor only ever produces these itself. `href` is gated to safe
 * schemes below; `style` is gated to the property allowlist beneath it;
 * the checklist data attributes are gated to their fixed vocabularies.
 */
const ALLOWED_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['A', new Set(['href'])],
  ['SPAN', new Set(['style'])],
  ['DIV', new Set(['style'])],
  ['P', new Set(['style'])],
  ['H1', new Set(['style'])],
  ['H2', new Set(['style'])],
  ['H3', new Set(['style'])],
  ['UL', new Set(['data-rich-checklist'])],
  ['LI', new Set(['style', 'data-checked'])],
  ['BLOCKQUOTE', new Set(['style'])],
  ['PRE', new Set(['style'])],
  ['TD', new Set(['style'])],
  ['TH', new Set(['style'])],
]);

/**
 * The math-shell class and the shape of its stored LaTeX source. A shell
 * survives as exactly `<span class="padify-math" data-latex="…"></span>`
 * — no style, no rendered children, nothing else (see editor/math.ts).
 */
const MATH_CLASS = 'padify-math';
const MATH_LATEX_PATTERN = /^[\s\S]{1,2000}$/;

/**
 * Data-attribute values that may survive, by attribute. The checklist mark
 * is a boolean flag and the item state a boolean pair — anything else is a
 * crafted payload, not editor output.
 */
const ALLOWED_DATA_ATTR_VALUES: ReadonlyMap<string, RegExp> = new Map([
  ['data-rich-checklist', /^true$/],
  ['data-checked', /^(true|false)$/],
]);

/**
 * CSS a stored note may keep, split by tag class. The editor only ever
 * produces these declarations itself (the Docs-style controls), but notes
 * also come back from storage and cloud sync — the allowlist is the wall
 * that keeps a crafted payload from carrying url()/expression() or layout
 * hijacks into the surface.
 */
const COLOR_VALUE_PATTERN =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*(0?\.\d+|1)\s*)?\)|[a-z]+)$/i;
const FONT_FAMILY_VALUE_PATTERN = /^[-a-z0-9\s,'’]{1,120}$/i;

const INLINE_STYLE_PROPS: ReadonlyMap<string, RegExp> = new Map([
  ['color', COLOR_VALUE_PATTERN],
  ['background-color', COLOR_VALUE_PATTERN],
  ['font-size', /^\d+(\.\d+)?(px|pt)$/],
  ['font-family', FONT_FAMILY_VALUE_PATTERN],
]);

const BLOCK_STYLE_PROPS: ReadonlyMap<string, RegExp> = new Map([
  ['text-align', /^(left|center|right|justify)$/i],
  ['margin-left', /^\d+(\.\d+)?px$/],
]);

function sanitizeStyle(raw: string, inline: boolean): string | null {
  const allowed = inline ? INLINE_STYLE_PROPS : BLOCK_STYLE_PROPS;
  const kept: string[] = [];
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const pattern = allowed.get(prop);
    if (pattern && pattern.test(value)) {
      kept.push(`${prop}: ${value}`);
    }
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * Link schemes a stored href may use. javascript:/data:/vbscript: and
 * friends are dropped (the anchor keeps its text, just without a target).
 */
const SAFE_HREF_PATTERN = /^(https?:|mailto:|#|\/)/i;

/**
 * Rendering-only variations of the storage policy. The DEFAULT is the
 * storage format itself (what the editor writes and reloads); read-only
 * renderers — today the public share viewer, whose sanitizer is GENERATED
 * from this file by scripts/build-share.mjs — pass options to adapt the
 * same policy for display.
 */
export interface SanitizeOptions {
  /**
   * Hardens surviving anchors for read-only rendering: target="_blank"
   * plus rel="noopener noreferrer nofollow". The stored format never
   * carries these (they are presentation, not content), so the option
   * exists for surfaces that render unknown-safe markup to third parties.
   */
  hardenLinks?: boolean;
  /**
   * Renders math shells as their LaTeX source text instead of keeping the
   * empty `<span class="padify-math" data-latex="…">` shell. A read-only
   * viewer without KaTeX would otherwise show nothing where an equation
   * belongs — the shell is a storage container, not a display form.
   */
  mathToText?: boolean;
}

/**
 * The one safe-href gate: drops javascript:/data:/vbscript: and friends
 * (the anchor keeps its text, just without a target). Exported since the
 * Markdown renderer appeared — its preview links pass the same bar the
 * stored subset does, and a second copy of the pattern would drift.
 */
export function sanitizeHref(raw: string): string | null {
  const href = raw.trim();
  return href.length > 0 && SAFE_HREF_PATTERN.test(href) ? href : null;
}

/**
 * Strips stored HTML down to the formatting subset the editor produces:
 * known inline/block tags survive (with their one allowed attribute where
 * declared), everything else is unwrapped to its text. Guards the innerHTML
 * round-trip against stray markup.
 *
 * With no options this is the storage-format canonicalizer (what a note's
 * HTML IS); with the SanitizeOptions flags it is also the read-only render
 * policy — one allowlist, two dialects, and the public share viewer's copy
 * is generated from this source (scripts/build-share.mjs) so the two can
 * never drift apart again.
 */
export function sanitizeNoteHtml(html: string, options: SanitizeOptions = {}): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

  const walk = (node: Node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      return [node];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }

    const element = node as HTMLElement;

    // Code/metadata elements vanish whole — their text is a program or a
    // stylesheet, never the note's words (see DROP_CONTENT_TAGS).
    if (DROP_CONTENT_TAGS.has(element.tagName)) {
      return [];
    }

    const children: Node[] = [];
    element.childNodes.forEach((child) => {
      children.push(...walk(child));
    });

    if (!ALLOWED_TAGS.has(element.tagName)) {
      return children;
    }

    const clone = document.createElement(element.tagName);

    // Math shells are their own vocabulary: fixed class + capped LaTeX
    // source, rendered children never store (the shell is the truth).
    if (element.tagName === 'SPAN' && element.classList.contains(MATH_CLASS)) {
      const latex = element.getAttribute('data-latex') ?? '';
      if (!MATH_LATEX_PATTERN.test(latex)) {
        return children;
      }
      if (options.mathToText) {
        // A reader without KaTeX gets the equation's source, not an
        // invisible empty span (what the shell renders as, unpainted).
        return [document.createTextNode(latex)];
      }
      clone.setAttribute('class', MATH_CLASS);
      clone.setAttribute('data-latex', latex);
      return [clone];
    }

    const allowedAttrs = ALLOWED_ATTRS.get(element.tagName);
    if (allowedAttrs) {
      allowedAttrs.forEach((attr) => {
        const value = element.getAttribute(attr);
        if (value === null) {
          return;
        }
        if (attr === 'href') {
          const safe = sanitizeHref(value);
          if (safe !== null) {
            clone.setAttribute(attr, safe);
            if (options.hardenLinks) {
              // Read-only rendering: the link opens in its own tab, walled
              // off from the viewer's origin and followed without leaking
              // the share URL as a referrer.
              clone.setAttribute('target', '_blank');
              clone.setAttribute('rel', 'noopener noreferrer nofollow');
            }
          }
          return;
        }
        if (attr === 'style') {
          const safe = sanitizeStyle(value, element.tagName === 'SPAN');
          if (safe !== null) {
            clone.setAttribute(attr, safe);
          }
          return;
        }
        const dataPattern = ALLOWED_DATA_ATTR_VALUES.get(attr);
        if (dataPattern) {
          if (dataPattern.test(value)) {
            clone.setAttribute(attr, value);
          }
          return;
        }
        clone.setAttribute(attr, value);
      });
    }

    children.forEach((child) => clone.appendChild(child));
    return [clone];
  };

  const container = parsed.body;
  const out: Node[] = [];
  container.childNodes.forEach((child) => out.push(...walk(child)));

  const fragment = document.createElement('div');
  out.forEach((node) => fragment.appendChild(node));
  return fragment.innerHTML;
}
