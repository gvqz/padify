/**
 * The Markdown SOURCE editor's editing primitives — every operation the
 * toolbar, the context menu and the keyboard can perform on the raw
 * markdown textarea, expressed as pure text transforms over a
 * <textarea>'s value + selection.
 *
 * One editing grammar: the characters ARE the syntax (the exact source
 * the note stores byte-exact), so every action here edits text the way
 * GitHub's and Obsidian's source editors do — wrap selections with
 * markers, prefix lines, continue lists — and every edit lands through
 * applyEdit(), which drives document.execCommand('insertText') so the
 * browser's OWN native undo stack covers toolbar actions exactly as it
 * covers typing (the setRangeText fallback, for engines without the
 * command, dispatches the input event by hand — the announce contract
 * must never depend on the engine).
 */
import type { MarkdownSelectionState } from './selection-state';

/** The Tab key's indent width in the source editor (spaces). */
export const SOURCE_INDENT = '  ';

// ---------------------------------------------------------------------------
// The one write path
// ---------------------------------------------------------------------------

/**
 * Replaces [from, to) with text and leaves the selection where the caller
 * wants it — one undo step, one input event. The execCommand path keeps
 * the browser's native undo alive (typing and toolbar actions share the
 * same stack, exactly like GitHub's source editor).
 */
