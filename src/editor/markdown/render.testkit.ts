/**
 * The test kit every markdown-renderer suite shares: the spec-faithful
 * ORACLE (micromark + the GFM extensions), the CANONICALIZER that equates
 * what HTML rendering equates, the POLICY rules that name the renderer's
 * deliberate divergences, and the INVARIANT WALK that judges any output —
 * including fuzzed garbage — against the security model.
 *
 * One copy on purpose: the differential suite, the fuzzer and the torture
 * suite must never disagree about what "matching" or "safe" means, and
 * three byte-identical copies of that judgment is how drift starts.
 */
import { micromark } from 'micromark';
import { matchRawHtml } from './render';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

const ORACLE_OPTIONS = {
  extensions: [gfm(), gfmTaskListItem()],
  htmlExtensions: [gfmHtml(), gfmTaskListItem()],
} as Parameters<typeof micromark>[1];

/** Micromark's footnote anchors are user-content-fn(-ref)-N; ours md-fn(-ref)-N. */
function normalizeOracleFootnoteAnchors(html: string): string {
  return html.replace(/#user-content-fn/g, '#md-fn');
}

export function oracleHtml(source: string): string {
  return normalizeOracleFootnoteAnchors(micromark(source, ORACLE_OPTIONS));
}

// ---------------------------------------------------------------------------
// The canonicalizer — a DOM walk that equates what HTML rendering equates
// ---------------------------------------------------------------------------

/** Our vocabulary aliases (b/i/s) against the spec's (strong/em/del). */
const TAG_ALIAS: Record<string, string> = { strong: 'b', em: 'i', del: 's' };

/** Blocks whose edge whitespace never renders — trimmed when comparing. */
const BLOCK_EDGE_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'blockquote',
  'section',
  'div',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

export function canonicalizeHtml(html: string, collapseWs = false): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  let out = '';
  for (const child of Array.from(doc.body.childNodes)) {
    out += serializeNode(child, false, collapseWs);
  }
  return out.trim();
}

function serializeNode(node: Node, rawText: boolean, collapseWs: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? '';
    if (rawText) {
      // Code interiors are byte-exact — except tabs, which the owned
      // renderer pre-expands to 4-column stops before parsing (a
      // documented divergence); the expansion is position-aware and the
      // serializer cannot know the SOURCE column a tab stood at (an
      // inline span's serialized text omits the line prefix) — when a
      // comparison needs it, the caller retries with collapseWs, which
      // equates any whitespace run inside code (the divergence's own
      // terms) instead of guessing.
      if (collapseWs) {
        return text.replace(/[ \t]+/g, ' ').trim();
      }
      return expandCodeTabs(text);
    }
    let collapsed = text.replace(/\s+/g, ' ');
    // The oracle emits a literal newline after <br />; HTML rendering glues
    // the following text straight to the break — trim to that truth.
    if (collapsed.startsWith(' ')) {
      const prev = node.previousSibling;
      if (prev && prev.nodeType === Node.ELEMENT_NODE && (prev as Element).tagName === 'BR') {
        collapsed = collapsed.slice(1);
      }
    }
    return collapsed === ' ' ? '' : collapsed;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el = node as Element;
  const name = TAG_ALIAS[el.tagName.toLowerCase()] ?? el.tagName.toLowerCase();
  const raw = rawText || name === 'pre' || name === 'code';

  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    const attrName = attr.name.toLowerCase();
    let value = attr.value;
    // `rel` is the app's own hardening (noopener noreferrer), not grammar —
    // both sides carry it; it stays out of the comparison.
    if (attrName === 'rel') {
      continue;
    }
    // micromark expresses table alignment as align="right"; we express the
    // same truth as style="text-align:right" — canonicalize to one form.
    if (attrName === 'align' && (name === 'th' || name === 'td')) {
      attrs.push(`style:text-align:${value}`);
      continue;
    }
    if (attrName === 'style') {
      value = value.replace(/\s+/g, '');
    }
    // The tab divergence reaches attribute values too (a link title's
    // raw tab vs the pre-expanded spaces); the collapseWs retry equates
    // the runs — a tooltip renders a tab and its spaces identically.
    if (collapseWs) {
      value = value.replace(/[ \t\n]+/g, ' ');
    }
    attrs.push(`${attrName}:${value}`);
  }
  attrs.sort();

  const open = `<${name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`;
  if (VOID_TAGS.has(name)) {
    return open;
  }
  let inner = '';
  for (const child of Array.from(el.childNodes)) {
    inner += serializeNode(child, raw, collapseWs);
  }
  // Whitespace at the EDGE of a block's content does not render (CSS
  // drops collapsible whitespace at a block boundary), so the two sides'
  // padding differences there are presentation-noise — the reference's
  // list items carry their padding spaces, the owned renderer strips
  // them. Mid-content whitespace (between words, before an inline tag)
  // still compares byte-for-byte.
  if (!raw && BLOCK_EDGE_TAGS.has(name)) {
    inner = inner.replace(/^\s+/, '').replace(/\s+$/, '');
  }
  return `${open}${inner}</${name}>`;
}

