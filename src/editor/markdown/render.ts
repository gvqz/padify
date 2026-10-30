/**
 * The Markdown renderer — the preview pipeline for Markdown notes.
 *
 * Markdown notes store their SOURCE (the 'text' content kind — see
 * editor/note-types.ts); this module turns that source into the HTML the
 * preview pane and the HTML-source view show. It replaces the retired
 * Markdown Editor page's `marked` dependency with a renderer the app owns,
 * for the same reason the HTML sanitizer is hand-written: the output is
 * only ever as trustworthy as the discipline of the code that produces it,
 * and a renderer that NEVER emits a tag it did not itself generate cannot
 * smuggle markup in through a note.
 *
 * SECURITY MODEL. Raw HTML in the source is SANITIZED, not trusted — a
 * strict allowlist rewrites every tag (the markdown HTML policy below):
 * benign tags survive with a per-tag attribute allowlist, everything
 * else stays the escaped text it was. The note is data, never markup;
 * every literal character passes through escapeHtml at emission; the
 * only tags in the output are the ones this file (or the policy's
 * allowlist) wrote; the only URLs are hrefs/srcs that passed the storage
 * subset's SAFE_HREF gate (javascript:/data: URLs render as their
 * literal text). Images load for real — GitHub parity — through the same
 * gate, lazily, with the referrer stripped: `![alt](url)` is an <img>
 * whose src is http(s)/relative, and an unsafe URL keeps the whole
 * construct as literal text. The renderer is pure (string in, string
 * out) and DOM-free, so it runs identically in the app, in jsdom tests
 * and in any future server-side consumer.
 *
 * THE GRAMMAR (CommonMark 0.31.2 + the GFM extensions, verified example by
 * example against the spec-faithful oracle in render.differential.test.ts —
 * the documented divergences above are the only policy exceptions):
 *   blocks   ATX + setext headings · thematic breaks · fenced code blocks
 *            (``` and ~~, the info string's first word kept as a language
 *            class, the body de-indented by the opening fence) · indented
 *            code blocks (the 4-space form, tabs pre-expanded) ·
 *            blockquotes (nested, lazy paragraphs) · ordered/unordered
 *            lists (nesting by indentation, tight vs loose, `start`
 *            numbers, the paragraph-interrupt rules, the reference
 *            implementation's marker-padding rules) · task list items ·
 *            GFM tables (alignment, ragged rows padded) · GFM footnotes
 *            (definitions collected at their own lines, references
 *            numbered in first-use order, backrefs, the section appended
 *            after the body) · link reference definitions (all three
 *            `[text]` forms, document-scoped, first wins) · paragraphs
 *   inline   code spans (they take precedence over everything, links
 *            included) · **bold** · *italic* — the full CommonMark
 *            emphasis algorithm: Unicode flanking, the rule of 3, proper
 *            delimiter stacking · ~~strike~~ (one or two tildes, github's
 *            reading) · [links](url) with titles and the safe-href gate ·
 *            reference links (full/collapsed/shortcut) · images as links ·
 *            autolinks — `<scheme:…>` and `<mail@…>` angles plus the GFM
 *            literal forms (https://, http://, www., addresses) with the
 *            trailing-punctuation / paren-balance / entity rules · HTML
 *            entities (`&copy;`, `&#169;`, `&#xA9;` — the WHATWG table,
 *            semicolon-terminated per CommonMark) · backslash escapes ·
 *            hard breaks (two trailing spaces or a trailing backslash) ·
 *            math
 *   math     `$…$` and `\(…\)` render inline, `$$…$$` on its own lines
 *            renders as a block — all three become the same `padify-math`
 *            shells the rich editor stores, so the preview reuses
 *            editor/math.ts's renderMathIn (KaTeX, forbidden-macro gate and
 *            all). `$` that does not delimit math (currency) stays a
 *            dollar: the inner edges of `$…$` must touch non-space
 *            characters.
 *   literal  raw HTML (escaped — the security model above) · `&copy`
 *            without the semicolon · tab bytes inside code blocks (tabs
 *            are pre-expanded to 4-column stops before parsing, so a tab
 *            that survives into code renders as the spaces it stood for)
 */

import { escapeHtml, escapeHtmlAttr } from '../../lib/escape';
import { buildMathShell } from '../math-shell';
import { sanitizeHref } from '../storage-subset';
import { NAMED_ENTITIES } from './entities.generated';
import { GEMOJI } from './emoji.generated';
import { markdownTagAllowed, safeHrefForMarkdown, sanitizeHtmlTag } from './html-policy';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Renders Markdown source to the preview HTML. Pure: no DOM, no state, no
 * side effects — the caller hands the result to the preview pane's
 * innerHTML (then renderMathIn, for the math shells this emits).
 *
 * Three passes: the footnote pre-scan (which labels are alive), a
 * structure-only walk that harvests link reference definitions from every
 * block context (they resolve document-wide, wherever they stand), then
 * the render walk itself.
 */
export function renderMarkdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline terminates the last line — it does not open an
  // empty one (the split artifact would end every code block with a
  // phantom blank line).
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  // NUL never survives: the reference preprocessing replaces every null
  // byte with U+FFFD before any parsing (code blocks included).
  // split/join: the NUL byte as a string literal keeps the regex linter
  // (and its control-character worries) out of it.
  const expanded = lines.map((line) => expandTabs(line).split('\u0000').join('\uFFFD'));
  footnotes = scanFootnotes(expanded);
  linkRefs = new Map();
  try {
    renderBlocks(expanded, 0, true);
    const out = renderBlocks(expanded, 0, false);
    const section = footnoteSection();
    if (section) {
      out.push(section);
    }
    return out.join('\n');
  } finally {
    footnotes = null;
    linkRefs = null;
  }
}

/**
 * Tabs advance to the next multiple-of-4 column (CommonMark's tab stop).
 * Every tab becomes the spaces it stood for before any block parsing —
 * whitespace scanning then stays plain character counting everywhere.
 * Two exceptions keep the original bytes: a trailing whitespace run that
 * holds a tab (a trailing tab can neither make a hard break nor survive
 * expansion inside code), and — accepted divergence — mid-line tabs inside
 * code blocks, whose content reads in its expanded form.
 */
function expandTabs(line: string): string {
  if (!line.includes('\t')) {
    return line;
  }
  // A line whose trailing whitespace run holds a tab keeps that run in
  // its original bytes: a trailing tab cannot satisfy the hard-break rule
  // (only spaces can — the expanded form would fabricate one), and code
  // interiors preserve tabs byte-exactly, where the expanded form lied.
  const trail = /[ \t]+$/.exec(line);
  if (trail && trail[0].includes('\t') && /\S/.test(line)) {
    return `${expandTabs(line.slice(0, line.length - trail[0].length))}${trail[0]}`;
  }
  let out = '';
  let column = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const stop = column + 4 - (column % 4);
      while (column < stop) {
        out += ' ';
        column += 1;
      }
      continue;
    }
    out += ch;
    column += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Footnotes — GFM-style, document-scoped
// ---------------------------------------------------------------------------

/** A footnote definition line — up to 3 spaces of indent, label, colon. */
const FOOTNOTE_DEF = /^[ \t]{0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

/**
 * The footnote state for the render in flight. Set by renderMarkdownToHtml,
 * cleared on exit — the renderer is synchronous and single-threaded, so a
 * module-scoped scratch is as safe as a threaded parameter and keeps the
 * block collectors' signatures untouched.
 *
 *   labels    active labels — referenced AND defined (the scan's verdict)
 *   numbers   label → footnote number, assigned in first-use order as the
 *             refs render (GFM numbers by first reference, not by label)
 *   refCounts label → how many times it was referenced (unique anchor ids)
 *   texts     label → raw definition lines, collected by the block walk
 *             (continuation lines folded in; the section renders them
 *             through renderBlocks, so a footnote can hold lists of its
 *             own — the same block grammar as the body)
 */
type FootnoteState = {
  labels: Set<string>;
  numbers: Map<string, number>;
  refCounts: Map<string, number>;
  texts: Map<string, string[]>;
};

let footnotes: FootnoteState | null = null;

/**
 * Pre-scan: which labels have BOTH a reference and a definition anywhere in
 * the document (fence-interior lines are skipped — a `[^1]` inside a code
 * block is a literal, not a ref). Only active labels move: inactive refs
 * keep today's literal-text behavior, inactive definitions stay ordinary
 * paragraphs (the GFM verdict on both).
 */
function scanFootnotes(lines: string[]): FootnoteState {
  const refs = new Set<string>();
  const defs = new Set<string>();
  let insideFence = false;
  for (const line of lines) {
    if (FENCE_OPEN.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }
    const def = FOOTNOTE_DEF.exec(line);
    if (def) {
      defs.add(def[1]!);
      continue;
    }
    for (const match of line.matchAll(/\[\^([^\]\s]+)\]/g)) {
      refs.add(match[1]!);
    }
  }
  const active = new Set<string>();
  for (const label of refs) {
    if (defs.has(label)) {
      active.add(label);
    }
  }
  return { labels: active, numbers: new Map(), refCounts: new Map(), texts: new Map() };
}

/** The definitions section — `<hr>` + ordered list, GFM's shape. */
function footnoteSection(): string | null {
  const state = footnotes;
  if (!state || state.numbers.size === 0) {
    return null;
  }
  const ordered = [...state.numbers.entries()].sort((a, b) => a[1] - b[1]);
  const items = ordered
    .map(([label, number]) => {
      const blocks = renderBlocks(state.texts.get(label) ?? [], 0, false).join('\n');
      const backref = `<a href="#md-fnref-${number}" class="md-footnote-backref">\u21a9</a>`;
      return `<li id="md-fn-${number}" class="md-footnote-item">${blocks}${backref}</li>`;
    })
    .join('');
  return `<section class="md-footnotes"><hr><ol class="md-footnotes-list">${items}</ol></section>`;
}

/**
 * Consumes one footnote definition at `start` (an ACTIVE label — the
 * pre-scan's verdict) plus its continuation lines: indented ≥ 4 columns
 * (one indent's worth stripped) or a lazy plain-text run, the same shapes
 * a blockquote's lazy continuation accepts. Null when the line is not an
 * active definition — the caller then treats it as ordinary content.
 *
 * First definition of a label wins; later ones are consumed silently
 * (GFM ignores duplicates) — consuming, not skipping, is what keeps a
 * repeated `[^x]:` line from rendering as a stray literal paragraph.
 */
function collectFootnoteDefinition(lines: string[], start: number): { next: number } | null {
  const state = footnotes;
  if (!state) {
    return null;
  }
  const def = FOOTNOTE_DEF.exec(lines[start]!);
  if (!def || !state.labels.has(def[1]!)) {
    return null;
  }
  const label = def[1]!;
  const text: string[] = [def[2] ?? ''];
  let index = start + 1;

  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      // A blank continues the definition only when indented content
      // follows it; otherwise the definition ends here.
      const look = lines[index + 1];
      if (look !== undefined && !isBlank(look) && indentWidth(look) >= 4) {
        text.push('');
        index += 1;
        continue;
      }
      break;
    }
    if (indentWidth(line) >= 4) {
      text.push(stripIndent(line, 4));
      index += 1;
      continue;
    }
    // Lazy continuation: plain text that starts no new block extends the
    // definition — the same predicate the blockquote honors.
    if (!startsLazyBlock(line) && !FOOTNOTE_DEF.test(line) && !line.trimStart().startsWith('$$')) {
      text.push(line.trim());
      index += 1;
      continue;
    }
    break;
  }

  if (!state.texts.has(label)) {
    state.texts.set(label, text);
  }
  return { next: index };
}

// ---------------------------------------------------------------------------
// Link reference definitions — document-scoped, harvested in pass one
// ---------------------------------------------------------------------------

type LinkRef = { href: string | null; title: string | null };

/** The definitions the collect pass found. Cleared by the entry point. */
let linkRefs: Map<string, LinkRef> | null = null;

/**
 * A label's canonical key: case-folded (.toUpperCase — the Unicode fold
 * that makes `ẞ` and `SS` match), whitespace (spaces, tabs, the newlines
 * a multi-line label carries) collapsed to single spaces, then trimmed —
 * CommonMark's label-matching rule.
 */