export function applyEdit(
  ta: HTMLTextAreaElement,
  from: number,
  to: number,
  text: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): void {
  ta.focus();
  ta.setSelectionRange(from, to);
  try {
    if (!document.execCommand('insertText', false, text)) {
      throw new Error('insertText refused');
    }
  } catch {
    // setRangeText never fires input — the announce contract (autosave,
    // the word pill) must hear this edit, so dispatch it by hand.
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.setSelectionRange(selectionStart, selectionEnd);
}

/** True when the textarea has a selection (not a bare caret). */
export function hasSelection(ta: HTMLTextAreaElement): boolean {
  return ta.selectionStart !== ta.selectionEnd;
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

export interface LineRange {
  /** The index of the first character of the first selected line. */
  start: number;
  /** The index AFTER the last character of the last selected line (no newline). */
  end: number;
  /** The selected lines' text, '\n'-joined. */
  text: string;
}

/** The line range covering the selection (the caret's line when empty). */
export function selectedLines(ta: HTMLTextAreaElement): LineRange {
  const value = ta.value;
  const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let end = value.indexOf('\n', ta.selectionEnd);
  if (end === -1) {
    end = value.length;
  }
  return { start, end, text: value.slice(start, end) };
}

// ---------------------------------------------------------------------------
// Inline wraps (bold, italic, strikethrough, code)
// ---------------------------------------------------------------------------

export interface WrapResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** The value with the selection (or the markers around the caret) removed. */
function unwrapAt(value: string, from: number, to: number, marker: string): WrapResult | null {
  const before = value.slice(Math.max(0, from - marker.length), from);
  const after = value.slice(to, to + marker.length);
  if (before === marker && after === marker) {
    // Selection sits between the markers — the toggle's off ramp.
    return {
      value:
        value.slice(0, from - marker.length) +
        value.slice(from, to) +
        value.slice(to + marker.length),
      selectionStart: from - marker.length,
      selectionEnd: to - marker.length,
    };
  }
  return null;
}

/**
 * Toggles an inline marker around the selection. An empty selection
 * inserts the markers with the caret between them; a selection that
 * INCLUDES its markers unwraps; a plain selection wraps. Repeated
 * application is stable (wrap → unwrap → wrap).
 */
export function toggleWrap(ta: HTMLTextAreaElement, marker: string): void {
  const value = ta.value;
  const from = ta.selectionStart;
  const to = ta.selectionEnd;

  if (from === to) {
    // Caret: type a fresh empty wrap, caret between the markers.
    applyEdit(ta, from, to, `${marker}${marker}`, from + marker.length, from + marker.length);
    return;
  }

  const unwrapped = unwrapAt(value, from, to, marker);
  if (unwrapped) {
    const { value: next, selectionStart, selectionEnd } = unwrapped;
    replaceWhole(ta, next, selectionStart, selectionEnd);
    return;
  }

  const selected = value.slice(from, to);
  if (
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length > marker.length * 2
  ) {
    // The selection carries its own markers — strip them.
    const inner = selected.slice(marker.length, selected.length - marker.length);
    applyEdit(ta, from, to, inner, from, from + inner.length);
    return;
  }

  applyEdit(
    ta,
    from,
    to,
    `${marker}${selected}${marker}`,
    from + marker.length,
    from + marker.length + selected.length,
  );
}

/** Whole-value replacement (the unwrap path needs it — execCommand on a full select). */
function replaceWhole(
  ta: HTMLTextAreaElement,
  value: string,
  selectionStart: number,
  selectionEnd: number,
): void {
  applyEdit(ta, 0, ta.value.length, value, selectionStart, selectionEnd);
}

// ---------------------------------------------------------------------------
// Line prefixes (quote, lists, tasks, headings)
// ---------------------------------------------------------------------------

/** The prefixes this editor understands, in the order that wins a strip. */
const BULLET_PREFIX = /^(\s*)[-*+] \[( |x|X)\] /; // task
const BULLET_PLAIN = /^(\s*)([-*+]) /; // bullet
const ORDERED_PREFIX = /^(\s*)(\d{1,9})[.)] /; // ordered
const QUOTE_PREFIX = /^(\s*)> /; // quote
const HEADING_PREFIX = /^(\s*)(#{1,6}) /; // heading

/** Which list shape a line carries (for the pressed states + toggles). */
export function listShapeOfLine(line: string): 'bullet' | 'ordered' | 'task' | null {
  if (BULLET_PREFIX.test(line)) {
    return 'task';
  }
  if (BULLET_PLAIN.test(line)) {
    return 'bullet';
  }
  if (ORDERED_PREFIX.test(line)) {
    return 'ordered';
  }
  return null;
}

/** Strips any block prefix the grammar knows, keeping the indentation. */
function stripPrefix(line: string): string {
  return line
    .replace(BULLET_PREFIX, '$1')
    .replace(BULLET_PLAIN, '$1')
    .replace(ORDERED_PREFIX, '$1')
    .replace(QUOTE_PREFIX, '$1')
    .replace(HEADING_PREFIX, '$1');
}

/** The task toggle's prefix — matched against any checked state below. */
const TASK_TOGGLE_PREFIX = '- [ ] ';

/**
 * Toggles a fixed line prefix ('> ' for quotes, '- [ ] ' for tasks): every
 * selected line carries it → strip; otherwise strip other prefixes first,
 * then add. An empty prefix (null) strips whatever is there. The task
 * prefix counts '- [x] done' as CARRYING it — the off ramp must disarm the
 * list without resetting checked items to unchecked.
 */
export function toggleLinePrefix(ta: HTMLTextAreaElement, prefix: string | null): void {
  const range = selectedLines(ta);
  const strip = (line: string): string => stripPrefix(line);

  if (prefix === null) {
    commitLineEdit(ta, range, strip);
    return;
  }

  const isTaskToggle = prefix === TASK_TOGGLE_PREFIX;
  const carries = (line: string): boolean =>
    isTaskToggle
      ? BULLET_PREFIX.test(line) // any of '- [ ] ' / '- [x] ' / '- [X] '
      : line.trimStart().startsWith(prefix.trim());
  const every = range.text.split('\n').every((line) => carries(line) || line.trim() === '');
  if (every && range.text.trim() !== '') {
    // All prefix lines — the toggle's off ramp. Tasks strip through
    // stripPrefix so '- [x] ' loses the WHOLE marker, not nothing.
    const off = (line: string): string =>
      isTaskToggle
        ? stripPrefix(line)
        : line.replace(new RegExp(`^(\\s*)${escapeRegExp(prefix)}`), '$1');
    commitLineEdit(ta, range, off);
    return;
  }

  const on = (line: string): string => {
    if (line.trim() === '') {
      return line; // blank lines stay blank — the list keeps its shape
    }
    const lead = stripPrefix(line).match(/^\s*/)?.[0] ?? '';
    return lead + prefix + stripPrefix(line).slice(lead.length);
  };
  commitLineEdit(ta, range, on);
}

/**
 * Toggles the ordered list: renumbered per line across the selection
 * (1. 2. 3. — the same shape the renderer accepts).
 */
export function toggleOrderedList(ta: HTMLTextAreaElement): void {
  const range = selectedLines(ta);
  const lines = range.text.split('\n');
  if (
    lines.every((line) => ORDERED_PREFIX.test(line) || line.trim() === '') &&
    range.text.trim() !== ''
  ) {
    const off = (line: string): string => line.replace(ORDERED_PREFIX, '$1');
    commitLineEdit(ta, range, off);
    return;
  }
  let n = 0;
  const on = (line: string): string => {
    if (line.trim() === '') {
      return line;
    }
    n += 1;
    const lead = stripPrefix(line).match(/^\s*/)?.[0] ?? '';
    return `${lead}${n}. ${stripPrefix(line).slice(lead.length)}`;
  };
  commitLineEdit(ta, range, on);
}

/** Turns the selected lines into a heading (level) or a paragraph (null). */
export function setHeadingLevel(ta: HTMLTextAreaElement, level: number | null): void {
  const range = selectedLines(ta);
  const hash = level === null ? null : '#'.repeat(Math.min(6, Math.max(1, level))) + ' ';
  const rewrite = (line: string): string => {
    if (line.trim() === '') {
      return line;
    }
    const lead = stripPrefix(line).match(/^\s*/)?.[0] ?? '';
    const body = stripPrefix(line).slice(lead.length);
    return lead + (hash ?? '') + body;
  };
  commitLineEdit(ta, range, rewrite);
}

/** Indents (positive) or dedents (negative) the selected lines. */
export function indentLines(ta: HTMLTextAreaElement, direction: 1 | -1): void {
  const range = selectedLines(ta);
  if (direction > 0) {
    commitLineEdit(ta, range, (line) => (line.trim() === '' ? line : SOURCE_INDENT + line));
    return;
  }
  const dedent = (line: string): string => {
    const spaces = line.match(/^ {1,2}/)?.[0]?.length ?? 0;
    return line.slice(spaces);
  };
  commitLineEdit(ta, range, dedent);
}

/**
 * Maps a column through one line's rewrite, preserving the SELECTED
 * CHARACTERS: columns inside the line's unchanged prefix stay, columns
 * inside its unchanged suffix ride the length delta, and columns inside
 * the changed middle (the prefix swap itself) land at the junction.
 */
function mapColumn(oldLine: string, newLine: string, column: number): number {
  let prefix = 0;
  const limit = Math.min(oldLine.length, newLine.length);
  while (prefix < limit && oldLine[prefix] === newLine[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldLine[oldLine.length - 1 - suffix] === newLine[newLine.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (column <= prefix) {
    return column;
  }
  const oldSuffixStart = oldLine.length - suffix;
  if (column >= oldSuffixStart) {
    return newLine.length - suffix + (column - oldSuffixStart);
  }
  return prefix;
}

/** Applies a per-line rewrite to the line range, mapping the selection
 *  through each line's change (prefix toggles shift content; the
 *  selection rides the same characters). */
function commitLineEdit(
  ta: HTMLTextAreaElement,
  range: LineRange,
  rewrite: (line: string) => string,
): void {
  const oldLines = range.text.split('\n');
  const newLines = oldLines.map(rewrite);
  const text = newLines.join('\n');

  const mapOffset = (offset: number): number => {
    let oldLineStart = range.start;
    let newLineStart = range.start;
    for (let i = 0; i < oldLines.length; i += 1) {
      const oldEnd = oldLineStart + oldLines[i].length;
      if (offset <= oldEnd || i === oldLines.length - 1) {
        const column = Math.max(0, Math.min(offset - oldLineStart, oldLines[i].length));
        return newLineStart + mapColumn(oldLines[i], newLines[i], column);
      }
      oldLineStart = oldEnd + 1;
      newLineStart += newLines[i].length + 1;
    }
    return range.start + text.length;
  };

  applyEdit(
    ta,
    range.start,
    range.end,
    text,
    mapOffset(ta.selectionStart),
    mapOffset(ta.selectionEnd),
  );
}

// ---------------------------------------------------------------------------
// Enter — list continuation
// ---------------------------------------------------------------------------

/** A list line's shape: leading whitespace + marker (+ checked box). */
interface ListMarker {
  lead: string;
  marker: string;
  /** The offset within the line where the content starts. */
  contentAt: number;
}

/** Reads the list marker at the caret's line, if the caret sits in its content. */
function listMarkerAtLine(line: string): ListMarker | null {
  const task = line.match(/^(\s*)([-*+]) \[( |x|X)\] /);
  if (task) {
    // Continuation RESETS the checkbox — a fresh item starts unchecked.
    return { lead: task[1], marker: `${task[2]} [ ] `, contentAt: task[0].length };
  }
  const bullet = line.match(/^(\s*)([-*+]) /);
  if (bullet) {
    return { lead: bullet[1], marker: `${bullet[2]} `, contentAt: bullet[0].length };
  }
  const ordered = line.match(/^(\s*)(\d{1,9})[.)] /);
  if (ordered) {
    const number = Number.parseInt(ordered[2], 10) + 1;
    return { lead: ordered[1], marker: `${number}. `, contentAt: ordered[0].length };
  }
  return null;
}

/**
 * Enter in the source editor: a list line continues itself (marker +
 * indentation, tasks reset to unchecked); a line that is ONLY its marker
 * exits the list instead. Everything else falls through to the native
 * newline (returns false).
 */
export function continueListOnEnter(ta: HTMLTextAreaElement): boolean {
  const value = ta.value;
  const lineStart = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  const lineEnd = value.indexOf('\n', ta.selectionStart);
  const lineEndIndex = lineEnd === -1 ? value.length : lineEnd;
  const line = value.slice(lineStart, lineEndIndex);
  const marker = listMarkerAtLine(line);
  if (!marker) {
    return false;
  }
  const column = ta.selectionStart - lineStart;
  if (column < marker.contentAt) {
    return false; // the caret edits the marker itself — native behavior
  }
  const content = line.slice(marker.contentAt);
  if (content.trim() === '') {
    // Marker-only line — Enter lifts the list: clear it, stay at the end.
    const nextMarkerOnly = marker.lead;
    applyEdit(ta, lineStart, lineEndIndex, nextMarkerOnly, lineStart + nextMarkerOnly.length);
    return true;
  }
  const insertion = `\n${marker.lead}${marker.marker}`;
  // The selection is REPLACED by the continuation (native Enter's own
  // contract — the old empty-range insert left the selected words behind).
  const at = ta.selectionStart;
  applyEdit(ta, at, ta.selectionEnd, insertion, at + insertion.length);
  return true;
}

// ---------------------------------------------------------------------------
// Blocks (code fences, tables, dividers)
// ---------------------------------------------------------------------------

/** Wraps the selection in a fenced code block (the language line included). */
export function wrapCodeBlock(ta: HTMLTextAreaElement): void {
  const value = ta.value;
  const from = ta.selectionStart;
  const to = ta.selectionEnd;
  const lineStart = value.lastIndexOf('\n', from - 1) + 1;
  const afterTo = value.indexOf('\n', to);
  const lineEnd = afterTo === -1 ? value.length : afterTo;

  // Already inside a fence (an odd count of fence lines above) — unwrap
  // the enclosing region: the fence lines go, the content stays.
  const enclosing = enclosingFence(ta);
  if (enclosing) {
    const at = enclosing.start;
    applyEdit(
      ta,
      enclosing.start,
      enclosing.end + 1,
      enclosing.content,
      at,
      at + enclosing.content.length,
    );
    return;
  }

  const selected = value.slice(from, to) || '';
  const needsLead = lineStart !== from ? '\n' : '';
  const restOfLine = value.slice(to, lineEnd);
  const needsTrail = restOfLine !== '' ? '\n' : '';
  const text = `${needsLead}\`\`\`\n${selected}\n\`\`\`${needsTrail}`;
  const caret = from + needsLead.length + 4 + (selected ? selected.length + 1 : 0);
  applyEdit(
    ta,
    from,
    to,
    text,
    Math.min(caret, from + text.length),
    Math.min(caret, from + text.length),
  );
}

interface FenceRegion {
  /** The whole fenced region: opening fence line through closing fence line. */
  start: number;
  end: number;
  /** The content between the fence lines (trailing newline trimmed). */
  content: string;
}

/** The fenced region around the caret, if the caret sits inside one. */
function enclosingFence(ta: HTMLTextAreaElement): FenceRegion | null {
  const value = ta.value;
  const caret = ta.selectionStart;
  const lines = value.split('\n');
  let offset = 0;
  let open: { lineStart: number; contentStart: number } | null = null;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    if (!/^```/.test(line)) {
      continue;
    }
    if (open) {
      // The closing fence — the caret between the fences means inside.
      if (caret > open.contentStart && caret < lineStart) {
        return {
          start: open.lineStart,
          end: lineEnd,
          content: value.slice(open.contentStart, lineStart).replace(/\n$/, ''),
        };
      }
      open = null;
    } else {
      open = { lineStart, contentStart: offset };
    }
  }
  return null;
}

/** Inserts a block (hr, table template) on its own lines at the caret. */
export function insertBlock(
  ta: HTMLTextAreaElement,
  block: string,
  selectOffset?: [number, number],
): void {
  const value = ta.value;
  const from = ta.selectionStart;
  const to = ta.selectionEnd;
  const atLineStart = from === 0 || value[from - 1] === '\n';
  const afterTo = value.indexOf('\n', to);
  const lineEnd = afterTo === -1 ? value.length : afterTo;
  const restOfLine = value.slice(to, lineEnd);
  // Mid-line carets split their line: the block gets its own lines, the
  // tail keeps the user's text on the line after it.
  const lead = atLineStart ? '' : '\n';
  const trail = restOfLine !== '' ? '\n' : '';
  const text = lead + block + trail;
  const [selStart, selEnd] = selectOffset ?? [block.length, block.length];
  applyEdit(ta, from, to, text, from + lead.length + selStart, from + lead.length + selEnd);
}

/** The GitHub-shaped 2x3 table template (with the header row selected). */
export function tableTemplate(): string {
  return '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |';
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface SourceLink {
  start: number;
  end: number;
  text: string;
  href: string;
}

/** The [text](href) span at (or around) the caret, if any. */
export function linkAroundCaret(ta: HTMLTextAreaElement): SourceLink | null {
  const value = ta.value;
  const caret = ta.selectionStart;
  const pattern = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret >= start && caret <= end) {
      return { start, end, text: match[1], href: match[2] };
    }
  }
  return null;
}

/** True when the current selection sits INSIDE the span (a partial edit of
 *  it, not a wrap of text outside it). */
function selectionWithin(ta: HTMLTextAreaElement, start: number, end: number): boolean {
  return (
    ta.selectionStart >= start && ta.selectionEnd <= end && ta.selectionStart !== ta.selectionEnd
  );
}

/** Applies a link: wraps the selection, or rewrites the link under the caret. */
export function applyLink(ta: HTMLTextAreaElement, href: string, label?: string): void {
  const existing = linkAroundCaret(ta);
  const selectionText =
    ta.selectionStart !== ta.selectionEnd
      ? ta.value.slice(ta.selectionStart, ta.selectionEnd)
      : null;
  const target = label ?? selectionText;
  // An explicit label (the popover chip's Edit path) always renames; a
  // selection INSIDE the link is just where the user landed, not a
  // re-label — the label stays whole.
  if (
    existing &&
    label === undefined &&
    (!target || (selectionText !== null && selectionWithin(ta, existing.start, existing.end)))
  ) {
    // Retarget in place — the label stays WHOLE. A selection inside the
    // link is how the user landed here, not a re-label request: rebuilding
    // from the selected fragment used to silently delete the rest of the
    // label ("see [click here](url)" with 'here' selected became
    // "see [here](url)" — 'click ' was gone).
    const next = `[${existing.text}](${href})`;
    applyEdit(ta, existing.start, existing.end, next, existing.start, existing.start + next.length);
    return;
  }
  const text = target || 'link text';
  const link = `[${text}](${href})`;
  const from = existing ? existing.start : ta.selectionStart;
  const to = existing ? existing.end : ta.selectionEnd;
  applyEdit(ta, from, to, link, from + 1, from + 1 + text.length);
}

/** Strips the link under the caret to its text (the popover's Remove). */
export function removeLink(ta: HTMLTextAreaElement): boolean {
  const link = linkAroundCaret(ta);
  if (!link) {
    return false;
  }
  applyEdit(ta, link.start, link.end, link.text, link.start, link.start + link.text.length);
  return true;
}

// ---------------------------------------------------------------------------
// Clear formatting
// ---------------------------------------------------------------------------

/** Strips the inline markers around the selection + prefixes on its lines. */
export function clearFormatting(ta: HTMLTextAreaElement): void {
  // Inside a fenced code block, prefixes and markers are CONTENT — the
  // visual mode's clear never touches code blocks, and neither does this.
  // (Only the whole selection inside the fence skips; a fence boundary in
  // the selection is the user's own formatting to clear.)
  const state = sourceSelectionState(ta);
  if (!state.codeBlock) {
    toggleLinePrefix(ta, null);
  }
  for (const marker of ['**', '~~', '*', '`']) {
    // Unwrap when the markers hug the selection (or it carries them).
    const value = ta.value;
    const from = ta.selectionStart;
    const to = ta.selectionEnd;
    const unwrapped = unwrapAt(value, from, to, marker);
    if (unwrapped) {
      replaceWhole(ta, unwrapped.value, unwrapped.selectionStart, unwrapped.selectionEnd);
      continue;
    }
    const selected = value.slice(from, to);
    if (
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      selected.length > marker.length * 2
    ) {
      const inner = selected.slice(marker.length, selected.length - marker.length);
      applyEdit(ta, from, to, inner, from, from + inner.length);
    }
  }
}

// ---------------------------------------------------------------------------
// The pressed-state read (the toolbar's honest face in source mode)
// ---------------------------------------------------------------------------

/** Reads the caret's/selection's state for the toolbar, from raw text. */
export function sourceSelectionState(ta: HTMLTextAreaElement): MarkdownSelectionState {
  const value = ta.value;
  const from = ta.selectionStart;
  const to = ta.selectionEnd;
  const lineStart = value.lastIndexOf('\n', from - 1) + 1;
  const lineEndRaw = value.indexOf('\n', to);
  const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;
  const line = value.slice(lineStart, lineEnd);

  const wrapState = (marker: string): boolean => {
    if (from !== to) {
      const selected = value.slice(from, to);
      if (selected.startsWith(marker) && selected.endsWith(marker)) {
        return true;
      }
      return (
        value.slice(Math.max(0, from - marker.length), from) === marker &&
        value.slice(to, to + marker.length) === marker
      );
    }
    // Caret: markers immediately before AND after (…**|**…).
    return (
      value.slice(Math.max(0, from - marker.length), from) === marker &&
      value.slice(from, from + marker.length) === marker
    );
  };

  // The block states read the caret's line (a selection spanning lines
  // reports its first — the acting-on-block convention).
  const shape = listShapeOfLine(line);
  const headingMatch = line.match(HEADING_PREFIX);

  // codeBlock: an odd number of fence lines above the caret.
  const before = value.slice(0, lineStart);
  const fences = before.match(/^```/gm);
  const codeBlock = !!fences && fences.length % 2 === 1;

  const link = linkAroundCaret(ta);

  return {
    bold: wrapState('**'),
    italic: wrapState('*') && !wrapState('**'),
    strikethrough: wrapState('~~'),
    code: wrapState('`'),
    link: link !== null,
    linkHref: link?.href ?? null,
    heading: headingMatch ? headingMatch[2].length : null,
    blockquote: QUOTE_PREFIX.test(line),
    bulletList: shape === 'bullet',
    orderedList: shape === 'ordered',
    task: shape === 'task',
    codeBlock,
    math: null,
    image: false,
    inTable: line.trimStart().startsWith('|') && line.includes('|', line.indexOf('|') + 1),
  };
}

// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