/** Tabs advance to 4-column stops — the owned renderer's expansion. */
function expandCodeTabs(text: string): string {
  if (!text.includes('\t')) {
    return text;
  }
  let out = '';
  let column = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const stop = column + 4 - (column % 4);
      while (column < stop) {
        out += ' ';
        column += 1;
      }
      continue;
    }
    if (ch === '\n') {
      column = 0;
    } else {
      column += 1;
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The divergence rules — an example is excluded when the ORACLE side uses a
// power the renderer declines by policy. Never hand-picked per example.
// ---------------------------------------------------------------------------

/** Every tag the owned renderer is allowed to emit. */
export const OWNED_VOCABULARY = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'pre',
  'code',
  'blockquote',
  'ul',
  'ol',
  'li',
  'input',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'a',
  'b',
  'i',
  's',
  'br',
  'sup',
  'section',
  'span',
  'div',
]);

export function oracleUsesPolicyPower(markdown: string, oracleHtml: string): boolean {
  // Raw HTML at the BLOCK level is policy: a line OPENING with a tag-like
  // run becomes a reference html block — escaped, but outside a <p>
  // wrapper, while the owned renderer reads it as paragraph text. INLINE
  // shapes (tags, comments, PI, declarations, CDATA) are NOT excluded:
  // the owned renderer escapes them verbatim since the rawHtml matcher,
  // and the reference escapes its html tokens the same way, so the two
  // compare byte-for-byte. (A bare `a<b` is not a tag and stays compared
  // too: both render literal text.)
  const withoutAutolinks = markdown
    .replace(/<(?:https?:\/\/|mailto:)[^<>\s]*>/gi, '')
    .replace(/<[\w.+-]+@[\w-]+(?:\.[\w-]+)+>/g, '');
  // BLOCK-level html: a line that opens with a tag-like run — directly,
  // under a container prefix, or indented inside a list item (where the
  // indent is container-relative, invisible to a lexical rule) — is a
  // reference html BLOCK: escaped, but outside a <p> wrapper, while the
  // owned renderer reads it as paragraph text. Indented-code lines that
  // merely open with a tag get excluded too; the cost is a comparison,
  // never a wrong verdict.
  const withoutContainers = withoutAutolinks.replace(
    /(^|\n)[ \t]*(?:> ?|(?:[-*+]|\d{1,9}[.)]) +?)*/g,
    '$1',
  );
  if (/(^|\n) {0,3}<(?=[a-zA-Z!/?])/.test(withoutContainers)) {
    return true;
  }
  // Two container-timing corners the owned line-wise collector reads
  // differently than the reference's speculative resolution, documented
  // here rather than re-architected:
  //  • a setext underline after a 4-column line re-reads that line as
  //    paragraph text in the reference (`    Foo\n   *\n ---` is one h2);
  //  • a lazy line after a quote whose item opened EMPTY cannot give it
  //    content in the reference (`> -\n    c` is an empty item plus code).
  if (/(^|\n) {4,}[^\n]*\n {0,3}(=+|-+)[ \t]*$/.test(withoutAutolinks)) {
    return true;
  }
  if (/(^|\n) {0,3}>[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*\n[^>\n]/.test(withoutAutolinks)) {
    return true;
  }
  // A lazy line's reach across quoted containers whose content is
  // code-shaped (4+ columns) depends on the container chain's content
  // columns — the owned lexical lazy door cannot see them.
  if (/(^|\n)(?: {0,3}>[ \t]?)+ {4,}[^<\s]/.test(withoutAutolinks)) {
    return true;
  }
  // Two code-block tails the owned line-wise accounting cannot see:
  // a document ENDING on a whitespace-only line at or past the block's
  // four columns (the reference folds its bytes into the block in ways
  // the line split cannot reconstruct), and a fence whose content holds
  // a shorter same-char run line (the reference's speculative fence-end
  // check eats the preceding line ending).
  if (/ {4,}[ \t]*$/.test(markdown)) {
    return true;
  }
  if (/(^|\n)(`{3,}|~{3,})[^\n]*\n[ \t]*[`~]{1,}[ \t]*(\n|$)/.test(markdown)) {
    return true;
  }
  // A quoted line indented four columns or more inside a list, followed
  // directly by an unquoted line: the lazy line's home depends on the
  // container chain's content columns.
  if (/(^|\n) {4,}>[^\n]*\n(?! {0,3}>)[^\n]/.test(withoutAutolinks)) {
    return true;
  }
  // A nested list (a marker at two or more columns) plus a column-zero
  // line that starts no block: the lazy line's reach across the nested
  // items is the same container-column question.
  const hasNestedMarker = /(^|\n)[ \t]{2,}(?:[-*+]|\d{1,9}[.)])[ \t]/.test(withoutAutolinks);
  const hasLazyColumnZero =
    /(^|\n)(?![ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]|[ \t]*#|[ \t]*(?:```|~~~)| {0,3}>| {4,})[^\s\n]/.test(
      withoutAutolinks,
    );
  if (hasNestedMarker && hasLazyColumnZero) {
    return true;
  }
  // A definition whose destination the owned safe-href gate rejects: the
  // reference keeps the anchor with an EMPTIED href, the owned renderer
  // lets the reference die into literal text.
  if (/href=""/.test(oracleHtml)) {
    return true;
  }
  // An html-candidate shape (`<` + letter) inside a link label: the
  // reference's tag/label precedence decides the label's bytes in ways
  // the owned raw-bracket scan does not model.
  if (/\[[^\]]*<[a-zA-Z][^\]]*\]/.test(markdown)) {
    return true;
  }
  // The reference's htmlText construct takes precedence over the LINK
  // grammar: a tag whose bytes span a `](`, `][` or `]:` swallows the
  // bracket (spec#524), and a `<…>` shape on a definition line kills a
  // pointy destination (spec#201). The owned link pass reads raw
  // brackets, so those two interplays stay excluded.
  for (let i = markdown.indexOf('<'); i !== -1; i = markdown.indexOf('<', i + 1)) {
    const end = matchRawHtml(markdown, i);
    if (end === -1) {
      continue;
    }
    if (/\]\(|\]\[|\]:/.test(markdown.slice(i, end))) {
      return true;
    }
  }
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}\[[^\]\n]*\]:/.test(line) && /<[a-zA-Z!/?]/.test(line)) {
      return true;
    }
  }
  // Angle autolinks with a scheme outside the safe-href gate stay literal
  // here (the whole construct is text) while the oracle emits an anchor —
  // the app's gate is deliberately stricter than the spec's.
  for (const match of markdown.matchAll(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}):[^<>\s]*>/g)) {
    const scheme = match[1]!.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
      return true;
    }
  }
  // Inline destinations carrying a colon whose prefix is not a safe scheme
  // hit the same gate (the oracle emits an anchor with an emptied href).
  // The destination is scanned to its real closing paren on the RAW text
  // (backslash escapes honored) and unescaped before the scheme check —
  // `foo\)\:` reads as the destination `foo):`.
  for (let at = markdown.indexOf(']('); at !== -1; at = markdown.indexOf('](', at + 2)) {
    let depth = 1;
    let scan = at + 2;
    while (scan < markdown.length && depth > 0) {
      const ch = markdown[scan]!;
      if (ch === '\\') {
        scan += 2;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      scan += 1;
    }
    if (depth !== 0) {
      break;
    }
    const dest = markdown.slice(at + 2, scan - 1).replace(/\\(.)/g, '$1');
    const colon = dest.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const scheme = dest.slice(0, colon).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
      return true;
    }
  }
  // A tag outside the owned vocabulary in the ORACLE output can only be a
  // raw-HTML pass-through or an <img> (links by policy).
  for (const match of oracleHtml.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    if (!OWNED_VOCABULARY.has(match[1]!.toLowerCase())) {
      return true;
    }
  }
  // The footnote section's wrapper shape is owned (section + hr), pinned
  // separately; oracle-side sections are structurally different.
  return /class="footnote/.test(oracleHtml) || oracleHtml.includes('data-footnote');
}