function normalizeRefLabel(label: string): string {
  // The sharp s folds to "ss" in both its cases — the one place JavaScript's
  // case mapping misses what Unicode case-folding (and the reference) does.
  return label
    .replace(/[ßẞ]/g, 'ss')
    .replace(/[ \t\n]+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Peels leading link reference definitions off a paragraph (both walks),
 * recording each into the document-wide map — first definition wins.
 * Returns the index of the first line that is paragraph content. A
 * `[label]:` that runs out of paragraph only becomes an empty-destination
 * definition when the paragraph runs to the document's end — a blank line
 * after it kills the definition (the reference implementation's verdict).
 */
function peelDefinitions(paragraph: string[]): number {
  let start = 0;
  while (start < paragraph.length) {
    const def = parseLinkRefDef(paragraph, start);
    if (!def) {
      break;
    }
    const label = normalizeRefLabel(def.label);
    if (label === '') {
      break; // an empty label is never a definition
    }
    if (!linkRefs!.has(label)) {
      // The destination is gated and entity-decoded ONCE, at collection —
      // scheme-less relative destinations pass (no scheme, no danger), an
      // unsafe one leaves the ref dead (href null) and its references
      // render as literal text, the same verdict an inline link gets.
      const href = def.dest === '' ? '' : safeHrefForMarkdown(decodeEntities(def.dest));
      linkRefs!.set(label, { href, title: def.title });
    }
    start = def.next;
  }
  return start;
}

/**
 * A paragraph's inline text: continuation lines lose their leading
 * whitespace, the whole run loses its trailing spaces (only mid-paragraph
 * spaces can be hard breaks).
 */
function renderInlineParagraph(lines: string[]): string {
  // The FIRST line's leading whitespace is the block's own indent (gone
  // before the inline pass); the CONTINUATION lines keep their raw bytes —
  // code spans read them — and the render-time skip drops their leading
  // spaces from the text path only.
  const text =
    `${lines[0]!.replace(/^ +/, '')}${lines.length > 1 ? `\n${lines.slice(1).join('\n')}` : ''}`.replace(
      /[ \t]+$/,
      '',
    );
  return renderInline(text);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Blank line (only spaces — tabs became spaces at entry). */
function isBlank(line: string): boolean {
  return /^ *$/.test(line);
}

/** Leading whitespace width — tabs are already spaces, so this is a count. */
function indentWidth(line: string): number {
  let width = 0;
  while (line[width] === ' ') {
    width += 1;
  }
  return width;
}

/** Removes up to `columns` leading spaces (they are all spaces now). */
function stripIndent(line: string, columns: number): string {
  let cut = 0;
  while (cut < columns && line[cut] === ' ') {
    cut += 1;
  }
  return line.slice(cut);
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_SOLID = /^ {0,3}(=+|-+)[ \t]*$/;
// Anchored so `    ***` (a four-column line) cannot backtrack its way into
// a break, and same-character (the spec: three OR MORE MATCHING marks —
// `- * * *` is a list item, not a break). The trailing run is tab-tolerant
// because the entry expansion deliberately preserves it (see expandTabs).
const THEMATIC_BREAK = /^ {0,3}([-*_]) *(?:\1 *){2,}[ \t]*$/;
const BLOCKQUOTE_MARKER = /^ {0,3}>[ \t]?/;
// A marker must be followed by whitespace or end-of-line — that is what
// keeps `*emphasis*` and `-5 degrees` from parsing as list items.
const LIST_BULLET = /^([-*+])([ \t]+|$)/;
const LIST_ORDERED = /^(\d{1,9})([.)])([ \t]+|$)/;
const TASK_MARKER = /^\[([ xX])\](?:[ \t]+|$)/;

/**
 * Parses the given lines as a sequence of blocks. Recursion is how
 * blockquotes and list items nest: both strip their markers and hand the
 * remaining lines straight back to this function.
 *
 * `collect` runs the SAME walk with the output suppressed: it exists to
 * harvest link reference definitions, which may stand in ANY block context
 * (a blockquote, a list item) yet resolve document-wide — one deterministic
 * walk finds them all, the render walk then sees the completed map.
 *
 * `depth` guards the recursion: deeply indented outlines (Workflowy or
 * Obsidian exports, machine-generated TOCs) used to hit superlinear cost
 * — depth × remaining-lines × per-level slicing ≈ O(N³), measured at
 * 7 s of main-thread block for a 900-deep document. Past the cap the
 * nested markers degrade to plain paragraph text (content preserved,
 * structure flattened) instead of freezing the page.
 */
const MAX_NESTING_DEPTH = 50;

function renderBlocks(
  lines: string[],
  depth: number,
  collect: boolean,
  firstLineInterruptCheck = false,
): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  // The line right after an indented code block meets the list-start
  // interrupt check even without an open paragraph — the reference's
  // flow-close semantics (`    Foo\n-` is a paragraph, not an empty item).
  let afterIndentedCode = false;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    // Link reference definitions peel off the FRONT of a paragraph only —
    // once ordinary text leads, later definition-shaped lines are text
    // (the CommonMark reading the spec's own examples pin).
    const start = peelDefinitions(paragraph);
    if (!collect && start < paragraph.length) {
      out.push(`<p>${renderInlineParagraph(paragraph.slice(start))}</p>`);
    }
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const afterCode = afterIndentedCode;
    afterIndentedCode = false;

    if (isBlank(line)) {
      flushParagraph();
      index += 1;
      continue;
    }

    // Display math ($$…$$ on its own lines) is a BLOCK — a <div> can
    // never sit inside a <p>. Only probed while the paragraph is fresh;
    // math mid-paragraph renders through the inline $…$ pass.
    if (paragraph.length === 0) {
      const display = collectDisplayMath(lines, index);
      if (display) {
        if (!collect) {
          out.push(display.markup);
        }
        index = display.next;
        continue;
      }
    }

    // Fenced code blocks — they can interrupt a paragraph (CommonMark).
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      // A backtick fence's info string cannot carry a backtick; with one
      // the line is not a fence at all (it falls through to text).
      flushParagraph();
      const { markup, next } = collectFence(
        lines,
        index,
        fence[1]!.length,
        fence[2]![0]!,
        fence[2]!.length,
        fence[3]!,
      );
      if (!collect) {
        out.push(markup);
      }
      index = next;
      continue;
    }

    // ATX headings — also paragraph-interrupting.
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      flushParagraph();
      if (!collect) {
        // The trailing `#` run of a closing ATX heading is decoration —
        // space-separated, or the whole content when it is only hashes.
        const raw = atx[2] ?? '';
        const text = /^#+$/.test(raw.trim()) ? '' : raw.replace(/ +#* *$/, '').trim();
        out.push(`<h${atx[1]!.length}>${renderInline(text)}</h${atx[1]!.length}>`);
      }
      index += 1;
      continue;
    }

    // Setext underlines only mean something under a paragraph; with no
    // paragraph open, `---` is a thematic break (probed further below).
    // Definitions peel first — `[foo]: /url` above `===` is a definition
    // plus an h1 of what remains, and a fully-peeled paragraph means the
    // underline is paragraph text after all.
    if (paragraph.length > 0 && SETEXT_SOLID.test(line)) {
      const start = peelDefinitions(paragraph);
      if (start < paragraph.length) {
        if (!collect) {
          const level = line.trimStart().startsWith('=') ? 1 : 2;
          out.push(`<h${level}>${renderInlineParagraph(paragraph.slice(start))}</h${level}>`);
        }
        paragraph = [];
        index += 1;
        continue;
      }
    }

    // Indented code — four or more columns with no paragraph open (it
    // cannot interrupt one; a 4-column line under text stays text).
    if (paragraph.length === 0 && indentWidth(line) >= 4) {
      const { markup, next } = collectIndentedCode(lines, index);
      if (!collect) {
        out.push(markup);
      }
      index = next;
      afterIndentedCode = true;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      if (!collect) {
        out.push('<hr>');
      }
      index += 1;
      continue;
    }

    // Footnote definitions for labels the pre-scan activated — consumed
    // wherever they stand (GFM lets them interrupt a paragraph), their
    // text hoisted into the document's footnote state instead of the
    // flow. Inactive labels never reach this branch; they stay paragraph
    // text exactly as before footnotes existed.
    const footnote = collectFootnoteDefinition(lines, index);
    if (footnote) {
      flushParagraph();
      index = footnote.next;
      continue;
    }

    // Blockquotes — markers strip one level; lazy continuation lets a
    // bare text line extend the quote's open paragraph.
    if (BLOCKQUOTE_MARKER.test(line)) {
      flushParagraph();
      const { markup, next } = collectBlockquote(lines, index, depth, collect);
      if (!collect) {
        out.push(markup);
      }
      index = next;
      continue;
    }

    // Tables — the header + delimiter pair interrupts a paragraph: the
    // reference implementation starts the table wherever the pair stands,
    // even under an open paragraph (each fresh line gets its chance; a
    // pair that fails to form leaves the paragraph flowing).
    {
      const table = collectTable(lines, index);
      if (table) {
        flushParagraph();
        if (!collect) {
          out.push(table.markup);
        }
        index = table.next;
        continue;
      }
    }

    // Raw HTML blocks — CommonMark's types 6 and 7, gated to the policy's
    // allowlist (a declined tag never opens a block; its line stays
    // paragraph text, the pre-policy behavior). Type 6 (the known block
    // tags) may interrupt a paragraph; type 7 (any other tag ALONE on its
    // line) may not. Both run to the next BLANK line, and the whole chunk
    // renders through renderRawHtmlChunk — allowlisted tags rebuilt,
    // everything else escaped, in-between text escaped except its
    // already-encoded entities.
    {
      const html = collectHtmlBlock(lines, index, paragraph.length > 0);
      if (html) {
        flushParagraph();
        if (!collect) {
          out.push(html.markup);
        }
        index = html.next;
        continue;
      }
    }

    // Lists — a marker line starts one whether or not a paragraph is open
    // (with the interrupt rules: an ordered list must start at 1, and the
    // first item must carry content). At the depth cap the marker degrades
    // to paragraph text — see MAX_NESTING_DEPTH.
    const mayStartList =
      paragraph.length > 0 || afterCode
        ? canListInterrupt(line)
        : !(firstLineInterruptCheck && index === 0) || canListInterrupt(line);
    if (isListItemStart(line) && depth < MAX_NESTING_DEPTH && mayStartList) {
      // Whether the list INTERRUPTED a paragraph — read before
      // flushParagraph empties the buffer.
      const interrupting = paragraph.length > 0;
      flushParagraph();
      const { markup, next } = collectList(
        lines,
        index,
        depth,
        collect,
        interrupting || (firstLineInterruptCheck && index === 0),
      );
      if (!collect) {
        out.push(markup);
      }
      index = next;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return out;
}

/**
 * Display math: `$$…$$` opened at line `start`, closing on a later line
 * that ends with `$$` (or the same line, `$$x$$`). Null when the shape is
 * not there — the lines then fall through to paragraph handling.
 */
function collectDisplayMath(
  lines: string[],
  start: number,
): { markup: string; next: number } | null {
  const opener = lines[start]!.trim();
  if (!opener.startsWith('$$')) {
    return null;
  }

  let end = -1;
  if (opener.endsWith('$$') && opener.length > 4) {
    end = start; // `$$x$$` — one line, both delimiters
  } else {
    for (let look = start + 1; look < lines.length; look += 1) {
      if (/\$\$ *$/.test(lines[look]!)) {
        end = look;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }

  const latex = lines
    .slice(start, end + 1)
    .join('\n')
    .replace(/^ *\$\$/, '')
    .replace(/\$\$ *$/, '')
    .trim();
  if (latex === '') {
    return null;
  }
  return { markup: `<div class="md-math-block">${buildMathShell(latex)}</div>`, next: end + 1 };
}

/**
 * Consumes a fenced code block; returns its markup and the next index.
 * `indent` is the opening fence's own column count — every body line
 * loses up to that much indentation, so a fence nested inside a list
 * keeps its relative shape.
 */
function collectFence(
  lines: string[],
  start: number,
  indent: number,
  fenceChar: string,
  fenceLength: number,
  info: string,
): { markup: string; next: number } {
  const body: string[] = [];
  let index = start + 1;

  while (index < lines.length) {
    const closing = FENCE_CLOSE.exec(lines[index]!);
    if (closing && closing[1]![0] === fenceChar && closing[1]!.length >= fenceLength) {
      index += 1;
      break;
    }
    body.push(stripIndent(lines[index]!, indent));
    index += 1;
  }

  // The info string's first word becomes a language-* class — backslash
  // escapes and entities resolve first (the reference reading), then the
  // word is HTML-escaped into the attribute, so a hostile info string
  // renders as text inside the class and never as markup.
  const infoValue = decodeEntities(info.trim().replace(/\\(.)/g, '$1'));
  const language = infoValue.split(/ +/)[0] ?? '';
  const lang = language === '' ? '' : ` class="language-${escapeHtmlAttr(language)}"`;
  // The body's lines are newline-terminated — the reference's per-line
  // accounting synthesizes the final line ending at EOF, so the code
  // content always ends with one newline when it has lines.
  const tail = body.length > 0 ? '\n' : '';
  return {
    markup: `<pre><code${lang}>${escapeHtml(body.join('\n'))}${tail}</code></pre>`,
    next: index,
  };
}

/**
 * Consumes an indented code block: consecutive lines carrying four or more
 * leading columns, blank lines between chunks kept (their own indentation
 * shrunk by the block's four columns, like any other line) and the
 * trailing run dropped. Tabs were expanded at entry, so "four columns" is
 * four literal spaces.
 */
function collectIndentedCode(lines: string[], start: number): { markup: string; next: number } {
  const body: string[] = [];
  let pendingBlanks: string[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    // A whitespace-only line at or under the block's own four columns is
    // a separator (kept between chunks, dropped at the end) — the
    // reference consumes four columns of a blank line as prefix and reads
    // nothing left. Deeper whitespace keeps its remainder as content.
    if (isBlank(line) && indentWidth(line) <= 4) {
      pendingBlanks.push('');
      index += 1;
      continue;
    }
    if (indentWidth(line) < 4) {
      break;
    }
    if (body.length > 0 && pendingBlanks.length > 0) {
      body.push(...pendingBlanks);
    }
    pendingBlanks = [];
    body.push(stripIndent(line, 4));
    index += 1;
  }
  const tail = body.length > 0 ? '\n' : '';
  return {
    markup: `<pre><code>${escapeHtml(body.join('\n'))}${tail}</code></pre>`,
    next: index,
  };
}

/** Consumes a blockquote (markers + lazy continuation); recurses inside. */
function collectBlockquote(
  lines: string[],
  start: number,
  depth: number,
  collect: boolean,
): { markup: string; next: number } {
  const inner: string[] = [];
  /**
   * Whether the quote's inner flow is an open paragraph — the only block
   * a marker-less line may lazily extend. A marker line whose content is
   * paragraph text (a list item's first line included — its item opens
   * paragraph text too) keeps the door open; fences, headings, breaks and
   * indented code close it.
   */
  let lazyParagraph = false;
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    const marker = BLOCKQUOTE_MARKER.exec(line);
    if (marker) {
      // '>' plus at most one space of marker — the rest of the line's
      // indentation belongs to the content (it may re-indent a code block).
      const stripped = line.replace(BLOCKQUOTE_MARKER, '');
      inner.push(stripped);
      lazyParagraph = endsParagraphOpen(stripped);
      index += 1;
      continue;
    }
    // Lazy continuation: a non-blank line that starts nothing new extends
    // the quote's open paragraph — a line that would CLOSE it as a setext
    // underline is paragraph text too (lazy lines cannot close blocks),
    // so it merges onto the line it continues.
    if (lazyParagraph && !isBlank(line)) {
      if (startsLazyBlock(line)) {
        break;
      }
      const last = inner[inner.length - 1];
      if (SETEXT_SOLID.test(line) && last !== undefined && !isBlank(last) && !startsBlock(last)) {
        inner[inner.length - 1] = `${last}\n${line}`;
      } else {
        inner.push(line);
      }
      index += 1;
      continue;
    }
    break;
  }

  const innerMarkup = renderBlocks(inner, depth + 1, collect).join('\n');
  return {
    // The inner walk runs in BOTH modes — the collect pass needs it to
    // harvest definitions hiding inside the quote.
    markup: collect ? '' : `<blockquote>${innerMarkup}</blockquote>`,
    next: index,
  };
}

/** The content a list marker line carries past its marker ('' when bare). */
function listItemContent(line: string): string {
  const stripped = line.replace(/^ +/, '');
  const bullet = LIST_BULLET.exec(stripped);
  const ordered = LIST_ORDERED.exec(stripped);
  if (!bullet && !ordered) {
    return '';
  }
  return stripped.slice(bullet ? bullet[0].length : ordered![0].length);
}

/**
 * Whether the line leaves its container's innermost flow as an OPEN
 * PARAGRAPH — the only state a lazy continuation line may extend. Quote
 * markers recurse into their content; a list marker opens paragraph text
 * only when its item carries content (a bare marker opens nothing); a
 * fence, heading, break or indented-code line closes the flow.
 */
function endsParagraphOpen(line: string): boolean {
  const quote = BLOCKQUOTE_MARKER.exec(line);
  if (quote) {
    return endsParagraphOpen(line.slice(quote[0].length));
  }
  if (isListItemStart(line)) {
    return listItemContent(line).trim() !== '';
  }
  return (
    !isBlank(line) &&
    !FENCE_OPEN.test(line) &&
    !ATX_HEADING.test(line) &&
    !THEMATIC_BREAK.test(line) &&
    indentWidth(line) < 4
  );
}

/** True when the line opens a list item (any indent, either marker form). */
function isListItemStart(line: string): boolean {
  if (indentWidth(line) >= 4) {
    // Deep indentation is content, not a new block (nested structures
    // carry their own indent relative to their parent — this probe runs
    // at the top of a block scope).
    return false;
  }
  const stripped = line.replace(/^ +/, '');
  return LIST_BULLET.test(stripped) || LIST_ORDERED.test(stripped);
}

/**
 * Whether a list marker may interrupt an open paragraph: ordered lists
 * only when they start at 1, and only when the first item carries content
 * (a bare `-` under text is the setext underline's sibling, not a list).
 */
function canListInterrupt(line: string): boolean {
  const stripped = line.replace(/^ +/, '');
  const bullet = LIST_BULLET.exec(stripped);
  const ordered = LIST_ORDERED.exec(stripped);
  if (!bullet && !ordered) {
    return false;
  }
  if (ordered && ordered[1] !== '1') {
    return false;
  }
  const markerLen = bullet ? 1 : ordered![1]!.length + 1;
  const rest = stripped.slice(markerLen);
  let padding = 0;
  while (padding < 4 && rest[padding] === ' ') {
    padding += 1;
  }
  if (padding === 4 && rest[4] === ' ') {
    padding = 1;
  }
  return rest.slice(Math.max(padding, 1)).trim() !== '';
}

/**
 * The marker KIND a line opens — `bullet:<char>` (`-`, `*`, `+`) or
 * `ordered:<delimiter>` (`.` or `)`), or null when the line opens no
 * list. CommonMark keeps a list alive only while its markers share one
 * kind: a bullet list followed by an ordered one (blank line between or
 * not) is TWO lists, and merging them would swallow the ordered numbers
 * and the task checkboxes into a `<ul>`.
 */
function listMarkerKind(line: string): string | null {
  if (indentWidth(line) >= 4) {
    return null; // deep indentation is content, not a marker
  }
  const stripped = line.replace(/^ +/, '');
  const bullet = LIST_BULLET.exec(stripped);
  if (bullet) {
    return `bullet:${bullet[1]}`;
  }
  const ordered = LIST_ORDERED.exec(stripped);
  if (ordered) {
    return `ordered:${ordered[2]}`;
  }
  return null;
}

interface ListItem {
  /** The item's content lines (marker stripped, relative indentation). */
  content: string[];
  /** Ordered-list number, when the item came from `\d.` / `\d)`. */
  number: number | null;
  /** GFM task state; null = not a task item. */
  task: 'checked' | 'unchecked' | null;
  /** The column this item's content begins at (marker + its spaces). */
  contentIndent: number;
}

/**
 * Matches a single item line into its shell shape (or null).
 *
 * The padding rule is the reference implementation's: up to four spaces
 * after the marker, but if whitespace CONTINUES past four the whole
 * prefix collapses to a single space (the tokenizer's whitespace attempt
 * rewinds and takes one character) — which is how `-\t\tfoo` ends up
 * running a code block inside its item while `-   foo` does not. An
 * absent space still counts as one, so `-` and `- ` share a content
 * column.
 */
function matchListItem(line: string): ListItem | null {
  const indent = indentWidth(line);
  if (indent >= 4) {
    return null;
  }
  const stripped = line.replace(/^ +/, '');
  const bullet = LIST_BULLET.exec(stripped);
  const ordered = LIST_ORDERED.exec(stripped);
  const match = bullet ?? ordered;
  if (!match) {
    return null;
  }

  const markerLen = bullet ? 1 : ordered![1]!.length + 1;
  const rest = stripped.slice(markerLen);
  let padding = 0;
  while (padding < 4 && rest[padding] === ' ') {
    padding += 1;
  }
  if (padding === 4 && rest[4] === ' ') {
    padding = 1;
  }
  // An item whose marker line carries no content starts blank — its
  // content indent is one column past the marker (the spec's blank-first
  // rule), not the padding the bare spaces suggest.
  const contentIndent =
    rest.trim() === '' ? indent + markerLen + 1 : indent + markerLen + Math.max(padding, 1);
  const body = rest.slice(Math.max(padding, 1));

  let task: ListItem['task'] = null;
  let content = body;
  const taskMatch = TASK_MARKER.exec(body);
  if (taskMatch) {
    task = taskMatch[1] === ' ' ? 'unchecked' : 'checked';
    content = body.slice(taskMatch[0].length);
  }

  return {
    content: content.trim() === '' ? [] : [content],
    number: ordered ? Number(ordered[1]) : null,
    task,
    contentIndent,
  };
}

/**
 * Consumes one list (sibling items at a shared base indent). Lines indented
 * past an item's marker become that item's CONTENT — the recursive
 * renderBlocks call inside renderList is what turns them into nested
 * lists, paragraphs and everything else an item can hold.
 */
function collectList(
  lines: string[],
  start: number,
  depth: number,
  collect: boolean,
  interrupted = false,
): { markup: string; next: number } {
  const baseIndent = indentWidth(lines[start]!);
  const items: ListItem[] = [];
  let loose = false;
  let pendingBlank = false;
  let index = start;
  // This list's marker kind (from its first line) — siblings of another
  // kind belong to the NEXT list, not this one.
  const listKind = listMarkerKind(lines[start]!);
  // Whether the innermost open flow (the current item's content) ends in
  // a paragraph — the only state a lazy line may extend. A bare marker
  // opens nothing, a code/fence/heading line closes, text opens.
  let flowParagraphOpen = endsParagraphOpen(lines[start]!);

  const contentIndent = (): number => items[items.length - 1]?.contentIndent ?? 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const lineIndent = indentWidth(line);

    if (isBlank(line)) {
      // A blank ends the list unless the next content line still belongs
      // to it (a sibling marker OF THE SAME KIND, or content indented
      // past the marker — a changed marker kind starts a new list). Runs
      // of blanks ride into the item's content; they only make the list
      // LOOSE when they separate this item's own blocks — a blank that a
      // deeper nested list continues belongs to that list.
      let runEnd = index;
      while (runEnd < lines.length && isBlank(lines[runEnd]!)) {
        runEnd += 1;
      }
      const next = runEnd < lines.length ? lines[runEnd]! : null;
      if (next === null) {
        break;
      }
      const nextIsContent =
        indentWidth(next) >= contentIndent() ||
        (isListItemStart(next) &&
          indentWidth(next) >= baseIndent &&
          listMarkerKind(next) === listKind);
      if (!nextIsContent) {
        break;
      }
      const current = items[items.length - 1];
      const nextIsSibling =
        isListItemStart(next) &&
        indentWidth(next) >= baseIndent &&
        listMarkerKind(next) === listKind;
      // An item that opened EMPTY already spent its one blank line — a
      // further blank ends the list unless a sibling marker follows (the
      // reference's initialBlankLine rule: `-\n\n  foo` is an empty item
      // plus a paragraph, but `-\n\n- c` is one loose list).
      if ((!current || current.content.length === 0) && !nextIsSibling) {
        break;
      }
      if (current) {
        const lastContent = current.content[current.content.length - 1];
        const nested =
          lastContent !== undefined && isListItemStart(lastContent)
            ? matchListItem(lastContent)
            : null;
        // Ownership compares in the item's CONTENT space: the next line's
        // indent minus the item's own content column, against the nested
        // marker's content column (its stored indent is already relative
        // to that same space).
        const ownedDeeper =
          (nested !== null && indentWidth(next) - contentIndent() >= nested!.contentIndent) ||
          contentInOpenFence(current.content);
        if (!ownedDeeper) {
          pendingBlank = true;
        }
        for (let blank = index; blank < runEnd; blank += 1) {
          current.content.push('');
        }
        flowParagraphOpen = false;
      }
      index = runEnd;
      continue;
    }

    if (lineIndent < baseIndent && isListItemStart(line)) {
      // A same-kind marker at a shallower column still joins this list —
      // the reference's list container survives the flow close and the
      // re-attempt at whatever column the marker stands (`  - a\n- b` is
      // ONE list). Another kind belongs to the enclosing flow.
      if (listMarkerKind(line) !== listKind) {
        break;
      }
    }

    // A sibling lives inside the list's indent band — a line deeper than
    // the band is content, never a sibling, and the marker match below
    // (a regex run plus a line copy) is pure waste for it. Gate it — and
    // a line that is ITSELF a same-character thematic break is never a
    // sibling: the break wins at list-start (`* Foo\n* * *\n* Bar`).
    const item =
      lineIndent < baseIndent + 4 && !THEMATIC_BREAK.test(line) ? matchListItem(line) : null;

    // A thematic break at a shallower column than the item's content
    // — and NOT itself a sibling marker (`- * * *` is an item whose
    // content is a break) — belongs to the enclosing flow and ends the
    // list (`- foo\n***\n- bar` is a list, a break, a list).
    if (!item && THEMATIC_BREAK.test(line) && lineIndent < contentIndent()) {
      break;
    }
    // A sibling marker: below the current item's content column (it
    // cannot be that item's content) and within the list's own band —
    // and of the same kind (a changed kind starts a new list).
    const isSibling =
      !!item &&
      listMarkerKind(line) === listKind &&
      (items.length === 0 || lineIndent < items[items.length - 1]!.contentIndent);
    if (isSibling) {
      // A blank line before a sibling is what makes the list loose.
      if (pendingBlank) {
        loose = true;
        pendingBlank = false;
      }
      items.push(item!);
      flowParagraphOpen = endsParagraphOpen(line);
      index += 1;
      continue;
    }

    // Anything else is content of the current item: indented at least
    // past its marker, or a lazy PARAGRAPH continuation — a lazy line
    // cannot start a fence, heading, break or quote, and it can never
    // start a list (the reference flow never container-checks lazy
    // lines; they flow straight into the open paragraph, merging onto
    // the line they continue).
    const current = items[items.length - 1];
    if (
      current &&
      (lineIndent >= contentIndent() ||
        (flowParagraphOpen && !pendingBlank && !startsLazyBlock(line)))
    ) {
      if (pendingBlank) {
        loose = true;
        pendingBlank = false;
      }
      if (lineIndent < contentIndent() && current.content.length > 0) {
        const last = current.content[current.content.length - 1]!;
        if (!isBlank(last) && !startsBlock(last)) {
          current.content[current.content.length - 1] = `${last}\n${line}`;
          index += 1;
          continue;
        }
      }
      const strippedContent = stripIndent(line, contentIndent());
      current.content.push(strippedContent);
      flowParagraphOpen = endsParagraphOpen(strippedContent);
      index += 1;
      continue;
    }
    break;
  }

  const listMarkup = renderList(items, loose, depth, collect, interrupted);
  return { markup: collect ? '' : listMarkup, next: index };
}

/** Renders the collected items as `<ul>`/`<ol>` markup. */
function renderList(
  items: ListItem[],
  loose: boolean,
  depth: number,
  collect: boolean,
  interrupted: boolean,
): string {
  if (items.length === 0) {
    return '';
  }
  const ordered = items[0]!.number !== null;
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && items[0]!.number !== 1 ? ` start="${items[0]!.number}"` : '';

  const rendered = items
    .map((item, itemIndex) => {
      // A list that interrupts a paragraph passes the demand down: the
      // first item's first line may not grow an empty child list either.
      let blocks = renderBlocks(item.content, depth + 1, collect, interrupted && itemIndex === 0);
      // Tight lists unwrap every paragraph — the item's blocks read as
      // one flow (a heading followed by text stays heading-then-text);
      // loose lists keep every wrapper.
      if (!loose) {
        blocks = blocks.map((block) => block.replace(/^<p>([\s\S]*)<\/p>$/, '$1'));
      }
      let inner = blocks.join('\n');

      if (item.task !== null) {
        const checked = item.task === 'checked' ? ' checked' : '';
        const box = `<input type="checkbox" disabled${checked}> `;
        // A loose item's first block is a paragraph — the checkbox rides
        // inside it, the reference's own shape.
        inner = loose && inner.startsWith('<p>') ? inner.replace('<p>', `<p>${box}`) : box + inner;
      }
      return `<li>${inner}</li>`;
    })
    .join('\n');

  return `<${tag}${start}>\n${rendered}\n</${tag}>`;
}

// ---------------------------------------------------------------------------
// Tables (GFM)
// ---------------------------------------------------------------------------

/** Matches a delimiter row cell: `:-`, `:--`, `--:`, `:-:` … (GFM: ≥1 dash). */
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * Consumes a GFM table starting at `start` (header row). Null when the
 * shape is not a table — the caller falls through to paragraph text.
 *
 * Body rows continue past blank-less lines that carry no pipes (they read
 * as one wide cell) and end at any block start — heading, fence, quote,
 * list, break or indented code.
 */
function collectTable(lines: string[], start: number): { markup: string; next: number } | null {
  const header = lines[start]!;
  const delimiter = lines[start + 1];
  if (delimiter === undefined || !header.includes('|')) {
    return null;
  }

  const delimiterCells = splitTableRow(delimiter);
  if (delimiterCells.length === 0 || !delimiterCells.every((cell) => DELIMITER_CELL.test(cell))) {
    return null;
  }

  const headerCells = splitTableRow(header);
  if (headerCells.length !== delimiterCells.length) {
    return null;
  }

  const alignments = delimiterCells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) {
      return 'center';
    }
    return right ? 'right' : left ? 'left' : '';
  });

  const align = (index: number): string =>
    alignments[index] ? ` style="text-align:${alignments[index]}"` : '';

  const head = headerCells
    .map((cell, index) => `<th${align(index)}>${renderInline(cell)}</th>`)
    .join('');

  const width = headerCells.length;
  const bodyRows: string[] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line) || startsBlock(line)) {
      break;
    }
    const cells = splitTableRow(line);
    const row: string[] = [];
    for (let cellIndex = 0; cellIndex < width; cellIndex += 1) {
      // Ragged rows pad short on the right and drop the overflow — the
      // GFM rule the reference implementation follows.
      const cell = cells[cellIndex] ?? '';
      row.push(`<td${align(cellIndex)}>${renderInline(cell)}</td>`);
    }
    bodyRows.push(`<tr>${row.join('')}</tr>`);
    index += 1;
  }

  const body = bodyRows.length > 0 ? `\n<tbody>${bodyRows.join('')}</tbody>` : '';
  return { markup: `<table>\n<thead>\n<tr>${head}</tr>\n</thead>${body}\n</table>`, next: index };
}

