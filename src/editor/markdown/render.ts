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
 * SECURITY MODEL. Raw HTML in the source is NOT rendered — it is escaped
 * and shown as text, exactly like the app's sanitizer strips unknown tags
 * from rich notes: the note is data, never markup. Every literal character
 * passes through escapeHtml at emission; the only tags in the output are
 * the ones this file writes; the only attributes are hrefs that passed the
 * storage subset's SAFE_HREF gate (javascript:/data: URLs render as their
 * literal text). There are no images: a remote image URL would make the
 * note phone home on every preview, and `![alt](url)` renders as a plain
 * link with the alt text instead — the same trade the sanitizer makes when
 * it strips `img` from rich notes. The renderer is pure (string in, string
 * out) and DOM-free, so it runs identically in the app, in jsdom tests and
 * in any future server-side consumer.
 *
 * THE SUBSET (deliberate, documented — CommonMark where it is cheap, GFM
 * where notes use it, and honest literals everywhere else):
 *   blocks   ATX + setext headings · thematic breaks · fenced code blocks
 *            (``` and ~~, info string kept as a class) · blockquotes
 *            (nested, lazy paragraphs) · ordered/unordered lists (nesting
 *            by indentation, tight vs loose, `start` numbers) · task list
 *            items · GFM tables · GFM footnotes (definitions collected at
 *            their own lines, references numbered in first-use order, the
 *            section appended after the body) · paragraphs
 *   inline   code spans · **bold** · *italic* · ~~strike~~ (simplified
 *            CommonMark flanking: no intraword `_`, whitespace edges never
 *            open or close) · [links](url) with the safe-href gate ·
 *            footnote references `[^label]` (only when a definition
 *            matches — otherwise literal brackets, a half-written
 *            note's shape) · images as links · backslash escapes · hard
 *            breaks (two trailing spaces or a trailing backslash) · math
 *   math     `$…$` and `\(…\)` render inline, `$$…$$` on its own lines
 *            renders as a block — all three become the same `padify-math`
 *            shells the rich editor stores, so the preview reuses
 *            editor/math.ts's renderMathIn (KaTeX, forbidden-macro gate and
 *            all). `$` that does not delimit math (currency) stays a
 *            dollar: the inner edges of `$…$` must touch non-space
 *            characters.
 *   literal  indented code blocks (fences only — the 4-space form fights
 *            the list continuation rules) · reference links · autolinks ·
 *            HTML entities (`&copy;` shows as typed) · raw HTML
 */

import { escapeHtml, escapeHtmlAttr } from '../../lib/escape';
import { buildMathShell } from '../math-shell';
import { sanitizeHref } from '../storage-subset';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Renders Markdown source to the preview HTML. Pure: no DOM, no state, no
 * side effects — the caller hands the result to the preview pane's
 * innerHTML (then renderMathIn, for the math shells this emits).
 */
export function renderMarkdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  footnotes = scanFootnotes(lines);
  try {
    const out = renderBlocks(lines);
    const section = footnoteSection();
    if (section) {
      out.push(section);
    }
    return out.join('\n');
  } finally {
    footnotes = null;
  }
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
 *   numbers   label → footnote number, assigned in reference order as the
 *             refs render (GFM numbers by first reference, not by label)
 *   texts     label → raw definition text, collected by the block walk
 *             (continuation lines folded in, inline syntax UNRESOLVED — the
 *             section renders it through the same renderInline as body text)
 */
type FootnoteState = {
  labels: Set<string>;
  numbers: Map<string, number>;
  texts: Map<string, string>;
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
  return { labels: active, numbers: new Map(), texts: new Map() };
}

/** The definitions section — `<hr>` + ordered list, GFM's shape. */
function footnoteSection(): string | null {
  const state = footnotes;
  if (!state || state.numbers.size === 0) {
    return null;
  }
  const ordered = [...state.numbers.entries()].sort((a, b) => a[1] - b[1]);
  const items = ordered
    .map(
      ([label, number]) =>
        `<li id="md-fn-${number}" class="md-footnote-item">${renderInline(state.texts.get(label) ?? '')}</li>`,
    )
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
      text.push(stripColumns(line, 4));
      index += 1;
      continue;
    }
    // Lazy continuation: plain text that starts no new block extends the
    // definition — the same predicate the blockquote honors.
    if (
      !FENCE_OPEN.test(line) &&
      !ATX_HEADING.test(line) &&
      !THEMATIC_BREAK.test(line) &&
      !BLOCKQUOTE_MARKER.test(line) &&
      !isListItemStart(line) &&
      !FOOTNOTE_DEF.test(line) &&
      !line.trimStart().startsWith('$$')
    ) {
      text.push(line.trim());
      index += 1;
      continue;
    }
    break;
  }

  if (!state.texts.has(label)) {
    state.texts.set(label, text.join('\n').trim());
  }
  return { next: index };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Blank line (only spaces/tabs). */
function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** Leading whitespace width — a tab counts as 4 columns (CommonMark). */
function indentWidth(line: string): number {
  const leading = /^[ \t]*/.exec(line)![0];
  let width = 0;
  for (const ch of leading) {
    width += ch === '\t' ? 4 : 1;
  }
  return width;
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_HEADING = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT_SOLID = /^[ \t]{0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^[ \t]{0,3}((?:[ \t]*\*){3,}|(?:[ \t]*-){3,}|(?:[ \t]*_){3,})[ \t]*$/;
const BLOCKQUOTE_MARKER = /^[ \t]{0,3}>[ \t]?/;
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
 * `depth` guards that recursion: deeply indented outlines (Workflowy or
 * Obsidian exports, machine-generated TOCs) used to hit superlinear cost
 * — depth × remaining-lines × per-level slicing ≈ O(N³), measured at
 * 7 s of main-thread block for a 900-deep document. Past the cap the
 * nested markers degrade to plain paragraph text (content preserved,
 * structure flattened) instead of freezing the page.
 */
const MAX_NESTING_DEPTH = 50;

function renderBlocks(lines: string[], depth = 0): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index]!;

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
        out.push(display.markup);
        index = display.next;
        continue;
      }
    }

    // Fenced code blocks — they can interrupt a paragraph (CommonMark).
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushParagraph();
      const { markup, next } = collectFence(lines, index, fence[1]!);
      out.push(markup);
      index = next;
      continue;
    }

    // ATX headings — also paragraph-interrupting.
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      flushParagraph();
      // The trailing `#` run of a closing ATX heading is decoration.
      const text = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      out.push(`<h${atx[1]!.length}>${renderInline(text)}</h${atx[1]!.length}>`);
      index += 1;
      continue;
    }

    // Setext underlines only mean something under a paragraph; with no
    // paragraph open, `---` is a thematic break (probed further below).
    if (paragraph.length > 0 && SETEXT_SOLID.test(line)) {
      const level = line.trimStart().startsWith('=') ? 1 : 2;
      out.push(`<h${level}>${renderInline(paragraph.join('\n'))}</h${level}>`);
      paragraph = [];
      index += 1;
      continue;
    }

    // Thematic break before footnote definition: `[^x]` cannot be a break.
    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      out.push('<hr>');
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
      const { markup, next } = collectBlockquote(lines, index, depth);
      out.push(markup);
      index = next;
      continue;
    }

    // Tables cannot interrupt a paragraph (GFM): the header row must be
    // fresh, so they are only probed while the paragraph buffer is empty.
    if (paragraph.length === 0) {
      const table = collectTable(lines, index);
      if (table) {
        out.push(table.markup);
        index = table.next;
        continue;
      }
    }

    // Lists — a marker line starts one whether or not a paragraph is open
    // (CommonMark lets lists interrupt paragraphs; the text simply ends
    // the moment the marker appears). At the depth cap the marker degrades
    // to paragraph text — see MAX_NESTING_DEPTH.
    if (isListItemStart(line) && depth < MAX_NESTING_DEPTH) {
      flushParagraph();
      const { markup, next } = collectList(lines, index, depth);
      out.push(markup);
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
      if (/\$\$\s*$/.test(lines[look]!)) {
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
    .replace(/^\s*\$\$/, '')
    .replace(/\$\$\s*$/, '')
    .trim();
  if (latex === '') {
    return null;
  }
  return { markup: `<div class="md-math-block">${buildMathShell(latex)}</div>`, next: end + 1 };
}

/** Consumes a fenced code block; returns its markup and the next index. */
function collectFence(
  lines: string[],
  start: number,
  fenceRun: string,
): { markup: string; next: number } {
  const fenceChar = fenceRun[0]!;
  const info = FENCE_OPEN.exec(lines[start]!)![2]!.trim();
  const body: string[] = [];
  let index = start + 1;

  while (index < lines.length) {
    const closing = FENCE_CLOSE.exec(lines[index]!);
    if (closing && closing[1]![0] === fenceChar && closing[1]!.length >= fenceRun.length) {
      index += 1;
      break;
    }
    body.push(lines[index]!);
    index += 1;
  }

  // The info string becomes a language-* class — no highlighter rides the
  // preview, but the class names the language for styling and copy-paste.
  const lang = /^[A-Za-z0-9_-]+$/.test(info) ? ` class="language-${info}"` : '';
  return { markup: `<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`, next: index };
}

/** Consumes a blockquote (markers + lazy continuation); recurses inside. */
function collectBlockquote(
  lines: string[],
  start: number,
  depth: number,
): { markup: string; next: number } {
  const inner: string[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    if (BLOCKQUOTE_MARKER.test(line)) {
      inner.push(line.replace(BLOCKQUOTE_MARKER, ''));
      index += 1;
      continue;
    }
    // Lazy continuation: a non-blank line that starts nothing new extends
    // the quote's open paragraph.
    if (
      inner.length > 0 &&
      !isBlank(line) &&
      !FENCE_OPEN.test(line) &&
      !ATX_HEADING.test(line) &&
      !THEMATIC_BREAK.test(line) &&
      !BLOCKQUOTE_MARKER.test(line) &&
      !isListItemStart(line)
    ) {
      inner.push(line);
      index += 1;
      continue;
    }
    break;
  }

  return {
    markup: `<blockquote>${renderBlocks(inner, depth + 1).join('\n')}</blockquote>`,
    next: index,
  };
}

/** True when the line opens a list item (any indent, either marker form). */
function isListItemStart(line: string): boolean {
  if (indentWidth(line) >= 4) {
    // Deep indentation is content, not a new block (nested structures
    // carry their own indent relative to their parent — this probe runs
    // at the top of a block scope).
    return false;
  }
  const stripped = line.replace(/^[ \t]+/, '');
  return LIST_BULLET.test(stripped) || LIST_ORDERED.test(stripped);
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
  const stripped = line.replace(/^[ \t]+/, '');
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
 * Consumes one list (sibling items at a shared base indent). Lines indented
 * past an item's marker become that item's CONTENT — the recursive
 * renderBlocks call inside renderList is what turns them into nested
 * lists, paragraphs and everything else an item can hold.
 */
function collectList(
  lines: string[],
  start: number,
  depth: number,
): { markup: string; next: number } {
  const baseIndent = indentWidth(lines[start]!);
  const items: ListItem[] = [];
  let loose = false;
  let pendingBlank = false;
  let index = start;
  // This list's marker kind (from its first line) — siblings of another
  // kind belong to the NEXT list, not this one.
  const listKind = listMarkerKind(lines[start]!);

  const contentIndent = (): number => items[items.length - 1]?.contentIndent ?? 0;

  while (index < lines.length) {
    const line = lines[index]!;
    // The indent is this loop's hottest value (the blank check, the
    // sibling check and the content check all read it) — compute it once
    // per line. On pathological documents (deep indent ladders) the
    // repeated regex scans were the difference between interactive time
    // and a multi-second freeze.
    const lineIndent = indentWidth(line);

    if (isBlank(line)) {
      // A blank ends the list unless the next content line still belongs
      // to it (a sibling marker OF THE SAME KIND, or content indented
      // past the marker — a changed marker kind starts a new list).
      const look = index + 1;
      if (look < lines.length && !isBlank(lines[look]!)) {
        const nextLine = lines[look]!;
        const nextIsContent =
          indentWidth(nextLine) >= contentIndent() ||
          (isListItemStart(nextLine) &&
            indentWidth(nextLine) >= baseIndent &&
            listMarkerKind(nextLine) === listKind);
        if (nextIsContent) {
          pendingBlank = true;
          index += 1;
          continue;
        }
      }
      break;
    }

    if (lineIndent < baseIndent && isListItemStart(line)) {
      break; // a shallower marker belongs to an enclosing list
    }

    // A sibling lives inside the list's indent band — a line deeper than
    // the band is content, never a sibling, and the marker match below
    // (a regex run plus a line copy) is pure waste for it. Gate it.
    const item = lineIndent < baseIndent + 4 ? matchListItem(line) : null;
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
      index += 1;
      continue;
    }

    // Anything else is content of the current item: indented at least
    // past its marker, or a lazy paragraph continuation of it.
    const current = items[items.length - 1];
    if (current && (lineIndent >= contentIndent() || (!pendingBlank && !isListItemStart(line)))) {
      if (pendingBlank) {
        loose = true;
        pendingBlank = false;
      }
      current.content.push(stripColumns(line, contentIndent()));
      index += 1;
      continue;
    }
    break;
  }

  return { markup: renderList(items, loose, depth), next: index };
}

/** Matches a single item line into its shell shape (or null). */
function matchListItem(line: string): ListItem | null {
  const indent = indentWidth(line);
  const stripped = line.replace(/^[ \t]+/, '');
  const bullet = LIST_BULLET.exec(stripped);
  const ordered = LIST_ORDERED.exec(stripped);
  const match = bullet ?? ordered;
  if (!match) {
    return null;
  }

  // Marker width = symbol + the whitespace after it (an absent space
  // counts as one so `-` and `- ` share a content column; spaces beyond
  // four collapse — the simplified rule, documented above).
  const symbol = bullet ? bullet[1]! : `${ordered![1]!}${ordered![2]!}`;
  const spacesMatch = bullet ? bullet[2] : ordered![3];
  const spaceColumns = spacesMatch ? Math.min(spacesMatch.replace(/\t/g, '    ').length, 4) : 0;
  const contentIndent = indent + symbol.length + Math.max(spaceColumns, 1);

  let body = stripped.slice(symbol.length + (spacesMatch ? spacesMatch.length : 0));
  let task: ListItem['task'] = null;
  const taskMatch = TASK_MARKER.exec(body);
  if (taskMatch) {
    task = taskMatch[1] === ' ' ? 'unchecked' : 'checked';
    body = body.slice(taskMatch[0].length);
  }

  return {
    content: body.trim() === '' ? [] : [body],
    number: ordered ? Number(ordered[1]) : null,
    task,
    contentIndent,
  };
}

/** Removes `columns` columns of leading whitespace (a tab = 4 columns). */
function stripColumns(line: string, columns: number): string {
  let remaining = columns;
  let cut = 0;
  for (const ch of line) {
    if (remaining <= 0) {
      break;
    }
    const width = ch === '\t' ? 4 : ch === ' ' ? 1 : 0;
    if (width === 0 || width > remaining) {
      break;
    }
    remaining -= width;
    cut += 1;
  }
  return line.slice(cut);
}

/** Renders the collected items as `<ul>`/`<ol>` markup. */
function renderList(items: ListItem[], loose: boolean, depth: number): string {
  if (items.length === 0) {
    return '';
  }
  const ordered = items[0]!.number !== null;
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && items[0]!.number !== 1 ? ` start="${items[0]!.number}"` : '';

  const rendered = items
    .map((item) => {
      let blocks = renderBlocks(item.content, depth + 1);
      // Tight lists unwrap the item's first paragraph (CommonMark), even
      // when further blocks follow it; loose lists keep every wrapper.
      if (!loose && blocks.length > 0 && blocks[0]!.startsWith('<p>')) {
        blocks = [blocks[0]!.replace(/^<p>([\s\S]*)<\/p>$/, '$1'), ...blocks.slice(1)];
      }
      let inner = blocks.join('\n');

      if (item.task !== null) {
        const checked = item.task === 'checked' ? ' checked' : '';
        inner = `<input type="checkbox" disabled${checked}> ${inner}`;
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
const DELIMITER_CELL = /^:?-{1,}:?$/;

/**
 * Consumes a GFM table starting at `start` (header row). Null when the
 * shape is not a table — the caller falls through to paragraph text.
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

  const bodyRows: string[] = [];
  let index = start + 2;
  while (index < lines.length && !isBlank(lines[index]!) && lines[index]!.includes('|')) {
    const cells = splitTableRow(lines[index]!);
    bodyRows.push(
      cells
        .slice(0, headerCells.length)
        .map((cell, cellIndex) => `<td${align(cellIndex)}>${renderInline(cell)}</td>`)
        .join(''),
    );
    index += 1;
  }

  const body =
    bodyRows.length > 0
      ? `\n<tbody>${bodyRows.map((row) => `<tr>${row}</tr>`).join('')}</tbody>`
      : '';
  return { markup: `<table>\n<thead>\n<tr>${head}</tr>\n</thead>${body}\n</table>`, next: index };
}

/** Splits a table row into trimmed cells (escaped `\|` becomes a literal). */
function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|') && !text.endsWith('\\|')) {
    text = text.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
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

type InlineToken =
  | { kind: 'text'; raw: string }
  | { kind: 'html'; html: string }
  | {
      kind: 'delimiter';
      char: string;
      run: number;
      canOpen: boolean;
      canClose: boolean;
      /** Tags assigned during pairing; unpaired runs fall back to literal. */
      tags: string[];
    };

/**
 * Renders one text run (a paragraph, a heading, a table cell) to inline
 * HTML. Single scan into tokens: backslash escapes, code spans, math and
 * links are recognised as they are met; emphasis runs become delimiter
 * tokens that pairDelimiters matches afterwards. Everything else is
 * escaped literal text — the tags in the output are only ever ours.
 */
function renderInline(text: string): string {
  const tokens: InlineToken[] = [];
  let buffer = '';

  const flushBuffer = (): void => {
    if (buffer !== '') {
      tokens.push({ kind: 'text', raw: buffer });
      buffer = '';
    }
  };

  const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    // Math first: `\(` is also a backslash escape candidate, but it is
    // math syntax here (and `\)` closes it).
    const math = matchMath(text, i);
    if (math) {
      flushBuffer();
      tokens.push({ kind: 'html', html: math.markup });
      i = math.next;
      continue;
    }

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

    // Code spans: a backtick run closes at the next run of the same
    // length; one leading and trailing space are trimmed (CommonMark).
    if (ch === '`') {
      let run = 0;
      while (text[i + run] === '`') {
        run += 1;
      }
      const closing = findBacktickRun(text, i + run, run);
      if (closing !== -1) {
        flushBuffer();
        let code = text.slice(i + run, closing);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
          code = code.slice(1, -1);
        }
        tokens.push({ kind: 'html', html: `<code>${escapeHtml(code.replace(/\n/g, ' '))}</code>` });
        i = closing + run;
        continue;
      }
      // Unclosed backtick run: literal.
      flushBuffer();
      tokens.push({ kind: 'text', raw: '`'.repeat(run) });
      i += run;
      continue;
    }

    // Links and images — footnote references first: `[^label]` shares
    // the opening bracket but is not a link construct.
    if (ch === '[') {
      const ref = matchFootnoteRef(text, i);
      if (ref) {
        flushBuffer();
        tokens.push({ kind: 'html', html: ref.markup });
        i = ref.next;
        continue;
      }
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const link = matchLink(text, i);
      if (link) {
        flushBuffer();
        tokens.push({ kind: 'html', html: link.markup });
        i = link.next;
        continue;
      }
    }

    // Emphasis delimiter runs: *, _ and exactly ~~.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (text[i + run] === ch) {
        run += 1;
      }
      if (ch === '~' && run !== 2) {
        // Strikethrough is exactly two tildes; any other run is literal.
        flushBuffer();
        tokens.push({ kind: 'text', raw: '~'.repeat(run) });
        i += run;
        continue;
      }

      const before = i > 0 ? text[i - 1] : undefined;
      const after = i + run < text.length ? text[i + run] : undefined;
      let canOpen = after !== undefined && !/\s/.test(after);
      let canClose = before !== undefined && !/\s/.test(before);
      if (ch === '_') {
        // Intraword underscores never emphasise (snake_case stays whole).
        canOpen = canOpen && !isAlnum(before);
        canClose = canClose && !isAlnum(after);
      }

      flushBuffer();
      tokens.push({ kind: 'delimiter', char: ch, run, canOpen, canClose, tags: [] });
      i += run;
      continue;
    }

    // Hard break: two or more trailing spaces before a newline; a plain
    // newline inside a paragraph stays a newline (HTML folds it).
    if (ch === '\n') {
      let spaces = 0;
      let back = i - 1;
      while (back >= 0 && text[back] === ' ') {
        spaces += 1;
        back -= 1;
      }
      if (spaces >= 2) {
        buffer = buffer.slice(0, -spaces);
        flushBuffer();
        tokens.push({ kind: 'html', html: '<br>' });
      } else {
        buffer += '\n';
      }
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flushBuffer();
  pairDelimiters(tokens);
  return tokens.map(renderToken).join('');
}

/** One token's final HTML (literal text escapes, delimiters resolve). */
function renderToken(token: InlineToken): string {
  if (token.kind === 'text') {
    return escapeHtml(token.raw);
  }
  if (token.kind === 'html') {
    return token.html;
  }
  // A delimiter that never paired is its literal characters; one that
  // paired carries only its tags (leftovers were folded in by the
  // pairing pass, opener-side after the tags, closer-side before them).
  return token.tags.length > 0 ? token.tags.join('') : escapeHtml(token.char.repeat(token.run));
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
    if (/^\s|\s$|\n|\$/.test(latex) || latex.trim() === '') {
      return null; // currency, not math
    }
    return { markup: buildMathShell(latex), next: close + 1 };
  }

  return null;
}

/**
 * A footnote reference `[^label]` at position `i` — the second char must be
 * `^`, the label non-empty and bracket-free, and the label ACTIVE (the
 * pre-scan found both this reference and a definition for it). Active refs
 * number in first-reference order and link into the definitions section;
 * everything else returns null and the brackets stay literal text (a ref
 * with no definition was always literal here, as in a code-free GFM
 * reading of a half-written note).
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
  const next = i + 2 + label.length + 1;
  return {
    markup: `<sup class="md-footnote-ref" id="md-fnref-${number}"><a href="#md-fn-${number}">${number}</a></sup>`,
    next,
  };
}

/**
 * A link `[text](url)` or image `![alt](url)` at position `i`. Images do
 * not load anything — they render as a link carrying the alt text, the
 * same privacy trade the sanitizer makes for rich notes. Unsafe URLs
 * (anything outside http(s)/mailto/anchor/relative) make the whole
 * `[text](url)` stay literal text rather than a dead anchor. An optional
 * `"title"` after the URL is parsed and ignored.
 */
function matchLink(text: string, i: number): { markup: string; next: number } | null {
  const image = text[i] === '!';
  const open = i + (image ? 1 : 0);
  if (text[open] !== '[') {
    return null;
  }

  // Find the matching ] — one level of bracket nesting is honoured.
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
        break;
      }
    }
    j += 1;
  }
  if (depth !== 0 || text[j + 1] !== '(') {
    return null;
  }

  // Destination: up to whitespace or the closing paren; a "title" may
  // follow, and escaped parens belong to the URL.
  let k = j + 2;
  let url = '';
  while (k < text.length && text[k] !== ')' && !/\s/.test(text[k]!)) {
    if (text[k] === '\\' && k + 1 < text.length && /[()]/.test(text[k + 1]!)) {
      url += text[k + 1];
      k += 2;
      continue;
    }
    url += text[k];
    k += 1;
  }
  if (url === '') {
    return null;
  }

  // Optional title: skip whitespace, then a double-quoted run.
  while (k < text.length && /[ \t]/.test(text[k]!)) {
    k += 1;
  }
  if (text[k] === '"') {
    const quoteEnd = text.indexOf('"', k + 1);
    if (quoteEnd === -1) {
      return null;
    }
    k = quoteEnd + 1;
  }
  if (k >= text.length || text[k] !== ')') {
    return null;
  }

  const label = text.slice(open + 1, j);
  const href = sanitizeHref(url);
  if (href === null) {
    return null;
  }

  if (image) {
    return {
      markup: `<a href="${escapeHtmlAttr(href)}" class="md-image-link" title="image">${escapeHtml(label)}</a>`,
      next: k + 1,
    };
  }
  return {
    markup: `<a href="${escapeHtmlAttr(href)}" rel="noopener noreferrer">${renderInline(label)}</a>`,
    next: k + 1,
  };
}

