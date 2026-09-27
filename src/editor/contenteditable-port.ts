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
  TableCellContext,
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

/**
 * Block siblings a caret can safely move to when an insertion must escape a
 * list (tables/dividers nest inside <li> otherwise) — the note's block set
 * plus the lists and tables themselves.
 */
const BLOCK_SIBLING_TAGS = new Set([
  ...INDENTABLE_TAGS,
  'UL',
  'OL',
  'TABLE',
]);

/** px added per indent step — the classic contenteditable indent depth. */
const INDENT_STEP_PX = 40;
const MAX_INDENT_PX = 240;

/**
 * The checklist vocabulary on the stored subset: an unordered list carries
 * data-rich-checklist, every item states its box state. Clicks in the
 * item's left gutter (the checkbox column the CSS paints) toggle it.
 */
const CHECKLIST_ATTR = 'data-rich-checklist';
const CHECKED_ATTR = 'data-checked';
const CHECKLIST_GUTTER_PX = 30;

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

/**
 * The styled-caret marker: a zero-width space inside the span the caret
 * lands in, so typed text joins a run that already carries the picked
 * style. Invisible to the reader, stripped from titles/previews/counts.
 */
const ZERO_WIDTH_SPACE = '\u200B';

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

    // Checklist interactions live on the surface itself: clicking an item's
    // checkbox gutter flips its state, and Enter on a checked item starts
    // the next one unchecked (the engine clones the item's attributes).
    element.addEventListener('click', (event) => {
      this.toggleChecklistItem(event as MouseEvent);
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      // After the engine splits the item, an empty checked clone unchecks.
      requestAnimationFrame(() => this.uncheckEmptyItemUnderCaret());
    });
  }

  getHtml(): string {
    return this.element.innerHTML;
  }

  setHtml(html: string): void {
    this.element.innerHTML = this.deps.sanitize(html);
    this.deps.onDocumentReplaced?.();
  }

  getText(): string {
    // The styled-caret marker is plumbing, not text — keep it out of the
    // counts, previews and stats the same way innerText skips hidden runs.
    return this.element.innerText.replace(/\u00a0/g, ' ').replace(/\u200B/g, '');
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
    // Strike inside a CHECKED checklist item is a Chrome trap: the item's
    // CSS-painted line-through makes the engine believe the text is already
    // struck, so the toggle silently no-ops (command answers true, DOM never
    // changes, unchecking later reveals no strike). The checked-item toggle
    // is handled by hand instead — wrap/unwrap the selection's runs in
    // <strike>, which the sanitizer already stores.
    if (command === 'strikeThrough' && this.insideCheckedItem()) {
      return this.toggleManualStrike();
    }
    return document.execCommand(command, false);
  }

  /** True when the selection starts inside a checked checklist item. */
  private insideCheckedItem(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }
    const node = selection.getRangeAt(0).startContainer;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const item = base?.closest<HTMLLIElement>('li[data-checked="true"]');
    return !!item && this.element.contains(item);
  }

  /**
   * Strike toggle for checked checklist items: wraps the selection's runs in
   * <strike> (or unwraps them when every covered run is already struck),
   * then announces the edit. extractContents splits partial text nodes and
   * partial strike elements natively, so partial toggles behave too.
   */
  private toggleManualStrike(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      return false;
    }
    // Within one list item the range is purely inline — extract/insert can
    // rework it safely. Across blocks only the per-run wrap is safe.
    const sameBlock = this.blockOf(range.startContainer) === this.blockOf(range.endContainer);
    const texts = this.textNodesInRange(range);
    if (texts.length === 0) {
      return false;
    }
    if (sameBlock) {
      // Toggle off only when every covered run is already struck; otherwise
      // the press means "strike it all". Unwrapping targets the LIVE strike
      // wrappers: extract/insert would only drop the wrapper from a fragment
      // and re-insert the text right back inside the live <strike>.
      const allStruck = texts.every((t) => t.parentElement?.closest('strike, s, del'));
      if (allStruck) {
        const wrappers = new Set<Element>();
        for (const text of texts) {
          const wrapper = text.parentElement?.closest('strike, s, del');
          if (wrapper && this.element.contains(wrapper)) {
            wrappers.add(wrapper);
          }
        }
        wrappers.forEach((el) => this.unwrapElement(el));
      } else {
        const fragment = range.extractContents();
        const strike = document.createElement('strike');
        strike.append(fragment);
        range.insertNode(strike);
        // Native parity: the engine keeps the struck text selected, so the
        // toolbar answers pressed for the run the caret sits in.
        const struck = document.createRange();
        struck.selectNodeContents(strike);
        selection.removeAllRanges();
        selection.addRange(struck);
      }
    } else {
      // Cross-block: wrap the unstruck runs in place, leave the rest alone.
      const wrapTargets = texts.filter((t) => !t.parentElement?.closest('strike, s, del'));
      if (wrapTargets.length === 0) {
        return false;
      }
      for (const text of wrapTargets) {
        this.wrapTextRange(text, range);
      }
    }
    this.announceEdit();
    return true;
  }

  /** The block-level ancestor of a node inside the editor, or null. */
  private blockOf(node: Node): Element | null {
    let el = node instanceof Element ? node : (node.parentElement ?? null);
    while (el && el !== this.element && !BLOCK_SIBLING_TAGS.has(el.tagName)) {
      el = el.parentElement;
    }
    return el && el !== this.element ? el : null;
  }

  /** Non-empty text nodes the range touches, document order. */
  private textNodesInRange(range: Range): Text[] {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue ?? '').length > 0 && range.intersectsNode(node)) {
        texts.push(node as Text);
      }
    }
    return texts;
  }

  /** Wraps the part of `text` the range covers into a fresh <strike>. */
  private wrapTextRange(text: Text, range: Range): void {
    const value = text.nodeValue ?? '';
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : value.length;
    if (end <= start) {
      return;
    }
    let mid: Text = text;
    if (end < value.length) {
      text.splitText(end); // tail stays in the DOM as the next sibling
    }
    if (start > 0) {
      mid = text.splitText(start);
    }
    const strike = document.createElement('strike');
    mid.replaceWith(strike);
    strike.append(mid);
  }

  /** Replaces an element with its children (keeps the selection's host). */
  private unwrapElement(el: Element): void {
    const parent = el.parentNode;
    if (!parent) {
      return;
    }
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    el.remove();
    parent.normalize();
  }

  queryFormat(command: FormatCommand): boolean {
    // Chrome's queryCommandState('strikeThrough') also answers true when the
    // selection merely sits in a checked checklist item — the checklist
    // paints its strike with CSS text-decoration. Compute the state from the
    // stored subset (s/strike/del) so the toolbar only lights up for real
    // user-applied strike.
    if (command === 'strikeThrough') {
      const struck = this.strikeAtCaret();
      return struck !== null;
    }
    return document.queryCommandState(command);
  }

  /** The strike element the caret's anchor sits in, or null. */
  private strikeAtCaret(): Element | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const struck = base?.closest('s, strike, del');
    return struck && this.element.contains(struck) ? struck : null;
  }

  /** True when the selection is a single point inside the note. */
  private selectionIsCollapsed(): boolean {
    const selection = window.getSelection();
    return (
      !!selection &&
      selection.rangeCount === 1 &&
      selection.getRangeAt(0).collapsed &&
      this.element.contains(selection.anchorNode)
    );
  }

  /**
   * Docs behavior for styling at a collapsed caret: what the user types
   * next carries the picked style. execCommand cannot express that for
   * size/color/font/highlight (fontSize is a plain no-op; the others keep
   * the style in Chrome's typing layer and emit <font> tags the sanitizer
   * strips at save). Insert a zero-width-space run styled with the target
   * properties instead — the caret lands inside it, so the following
   * keystrokes join the run, the markup is already the storage subset, and
   * undo removes the run in one step (verified against Chrome's stack).
   */
  private applyCollapsedStyle(styles: Record<string, string>): boolean {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }
    const styleAttr = Object.entries(styles)
      .filter(([, value]) => value !== '')
      .map(([prop, value]) => `${prop}: ${value}`)
      .join('; ');
    if (styleAttr === '') {
      return false;
    }
    // insertHTML (not a manual range.insertNode) so the run stays on
    // Chrome's native undo stack — one Ctrl+Z removes it, style included.
    if (!document.execCommand('insertHTML', false, `<span style="${styleAttr}">${ZERO_WIDTH_SPACE}</span>`)) {
      return false;
    }
    // Chrome leaves the caret right after the inserted run; move it inside,
    // past the marker, so the next keystrokes join the styled run.
    const run = this.zeroWidthRunAtCaret();
    if (run) {
      const caret = document.createRange();
      caret.setStart(run.firstChild!, 1);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    this.announceEdit();
    return true;
  }

  /** The styled-caret run the selection just landed beside, or null. */
  private zeroWidthRunAtCaret(): HTMLElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const anchor = selection.anchorNode;
    const candidates: (Node | null)[] = [
      anchor,
      anchor ? anchor.childNodes[selection.anchorOffset - 1] ?? null : null,
    ];
    for (const candidate of candidates) {
      if (
        candidate instanceof HTMLElement &&
        candidate.tagName === 'SPAN' &&
        candidate.textContent === ZERO_WIDTH_SPACE &&
        this.element.contains(candidate)
      ) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * "None" highlight at a collapsed caret: if the caret sits in a styled
   * caret run, drop that run's background; otherwise plain ink is already
   * the state, so the request is a no-op success.
   */
  private clearCollapsedHighlight(): boolean {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const run = base?.closest<HTMLElement>('span');
    if (run && this.element.contains(run) && run.textContent === ZERO_WIDTH_SPACE) {
      run.style.removeProperty('background-color');
      this.announceEdit();
    }
    return true;
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
    if (!this.canExec()) {
      return false;
    }
    // The bullet button over a checklist converts it to a plain bulleted
    // list (Docs semantics) — the engine's toggle would erase the list.
    if (kind === 'ul' && this.queryListKind() === 'checklist') {
      const lists = this.checklistsAtSelection();
      if (lists.length === 0) {
        return false;
      }
      lists.forEach((list) => list.removeAttribute(CHECKLIST_ATTR));
      this.announceEdit();
      return true;
    }
    if (kind === 'checklist') {
      // Toggling a checklist off hands the blocks back to the engine.
      if (this.queryListKind() === 'checklist') {
        const savedOff = this.captureCaretTextOffset();
        const done = document.execCommand('insertUnorderedList', false);
        this.restoreCaretTextOffset(savedOff);
        return done;
      }
      const savedOn = this.captureCaretTextOffset();
      if (!document.execCommand('insertUnorderedList', false)) {
        return false;
      }
      // Mark the lists the command just produced/touched, then announce:
      // the attribute rewrite below is invisible to execCommand's events.
      this.markSelectionListsAsChecklist();
      this.restoreCaretTextOffset(savedOn);
      this.announceEdit();
      return true;
    }
    const saved = this.captureCaretTextOffset();
    const done = document.execCommand(
      kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList',
      false,
    );
    this.restoreCaretTextOffset(saved);
    return done;
  }

  queryListKind(): ListKind | null {
    if (typeof document.queryCommandState !== 'function') {
      return null;
    }
    if (document.queryCommandState('insertUnorderedList')) {
      return this.listAtSelection()?.hasAttribute(CHECKLIST_ATTR) ? 'checklist' : 'ul';
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
    // Chrome ignores fontSize at a collapsed caret entirely (no typing
    // style either) — the Docs behavior "pick a size, then type" needs the
    // styled-caret run below.
    if (this.selectionIsCollapsed()) {
      return this.applyCollapsedStyle({ 'font-size': `${px}px` });
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
    // At a collapsed caret Chrome answers fontName with a typing style that
    // later wraps typed text in <font face> tags — markup the sanitizer
    // strips at save time. The styled caret run below keeps the output in
    // the span subset.
    if (this.selectionIsCollapsed()) {
      return this.applyCollapsedStyle({ 'font-family': name });
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
    // Same collapsed-caret story as setFontFamily: Chrome's typing style
    // would produce <font color> tags that silently lose their ink at the
    // sanitizer. The styled caret run keeps everything in the subset.
    if (this.selectionIsCollapsed()) {
      return this.applyCollapsedStyle({ color: value });
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
    // "None" at a collapsed caret: plain ink is the absence of a highlight,
    // but if the caret sits in a styled caret run, that run loses its ink.
    if (this.selectionIsCollapsed() && value === 'transparent') {
      return this.clearCollapsedHighlight();
    }
    if (this.selectionIsCollapsed()) {
      return this.applyCollapsedStyle({ 'background-color': value });
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
    this.escapeListAtCaret();
    return document.execCommand('insertHorizontalRule', false);
  }

  /**
   * A table or divider dropped while the caret sits in a list item would be
   * nested inside that <li> (checkbox gutter, strike-through, list indents
   * all leak onto it). Move the caret out of the list first: to the start of
   * the block after the list, or to a fresh paragraph appended after it.
   */
  private escapeListAtCaret(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const node = selection.getRangeAt(0).startContainer;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const item = base?.closest('li');
    const list = item?.closest('ul, ol');
    if (!(list instanceof HTMLElement) || !this.element.contains(list)) {
      return;
    }
    const next = list.nextElementSibling;
    if (next && BLOCK_SIBLING_TAGS.has(next.tagName)) {
      // A block follows the list — aim for its very start.
      const range = document.createRange();
      range.setStart(next, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    // Nothing usable after the list — give the insert a paragraph to land in.
    const paragraph = document.createElement('div');
    paragraph.append(document.createElement('br'));
    list.after(paragraph);
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // -------------------------------------------------------------------------
  // Tables — the table > tbody > tr > td subset. Insertion rides
  // execCommand('insertHTML') so the native undo stack keeps one step; the
  // row/column operations rewrite the DOM by hand and announce themselves.
  // -------------------------------------------------------------------------

  insertTable(rows: number, cols: number): boolean {
    if (!this.canExec()) {
      return false;
    }
    const safeRows = Math.min(Math.max(Math.floor(rows), 1), 20);
    const safeCols = Math.min(Math.max(Math.floor(cols), 1), 10);
    const rowHtml = `<tr>${'<td></td>'.repeat(safeCols)}</tr>`;
    const html = `<table><tbody>${rowHtml.repeat(safeRows)}</tbody></table><div><br></div>`;
    this.escapeListAtCaret();
    if (!document.execCommand('insertHTML', false, html)) {
      return false;
    }
    // Put the caret into the first cell — Chrome leaves it after the table.
    const firstCell = this.element.querySelectorAll('td')[0];
    if (firstCell) {
      const range = document.createRange();
      range.selectNodeContents(firstCell);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    this.announceEdit();
    return true;
  }

  /** The table/cell the selection's anchor sits in, or null. */
  private tableAtSelection(): { table: HTMLTableElement; cell: HTMLTableCellElement } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const cell = base?.closest('td, th');
    const table = cell?.closest('table');
    if (!(cell instanceof HTMLElement) || !(table instanceof HTMLTableElement)) {
      return null;
    }
    if (!this.element.contains(table)) {
      return null;
    }
    return { table, cell: cell as HTMLTableCellElement };
  }

  queryTableContext(): TableCellContext | null {
    const at = this.tableAtSelection();
    if (!at) {
      return null;
    }
    const rows = Array.from(at.table.querySelectorAll('tr'));
    const rowIndex = rows.findIndex((row) => row.contains(at.cell));
    if (rowIndex === -1) {
      return null;
    }
    const cols = rows[rowIndex]!.children.length;
    const colIndex = Array.from(rows[rowIndex]!.children).indexOf(at.cell);
    return { rows: rows.length, cols, rowIndex, colIndex: colIndex === -1 ? 0 : colIndex };
  }

  moveTableCellFocus(step: 1 | -1): boolean {
    const context = this.queryTableContext();
    if (!context) {
      return false;
    }
    const table = this.tableAtSelection()!.table;
    const rows = Array.from(table.querySelectorAll('tr'));
    const targetRow = context.rowIndex;
    const targetCol = context.colIndex + step;
    // Row wrap: past the last/first cell of a row, move to the next/prev row.
    const clampedRow = Math.min(Math.max(targetRow + Math.floor(targetCol / context.cols), 0), rows.length - 1);
    const clampedCol = ((targetCol % context.cols) + context.cols) % context.cols;
    if (clampedRow === context.rowIndex && clampedCol === context.colIndex) {
      return false;
    }
    const cell = rows[clampedRow]?.children[clampedCol];
    if (!(cell instanceof HTMLElement)) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }

  /**
   * The table menu's operations. Every one keeps the caret logically near
   * where it was (the touched cell, its replacement, or the block after the
   * removed table) and announces the rewrite so autosave/toolbar stay live.
   */
  runTableAction(action: string): boolean {
    const context = this.queryTableContext();
    if (!context) {
      return false;
    }
    const { table, cell } = this.tableAtSelection()!;
    const rows = Array.from(table.querySelectorAll('tr'));
    const row = rows[context.rowIndex]!;
    const placeCaret = (target: Element | null): void => {
      if (!target) {
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    switch (action) {
      case 'row-above':
      case 'row-below': {
        const newRow = row.cloneNode(true) as HTMLTableRowElement;
        Array.from(newRow.children).forEach((td) => {
          td.innerHTML = '';
        });
        row.insertAdjacentElement(action === 'row-above' ? 'beforebegin' : 'afterend', newRow);
        const cellIndex = Array.from(row.children).indexOf(cell);
        placeCaret(newRow.children[cellIndex]);
        break;
      }
      case 'col-left':
      case 'col-right': {
        const cellIndex = Array.from(row.children).indexOf(cell);
        const offset = action === 'col-left' ? 0 : 1;
        rows.forEach((r) => {
          const fresh = document.createElement('td');
          r.children[cellIndex]?.insertAdjacentElement(
            offset === 0 ? 'beforebegin' : 'afterend',
            fresh,
          );
        });
        placeCaret(row.children[cellIndex + offset]);
        break;
      }
      case 'row-delete': {
        if (rows.length === 1) {
          table.remove();
          this.caretAfterTable(table);
          break;
        }
        const next = row.nextElementSibling ?? row.previousElementSibling;
        row.remove();
        placeCaret(next?.children[context.colIndex] ?? null);
        break;
      }
      case 'col-delete': {
        const cellIndex = Array.from(row.children).indexOf(cell);
        if (row.children.length === 1) {
          table.remove();
          this.caretAfterTable(table);
          break;
        }
        rows.forEach((r) => r.children[cellIndex]?.remove());
        placeCaret(row.children[Math.min(cellIndex, row.children.length - 1)]);
        break;
      }
      case 'table-delete': {
        table.remove();
        this.caretAfterTable(table);
        break;
      }
      default:
        return false;
    }
    this.announceEdit();
    return true;
  }

  /** After a table disappears, park the caret in the block that follows it. */
  private caretAfterTable(table: HTMLTableElement): void {
    const next = table.nextElementSibling;
    if (next) {
      const range = document.createRange();
      range.selectNodeContents(next);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  private canExec(): boolean {
    return typeof document.execCommand === 'function';
  }

  // -------------------------------------------------------------------------
  // Checklists — the data-rich-checklist subset. Storage sees only the two
  // attributes (see the sanitizer allowlist); the boxes themselves are
  // painted by CSS, so no foreign element ever enters the note.
  // -------------------------------------------------------------------------

  /** The UL at/around the selection, or null. */
  private listAtSelection(): HTMLUListElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const list = base?.closest('ul');
    return list && this.element.contains(list) ? (list as HTMLUListElement) : null;
  }

  /**
   * Chrome's list commands reset a collapsed caret to the start of the item
   * they produce. Remember the caret as a character offset inside its
   * block's text so toggleList can re-anchor it after the rewrite. Only the
   * collapsed case needs this: ranged toggles leave the selection to the
   * engine, which keeps it across the produced items.
   */
  private captureCaretTextOffset(): { text: string; offset: number } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const block = node.parentElement?.closest('div, p, h1, h2, h3, li, blockquote, pre');
    if (!block || !this.element.contains(block)) {
      return null;
    }
    const leading = document.createRange();
    leading.selectNodeContents(block);
    leading.setEnd(range.startContainer, range.startOffset);
    return { text: block.textContent ?? '', offset: leading.toString().length };
  }

  /**
   * Puts the caret back where captureCaretTextOffset found it: the item
   * carrying the same text, walked to the same character offset. Offset 0
   * needs no work — Chrome already left the caret there.
   */
  private restoreCaretTextOffset(saved: { text: string; offset: number } | null): void {
    if (!saved || saved.offset === 0) {
      return;
    }
    for (const li of this.element.querySelectorAll('li')) {
      if ((li.textContent ?? '') !== saved.text) {
        continue;
      }
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      let remaining = saved.offset;
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        const length = text.nodeValue?.length ?? 0;
        if (remaining <= length) {
          const range = document.createRange();
          range.setStart(text, remaining);
          range.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
        remaining -= length;
      }
      return;
    }
  }

  /** The checklists holding the selection's start and end blocks. */
  private checklistsAtSelection(): HTMLUListElement[] {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return [];
    }
    const range = selection.getRangeAt(0);
    const found = new Set<HTMLUListElement>();
    for (const node of [range.startContainer, range.endContainer]) {
      const base = node instanceof Element ? node : (node?.parentElement ?? null);
      const list = base?.closest('ul');
      if (list instanceof HTMLUListElement && list.hasAttribute(CHECKLIST_ATTR)) {
        found.add(list);
      }
    }
    return Array.from(found);
  }

  /**
   * After insertUnorderedList, every UL holding the selection's edges is a
   * list the command just produced or merged — mark those as checklists and
   * give any item without a stated state the unchecked default.
   */
  private markSelectionListsAsChecklist(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    const marked = new Set<HTMLUListElement>();
    for (const node of [range.startContainer, range.endContainer]) {
      const base = node instanceof Element ? node : (node?.parentElement ?? null);
      const list = base?.closest('ul');
      if (list instanceof HTMLUListElement && this.element.contains(list)) {
        marked.add(list);
      }
    }
    marked.forEach((list) => {
      list.setAttribute(CHECKLIST_ATTR, 'true');
      list.querySelectorAll('li').forEach((li) => {
        if (!li.hasAttribute(CHECKED_ATTR)) {
          li.setAttribute(CHECKED_ATTR, 'false');
        }
      });
    });
  }

  /**
   * The boxes are painted by CSS in the item's left gutter — a click there
   * toggles the state instead of moving the caret.
   */
  private toggleChecklistItem(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const item = target?.closest('li');
    if (!item || !this.element.contains(item)) {
      return;
    }
    const list = item.closest('ul');
    if (!(list instanceof HTMLUListElement) || !list.hasAttribute(CHECKLIST_ATTR)) {
      return;
    }
    const rect = item.getBoundingClientRect();
    if (event.clientX - rect.left > CHECKLIST_GUTTER_PX) {
      return;
    }
    const next = item.getAttribute(CHECKED_ATTR) === 'true' ? 'false' : 'true';
    item.setAttribute(CHECKED_ATTR, next);
    this.announceEdit();
  }

  /**
   * Enter clones the item's attributes into its continuation — an empty
   * checked clone reads as a done item with no text. Docs starts the next
   * item unchecked, so strip the state when the split left one empty.
   */
  private uncheckEmptyItemUnderCaret(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const node = selection.getRangeAt(0).startContainer;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    const item = base?.closest('li');
    if (
      item &&
      this.element.contains(item) &&
      (item.textContent ?? '').trim() === '' &&
      item.getAttribute(CHECKED_ATTR) === 'true'
    ) {
      item.setAttribute(CHECKED_ATTR, 'false');
      this.announceEdit();
    }
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
    // A fresh note's first line is bare text directly in #note — no block
    // element exists to carry the margin. Give the run a real block first,
    // the same wrap formatBlock performs.
    if (this.selectionBlocks().length === 0) {
      if (!this.canExec() || !document.execCommand('formatBlock', false, '<div>')) {
        return false;
      }
    }
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