// ---------------------------------------------------------------------------
// Raw HTML blocks — CommonMark types 6/7, the policy-allowlisted reading
// ---------------------------------------------------------------------------

/**
 * CommonMark's type-6 tag list (the known block-level tag names that open
 * an HTML block wherever they stand, paragraph or not). Type 1's four
 * (script/pre/style/textarea) are deliberately absent: their end
 * conditions differ, none is allowlisted, and they stay paragraph text.
 */
const HTML_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'section',
  'source',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
]);

/**
 * The html-block start condition on one line: 6 (a listed tag name,
 * attributes may follow), 7 (an unlisted tag that is the WHOLE line), or
 * null. The tag must also pass the policy's allowlist for the block to
 * claim the line — a declined tag's line stays paragraph text.
 */
function htmlBlockKind(line: string): { kind: 6 | 7; name: string } | null {
  const probe = /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(line);
  if (!probe) {
    return null;
  }
  const name = probe[2]!.toLowerCase();
  if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') {
    return null; // type 1 — different end condition, never allowlisted
  }
  if (!markdownTagAllowed(name)) {
    return null; // the policy declines it — paragraph text, as before
  }
  if (HTML_BLOCK_TAGS.has(name)) {
    return { kind: 6, name };
  }
  // Type 7: a complete tag followed by ONLY whitespace to the line's end.
  const lt = line.indexOf('<');
  const end = matchRawHtml(line, lt);
  if (end !== -1 && line.slice(end).trim() === '') {
    return { kind: 7, name };
  }
  return null;
}