/**
 * Pairs delimiter runs into emphasis tags — the simplified CommonMark
 * matching: walking left to right, a closing run consumes the nearest
 * compatible opener of the same character, repeatedly until one side runs
 * out (which is how `***x***` nests `<b><i>`). Two-or-more on both sides
 * give `<b>`, one gives `<i>`, `~~` always gives `<s>`; unmatched runs
 * stay literal, and leftovers sit beside the emphasis they helped open
 * or close (`***x**` → `<b>*x</b>`, `**x***` → `<b>x*</b>`). Code, math
 * and link tokens between a pair are simply content — emphasis may wrap
 * them, and a delimiter swallowed by a code span never existed here.
 */
function pairDelimiters(tokens: InlineToken[]): void {
  const openers: Extract<InlineToken, { kind: 'delimiter' }>[] = [];

  for (const token of tokens) {
    if (token.kind !== 'delimiter') {
      continue;
    }

    while (token.run > 0 && token.canClose) {
      let opener: Extract<InlineToken, { kind: 'delimiter' }> | null = null;
      for (let o = openers.length - 1; o >= 0; o -= 1) {
        const candidate = openers[o]!;
        if (candidate.char === token.char && candidate.canOpen && candidate.run > 0) {
          opener = candidate;
          openers.splice(o, 1);
          break;
        }
        // Openers of other characters stay eligible — keep searching.
      }
      if (opener === null) {
        break;
      }

      const strong = token.run >= 2 && opener.run >= 2 && token.char !== '~';
      const use = strong || token.char === '~' ? 2 : 1;
      const [openTag, closeTag] =
        token.char === '~' ? ['<s>', '</s>'] : strong ? ['<b>', '</b>'] : ['<i>', '</i>'];

      opener.tags.push(openTag);
      token.tags.unshift(closeTag);

      opener.run -= use;
      token.run -= use;

      // An opener with characters left stays eligible for the closer's
      // next pass (the `***x***` inner <i>); it re-enters the stack only
      // once its closer is done with it.
      if (opener.run > 0) {
        openers.push(opener);
      }
    }

    // Closer leftovers sit before the tags they close; a closer that
    // still has unmatched characters and nothing matched stays literal
    // (renderToken's fallback).
    if (token.run > 0 && token.tags.length > 0) {
      token.tags.unshift(escapeHtml(token.char.repeat(token.run)));
      token.run = 0;
    }

    if (token.run > 0 && token.canOpen) {
      openers.push(token);
    }
  }

  // Opener leftovers sit after the tags they opened.
  for (const token of tokens) {
    if (token.kind === 'delimiter' && token.run > 0 && token.tags.length > 0) {
      token.tags.push(escapeHtml(token.char.repeat(token.run)));
      token.run = 0;
    }
  }
}
