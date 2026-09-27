/**
 * The legacy editor implementation of EditorPort: the existing
 * contenteditable #note surface driven by document.execCommand.
 *
 * This file concentrates everything the old editor did implicitly —
 * styleWithCSS tuning, sanitize-on-entry, innerHTML round-trips, the
 * execCommand boolean contract — so the rest of the app never touches the
 * surface directly. When the document-model editor lands, it ships as a
 * sibling implementation of EditorPort and this adapter retires.
 */
import type {
  Alignment,
  BlockFormat,
  EditorCommand,
  EditorPort,
  FormatCommand,
  ListKind,
  ScriptType,
} from './port';

const FORMAT_COMMANDS: readonly FormatCommand[] = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
];

const BLOCK_TAGS: readonly BlockFormat[] = ['p', 'h1', 'h2', 'h3', 'blockquote', 'pre'];

/** Blocks that carry the margin-left indent step (lists nest natively). */
const INDENTABLE_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE']);

/** px added per indent step — the classic contenteditable indent depth. */
const INDENT_STEP_PX = 40;
const MAX_INDENT_PX = 240;

/** The legacy execCommand font-size scale, in px (what 1..7 rendered as). */
const LEGACY_FONT_SIZE_PX: ReadonlyMap<string, number> = new Map([
  ['1', 10],
  ['2', 13],
  ['3', 16],
  ['4', 18],
  ['5', 24],
  ['6', 32],
  ['7', 48],
]);

/** The execCommand marker size: setFontSize rewrites every size="7" to px. */
const FONT_MARKER_SIZE = '7';

function isFormatCommand(command: EditorCommand): command is FormatCommand {
  return (FORMAT_COMMANDS as readonly string[]).includes(command);
}

export interface ContentEditablePortDeps {
  /**
   * The storage-format sanitizer (tabs.ts). Every string that enters the
   * surface through setHtml passes through it, exactly like storage load.
   */
  sanitize: (html: string) => string;

  /**
   * Called after setHtml replaces the content — the TabManager hook that
   * persists the replacement and refreshes the tab label.
   */
  onDocumentReplaced?: () => void;
}

export class ContentEditablePort implements EditorPort {
  private readonly element: HTMLElement;
  private readonly deps: ContentEditablePortDeps;

  constructor(element: HTMLElement, deps: ContentEditablePortDeps) {
    this.element = element;
    this.deps = deps;

    // Keep execCommand producing plain tags (b/i/u/s) rather than inline
    // styles — the storage subset has no place for `<span style>`.
    document.execCommand('styleWithCSS', false, 'false');
  }

  getHtml(): string {
    return this.element.innerHTML;
  }

  setHtml(html: string): void {
    this.element.innerHTML = this.deps.sanitize(html);
    this.deps.onDocumentReplaced?.();
  }

  getText(): string {
    return this.element.innerText.replace(/\u00a0/g, ' ');
  }

  isEmpty(): boolean {
    return this.getText().trim() === '';
  }

  focus(): void {
    this.element.focus();
  }

  isCaretInside(): boolean {
    const selection = window.getSelection();
    return (
      !!selection &&
      selection.rangeCount > 0 &&
      this.element.contains(selection.getRangeAt(0).startContainer)
    );
  }

  ensureCaretInside(): boolean {
    if (this.isCaretInside()) {
      return true;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this.element);
    range.collapse(false); // end of the note
    selection?.removeAllRanges();
    selection?.addRange(range);
    return this.isCaretInside();
  }

  charBeforeCaret(): string {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return '';
    }

    const anchor = selection.getRangeAt(0).startContainer;
    const offset = selection.getRangeAt(0).startOffset;

    if (anchor.nodeType === Node.TEXT_NODE) {
      return (anchor.nodeValue ?? '').slice(0, offset).slice(-1);
    }