/**
 * Collects one raw HTML block: from `start` to the next blank line (both
 * types 6 and 7 end there), the chunk rendered through the policy. Null
 * when the line does not open one — a type-7 tag may NOT interrupt a
 * paragraph (CommonMark's own rule), and a declined tag never claims the
 * line at all.
 */
function collectHtmlBlock(
  lines: string[],
  start: number,
  paragraphOpen: boolean,
): { markup: string; next: number } | null {
  const shape = htmlBlockKind(lines[start]!);
  if (!shape || (shape.kind === 7 && paragraphOpen)) {
    return null;
  }
  let end = start + 1;
  while (end < lines.length && !isBlank(lines[end]!)) {
    end += 1;
  }
  return { markup: renderRawHtmlChunk(lines.slice(start, end).join('\n')), next: end };
}

/**
 * Renders a raw-HTML chunk (an html block's lines, joined) through the
 * policy: every tag shape the grammar recognizes is either REBUILT (the
 * allowlist's own markup — only its attributes, every URL gated) or
 * escaped; a `<` that forms no shape is escaped alone; and the text
 * between tags rides through with its entities intact (`&amp;` shows as
 * `&`, the browser's own reading of html-block bytes).
 */
function renderRawHtmlChunk(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '<') {
      const end = matchRawHtml(raw, i);
      if (end !== -1) {
        const shape = raw.slice(i, end);
        if (shape[1] === '!' || shape[1] === '?') {
          // Comment / PI / declaration / CDATA — invisible in a browser.
        } else {
          const rebuilt = sanitizeHtmlTag(shape);
          out += rebuilt !== null ? rebuilt : escapeHtml(shape);
        }
        i = end;
        continue;
      }
      out += '&lt;';
      i += 1;
      continue;
    }
    out += raw[i]!;
    i += 1;
  }
  return out;
}

/** True when the line opens a block that would end a table's body. */
function startsBlock(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    BLOCKQUOTE_MARKER.test(line) ||
    isListItemStart(line) ||
    indentWidth(line) >= 4
  );
}

/**
 * True when the item's content ends inside an unclosed fence — blank
 * lines that follow are the fence's body, not the item's own block
 * separator.
 */
function contentInOpenFence(content: string[]): boolean {
  let open: { char: string; length: number } | null = null;
  for (const line of content) {
    if (open === null) {
      const opened = FENCE_OPEN.exec(line);
      if (opened) {
        open = { char: opened[2]![0]!, length: opened[2]!.length };
      }
      continue;
    }
    const closed = FENCE_CLOSE.exec(line);
    if (closed && closed[1]![0] === open.char && closed[1]!.length >= open.length) {
      open = null;
    }
  }
  return open !== null;
}

/**
 * The lazy-continuation veto: the blocks a paragraph-continuing line may
 * NOT start. Deliberately WITHOUT the four-column rule — a deep line under
 * a wide marker is still just paragraph text (the reference flow never
 * container-checks lazy lines).
 */
function startsLazyBlock(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    ATX_HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    BLOCKQUOTE_MARKER.test(line) ||
    isListItemStart(line)
  );
}

/**
 * Splits a table row into trimmed cells. A pipe preceded by an ODD run of
 * backslashes is escaped content (the run's last member is its escape); an
 * even run — including none — leaves the pipe a live cell separator, so
 * `a \\| b` splits (`\\` is an escaped backslash) while `a \| b` does not.
 * The escaped pipe becomes `|` here; every other backslash pair stays for
 * the inline pass to judge.
 */
function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|')) {
    // The trailing pipe is the row's closer — unless an odd backslash run
    // escapes it (the same parity rule, read backwards from the end).
    let slashes = 0;
    for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      text = text.slice(0, -1);
    }
  }

  const cells: string[] = [];
  let current = '';
  let slashes = 0; // the backslash run ending at the cursor
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      slashes += 1;
      current += ch;
      continue;
    }
    if (ch === '|') {
      if (slashes % 2 === 1) {
        // Odd run: the last backslash is this pipe's escape — the pipe is
        // content, and the run pays for it.
        current = `${current.slice(0, -1)}|`;
      } else {
        cells.push(current.trim());
        current = '';
      }
      slashes = 0;
      continue;
    }
    slashes = 0;
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

// ---------------------------------------------------------------------------
// Inline parsing — a token stream
// ---------------------------------------------------------------------------

/** Characters a backslash may escape (CommonMark's ASCII punctuation). */
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!:|~<>&"\'$%/;,=?@^'.split(''));

/**
 * An ASCII control character — C0 plus DEL (the spec's "ASCII control
 * character" for bare destinations: one cannot appear in a destination,
 * so the destination ends before it and whatever follows is junk).
 */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 32 || code === 127;
}

type InlineToken =
  | { kind: 'text'; raw: string }
  | { kind: 'rawText'; raw: string }
  | { kind: 'html'; html: string }
  | {
      kind: 'delimiter';
      char: string;
      /** Characters left to pair (mutates down as pairs consume). */
      run: number;
      /** The run's original length — the rule of 3 reads this. */
      origin: number;
      /** Walk order — the openers-bottom bound compares these. */
      seq: number;
      canOpen: boolean;
      canClose: boolean;
      /**
       * Tags assigned during pairing, in render order: the CLOSE group
       * [0, openStart) (pairs this run closed, innermost first), then the
       * OPEN group (pairs it opened, outermost first) — the leftover
       * literal folds between them. A run that closes one pair and opens
       * another (`b***foo*` after an open em) renders close-tag, leftover,
       * open-tag, exactly where its characters stand.
       */
      tags: string[];
      openStart: number;
    };

/**
 * A span the main scan must not re-interpret: code spans, math and
 * autolinks, whose interiors are literal. Brackets inside a span never
 * count toward the label scan (code spans take precedence over links);
 * an AUTOlink span inside a link's LABEL vetoes the link itself — an
 * autolink is a link, and links may not nest.
 */
type ProtectedSpan = {
  start: number;
  end: number;
  html: string;
  /** The span's plain-text rendering — the alt-text mode's emission. */
  text: string;
  kind: 'code' | 'math' | 'autolink';
};

/**
 * Renders one text run (a paragraph, a heading, a table cell) to inline
 * HTML — or, with asText, to the run's PLAIN TEXT (the image alt-text
 * projection: emphasis markers drop, nested links and images contribute
 * their own label text, code spans their interior, everything else its
 * literal characters). A pre-pass pins code spans, math and autolinks
 * left to right — the earliest construct wins, exactly like the reference
 * scan — then the main scan recognises escapes, links and emphasis runs
 * around them. Everything else is escaped literal text — the tags in the
 * output are only ever ours. `inLink` suppresses constructs that cannot
 * nest inside a link (links, autolinks; images degrade to a marked span).
 */