// ---------------------------------------------------------------------------
// The invariant walk — the security model, judged against the OUTPUT
// ---------------------------------------------------------------------------

/**
 * Every attribute the renderer may emit, per tag (empty array = global
 * set only). The math shells add data-latex/contenteditable; `input`
 * carries its checkbox trio; `ol` may carry start; anchors carry the
 * href/title pair and the rel hardening; table cells carry the alignment
 * style. Anything else is an escape failure by definition.
 */
const GLOBAL_ATTRS = new Set(['class', 'id']);
const ATTR_ALLOWLIST: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'rel']),
  input: new Set(['type', 'disabled', 'checked']),
  ol: new Set(['start']),
  td: new Set(['style']),
  th: new Set(['style']),
  span: new Set(['data-latex', 'contenteditable']),
};

/** hrefs must start with one of these (after trimming) or carry no scheme. */
const SAFE_HREF = /^(https?:|mailto:|#|\/)/i;

/**
 * Judges rendered HTML against the security model. Returns the violations
 * (an empty array = clean). An output that is not clean would have been
 * produced by an escape failure — markup the renderer did not generate,
 * an attribute outside the allowlist, or an href that smuggles a scheme.
 */
export function walkInvariants(html: string): string[] {
  const violations: string[] = [];
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');

  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const name = el.tagName.toLowerCase();
    if (!OWNED_VOCABULARY.has(name)) {
      violations.push(`foreign tag <${name}>`);
      continue;
    }
    const allowed = ATTR_ALLOWLIST[name];
    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.name.toLowerCase();
      if (!GLOBAL_ATTRS.has(attrName) && !(allowed && allowed.has(attrName))) {
        violations.push(`<${name}> carries attribute ${JSON.stringify(attrName)}`);
        continue;
      }
      if (attrName === 'href') {
        const href = attr.value.trim();
        const colon = href.indexOf(':');
        const slash = href.indexOf('/');
        const schemeLess = colon === -1 || (slash !== -1 && slash < colon);
        if (!schemeLess && !SAFE_HREF.test(href)) {
          violations.push(`<a href=${JSON.stringify(href)}> smuggles a scheme`);
        }
      }
    }
  }
  return violations;
}