    // Element anchor: the text right before it, if any.
    const element = anchor as Element;
    const before = element.textContent ?? '';
    return offset > 0 ? before.slice(-1) : before;
  }

  insertText(text: string): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('insertText', false, text);
  }

  applyFormat(command: EditorCommand): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    if (!isFormatCommand(command) && command !== 'removeFormat') {
      return false;
    }
    return document.execCommand(command, false);
  }

  queryFormat(command: FormatCommand): boolean {
    return document.queryCommandState(command);
  }

  applyBlockFormat(format: BlockFormat): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    // The bracketed tag form is the long-standing cross-browser spelling of
    // formatBlock's value.
    return document.execCommand('formatBlock', false, `<${format}>`);
  }

  queryBlockFormat(): BlockFormat | null {
    if (typeof document.queryCommandValue !== 'function') {
      return null;
    }
    const value = (document.queryCommandValue('formatBlock') || '').toLowerCase();
    // Plain paragraphs live as divs in the contenteditable surface.
    if (value === 'div' || value === '') {
      return 'p';
    }
    return BLOCK_TAGS.includes(value as BlockFormat) ? (value as BlockFormat) : null;
  }

  toggleList(kind: ListKind): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand(kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList', false);
  }

  queryListKind(): ListKind | null {
    if (typeof document.queryCommandState !== 'function') {
      return null;
    }
    if (document.queryCommandState('insertUnorderedList')) {
      return 'ul';
    }
    if (document.queryCommandState('insertOrderedList')) {
      return 'ol';
    }
    return null;
  }

  insertLink(href: string): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    // The contract promises false over a collapsed caret ("nothing to
    // link") — but Chrome happily accepts it and dumps the href into the
    // note as anchor text. Guard so the caller's guidance toast fires.
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }
    return document.execCommand('createLink', false, href);
  }

  removeLink(): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('unlink', false);
  }

  /** The anchor at/around the selection, or null — always inside the note. */
  private anchorAtSelection(): HTMLAnchorElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.anchorNode;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const anchor = base?.closest('a');
    return anchor && this.element.contains(anchor) ? (anchor as HTMLAnchorElement) : null;
  }

  queryLinkHref(): string | null {
    return this.anchorAtSelection()?.getAttribute('href') ?? null;
  }

  retargetLink(href: string): boolean {
    const anchor = this.anchorAtSelection();
    if (!anchor) {
      return false;
    }
    anchor.setAttribute('href', href);
    return true;
  }

  undo(): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('undo', false);
  }

  redo(): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('redo', false);
  }

  // -------------------------------------------------------------------------
  // The Docs-style vocabulary.
  //
  // execCommand predates inline styles for three of these commands and
  // answers with legacy <font> tags (size/face/color). The storage subset
  // has no place for <font>, so every method below normalizes the engine's
  // output into span/block styles right after the command — the note never
  // shows, saves or syncs markup outside the sanitized vocabulary.
  // -------------------------------------------------------------------------

  setFontSize(px: number): boolean {
    if (!this.canExec()) {
      return false;
    }
    if (!Number.isFinite(px) || px < 8 || px > 96) {
      return false;
    }
    if (!document.execCommand('fontSize', false, FONT_MARKER_SIZE)) {
      return false;
    }
    // Rewrite the marker tags to the requested px; any other font tags the
    // command produced or found keep the legacy mapping.
    this.element.querySelectorAll(`font[size="${FONT_MARKER_SIZE}"]`).forEach((font) => {
      this.replaceFontWithSpan(font as HTMLFontElement, { 'font-size': `${px}px` });
    });
    this.normalizeFontTags();
    this.announceEdit();
    return true;
  }

  setFontFamily(family: string): boolean {
    const name = family.trim().replace(/["']/g, '');
    if (name === '' || !this.canExec()) {
      return false;
    }
    if (!document.execCommand('fontName', false, name)) {
      return false;
    }
    this.normalizeFontTags();
    this.announceEdit();
    return true;
  }

  setTextColor(color: string): boolean {
    const value = color.trim();
    if (value === '' || !this.canExec()) {
      return false;
    }
    if (!document.execCommand('foreColor', false, value)) {
      return false;
    }
    this.normalizeFontTags();
    this.announceEdit();
    return true;
  }

  setHighlight(color: string): boolean {
    const value = color.trim();
    if (value === '' || !this.canExec()) {
      return false;
    }
    // hiliteColor already answers with a span style in Chrome; no <font>
    // normalization needed, but run it anyway in case older paths leak.
    if (!document.execCommand('hiliteColor', false, value)) {
      return false;
    }
    this.announceEdit();
    return true;
  }

  applyScript(type: ScriptType): boolean {
    if (!this.canExec()) {
      return false;
    }
    return document.execCommand(type === 'super' ? 'superscript' : 'subscript', false);
  }

  queryScript(type: ScriptType): boolean {
    if (typeof document.queryCommandState !== 'function') {
      return false;
    }
    try {
      return document.queryCommandState(type === 'super' ? 'superscript' : 'subscript');
    } catch {
      return false;
    }
  }

  applyAlignment(align: Alignment): boolean {
    if (!this.canExec()) {
      return false;
    }
    const command = `justify${align[0]!.toUpperCase()}${align.slice(1)}`;
    return document.execCommand(command, false);
  }

  queryAlignment(): Alignment | null {
    if (typeof document.queryCommandState !== 'function') {
      return null;
    }
    // 'left' answers true on default-aligned blocks, so it doubles as the
    // resting state; check the others first so they win when set.
    const checks: readonly [Alignment, string][] = [
      ['center', 'justifyCenter'],
      ['right', 'justifyRight'],
      ['justify', 'justifyFull'],
      ['left', 'justifyLeft'],
    ];
    for (const [align, command] of checks) {
      try {
        if (document.queryCommandState(command)) {
          return align;
        }
      } catch {
        /* odd selection states — try the next */
      }
    }
    return null;
  }

  indent(): boolean {
    if (!this.canExec()) {
      return false;
    }
    // Inside a list the engine nests natively (list items and sublists);
    // Chrome's paragraph path would wrap blocks in borderless blockquotes,
    // which would hijack the quote element — margin-step plain blocks instead.
    if (this.queryListKind() !== null) {
      return document.execCommand('indent', false);
    }
    return this.shiftSelectionBlocks(INDENT_STEP_PX);
  }

  outdent(): boolean {
    if (!this.canExec()) {
      return false;
    }
    if (this.queryListKind() !== null) {
      return document.execCommand('outdent', false);
    }
    return this.shiftSelectionBlocks(-INDENT_STEP_PX);
  }

  insertHorizontalRule(): boolean {
    if (!this.canExec()) {
      return false;
    }
    return document.execCommand('insertHorizontalRule', false);
  }

  private canExec(): boolean {
    return typeof document.execCommand === 'function';
  }

  /**
   * Manual DOM rewriting after an execCommand does not fire the input event
   * the app's autosave/toolbar listen on — announce it explicitly.
   */
  private announceEdit(): void {
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Converts every remaining <font> tag into a span with the equivalent
   * inline style, innermost-first (each pass removes at least one level).
   */
  private normalizeFontTags(): void {
    let fonts = this.element.querySelectorAll('font');
    while (fonts.length > 0) {
      fonts.forEach((font) => {
        this.replaceFontWithSpan(font as HTMLFontElement, {});
      });
      fonts = this.element.querySelectorAll('font');
    }
  }

  /** The legacy <font> attribute set, read into a style record. */
  private static fontStyles(font: HTMLFontElement): Record<string, string> {
    const styles: Record<string, string> = {};
    const size = font.getAttribute('size');
    if (size) {
      const px = LEGACY_FONT_SIZE_PX.get(size);
      if (px !== undefined) {
        styles['font-size'] = `${px}px`;
      }
    }
    const face = font.getAttribute('face');
    if (face) {
      styles['font-family'] = face.replace(/["']/g, '').trim();
    }
    const color = font.getAttribute('color');
    if (color) {
      styles['color'] = color;
    }
    return styles;
  }

  private replaceFontWithSpan(font: HTMLFontElement, overrides: Record<string, string>): void {
    if (!font.parentNode) {
      return;
    }
    const span = document.createElement('span');
    const styles = { ...ContentEditablePort.fontStyles(font), ...overrides };
    for (const [prop, value] of Object.entries(styles)) {
      if (value !== '') {
        span.style.setProperty(prop, value);
      }
    }
    while (font.firstChild) {
      span.append(font.firstChild);
    }
    font.replaceWith(span);
  }

  /**
   * The block elements the selection covers: the blocks holding the range's
   * start and end, plus every sibling block between them when they share a
   * parent. Lists are handled natively before this runs.
   */
  private selectionBlocks(): HTMLElement[] {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return [];
    }
    const range = selection.getRangeAt(0);

    const blockOf = (node: Node | null): HTMLElement | null => {
      let el = node instanceof Element ? node : (node?.parentElement ?? null);
      while (el && el !== this.element && !INDENTABLE_TAGS.has(el.tagName)) {
        el = el.parentElement;
      }
      return el instanceof HTMLElement && el !== this.element ? el : null;
    };

    const startBlock = blockOf(range.startContainer);
    const endBlock = blockOf(range.endContainer);
    if (!startBlock && !endBlock) {
      return [];
    }
    if (!startBlock || !endBlock) {
      return [startBlock ?? endBlock!];
    }
    if (startBlock === endBlock) {
      return [startBlock];
    }

    const parent = startBlock.parentElement;
    if (parent && parent === endBlock.parentElement) {
      const kids = Array.from(parent.children);
      const from = Math.min(kids.indexOf(startBlock), kids.indexOf(endBlock));
      const to = Math.max(kids.indexOf(startBlock), kids.indexOf(endBlock));
      if (from >= 0 && to >= 0) {
        return kids
          .slice(from, to + 1)
          .filter(
            (el): el is HTMLElement =>
              el instanceof HTMLElement && INDENTABLE_TAGS.has(el.tagName),
          );
      }
    }
    return [startBlock, endBlock];
  }

  /** Applies the indent step to the selection's blocks, clamped to [0, max]. */
  private shiftSelectionBlocks(delta: number): boolean {
    const blocks = this.selectionBlocks();
    if (blocks.length === 0) {
      return false;
    }
    for (const block of blocks) {
      const current = parseInt(window.getComputedStyle(block).marginLeft, 10) || 0;
      const next = Math.min(Math.max(current + delta, 0), MAX_INDENT_PX);
      if (next > 0) {
        block.style.marginLeft = `${next}px`;
      } else {
        block.style.removeProperty('margin-left');
        if (block.getAttribute('style') === '') {
          block.removeAttribute('style');
        }
      }
    }
    this.announceEdit();
    return true;
  }

  onInput(listener: () => void): () => void {
    this.element.addEventListener('input', listener);
    return () => {
      this.element.removeEventListener('input', listener);
    };
  }
}