function renderInline(text: string, inLink = false, asText = false): string {
  // The text projection claims autolinks even inside link labels — an
  // autolink in an alt text contributes its URL, and the anchor-suppression
  // rule has no text-mode meaning.
  const spans = protectedSpans(text, inLink && !asText);
  const tokens: InlineToken[] = [];
  let buffer = '';

  const flushBuffer = (): void => {
    if (buffer !== '') {
      tokens.push({ kind: 'text', raw: buffer });
      buffer = '';
    }
  };

  let seq = 0;
  let spanIndex = 0;
  let i = 0;
  while (i < text.length && text[i] === ' ') {
    i += 1; // the first line's continuation-indent — text-path only
  }
  while (i < text.length) {
    // A protected span's turn — its HTML was decided by the pre-pass.
    // Spans the other tokens consumed (an autolink the pre-pass claimed
    // inside a link's raw destination, say) are skipped past, or every
    // span after them would go dark.
    while (spanIndex < spans.length && spans[spanIndex]!.start < i) {
      spanIndex += 1;
    }
    if (spanIndex < spans.length && spans[spanIndex]!.start === i) {
      flushBuffer();
      tokens.push({ kind: 'html', html: asText ? spans[spanIndex]!.text : spans[spanIndex]!.html });
      i = spans[spanIndex]!.end;
      spanIndex += 1;
      continue;
    }

    const ch = text[i]!;

    // Backslash escapes; a backslash before a newline is a hard break.
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === '\n') {
        flushBuffer();
        tokens.push({ kind: 'html', html: '<br>' });
        i += 2;
        continue;
      }
      if (ESCAPABLE.has(next)) {
        flushBuffer();
        tokens.push({ kind: 'text', raw: next });
        i += 2;
        continue;
      }
    }

    // Inline raw HTML — a tag, comment, PI, declaration or CDATA the
    // grammar recognizes. A TAG on the policy's allowlist is REBUILT
    // (sanitizeHtmlTag: only its allowed attributes survive, every URL
    // gated — GitHub's sanitize-then-render reading of raw HTML); a
    // non-listed tag is escaped verbatim (a rawText token: the reference
    // keeps html-token bytes undecoded, so `<!ELEMENT x&amp;y>` shows its
    // `&amp;` literally); and COMMENTS, PIs, declarations and CDATA drop
    // ENTIRELY — a browser renders them as nothing (bogus comments),
    // which is what GitHub's visible output does too.
    if (ch === '<') {
      const end = matchRawHtml(text, i);
      if (end !== -1) {
        const shape = text.slice(i, end);
        if (shape[1] === '!' || shape[1] === '?') {
          flushBuffer(); // comment / PI / declaration / CDATA — invisible
        } else {
          const rebuilt = sanitizeHtmlTag(shape);
          flushBuffer();
          tokens.push(
            rebuilt !== null ? { kind: 'html', html: rebuilt } : { kind: 'rawText', raw: shape },
          );
        }
        i = end;
        continue;
      }
    }

    // Footnote references — `[^label]` shares the opening bracket but is
    // not a link construct. Alt text keeps them as literal bytes (the
    // text projection has no superscripts).
    if (ch === '[' && !asText) {
      const ref = matchFootnoteRef(text, i);
      if (ref && !spanCrosses(spans, i, ref.next)) {
        flushBuffer();
        tokens.push({ kind: 'html', html: ref.markup });
        i = ref.next;
        continue;
      }
    }

    // Links and images.
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const link = matchLink(text, i, spans, inLink, asText);
      if (link) {
        flushBuffer();
        tokens.push({ kind: 'html', html: link.markup });
        i = link.next;
        continue;
      }
    }

    // Emoji shortcodes — `:+1:`, `:tada:`, the GitHub pipeline's own
    // gemoji table (emoji.generated.ts). Text positions only: code spans,
    // autolinks and math ride the protected pre-pass, link destinations
    // and raw-HTML bytes never pass through here, and an unknown or
    // unclosed name stays the literal text it was. The emoji character is
    // both the markup and the text — the alt projection needs no case.
    if (ch === ':') {
      const emoji = matchEmojiShortcode(text, i);
      if (emoji !== null) {
        flushBuffer();
        tokens.push({ kind: 'html', html: emoji.markup });
        i = emoji.next;
        continue;
      }
    }

    // Emphasis delimiter runs: * and _ any length, ~ exactly one or two.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (text[i + run] === ch) {
        run += 1;
      }
      if (ch === '~' && run > 2) {
        // Strikethrough is one or two tildes; longer runs are literal.
        flushBuffer();
        tokens.push({ kind: 'text', raw: '~'.repeat(run) });
        i += run;
        continue;
      }

      // Flanking — CommonMark's rule, with end-of-line reading as
      // whitespace (the reference implementation's own reading).
      const before = i > 0 ? text[i - 1]! : '\n';
      const after = i + run < text.length ? text[i + run]! : '\n';
      const beforeWs = /\s/.test(before);
      const afterWs = /\s/.test(after);
      const beforePunct = isPunct(before);
      const afterPunct = isPunct(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen = leftFlanking;
      let canClose = rightFlanking;
      if (ch === '_') {
        // Intraword underscores never emphasise (snake_case stays whole);
        // punctuation-adjacent ones still may.
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      }

      flushBuffer();
      tokens.push({
        kind: 'delimiter',
        char: ch,
        run,
        origin: run,
        seq: seq++,
        canOpen,
        canClose,
        tags: [],
        openStart: 0,
      });
      i += run;
      continue;
    }

    // Hard break: two or more trailing spaces before a newline; a plain
    // newline inside a paragraph stays a newline (HTML folds it). A tab
    // anywhere in the trailing run vetoes the break — the run is read in
    // its original bytes (expandTabs preserves it), and the reference's
    // rule counts spaces only.
    if (ch === '\n') {
      let spaces = 0;
      let sawTab = false;
      let back = i - 1;
      while (back >= 0 && (text[back] === ' ' || text[back] === '\t')) {
        if (text[back] === '\t') {
          sawTab = true;
        }
        spaces += 1;
        back -= 1;
      }
      if (!sawTab && spaces >= 2) {
        buffer = buffer.slice(0, -spaces);
        flushBuffer();
        tokens.push({ kind: 'html', html: asText ? '\n' : '<br>' });
      } else {
        buffer += '\n';
      }
      i += 1;
      while (i < text.length && text[i] === ' ') {
        i += 1; // a continuation line's leading indent — text-path only
      }
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flushBuffer();
  pairDelimiters(tokens, asText);
  return tokens.map((token) => renderToken(token, asText)).join('');
}

/** Unicode punctuation or symbol — flanking's widened 0.31 definition. */
function isPunct(ch: string): boolean {
  return /[\p{P}\p{S}]/u.test(ch);
}

/** True when any protected span starts inside (from, to]. */
function spanCrosses(spans: ProtectedSpan[], from: number, to: number): boolean {
  return spans.some((span) => span.start > from && span.start <= to);
}

/**
 * The pre-pass: math, autolinks and code spans claim their ranges left to
 * right — the earliest construct wins, exactly like the reference scan
 * (an autolink at column 0 owns a backtick further in; a code span owns a
 * link's closing bracket). Escapes are honored here too — an escaped
 * backtick opens nothing, and autolinks never claim inside a link label.
 */
function protectedSpans(text: string, inLink = false): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  const depths = bracketDepths(text);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    // Math first — `\(` is math syntax, not a backslash escape, and a
    // `\$` escape must NOT open math either (the escape branch below
    // skips it only when math does not claim the position).
    const math = matchMath(text, i);
    if (math) {
      // The text projection shows the equation's source — a reader
      // without rendering still reads the math.
      spans.push({
        start: i,
        end: math.next,
        html: math.markup,
        text: text.slice(i, math.next),
        kind: 'math',
      });
      i = math.next;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === '<' && !inLink) {
      const angle = matchAngleAutolink(text, i);
      if (angle) {
        // Autolink interiors are literal — the text is the body as written.
        spans.push({
          start: i,
          end: angle.next,
          html: angle.markup,
          text: text.slice(i + 1, angle.next - 1),
          kind: 'autolink',
        });
        i = angle.next;
        continue;
      }
    }
    if (!inLink && /[a-zA-Z0-9._+-]/.test(ch)) {
      const literal = matchLiteralAutolink(text, i, depths);
      if (literal) {
        spans.push({
          start: i,
          end: literal.next,
          html: literal.markup,
          text: text.slice(i, literal.next),
          kind: 'autolink',
        });
        i = literal.next;
        continue;
      }
    }
    if (ch === '`') {
      let run = 0;
      while (text[i + run] === '`') {
        run += 1;
      }
      const closing = findBacktickRun(text, i + run, run);
      if (closing !== -1) {
        let code = text.slice(i + run, closing);
        // One leading AND trailing space or newline is decoration (they
        // may not be the same character) — CommonMark's code-span trim.
        if (code.length >= 2 && /^[ \n]/.test(code) && /[ \n]$/.test(code) && code.trim() !== '') {
          code = code.slice(1, -1);
        }
        spans.push({
          start: i,
          end: closing + run,
          html: `<code>${escapeHtml(code.replace(/\n/g, ' '))}</code>`,
          text: code.replace(/\n/g, ' '),
          kind: 'code',
        });
        i = closing + run;
        continue;
      }
      i += run;
      continue;
    }
    i += 1;
  }
  return spans;
}

/** One token's final HTML (literal text escapes, delimiters resolve). */
function renderToken(token: InlineToken, asText = false): string {
  if (token.kind === 'text') {
    // The text projection decodes entities but never escapes — the caller
    // (an attribute emission) escapes the whole result itself.
    return asText ? decodeEntities(token.raw) : escapeHtml(decodeEntities(token.raw));
  }
  // A raw-HTML shape (tag, comment, PI, declaration, CDATA): escaped
  // VERBATIM — the bytes pass through undecoded, exactly like the
  // reference compiler's own escaping of its html tokens.
  if (token.kind === 'rawText') {
    return asText ? token.raw : escapeHtml(token.raw);
  }
  if (token.kind === 'html') {
    return token.html;
  }
  // A paired delimiter renders its tags; leftovers sit beside the
  // emphasis they helped open or close (folded in by pairDelimiters).
  if (token.tags.length > 0) {
    return token.tags.join('');
  }
  return asText
    ? decodeEntities(token.char.repeat(token.run))
    : escapeHtml(decodeEntities(token.char.repeat(token.run)));
}

/**
 * An emoji shortcode at position `i` — `:name:` with name drawn from the
 * gemoji table's own charset (lowercase letters, digits, underscore, plus,
 * hyphen). Null when the name is unknown, empty, unclosed or carries a
 * character the table never uses (the shortcode grammar stays as narrow
 * as the table, so `12:30:45` and `::` never look up).
 */
function matchEmojiShortcode(text: string, i: number): { markup: string; next: number } | null {
  let end = i + 1;
  while (end < text.length && /[a-z0-9_+-]/.test(text[end]!)) {
    end += 1;
  }
  if (end === i + 1 || text[end] !== ':') {
    return null;
  }
  const emoji = GEMOJI.get(text.slice(i + 1, end));
  if (emoji === undefined) {
    return null;
  }
  return { markup: emoji, next: end + 1 };
}

/** Index of the next backtick run of exactly `length` (or -1). */
function findBacktickRun(text: string, from: number, length: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') {
      continue;
    }
    let run = 0;
    while (text[i + run] === '`') {
      run += 1;
    }
    if (run === length) {
      return i;
    }
    i += run - 1;
  }
  return -1;
}

/**
 * Math at position `i`: `$…$` and `\(…\)` (inline — display math is a
 * block, handled by collectDisplayMath). Null when the delimiters do not
 * close — a lone `$` is a dollar. The inner edges of `$…$` must touch
 * non-space characters, the classic guard against "5$ and 6$" reading as
 * math.
 */
function matchMath(text: string, i: number): { markup: string; next: number } | null {
  if (text.startsWith('\\(', i)) {
    const close = text.indexOf('\\)', i + 2);
    if (close === -1) {
      return null;
    }
    const latex = text.slice(i + 2, close);
    if (latex.trim() === '') {
      return null;
    }
    return { markup: buildMathShell(latex.trim()), next: close + 2 };
  }

  if (text[i] === '$') {
    const close = text.indexOf('$', i + 1);
    if (close === -1) {
      return null;
    }
    const latex = text.slice(i + 1, close);
    if (/^ |\s$|\n|\$/.test(latex) || latex.trim() === '') {
      return null; // currency, not math
    }
    return { markup: buildMathShell(latex), next: close + 1 };
  }

  return null;
}

/**
 * A footnote reference `[^label]` at position `i` — the second char must
 * be `^`, the label non-empty and bracket-free, and the label ACTIVE (the
 * pre-scan found both this reference and a definition for it). Active refs
 * number in first-reference order and link into the definitions section;
 * a label referenced several times shares the number and takes a distinct
 * anchor per occurrence (ids must stay unique).
 */
function matchFootnoteRef(text: string, i: number): { markup: string; next: number } | null {
  const state = footnotes;
  if (!state || text[i + 1] !== '^') {
    return null;
  }
  const match = /^([^\]\s]+)/.exec(text.slice(i + 2));
  if (!match || text[i + 2 + match[1]!.length] !== ']') {
    return null;
  }
  const label = match[1]!;
  if (!state.labels.has(label)) {
    return null;
  }
  let number = state.numbers.get(label);
  if (number === undefined) {
    number = state.numbers.size + 1;
    state.numbers.set(label, number);
  }
  const occurrence = (state.refCounts.get(label) ?? 0) + 1;
  state.refCounts.set(label, occurrence);
  const anchor = occurrence === 1 ? `${number}` : `${number}-${occurrence}`;
  const next = i + 2 + label.length + 1;
  return {
    markup: `<sup class="md-footnote-ref" id="md-fnref-${anchor}"><a href="#md-fn-${number}">${number}</a></sup>`,
    next,
  };
}

/**
 * The markdown link gate: the storage subset's SAFE_HREF pattern for
 * anything scheme-like, PLUS scheme-less relative destinations — `foo/bar`
 * carries no scheme (a scheme needs its colon before any slash), cannot
 * smuggle javascript:, and the reference implementation links it.
 */

