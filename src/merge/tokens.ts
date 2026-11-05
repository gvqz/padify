/**
 * Merge tokens — the atomic units a note's content diffs over.
 *
 * A word-level diff over raw HTML would split tags mid-string ("onion
 * slicing": the hunk boundaries land inside `<b>` and produce markup soup).
 * So an html note tokenizes into TWO kinds of atoms: whole tags (never
 * split, never matched against words) and word runs. A text note
 * (markdown source, plain text) has no tags and tokenizes into word runs
 * alone.
 *
 * Whitespace runs are their own tokens, so the diff can see indentation
 * and spacing changes instead of gluing them to neighbouring words.
 */

export interface Token {
  kind: 'text' | 'tag';
  value: string;
}

const text = (value: string): Token => ({ kind: 'text', value });
const tag = (value: string): Token => ({ kind: 'tag', value });

/** Splits a run of characters into word/whitespace tokens. */
function splitWords(chunk: string): Token[] {
  const out: Token[] = [];
  for (const piece of chunk.match(/\s+|\S+/g) ?? []) {
    out.push(text(piece));
  }
  return out;
}

/**
 * Tokenizes html-note content: every `<…>` run is ONE tag token, the text
 * between splits into word tokens. Angle brackets that never close (a
 * stray `<` in prose) stay text — the storage subset sanitizer has already
 * escaped what it cares about by the time content reaches storage.
 */
export function tokenizeHtml(source: string): Token[] {
  const out: Token[] = [];
  let cursor = 0;
  const length = source.length;
  while (cursor < length) {
    const open = source.indexOf('<', cursor);
    if (open === -1) {
      out.push(...splitWords(source.slice(cursor)));
      break;
    }
    if (open > cursor) {
      out.push(...splitWords(source.slice(cursor, open)));
    }
    const close = source.indexOf('>', open);
    if (close === -1) {
      // An unclosed `<` — treat the rest as text, matching how the browser
      // would render it (as literal characters).
      out.push(...splitWords(source.slice(open)));
      break;
    }
    out.push(tag(source.slice(open, close + 1)));
    cursor = close + 1;
  }
  return out;
}

/** Tokenizes plain-text content (markdown source, anything not html). */
export function tokenizeText(source: string): Token[] {
  return splitWords(source);
}

/** Glues tokens back into the note's stored string. */
export function detokenize(tokens: readonly Token[]): string {
  return tokens.map((token) => token.value).join('');
}

/** Token equality — kind and value must both match. */
export function tokenEquals(a: Token, b: Token): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/** Tokens that carry no visible words or markup — an empty document. */
export function tokensAreBlank(tokens: readonly Token[]): boolean {
  return tokens.every((token) => token.kind === 'text' && token.value.trim() === '');
}

// ---------------------------------------------------------------------------
// Well-formedness — the guard on merged html
// ---------------------------------------------------------------------------

/** Void elements never take a closing tag (the storage subset's own set). */
const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'source',
  'track',
  'wbr',
]);

const OPEN_TAG = /^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>$/;
const CLOSE_TAG = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/;
const SELF_CLOSING = /\/>$/;

/**
 * True when the tag tokens nest cleanly — every opener has its closer, in
 * order, with no stray closers. A merge that splices two well-formed
 * documents produces well-formed output when each side's hunks were
 * contiguous; this check catches the rest (a hunk boundary that split a
 * tag pair) and routes the note to review instead of storing soup.
 */
export function tagsBalance(tokens: readonly Token[]): boolean {
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind !== 'tag') {
      continue;
    }
    if (SELF_CLOSING.test(token.value)) {
      continue;
    }
    const close = CLOSE_TAG.exec(token.value);
    if (close) {
      const opener = stack.pop();
      if (opener !== close[1]!.toLowerCase()) {
        return false;
      }
      continue;
    }
    const open = OPEN_TAG.exec(token.value);
    if (open) {
      const name = open[1]!.toLowerCase();
      if (!VOID_TAGS.has(name)) {
        stack.push(name);
      }
      continue;
    }
    // A tag token that parses as neither — the sanitizer's business, not
    // ours; do not fail the merge over it.
  }
  return stack.length === 0;
}