/**
 * A link `[text](url)` or image `![alt](url)` at position `i` — plus the
 * reference forms: `[text][ref]`, collapsed `[text][]` and shortcut
 * `[text]` (the last only when a definition stands somewhere in the
 * document). Images do not load anything — they render as a link carrying
 * the alt text, the same privacy trade the sanitizer makes for rich notes;
 * an image already inside a link cannot nest anchors, so it degrades to a
 * marked span. Unsafe URLs (anything outside http(s)/mailto/anchor/
 * relative) make the whole construct stay literal text rather than a dead
 * anchor. A label that contains a completed link kills the OUTER link —
 * links never nest, and the inner one wins (the badge reading).
 */
function matchLink(
  text: string,
  i: number,
  spans: ProtectedSpan[],
  inLink: boolean,
  asText = false,
): { markup: string; next: number } | null {
  const image = text[i] === '!';
  const open = i + (image ? 1 : 0);
  if (text[open] !== '[') {
    return null;
  }

  // Find the matching ] — one level of bracket nesting is honoured, and
  // brackets inside a PROTECTED span never count (a code span's brackets
  // are its literal content: `[a `]` b](/uri)` closes at the real one).
  // The spans are sorted by start, and j only moves forward — one cursor
  // skips their interiors in linear time.
  let depth = 1;
  let j = open + 1;
  let si = spans.findIndex((s) => s.end > open);
  if (si === -1) {
    si = spans.length;
  }
  while (j < text.length) {
    const span = spans[si];
    if (span && span.start <= j) {
      // j sits inside this span (its end is past j by the cursor's own
      // advance condition) — its bytes are literal, jump past them.
      j = span.end;
      while (si < spans.length && spans[si]!.end <= j) {
        si += 1;
      }
      continue;
    }
    if (text[j] === '\\' && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (text[j] === '[') {
      depth += 1;
    }
    if (text[j] === ']') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    j += 1;
  }
  if (depth !== 0) {
    return null;
  }

  const label = text.slice(open + 1, j);
  // The label's own protected spans, in label coordinates — code and
  // math inside a label are legal content, an autolink is not.
  const labelSpans: Array<{ start: number; end: number; kind: ProtectedSpan['kind'] }> = [];
  for (const span of spans) {
    if (span.start >= open + 1 && span.end <= j) {
      labelSpans.push({ start: span.start - open - 1, end: span.end - open - 1, kind: span.kind });
    }
  }

  // Links may not nest: a completed link construct inside the label (an
  // image does not count) means this bracket loses to the inner one. An
  // AUTOlink span in the label is the same verdict by construction — an
  // autolink IS a link, and the outer bracket must give way to it.
  if (
    !image &&
    (labelContainsLink(label, labelSpans) || labelSpans.some((s) => s.kind === 'autolink'))
  ) {
    return null;
  }

  let next = -1;
  let href: string | null = null;
  let title: string | null = null;

  // Inline destination: (url "title") — pointy destinations may carry
  // spaces; bare ones may not, but their parens may balance. Images keep
  // the right inside link labels (an image is not an anchor — the badge
  // shape `[![x](y)](z)` is a link whose content is an image); LINKS
  // lose it (links never nest) — except in the TEXT projection, where a
  // link inside an image label contributes its label text (spec#575) and
  // nothing is ever an anchor.
  if (text[j + 1] === '(' && (!inLink || image || asText)) {
    const inline = parseInlineDestination(text, j + 1);
    if (inline) {
      href = inline.dest === '' ? '' : safeHrefForMarkdown(decodeEntities(inline.dest));
      title = inline.title;
      next = inline.next;
    }
  }

  // Reference forms: full [label][ref] and collapsed [label][] — the
  // same image/text exemptions as the inline destination.
  if (href === null && text[j + 1] === '[') {
    const close = matchBracket(text, j + 1);
    if (close !== -1 && (!inLink || image || asText)) {
      const refText = text.slice(j + 2, close);
      const ref = linkRefs!.get(normalizeRefLabel(refText === '' ? label : refText));
      if (ref) {
        href = ref.href;
        title = ref.title;
        next = close + 1;
      }
    }
  }

  // Shortcut [label] — a definition anywhere in the document resolves it;
  // only when the closing bracket is NOT followed by '[' (the full-
  // reference form owns that, even when its reference is missing — a
  // failed inline '(' dest, though, falls through to the shortcut), and
  // never inside link labels (links never nest — images and text exempt).
  if (href === null && (!inLink || image || asText) && text[j + 1] !== '[') {
    const ref = linkRefs!.get(normalizeRefLabel(label));
    if (ref) {
      href = ref.href;
      title = ref.title;
      next = j + 1;
    }
  }

  if (href === null || next === -1) {
    return null;
  }

  if (image) {
    // A real <img> — GitHub parity: the picture is the point of the
    // syntax. The src passed the same safe-href gate the anchor hrefs
    // pass (javascript:/data: never got here — the construct stayed
    // literal text), the fetch rides lazy/async decoding with the
    // referrer stripped, and the alt text is the label's PLAIN-TEXT
    // projection (the reference's own rule: emphasis drops, nested
    // links and images contribute their label text, code spans their
    // interior — spec examples 573-589). Inside a link the image is the
    // link's content (the classic badge shape) — an image is not an
    // anchor, so no nesting rule fires.
    const titleAttr = title ? ` title="${escapeHtmlAttr(decodeEntities(title))}"` : '';
    if (asText) {
      return { markup: renderInline(label, true, true), next };
    }
    return {
      markup: `<img src="${escapeHtmlAttr(encodeHref(href))}" alt="${escapeHtmlAttr(renderInline(label, true, true))}"${titleAttr} loading="lazy" decoding="async" referrerpolicy="no-referrer">`,
      next,
    };
  }

  const titleAttr = title ? ` title="${escapeHtmlAttr(decodeEntities(title))}"` : '';
  if (asText) {
    return { markup: renderInline(label, true, true), next };
  }
  return {
    markup: `<a href="${escapeHtmlAttr(encodeHref(href))}"${titleAttr} rel="noopener noreferrer">${renderInline(label, true)}</a>`,
    next,
  };
}

/** A label-local protected span (see matchLink). */
type LabelSpan = { start: number; end: number; kind: ProtectedSpan['kind'] };

/**
 * True when the label hides a completed link construct — `[…](…)`,
 * `[…][…]`, `[…][]` or a shortcut whose definition exists. An escaped
 * bracket never opens one, and `![…](…)` is an image (images nest in
 * links; links do not). Brackets inside the label's protected spans are
 * literal content, not link syntax.
 */
function labelContainsLink(label: string, spans: LabelSpan[] = []): boolean {
  for (let k = 0; k < label.length; k += 1) {
    // Brackets inside a protected span are literal — a code span or a
    // math shell in the label does NOT nest a link (`[a `[b](c)` d](/uri)`
    // is one link with a code span inside it).
    const claimed = spans.find((s) => s.start <= k && k < s.end);
    if (claimed) {
      k = claimed.end - 1;
      continue;
    }
    if (label[k] === '\\') {
      k += 1;
      continue;
    }
    if (label[k] !== '[') {
      continue;
    }
    if (k > 0 && label[k - 1] === '!') {
      continue; // an image — images nest inside links
    }
    const close = matchBracket(label, k);
    if (close === -1) {
      continue;
    }
    const after = label[close + 1];
    if (after === '(' || after === '[') {
      return true;
    }
    if (linkRefs!.has(normalizeRefLabel(label.slice(k + 1, close)))) {
      return true;
    }
  }
  return false;
}

/** End of the balanced-bracket run opening at `open` (or -1). */
function matchBracket(text: string, open: number): number {
  let depth = 1;
  let j = open + 1;
  while (j < text.length) {
    if (text[j] === '\\' && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (text[j] === '[') {
      depth += 1;
    }
    if (text[j] === ']') {
      depth -= 1;
      if (depth === 0) {
        return j;
      }
    }
    j += 1;
  }
  return -1;
}

/**
 * `(dest "title")` after a link's closing bracket. The destination is
 * pointy (`<…>` — spaces allowed, no angle brackets inside) or bare (no
 * spaces, balanced parens, backslash-escaped characters honored); an
 * optional `"title"` / `'title'` / `(title)` may follow. An empty
 * destination is legal (`[a]()` — a self-link); whitespace separates the
 * parts and may carry line endings.
 */
function parseInlineDestination(
  text: string,
  open: number,
): { dest: string; title: string | null; next: number } | null {
  let k = open + 1;

  const skipSpace = (): void => {
    while (k < text.length && (text[k] === ' ' || text[k] === '\n' || text[k] === '\t')) {
      k += 1;
    }
  };

  skipSpace();
  let dest = '';
  if (text[k] === '<') {
    k += 1;
    while (k < text.length && text[k] !== '>') {
      const ch = text[k]!;
      if (ch === '\\' && k + 1 < text.length && ESCAPABLE.has(text[k + 1]!)) {
        dest += text[k + 1]!;
        k += 2;
        continue;
      }
      if (ch === '<' || ch === '\n') {
        return null;
      }
      dest += ch;
      k += 1;
    }
    if (text[k] !== '>') {
      return null;
    }
    k += 1;
  } else {
    let depth = 0;
    while (k < text.length) {
      const ch = text[k]!;
      if (ch === '\\' && k + 1 < text.length && ESCAPABLE.has(text[k + 1]!)) {
        dest += text[k + 1]!;
        k += 2;
        continue;
      }
      if (ch === ' ' || ch === '\n' || isControlChar(ch)) {
        break;
      }
      if (ch === '(') {
        depth += 1;
      }
      if (ch === ')') {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      dest += ch;
      k += 1;
    }
    if (depth !== 0) {
      return null; // unbalanced parens — not a destination
    }
  }

  skipSpace();
  let title: string | null = null;
  if (text[k] === '"' || text[k] === "'" || text[k] === '(') {
    const openChar = text[k]!;
    const closeChar = openChar === '(' ? ')' : openChar;
    k += 1;
    let scanned = '';
    let closed = false;
    while (k < text.length) {
      const ch = text[k]!;
      if (ch === '\\' && k + 1 < text.length && ESCAPABLE.has(text[k + 1]!)) {
        scanned += text[k + 1]!;
        k += 2;
        continue;
      }
      if (ch === closeChar) {
        closed = true;
        k += 1;
        break;
      }
      if (ch === openChar && closeChar === ')') {
        return null; // a (title) cannot nest parens
      }
      scanned += ch;
      k += 1;
    }
    if (!closed) {
      return null;
    }
    title = scanned;
    skipSpace();
  }

  if (text[k] !== ')') {
    return null;
  }
  return { dest, title, next: k + 1 };
}

/**
 * The href's URL escaping: everything outside CommonMark's safe set is
 * percent-encoded (backslashes, brackets, non-ASCII — as UTF-8 bytes), so
 * the attribute can never grow structure and foreign URLs stay valid.
 */
const HREF_SAFE = /[A-Za-z0-9\-_.+!*'(),%#@?=;:/,&$~]/;

function encodeHref(href: string): string {
  let out = '';
  for (let i = 0; i < href.length; i += 1) {
    const ch = href[i]!;
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(href.slice(i + 1, i + 3))) {
      out += ch; // an existing percent-escape stays bytes
      continue;
    }
    if (ch !== '%' && HREF_SAFE.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Autolinks
// ---------------------------------------------------------------------------

/**
 * An angle autolink — `<https://example.com>` or `<mail@example.com>`.
 * The scheme must be legal (letters, then letters/digits/+/-/.), the body
 * free of whitespace and angles; unsafe schemes die at the safe-href gate
 * and the whole thing stays literal text, exactly like an inline link.
 */
function matchAngleAutolink(text: string, i: number): { markup: string; next: number } | null {
  if (text[i] !== '<') {
    return null;
  }
  const close = text.indexOf('>', i + 1);
  if (close === -1) {
    return null;
  }
  const body = text.slice(i + 1, close);
  if (body === '' || /\s/.test(body) || body.includes('<')) {
    return null;
  }

  const email = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.exec(body);
  if (email) {
    const href = sanitizeHref(`mailto:${body}`);
    if (href === null) {
      return null;
    }
    return {
      markup: `<a href="${escapeHtmlAttr(encodeHref(href))}" rel="noopener noreferrer">${escapeHtml(body)}</a>`,
      next: close + 1,
    };
  }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):(.*)$/.exec(body);
  if (!scheme) {
    return null;
  }
  const href = sanitizeHref(body);
  if (href === null) {
    return null;
  }
  return {
    markup: `<a href="${escapeHtmlAttr(encodeHref(href))}" rel="noopener noreferrer">${escapeHtml(body)}</a>`,
    next: close + 1,
  };
}

/** The `[`-label depth before each position — one scan, shared by every autolink attempt. */
function bracketDepths(text: string): Int32Array {
  const depths = new Int32Array(text.length + 1);
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    depths[i] = depth;
    const ch = text[i]!;
    if (ch === '\\') {
      i += 1;
      depths[i] = depth;
      continue;
    }
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth = Math.max(0, depth - 1);
    }
  }
  depths[text.length] = depth;
  return depths;
}

/**
 * The literal autolinks — a faithful transcription of the reference
 * (micromark-extension-gfm-autolink-literal, itself a port of cmark-gfm's
 * autolink.c). Three shapes, three boundary rules, one shared domain/path
 * machinery:
 *
 *  • protocol (`https://…`) — the character before may be anything but an
 *    ASCII letter (`]https://x`, `5https://x` both link);
 *  • www (`www.…`) — the character before must be one the spec lists
 *    (document start, whitespace, `(`, `*`, `_`, `[`, `]`, `~`);
 *  • email — the character before may be anything but atext or `/`.
 *
 * The DOMAIN needs no dot (github/cmark-gfm#279 — GitHub documents one,
 * the implementation never enforces it), takes every character that is
 * neither whitespace nor Unicode punctuation (`-` explicitly allowed),
 * refuses an empty domain and an underscore touching either of the last
 * two segment boundaries, and ends before a punctuation run that trails.
 * The PATH runs to whitespace, `<`, or that same trailing-punctuation
 * rule (`!"')*,.:;<>?_~` + well-formed entity lookalikes + `]` followed
 * by `(`/`[`), counting parens so the link keeps its own balanced ones.
 */
const TRAIL_CHARS = new Set(['!', '"', "'", ')', '*', ',', '.', ':', ';', '?', '_', '~']);

/** Unicode punctuation and symbols — the domain/path stoppers (minus `-`). */
const UNICODE_PUNCT = /\p{P}|\p{S}/u;

function isUnicodePunct(ch: string): boolean {
  return UNICODE_PUNCT.test(ch);
}

function isWs(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/**
 * The trail check — true when the punctuation run opening at `p` reaches
 * the construct's end (whitespace, `<`, end of text), which makes the
 * whole run TRAILING (excluded from the link). `&…;` shapes count as
 * trailing only when well-formed; `]` continues the run unless `(`/`[`
 * or a boundary follows (the cmark-gfm#278 fix).
 */
function isTrailingPunctuationRun(text: string, p: number): boolean {
  for (;;) {
    const ch = text[p];
    if (ch === undefined || ch === '<' || isWs(ch)) {
      return true;
    }
    if (TRAIL_CHARS.has(ch)) {
      p += 1;
      continue;
    }
    if (ch === '&') {
      p += 1;
      if (!/[a-zA-Z]/.test(text[p] ?? '')) {
        return false;
      }
      while (/[a-zA-Z]/.test(text[p] ?? '')) {
        p += 1;
      }
      if (text[p] !== ';') {
        return false;
      }
      p += 1;
      continue;
    }
    if (ch === ']') {
      p += 1;
      const next = text[p];
      if (next === undefined || next === '(' || next === '[' || isWs(next)) {
        return true;
      }
      continue;
    }
    return false;
  }
}

/**
 * The domain scan: returns the end index (exclusive) of the domain, or -1
 * when the shape fails (nothing consumed, or an underscore touching the
 * last two segment boundaries). A `.`/`_` is consumed only when the trail
 * check says it is not trailing.
 */
function scanAutolinkDomain(text: string, at: number): number {
  let end = at;
  let seen = false;
  let underscoreInLastSegment: boolean | undefined;
  let underscoreInLastLastSegment: boolean | undefined;
  for (;;) {
    const ch = text[end];
    if (ch === '.' || ch === '_') {
      if (isTrailingPunctuationRun(text, end)) {
        break;
      }
      if (ch === '_') {
        underscoreInLastSegment = true;
      } else {
        underscoreInLastLastSegment = underscoreInLastSegment;
        underscoreInLastSegment = undefined;
      }
      end += 1;
      continue;
    }
    if (ch === undefined || ch === '<' || isWs(ch)) {
      break;
    }
    if (ch !== '-' && isUnicodePunct(ch)) {
      break;
    }
    seen = true;
    end += 1;
  }
  if (!seen || underscoreInLastSegment || underscoreInLastLastSegment) {
    return -1;
  }
  return end;
}

/**
 * The path scan: returns the end index (exclusive). Parens balance; a
 * trail-char whose run trails ends the path before it; every other
 * character (including `[`, `#`, `%`, other punctuation) is content.
 */
function scanAutolinkPath(text: string, at: number): number {
  let end = at;
  let sizeOpen = 0;
  let sizeClose = 0;
  for (;;) {
    const ch = text[end];
    if (ch === '(') {
      sizeOpen += 1;
      end += 1;
      continue;
    }
    if (ch === ')' && sizeClose < sizeOpen) {
      sizeClose += 1;
      end += 1;
      continue;
    }
    if (ch !== undefined && (ch === '&' || ch === ']' || ch === '<' || TRAIL_CHARS.has(ch))) {
      if (isTrailingPunctuationRun(text, end)) {
        break;
      }
      if (ch === ')') {
        sizeClose += 1;
      }
      end += 1;
      continue;
    }
    if (ch === undefined || ch === '<' || isWs(ch)) {
      break;
    }
    end += 1;
  }
  return end;
}

/**
 * The protocol autolink — `http(s)://domain/path`, allowed after anything
 * that is not an ASCII letter (digits and `]` included — the reference's
 * own boundary). The display keeps the source's case; the href passes the
 * safe-href gate on its way out.
 */
function matchProtocolAutolink(
  text: string,
  i: number,
  depths: Int32Array,
): { markup: string; next: number } | null {
  const prev = i > 0 ? text[i - 1]! : undefined;
  if (prev !== undefined && /[a-zA-Z]/.test(prev)) {
    return null;
  }
  if (depths[i] > 0) {
    return null; // the reference's previousUnbalanced veto
  }
  const scheme = /^https?:\/\//i.exec(text.slice(i, i + 8));
  if (!scheme) {
    return null;
  }
  const domainEnd = scanAutolinkDomain(text, i + scheme[0].length);
  if (domainEnd === -1) {
    return null;
  }
  const pathEnd = scanAutolinkPath(text, domainEnd);
  const display = text.slice(i, pathEnd);
  const href = sanitizeHref(display);
  if (href === null) {
    return null;
  }
  return {
    markup: `<a href="${escapeHtmlAttr(encodeHref(href))}" rel="noopener noreferrer">${escapeHtml(display)}</a>`,
    next: i + display.length,
  };
}

/** The www autolink — the spec's own boundary list guards the start. */
function matchWwwAutolink(
  text: string,
  i: number,
  depths: Int32Array,
): { markup: string; next: number } | null {
  if (depths[i] > 0) {
    return null; // the reference's previousUnbalanced veto
  }
  const prev = i > 0 ? text[i - 1]! : undefined;
  if (prev !== undefined && !/[\s*_[\]()~]/.test(prev)) {
    return null;
  }
  if (!/^www\./i.test(text.slice(i, i + 4))) {
    return null;
  }
  const domainEnd = scanAutolinkDomain(text, i + 4);
  if (domainEnd === -1) {
    return null;
  }
  const pathEnd = scanAutolinkPath(text, domainEnd);
  const display = text.slice(i, pathEnd);
  const href = sanitizeHref(`http://${display}`);
  if (href === null) {
    return null;
  }
  return {
    markup: `<a href="${escapeHtmlAttr(encodeHref(href))}" rel="noopener noreferrer">${escapeHtml(display)}</a>`,
    next: i + display.length,
  };
}

/**
 * The email autolink — atext, `@`, then the email domain: alphanumerics
 * with `-`/`_`, dots that are not trailing (a dot before a non-alphanumeric
 * ends the domain), valid only when it saw data, saw a dot, and ends on an
 * ASCII letter (cmark-gfm's verdict — `a@b.z1` is not an address).
 */
function matchEmailAutolink(
  text: string,
  i: number,
  depths: Int32Array,
): { markup: string; next: number } | null {
  if (depths[i] > 0) {
    return null; // the reference's previousUnbalanced veto
  }
  const prev = i > 0 ? text[i - 1]! : undefined;
  if (prev !== undefined && (/[A-Za-z0-9._+-]/.test(prev) || prev === '/')) {
    return null;
  }
  const ATEXT = /[A-Za-z0-9._+-]/;
  let at = i;
  while (at < text.length && ATEXT.test(text[at]!)) {
    at += 1;
  }
  if (at === i || text[at] !== '@') {
    return null;
  }
  let end = at + 1;
  let data = false;
  let dot = false;
  for (;;) {
    const ch = text[end];
    if (ch === '.') {
      if (!/[A-Za-z0-9]/.test(text[end + 1] ?? '')) {
        break; // trailing dot — excluded
      }
      dot = true;
      end += 1;
      continue;
    }
    if (ch !== undefined && (/[A-Za-z0-9]/.test(ch) || ch === '-' || ch === '_')) {
      data = true;
      end += 1;
      continue;
    }
    break;
  }
  const last = text[end - 1];
  if (!data || !dot || last === undefined || !/[a-zA-Z]/.test(last)) {
    return null;
  }
  const display = text.slice(i, end);
  const href = sanitizeHref(`mailto:${display}`);
  if (href === null) {
    return null;
  }
  return {
    markup: `<a href="${escapeHtmlAttr(encodeHref(href))}" rel="noopener noreferrer">${escapeHtml(display)}</a>`,
    next: i + display.length,
  };
}

/** The literal-autolink dispatcher — each shape guards its own boundary. */
function matchLiteralAutolink(
  text: string,
  i: number,
  depths: Int32Array,
): { markup: string; next: number } | null {
  const ch = text[i]!.toLowerCase();
  if (ch === 'h') {
    return matchProtocolAutolink(text, i, depths);
  }
  if (ch === 'w') {
    return matchWwwAutolink(text, i, depths);
  }
  return matchEmailAutolink(text, i, depths);
}

// ---------------------------------------------------------------------------
// Inline raw HTML — the grammar, verbatim-escaped
// ---------------------------------------------------------------------------

/**
 * The inline raw-HTML matcher — the reference tokenizer's own grammar
 * (micromark's htmlText, a transcription of CommonMark's "Raw HTML"
 * section): a matched shape consumes its bytes whole, whatever they hold
 * (an autolink-shaped URL inside a tag's attribute stays tag bytes). The
 * caller escapes the span verbatim, so the grammar decides only WHAT the
 * span is — never whether it is safe.
 *
 * Returns the index just past the shape, or -1 when nothing matches.
 */
export function matchRawHtml(text: string, at: number): number {
  const p = at + 1;
  const ch = text[p];
  if (ch === undefined) {
    return -1;
  }
  if (ch === '!') {
    return matchHtmlBang(text, p + 1);
  }
  if (ch === '?') {
    // A processing instruction: `<?` … `?>`.
    const close = text.indexOf('?>', p + 1);
    return close === -1 ? -1 : close + 2;
  }
  if (ch === '/') {
    // A closing tag: name, optional whitespace, `>`.
    let k = p + 1;
    if (!isAsciiAlpha(text[k])) {
      return -1;
    }
    k = scanHtmlTagName(text, k);
    k = skipHtmlWs(text, k);
    return text[k] === '>' ? k + 1 : -1;
  }
  if (isAsciiAlpha(ch)) {
    return matchHtmlOpenTag(text, p);
  }
  return -1;
}

/** After `<!`: a comment (`<!--…-->`), CDATA, or a declaration. */
function matchHtmlBang(text: string, at: number): number {
  if (text.startsWith('[CDATA[', at)) {
    const close = text.indexOf(']]>', at + 7);
    return close === -1 ? -1 : close + 3;
  }
  if (text[at] === '-' && text[at + 1] === '-') {
    // The spec's two EMPTY comments close the shape themselves: `<!-->`
    // and `<!--->` (CommonMark's own grammar — anything longer runs the
    // comment FSM).
    if (text[at + 2] === '>') {
      return at + 3;
    }
    if (text[at + 2] === '-' && text[at + 3] === '>') {
      return at + 4;
    }
    // The comment FSM: `--` runs close only in even pairs, `>` right
    // after an even pair — `<!--a--->` keeps going, `<!--a-->` ends.
    let k = at + 2;
    let state: 'comment' | 'close' | 'end' = 'end';
    while (k < text.length) {
      const ch = text[k]!;
      if (state === 'end') {
        if (ch === '>') {
          return k + 1;
        }
        state = ch === '-' ? 'close' : 'comment';
      } else if (state === 'close') {
        state = ch === '-' ? 'end' : 'comment';
      } else {
        state = ch === '-' ? 'close' : 'comment';
      }
      k += 1;
    }
    return -1;
  }
  // A declaration: `<!` + letters, anything but `>`, then `>`.
  let k = at;
  while (isAsciiAlpha(text[k])) {
    k += 1;
  }
  if (k === at) {
    return -1;
  }
  const close = text.indexOf('>', k);
  return close === -1 ? -1 : close + 1;
}

/** An opening tag: name, attributes (quoted / unquoted), optional `/`, `>`. */
function matchHtmlOpenTag(text: string, at: number): number {
  let k = scanHtmlTagName(text, at);
  for (;;) {
    const before = k;
    k = skipHtmlWs(text, k);
    if (text[k] === '/') {
      k += 1;
      return text[k] === '>' ? k + 1 : -1;
    }
    if (text[k] === '>') {
      return k + 1;
    }
    if (k === before && k === at) {
      return -1; // nothing after the name at all
    }
    // An attribute: name, optional `=` + value.
    if (!isHtmlAttrNameStart(text[k])) {
      return -1;
    }
    k = scanHtmlAttrName(text, k);
    const afterName = k;
    const ws = skipHtmlWs(text, k);
    if (text[ws] === '=') {
      k = matchHtmlAttrValue(text, ws + 1);
      if (k === -1) {
        return -1;
      }
    } else {
      k = afterName;
    }
  }
}

/** Scans a tag name (letters, digits, `-`) from `at`; `at` holds a letter. */
function scanHtmlTagName(text: string, at: number): number {
  let k = at + 1;
  while (/[A-Za-z0-9-]/.test(text[k] ?? '')) {
    k += 1;
  }
  return k;
}

/** Attribute-name start: letter, `:`, `_`. */
function isHtmlAttrNameStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z:_]/.test(ch);
}

/** Scans an attribute name (letters, digits, `-`, `.`, `:`, `_`). */
function scanHtmlAttrName(text: string, at: number): number {
  let k = at + 1;
  while (/[A-Za-z0-9-.:_]/.test(text[k] ?? '')) {
    k += 1;
  }
  return k;
}

/** An attribute value after `=` — quoted or unquoted. -1 when malformed. */
function matchHtmlAttrValue(text: string, at: number): number {
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    let k = at + 1;
    while (k < text.length && text[k] !== quote) {
      k += 1;
    }
    return k < text.length ? k + 1 : -1;
  }
  if (quote === undefined || /[\s<=>`]/.test(quote)) {
    return -1;
  }
  let k = at;
  while (k < text.length && !/[\s<=>`]/.test(text[k]!)) {
    k += 1;
  }
  return k;
}

/** Whitespace inside a tag: spaces, tabs, and the newlines a tag may span. */
function skipHtmlWs(text: string, at: number): number {
  let k = at;
  while (k < text.length && /[ \t\n]/.test(text[k]!)) {
    k += 1;
  }
  return k;
}

function isAsciiAlpha(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}

// ---------------------------------------------------------------------------
// Emphasis — the CommonMark algorithm
// ---------------------------------------------------------------------------

/**
 * Pairs delimiter runs into emphasis tags — the reference implementation's
 * process_emphasis, ported: walking left to right, a closer searches back
 * for the nearest compatible opener (same character, can-open, not barred
 * by the rule of 3: when either side is both-opener-and-closer, a combined
 * length divisible by 3 refuses to pair unless both are). Two characters
 * on both sides give `<b>`, one gives `<i>`; `~~`/`~` pair equal runs into
 * `<s>`. Everything between an opener and its closer leaves the stack
 * when they pair, unmatched runs stay literal, and leftovers sit beside
 * the emphasis they helped open or close. The openers-bottom map (keyed by
 * character, original length mod 3, can-open) bounds the backward search —
 * the algorithm's own guard against quadratic rescans.
 */
function pairDelimiters(tokens: InlineToken[], asText = false): void {
  type Delim = Extract<InlineToken, { kind: 'delimiter' }>;
  const stack: Delim[] = [];
  /** key → the walk-order bound future searches must not go below. */
  const bottoms = new Map<string, number>();
  /** A close tag joins the close group's end (innermost pair first). */
  const addCloseTag = (token: Delim, tag: string): void => {
    token.tags.splice(token.openStart, 0, asText ? '' : tag);
    token.openStart += 1;
  };
  /** An open tag joins the open group's front (outermost pair first). */
  const addOpenTag = (token: Delim, tag: string): void => {
    token.tags.splice(token.openStart, 0, asText ? '' : tag);
  };

  for (const token of tokens) {
    if (token.kind !== 'delimiter') {
      continue;
    }
    const closer = token;

    while (closer.canClose && closer.run > 0) {
      const key = `${closer.char}|${closer.origin % 3}|${closer.canOpen ? 'o' : 'n'}`;
      const bottom = bottoms.get(key);
      let opener: Delim | null = null;
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        const candidate = stack[s]!;
        if (bottom !== undefined && candidate.seq <= bottom) {
          break;
        }
        if (candidate.char !== closer.char || !candidate.canOpen || candidate.run === 0) {
          continue;
        }
        if (closer.char !== '~') {
          const oddMatch =
            (candidate.canClose || closer.canOpen) &&
            (candidate.origin + closer.origin) % 3 === 0 &&
            !(candidate.origin % 3 === 0 && closer.origin % 3 === 0);
          if (oddMatch) {
            continue;
          }
        } else if (candidate.run !== closer.run) {
          continue; // strikethrough pairs equal runs (one or two tildes)
        }
        opener = candidate;
        break;
      }

      if (opener === null) {
        bottoms.set(key, closer.seq - 1);
        break;
      }

      if (closer.char === '~') {
        addOpenTag(opener, '<s>');
        addCloseTag(closer, '</s>');
        opener.run = 0;
        closer.run = 0;
      } else {
        const strong = closer.run >= 2 && opener.run >= 2;
        const use = strong ? 2 : 1;
        const [openTag, closeTag] = strong ? ['<b>', '</b>'] : ['<i>', '</i>'];
        addOpenTag(opener, openTag);
        addCloseTag(closer, closeTag);
        opener.run -= use;
        closer.run -= use;
      }

      // Delimiters between opener and closer leave the stack.
      const openerIndex = stack.indexOf(opener);
      stack.length = openerIndex;
      if (opener.run > 0) {
        stack.push(opener);
      }
    }

    if (closer.run > 0 && closer.canOpen) {
      stack.push(closer);
    }
  }

  // Leftovers fold BETWEEN the groups, on the side the reference puts
  // them: cmark trims an opener's inl_text from its content-facing end,
  // so the surviving literal sits after any close tags and before the
  // opening ones (`***foo**` is `*<strong>foo</strong>`, `**foo***` is
  // `<strong>foo</strong>*`, and a run that closed then opened renders
  // close-tag, leftover, open-tag).
  for (const token of tokens) {
    if (token.kind === 'delimiter' && token.run > 0 && token.tags.length > 0) {
      const literal = asText
        ? decodeEntities(token.char.repeat(token.run))
        : escapeHtml(decodeEntities(token.char.repeat(token.run)));
      token.run = 0;
      token.tags.splice(token.openStart, 0, literal);
    }
  }
}

// ---------------------------------------------------------------------------
// Link reference definitions — the grammar
// ---------------------------------------------------------------------------

/**
 * Parses one link reference definition starting at paragraph line `start`:
 *
 *   [label]: destination "optional title"
 *
 * The label may not contain unescaped brackets and may span lines; the
 * destination is pointy (`<…>`) or bare (no spaces, balanced parens); the
 * title takes `"…"`, `'…'` or `(…)` and may span lines. Between the parts
 * whitespace may carry one line ending. A title that starts on the
 * DESTINATION'S line and then fails (junk after it, or it never closes)
 * fails the whole definition; a title that starts on its OWN line fails
 * only itself — the definition stands without it and the title line
 * becomes paragraph text (the spec's `[foo]: /url` + `"title" ok`
 * reading). A definition always consumes whole lines; `next` is the index
 * of the first unconsumed one.
 */
function parseLinkRefDef(
  lines: string[],
  start: number,
): { label: string; dest: string; title: string | null; next: number } | null {
  let index = start;
  let text = stripIndent(lines[index]!, 3);
  let cursor = 0;

  const atEnd = (): boolean => cursor >= text.length;
  const advanceLine = (): boolean => {
    index += 1;
    if (index >= lines.length) {
      return false;
    }
    text = lines[index]!;
    cursor = 0;
    return true;
  };

  if (text[cursor] !== '[') {
    return null;
  }
  cursor += 1;
  let label = '';
  for (;;) {
    if (cursor >= text.length) {
      // The label may span lines — the newlines fold away in matching.
      if (!advanceLine()) {
        return null;
      }
      label += '\n';
      continue;
    }
    const ch = text[cursor]!;
    if (ch === '\\' && cursor + 1 < text.length) {
      label += ch + text[cursor + 1]!;
      cursor += 2;
      continue;
    }
    if (ch === '[') {
      return null; // unescaped nested [ — a definition label cannot hold one
    }
    if (ch === ']') {
      break;
    }
    label += ch;
    cursor += 1;
  }
  if (text[cursor] !== ']' || text[cursor + 1] !== ':') {
    return null;
  }
  cursor += 2;

  // Whitespace — possibly one line ending — then the destination.
  let newlines = 0;
  for (;;) {
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
      cursor += 1;
    }
    if (!atEnd()) {
      break;
    }
    if (newlines > 0) {
      return null; // a blank line broke the definition
    }
    if (!advanceLine()) {
      // `[foo]:` with nothing after is a paragraph — the reference's
      // definition always needs its destination line, even for an empty
      // destination (`[foo]:\n` is text; `[foo]:\nbar` defines `bar`).
      return null;
    }
    newlines += 1;
  }
  const destLine = index;

  let dest = '';
  if (text[cursor] === '<') {
    cursor += 1;
    while (cursor < text.length && text[cursor] !== '>') {
      const ch = text[cursor]!;
      if (ch === '\\' && cursor + 1 < text.length && ESCAPABLE.has(text[cursor + 1]!)) {
        dest += text[cursor + 1]!;
        cursor += 2;
        continue;
      }
      if (ch === '<' || ch === ' ') {
        return null;
      }
      dest += ch;
      cursor += 1;
    }
    if (text[cursor] !== '>') {
      return null;
    }
    cursor += 1;
  } else {
    let depth = 0;
    while (cursor < text.length) {
      const ch = text[cursor]!;
      if (ch === '\\' && cursor + 1 < text.length && ESCAPABLE.has(text[cursor + 1]!)) {
        dest += text[cursor + 1]!;
        cursor += 2;
        continue;
      }
      if (ch === ' ' || isControlChar(ch)) {
        break;
      }
      if (ch === '(') {
        depth += 1;
      }
      if (ch === ')') {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      dest += ch;
      cursor += 1;
    }
    if (depth !== 0) {
      return null; // unbalanced parens — not a destination
    }
  }

  // Optional title, on the destination's line or the next one (one line
  // ending in the gap); after the title, the line must be blank.
  let sawEnding = false;
  for (;;) {
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
      cursor += 1;
    }
    if (!atEnd()) {
      break;
    }
    if (sawEnding || !advanceLine()) {
      break; // no title — the definition stands
    }
    sawEnding = true;
  }

  let title: string | null = null;
  if (!atEnd() && (text[cursor] === '"' || text[cursor] === "'" || text[cursor] === '(')) {
    const titleLine = index;
    const onDestLine = titleLine === destLine;
    const openChar = text[cursor]!;
    const closeChar = openChar === '(' ? ')' : openChar;
    cursor += 1;
    let scanned = '';
    let closed = false;
    while (cursor < text.length || index + 1 < lines.length) {
      if (cursor >= text.length) {
        if (!advanceLine()) {
          break;
        }
        scanned += '\n';
        continue;
      }
      const ch = text[cursor]!;
      if (ch === '\\' && cursor + 1 < text.length && ESCAPABLE.has(text[cursor + 1]!)) {
        scanned += text[cursor + 1]!;
        cursor += 2;
        continue;
      }
      if (ch === closeChar) {
        closed = true;
        cursor += 1;
        break;
      }
      if (ch === openChar && closeChar === ')') {
        break; // a (title) cannot nest parens
      }
      scanned += ch;
      cursor += 1;
    }
    if (closed) {
      while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
        cursor += 1;
      }
      if (atEnd()) {
        title = scanned;
      }
    }
    if (title === null) {
      if (onDestLine) {
        return null; // the whole definition fails
      }
      index = titleLine; // rewind — the title line becomes paragraph text
    }
  } else if (!atEnd() && index === destLine) {
    // Non-title text after the destination, on its own line: the
    // definition fails. Text on a LATER line is not this definition's
    // business (it ended at its own line's end).
    return null;
  }

  // The definition consumes through the title's last line when it has
  // one, through the destination's line when it does not — the lines the
  // title search merely LOOKED at stay for the caller (later definitions
  // among them).
  const next = title !== null ? index + 1 : destLine + 1;
  return { label, dest, title, next };
}

// ---------------------------------------------------------------------------
// HTML entities
// ---------------------------------------------------------------------------

/**
 * The HTML5 numeric reference map for the codes HTML5 does not render as
 * themselves — C1 controls are windows-1252 glyphs, 0 and the unprintables
 * are U+FFFD, CR stays CR. (HTML5's tokenizer rules; CommonMark defers.)
 */
const NUMERIC_REF_REMAP = new Map<number, number>([
  [0x00, 0xfffd],
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
  [0x0d, 0x0d],
]);

function numericRefChar(code: number): string {
  if (code === 0) {
    return '\ufffd';
  }
  const remap = NUMERIC_REF_REMAP.get(code);
  if (remap !== undefined) {
    return String.fromCodePoint(remap);
  }
  if (
    (code >= 0x01 && code <= 0x08) ||
    code === 0x0b ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return '\ufffd';
  }
  return String.fromCodePoint(code);
}

/**
 * `&name;` / `&#digits;` / `&#xhex;` — the CommonMark entity pass. Only
 * semicolon-terminated references decode (the WHATWG table is generated
 * semicolon-only), numeric references cap at seven digits the way the
 * reference tokenizer reads them; everything else stays the text it is,
 * and a decoded value re-hits escapeHtml downstream as its literal self.
 */
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]{1,7}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{0,31});/g;

function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(ENTITY_PATTERN, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isNaN(code)) {
        return entity;
      }
      return numericRefChar(code);
    }
    return NAMED_ENTITIES[body] ?? entity;
  });
}
