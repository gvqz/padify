/**
 * The document-model engine — the EditorPort implementation over the
 * canonical model (see model/).
 *
 * THE ONE DISCIPLINE: typing flows natively through the contenteditable
 * surface (the browser's caret, IME and undo-of-nothing), and every
 * structured change flows through the model — absorb the surface into a
 * canonical tree, run one typed operation on it in stream coordinates,
 * paint the model back onto the surface, restore the caret the operation
 * asked for, and announce. One history covers native edits and commands
 * alike (beforeinput opens a group per burst, commands are a group each);
 * one announce path serves every mutation; one serializer feeds storage.
 *
 * The legacy engine compensated for document.execCommand after the fact —
 * font-tag normalization, collapsed-caret no-ops, caret re-anchoring after
 * list toggles, eight-plus undo-bypassing rewrite paths. Here there is no
 * engine command to compensate for: operations are typed, tested without
 * a browser, and canonical by construction.
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
import { rgbStringToHex } from './color-picker';
import { ensureMathId, MATH_ID_ATTR, renderMathIn } from './math';
import { parse, serialize, collapseEmptySurface, surfaceLooksEmpty } from './model/document';
import {
  captureOffsets,
  nodeAtPath,
  ordered,
  pathTo,
  placeCaretAtSpot,
  placeRange,
  spotAtStream,
  streamLengthOf,
  type DomSpot,
} from './model/selection';
import {
  applyBlockTag,
  clearInlineStyle,
  clearStyledCaretRun,
  flipChecklistItem,
  insertPlainText,
  nestListItem,
  plantLink,
  plantMath,
  plantRule,
  plantStyledCaret,
  plantTable,
  removeInlineFormatting,
  retargetAnchorAt,
  retargetMath,
  runTableActionAt,
  setBlockStyleProp,
  setInlineStyle,
  shiftBlockIndent,
  splitScriptChain,
  toggleListKind,
  toggleMark,
  uncheckEmptyItems,
  unnestListItem,
  unwrapLinkAt,
  wrapLink,
  type OpIntent,
  type OpResult,
} from './model/ops';
import { CHECKLIST_ATTR } from './model/document';
import { ModelHistory } from './model/history';

const FORMAT_MARKS: Readonly<Record<FormatCommand, 'b' | 'i' | 'u' | 'strike'>> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  // The long spelling: the surface and the specs speak <strike> (the
  // subset admits both; the engine emits one).
  strikeThrough: 'strike',
};

/** The caret-parking gutter the checklist boxes paint (CSS left column). */
const CHECKLIST_GUTTER_PX = 30;

/** Typing bursts that continue the open group instead of opening one. */
const TYPING_INPUT_TYPES = new Set(['insertText', 'insertCompositionText']);

/**
 * An operation's selection request, normalized from its intent: a spot
 * (mapped node-for-node onto the repainted surface), or a stream range to
 * keep selected.
 */
interface Placement {
  spot?: DomSpot;
  range?: [number, number];
}

/**
 * A mark armed at a collapsed caret (Docs' typing style): applied to the
 * next inserted text by the input handler, then cleared. State instead of
 * a zero-width marker run — a marker inside the mark would pollute the
 * note's text, and the scripts spec pins that text clean.
 */
type PendingMark = FormatCommand | 'super' | 'sub';

export interface ModelPortDeps {
  /**
   * The storage-format sanitizer (storage-subset.ts). Entry sanitation for
   * setHtml/renderHtml — and the final wall on the way out of getHtml, so
   * a caller can never smuggle a declaration outside the subset into
   * storage through the engine.
   */
  sanitize: (html: string) => string;

  /**
   * Called after setHtml replaces the content — the commit hook. The
   * TabManager wiring persists the replacement and refreshes the tab
   * label. renderHtml never fires it: painting a surface is not an edit.
   */
  onDocumentReplaced?: () => void;
}

export class ModelPort implements EditorPort {
  private readonly element: HTMLElement;
  private readonly deps: ModelPortDeps;

  /** The canonical tree. Lazily absorbed; always fresh on read/command. */
  private model: HTMLElement;
  private readonly history = new ModelHistory();

  private pendingMark: PendingMark | null = null;

  /** Composition guard: no absorbing, painting or normalizing mid-IME. */
  private composing = false;

  /**
   * True while a typing burst's group is open: the first beforeinput of a
   * burst opens the group (snapshotting the pre-burst state); the rest
   * continue it. Closed by any other input type, any command, any undo.
   */
  private typingGroupOpen = false;

  /** Re-entrancy guard for the delete normalization pass. */
  private normalizing = false;

  constructor(element: HTMLElement, deps: ModelPortDeps) {
    this.element = element;
    this.deps = deps;
    this.model = parse('');

    // Checklist gutter clicks live on the surface itself; link clicks and
    // equation clicks announce themselves for the toolbar's popovers. All
    // three only REPORT — the mutations route through the model.
    element.addEventListener('click', (event) => this.onSurfaceClick(event as MouseEvent));
    element.addEventListener('keydown', (event) => this.onKeyDown(event));
    element.addEventListener('beforeinput', (event) => this.onBeforeInput(event as InputEvent));
    element.addEventListener('input', (event) => this.handleInput(event as InputEvent));
    element.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    element.addEventListener('compositionend', () => {
      this.composing = false;
    });
  }

  // -------------------------------------------------------------------------
  // The pipeline.
  // -------------------------------------------------------------------------

  /** Absorbs the surface into the model (fresh canonical tree). */
  private absorb(): void {
    this.model = parse(this.element.innerHTML);
  }

  /** Paints markup onto the surface: replace, render math. */
  private paint(markup: string): void {
    this.element.innerHTML = markup;
    renderMathIn(this.element);
  }

  /** Announces a model-made edit (autosave, toolbar, indicator follow). */
  private announce(): void {
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Where an operation wants the selection (its intent, normalized). */
  private convert(intent: OpIntent): Placement | null {
    if ('spot' in intent && intent.spot) {
      return { spot: intent.spot };
    }
    if ('range' in intent && intent.range) {
      return { range: intent.range };
    }
    return null;
  }

  /**
   * The command pipeline: capture selection → absorb → snapshot pre-state
   * → operation → history group → paint → restore the operation's intent
   * → announce. Every port mutation funnels through here, which is what
   * makes undo complete and the output canonical for all of them.
   */
  private command(build: (model: HTMLElement, coverage: [number, number]) => OpResult): boolean {
    this.typingGroupOpen = false;
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    const coverage = ordered(selection);
    this.absorb();
    const pre = serialize(this.model);
    const result = build(this.model, coverage);
    if (!result.changed) {
      return false;
    }
    const placement = result.intent ? this.convert(result.intent) : null;
    const preserve = result.intent && 'preserve' in result.intent ? selection : null;
    this.history.openGroup(pre);
    this.paint(serialize(this.model));
    this.applyPlacement(placement, preserve, selection);
    this.announce();
    return true;
  }

  /**
   * The same pipeline, without opening a new history group: for the
   * adjustments that belong to the group a beforeinput already opened
   * (the pending mark wrapping its burst's first insertion; the Enter
   * continuation uncheck). One group, one undo step, engine and native
   * edits alike.
   */
  private commandInOpenGroup(
    build: (model: HTMLElement, coverage: [number, number]) => OpResult,
  ): boolean {
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    const coverage = ordered(selection);
    this.absorb();
    const result = build(this.model, coverage);
    if (!result.changed) {
      return false;
    }
    const placement = result.intent ? this.convert(result.intent) : null;
    const preserve = result.intent && 'preserve' in result.intent ? selection : null;
    this.paint(serialize(this.model));
    this.applyPlacement(placement, preserve, selection);
    this.announce();
    return true;
  }

  /**
   * The selectionless pipeline: for mutations that do not address the
   * caret at all (an equation edit from its bubble, where the selection
   * sits in the popover's input, not the note). Absorb → operate →
   * history → paint; the selection is only restored when one exists in
   * the note.
   */
  private mutate(build: (model: HTMLElement) => OpResult): boolean {
    this.typingGroupOpen = false;
    this.absorb();
    const pre = serialize(this.model);
    const result = build(this.model);
    if (!result.changed) {
      return false;
    }
    const placement = result.intent ? this.convert(result.intent) : null;
    this.history.openGroup(pre);
    this.paint(serialize(this.model));
    const selection = captureOffsets(this.element);
    if (selection) {
      this.applyPlacement(placement, null, selection);
    }
    this.announce();
    return true;
  }

  /** Restores the selection after paint: the intent, else the preserved.
   *
   * A spot intent maps node-for-node onto the repainted surface — paint
   * renders the model exactly, so the model tree's child-index paths
   * address the same nodes on the surface. That keeps atom boundaries
   * exact (after a math shell, inside a marker run past its zero-width
   * character), which offsets alone cannot express.
   */
  private applyPlacement(
    placement: Placement | null,
    preserve: { anchor: number; focus: number } | null,
    selection: { anchor: number; focus: number } | null,
  ): void {
    const max = streamLengthOf(this.element);
    if (placement && 'spot' in placement && placement.spot) {
      const mapped = this.mapSpotToSurface(placement.spot);
      if (mapped && placeCaretAtSpot(this.element, mapped)) {
        return;
      }
    } else if (placement && 'range' in placement && placement.range) {
      const [from, to] = placement.range;
      if (from === to) {
        const spot = spotAtStream(this.element, Math.min(from, max));
        if (placeCaretAtSpot(this.element, spot)) {
          return;
        }
      } else {
        placeRange(this.element, Math.min(from, max), Math.min(to, max));
        return;
      }
    }
    if (preserve || selection) {
      this.reselect((preserve ?? selection)!, max);
    }
  }

  /** A model-space spot, resolved to the same position on the surface. */
  private mapSpotToSurface(spot: DomSpot): DomSpot | null {
    const anchorNode: Node = spot.kind === 'text' ? spot.node : spot.node;
    const path = pathTo(this.model, anchorNode);
    if (!path) {
      return null;
    }
    const target = nodeAtPath(this.element, path);
    if (!target) {
      return null;
    }
    return spot.kind === 'text'
      ? { kind: 'text', node: target as Text, raw: spot.raw }
      : { kind: 'element', node: target as Element, childIndex: spot.childIndex };
  }

  private reselect(selection: { anchor: number; focus: number }, max: number): void {
    const anchor = Math.min(selection.anchor, max);
    const focus = Math.min(selection.focus, max);
    if (anchor === focus) {
      placeCaretAtSpot(this.element, spotAtStream(this.element, anchor));
    } else {
      placeRange(this.element, anchor, focus);
    }
  }

  // -------------------------------------------------------------------------
  // Reading the note.
  // -------------------------------------------------------------------------

  getHtml(): string {
    this.absorb();
    return this.deps.sanitize(serialize(this.model));
  }

  setHtml(html: string): void {
    this.renderHtml(html);
    this.deps.onDocumentReplaced?.();
  }

  renderHtml(html: string): void {
    const canonical = this.deps.sanitize(html);
    this.model = parse(canonical);
    this.history.reset();
    this.history.know(canonical);
    this.paint(canonical);
    // A stored "empty but not really" state (a bare br, an emptied
    // skeleton) displays as a truly empty surface — same rule the load
    // path always applied, now in the engine that paints it.
    collapseEmptySurface(this.element);
    this.pendingMark = null;
  }

  getText(): string {
    // innerText carries the visual reading (block boundaries as \n); in
    // non-visual environments (the jsdom suite) it is undefined, and the
    // textContent fallback answers the same string for inline-only notes.
    const raw =
      typeof this.element.innerText === 'string'
        ? this.element.innerText
        : (this.element.textContent ?? '');
    return raw.replace(/\u00a0/g, ' ').replace(/\u200B/g, '');
  }

  isEmpty(): boolean {
    return this.getText().trim() === '';
  }

  normalizeEmptySurface(): boolean {
    return collapseEmptySurface(this.element);
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
    const element = anchor as Element;
    const before = element.textContent ?? '';
    return offset > 0 ? before.slice(-1) : before;
  }

  // -------------------------------------------------------------------------
  // Formatting.
  // -------------------------------------------------------------------------

  insertText(text: string): boolean {
    if (text === '') {
      return false;
    }
    return this.command((model, coverage) => insertPlainText(model, coverage, text));
  }

  applyFormat(command: EditorCommand): boolean {
    if (command === 'removeFormat') {
      const selection = captureOffsets(this.element);
      if (!selection) {
        return false;
      }
      const coverage = ordered(selection);
      if (coverage[1] <= coverage[0]) {
        return false;
      }
      return this.command((model) => removeInlineFormatting(model, coverage));
    }
    const mark = FORMAT_MARKS[command];
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    const coverage = ordered(selection);
    if (coverage[1] <= coverage[0]) {
      // Collapsed caret: arm the mark for the next typed text (Docs'
      // typing style — the scripts spec pins that text clean, so no marker
      // run here; the input handler wraps the insertion the moment it
      // lands).
      this.pendingMark = command;
      return true;
    }
    return this.command((model) => toggleMark(model, coverage, mark));
  }

  /** The stored spellings of each format family (corpus admits both). */
  private static readonly FORMAT_FAMILIES: Readonly<Record<FormatCommand, readonly string[]>> = {
    bold: ['b', 'strong'],
    italic: ['i', 'em'],
    underline: ['u'],
    strikeThrough: ['s', 'strike', 'del'],
  };

  queryFormat(command: FormatCommand): boolean {
    if (this.pendingMark === command) {
      return true;
    }
    return ModelPort.FORMAT_FAMILIES[command].some((tag) => this.inlineAtCaret(tag) !== null);
  }

  applyBlockFormat(format: BlockFormat): boolean {
    return this.command((model, coverage) => applyBlockTag(model, coverage, format));
  }

  queryBlockFormat(): BlockFormat | null {
    const block = this.blockAtCaret();
    if (!block) {
      return 'p';
    }
    const tag = block.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
      return tag.toLowerCase() as BlockFormat;
    }
    if (tag === 'BLOCKQUOTE') {
      return 'blockquote';
    }
    if (tag === 'PRE') {
      return 'pre';
    }
    return 'p';
  }

  toggleList(kind: ListKind): boolean {
    return this.command((model, coverage) => toggleListKind(model, coverage, kind));
  }

  queryListKind(): ListKind | null {
    const list = this.listAtCaret();
    if (!list) {
      return null;
    }
    if (list.tagName === 'OL') {
      return 'ol';
    }
    return list.hasAttribute(CHECKLIST_ATTR) ? 'checklist' : 'ul';
  }

  // -------------------------------------------------------------------------
  // Links.
  // -------------------------------------------------------------------------

  insertLink(href: string): boolean {
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    if (ordered(selection)[1] <= ordered(selection)[0]) {
      return false; // nothing to link — the contract promises false
    }
    return this.command((model, coverage) => wrapLink(model, coverage, href));
  }

  insertLinkAsText(href: string): boolean {
    return this.command((model, coverage) => plantLink(model, coverage[0], href));
  }

  removeLink(): boolean {
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    return this.command((model, coverage) => unwrapLinkAt(model, coverage[0]));
  }

  queryLinkHref(): string | null {
    const anchor = this.inlineAtCaret('a');
    return anchor?.getAttribute('href') ?? null;
  }

  retargetLink(href: string): boolean {
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    return this.command((model, coverage) => retargetAnchorAt(model, coverage[0], href));
  }

  // -------------------------------------------------------------------------
  // Math equations.
  // -------------------------------------------------------------------------

  insertMath(latex: string): boolean {
    const value = latex.trim();
    if (value === '') {
      return false;
    }
    return this.command((model, coverage) => plantMath(model, coverage[0], value));
  }

  queryMathAtCaret(): { latex: string; id: string } | null {
    const shell = this.shellAtCaret();
    if (!shell) {
      return null;
    }
    return { latex: shell.getAttribute('data-latex') ?? '', id: ensureMathId(shell) };
  }

  updateMath(id: string, latex: string): boolean {
    const value = latex.trim();
    if (value === '' || !/^m\d+$/.test(id)) {
      return false;
    }
    const shell = this.element.querySelector<HTMLElement>(`.padify-math[${MATH_ID_ATTR}="${id}"]`);
    if (!shell) {
      return false;
    }
    const shells = Array.from(this.element.querySelectorAll('.padify-math'));
    const index = shells.indexOf(shell);
    if (index === -1) {
      return false;
    }
    return this.mutate((model) => retargetMath(model, index, value));
  }

  undo(): boolean {
    this.absorb();
    const current = serialize(this.model);
    const restore = this.history.undo(current);
    if (restore === null) {
      return false;
    }
    const selection = captureOffsets(this.element);
    this.pendingMark = null;
    this.paint(restore);
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
    if (selection) {
      this.reselect(selection, streamLengthOf(this.element));
    } else {
      placeCaretAtSpot(this.element, spotAtStream(this.element, streamLengthOf(this.element)));
    }
    return true;
  }

  redo(): boolean {
    this.absorb();
    const current = serialize(this.model);
    const restore = this.history.redo(current);
    if (restore === null) {
      return false;
    }
    const selection = captureOffsets(this.element);
    this.pendingMark = null;
    this.paint(restore);
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
    if (selection) {
      this.reselect(selection, streamLengthOf(this.element));
    } else {
      placeCaretAtSpot(this.element, spotAtStream(this.element, streamLengthOf(this.element)));
    }
    return true;
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  // -------------------------------------------------------------------------
  // The Docs-style vocabulary.
  // -------------------------------------------------------------------------

  setFontSize(px: number): boolean {
    if (!Number.isFinite(px) || px < 1 || px > 400) {
      return false;
    }
    return this.applyInlineStyle('font-size', `${px}px`);
  }

  setFontFamily(family: string): boolean {
    const name = family.trim().replace(/["']/g, '');
    if (name === '') {
      return false;
    }
    return this.applyInlineStyle('font-family', name);
  }

  setTextColor(color: string): boolean {
    const value = color.trim();
    if (value === '') {
      return false;
    }
    return this.applyInlineStyle('color', value);
  }

  queryTextColor(): string | null {
    const run = this.styledSpanAtCaret('color');
    if (!run) {
      return null;
    }
    return rgbStringToHex(run);
  }

  setHighlight(color: string): boolean {
    const value = color.trim();
    if (value === '') {
      return false;
    }
    if (value === 'transparent') {
      return this.clearHighlight();
    }
    return this.applyInlineStyle('background-color', value);
  }

  /**
   * "None": a collapsed caret in a styled run clears that run's ink; a
   * ranged selection strips the declaration from every span it touches
   * (entirely — Chrome's hilite-None semantics, pinned by the highlight
   * spec); nothing to clear is a no-op success.
   */
  private clearHighlight(): boolean {
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    const coverage = ordered(selection);
    if (coverage[1] > coverage[0]) {
      return this.command((model) => clearInlineStyle(model, coverage, 'background-color'));
    }
    // Collapsed: the styled run the caret sits in, addressed structurally
    // (a marker run holds no stream position).
    const runIndex = this.styledRunIndexAtCaret();
    if (runIndex === null) {
      return true; // nothing to clear — plain ink is already the state
    }
    return this.command((model) => clearStyledCaretRun(model, runIndex));
  }

  /** The index of the styled caret run the caret sits in, or null. */
  private styledRunIndexAtCaret(): number | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    let el: HTMLElement | null =
      selection.getRangeAt(0).startContainer instanceof HTMLElement
        ? (selection.getRangeAt(0).startContainer as HTMLElement)
        : selection.getRangeAt(0).startContainer.parentElement;
    let run: HTMLElement | null = null;
    while (el && el !== this.element) {
      if (el.tagName === 'SPAN' && el.textContent === '\u200B' && el.getAttribute('style')) {
        run = el;
        break;
      }
      el = el.parentElement;
    }
    if (!run) {
      return null;
    }
    const runs = Array.from(this.element.querySelectorAll('span')).filter(
      (span) => span.textContent === '\u200B' && span.getAttribute('style'),
    );
    const index = runs.indexOf(run);
    return index === -1 ? null : index;
  }

  applyScript(type: ScriptType): boolean {
    const tag = type === 'super' ? 'sup' : 'sub';
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    const coverage = ordered(selection);
    if (coverage[1] > coverage[0]) {
      return this.command((model) => toggleMark(model, coverage, tag));
    }
    // Collapsed caret. Inside a live script: split out of it (nested
    // chains repaired in one press, the guard keeps typing plain).
    if (this.inlineAtCaret(tag)) {
      const opposite = type === 'super' ? ('sub' as const) : ('sup' as const);
      return this.command((model) => splitScriptChain(model, coverage[0], tag, opposite));
    }
    // Bare caret: arm the script for the next typed text.
    this.pendingMark = type;
    return true;
  }

  queryScript(type: ScriptType): boolean {
    if (this.pendingMark === type) {
      return true;
    }
    return this.inlineAtCaret(type === 'super' ? 'sup' : 'sub') !== null;
  }

  applyAlignment(align: Alignment): boolean {
    return this.command((model, coverage) =>
      setBlockStyleProp(model, coverage, 'text-align', align),
    );
  }

  queryAlignment(): Alignment | null {
    const block = this.blockAtCaret();
    if (!block) {
      return 'left';
    }
    const value = block.getAttribute('style')?.match(/text-align:\s*(\w+)/)?.[1];
    if (value === 'center' || value === 'right' || value === 'justify') {
      return value;
    }
    return 'left';
  }

  indent(): boolean {
    if (this.queryListKind() !== null) {
      return this.command((model, coverage) => nestListItem(model, coverage[0]));
    }
    return this.command((model, coverage) => shiftBlockIndent(model, coverage, 1));
  }

  outdent(): boolean {
    if (this.queryListKind() !== null) {
      return this.command((model, coverage) => unnestListItem(model, coverage[0]));
    }
    return this.command((model, coverage) => shiftBlockIndent(model, coverage, -1));
  }

  insertHorizontalRule(): boolean {
    return this.command((model, coverage) => plantRule(model, coverage[0]));
  }

  // -------------------------------------------------------------------------
  // Tables.
  // -------------------------------------------------------------------------

  insertTable(rows: number, cols: number): boolean {
    return this.command((model, coverage) => plantTable(model, coverage[0], rows, cols));
  }

  queryTableContext(): TableCellContext | null {
    const at = this.cellAtCaret();
    if (!at) {
      return null;
    }
    const rows = Array.from(at.table.querySelectorAll('tr'));
    const rowIndex = rows.findIndex((row) => row.contains(at.cell));
    if (rowIndex === -1) {
      return null;
    }
    const cols = rows[rowIndex]!.children.length;
    const colIndex = Array.prototype.indexOf.call(rows[rowIndex]!.children, at.cell);
    return { rows: rows.length, cols, rowIndex, colIndex: colIndex === -1 ? 0 : colIndex };
  }

  /** The table + cell the caret sits in — structural, from the live
   *  selection (an empty table holds no stream positions to point at). */
  private cellAtCaret(): { table: HTMLTableElement; cell: HTMLTableCellElement } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== this.element) {
      if (el.tagName === 'TD' || el.tagName === 'TH') {
        const table = el.closest('table');
        if (table instanceof HTMLTableElement && this.element.contains(table)) {
          return { table, cell: el as HTMLTableCellElement };
        }
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  moveTableCellFocus(step: 1 | -1): boolean {
    const context = this.queryTableContext();
    if (!context) {
      return false;
    }
    const at = this.cellAtCaret();
    if (!at) {
      return false;
    }
    const rows = Array.from(at.table.querySelectorAll('tr'));
    const targetCol = context.colIndex + step;
    const clampedRow = Math.min(
      Math.max(context.rowIndex + Math.floor(targetCol / context.cols), 0),
      rows.length - 1,
    );
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
    const live = window.getSelection();
    live?.removeAllRanges();
    live?.addRange(range);
    return true;
  }

  runTableAction(action: string): boolean {
    const at = this.cellAtCaret();
    if (!at) {
      return false;
    }
    // cellAtCaret reads the live surface; the operation runs on the model.
    // Same structure after absorb, so the surface nodes map to their model
    // counterparts by child-index path.
    return this.command((model) => {
      const table = this.surfaceNodeInModel(at.table) as HTMLTableElement | null;
      const cell = this.surfaceNodeInModel(at.cell) as HTMLTableCellElement | null;
      if (!(table instanceof HTMLTableElement) || !(cell instanceof HTMLTableCellElement)) {
        return { changed: false };
      }
      return runTableActionAt(model, table, cell, action);
    });
  }

  /** The model counterpart of a surface node (same structure, by path). */
  private surfaceNodeInModel(node: Node): Node | null {
    const path = pathTo(this.element, node);
    return path ? nodeAtPath(this.model, path) : null;
  }

  // -------------------------------------------------------------------------
  // Surface event plumbing.
  // -------------------------------------------------------------------------

  /**
   * Links and equations announce their clicks for the toolbar's popovers
   * (the chip under a link, the equation bubble); checklist gutter clicks
   * toggle the box through the model. Nothing here mutates the DOM by
   * hand — the mutations are one command away, in the model.
   */
  private onSurfaceClick(mouse: MouseEvent): void {
    if (mouse.button !== 0) {
      return;
    }
    const target = mouse.target as Element | null;

    // Link chip / Ctrl+click-open.
    const anchor = target?.closest?.('a');
    if (anchor && this.element.contains(anchor)) {
      const href = anchor.getAttribute('href');
      if (href) {
        document.dispatchEvent(
          new CustomEvent('padify:link-click', {
            detail: { href, anchor, openInNewTab: mouse.ctrlKey || mouse.metaKey },
          }),
        );
        return;
      }
    }

    // Equation bubble.
    const shell = target?.closest?.('.padify-math');
    if (shell instanceof HTMLElement && this.element.contains(shell)) {
      document.dispatchEvent(
        new CustomEvent('padify:math-click', {
          detail: { id: ensureMathId(shell), latex: shell.getAttribute('data-latex') ?? '' },
        }),
      );
      return;
    }

    // Checklist gutter toggle.
    const item = target?.closest?.('li');
    const list = item?.closest('ul');
    if (
      item instanceof HTMLElement &&
      list instanceof HTMLElement &&
      list.hasAttribute(CHECKLIST_ATTR) &&
      this.element.contains(item)
    ) {
      const rect = item.getBoundingClientRect();
      if (mouse.clientX - rect.left > CHECKLIST_GUTTER_PX) {
        return;
      }
      const lists = Array.from(this.element.querySelectorAll(`ul[${CHECKLIST_ATTR}]`));
      const listIndex = lists.indexOf(list);
      const itemIndex = Array.prototype.indexOf.call(list.children, item);
      if (listIndex === -1 || itemIndex === -1) {
        return;
      }
      this.command((model) => flipChecklistItem(model, listIndex, itemIndex));
    }
  }

  /**
   * Undo/redo interception: the engine owns history, so the native stack
   * must never run behind it (a native undo would rewrite the surface
   * without the model or the history knowing). Keydown catches the
   * shortcuts; beforeinput catches the mobile/IME history events.
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (!event.shiftKey && key === 'z') {
      event.preventDefault();
      this.undo();
      return;
    }
    if (!event.shiftKey && key === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (event.shiftKey && key === 'z') {
      event.preventDefault();
      this.redo();
    }
  }

  /**
   * Group boundaries: a burst of same-kind typing continues the open
   * group (one undo step for the whole phrase); anything else opens a new
   * one, snapshotting the pre-group state before the browser edits.
   */
  private onBeforeInput(event: InputEvent): void {
    if (this.composing) {
      return;
    }
    const type = event.inputType ?? '';
    if (type === 'historyUndo') {
      event.preventDefault();
      this.undo();
      return;
    }
    if (type === 'historyRedo') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (type === '') {
      return;
    }
    if (TYPING_INPUT_TYPES.has(type)) {
      if (this.typingGroupOpen) {
        return; // continuation of the open burst
      }
      this.typingGroupOpen = true;
      this.absorb();
      this.history.openGroup(serialize(this.model));
      return;
    }
    this.typingGroupOpen = false;
    this.absorb();
    this.history.openGroup(serialize(this.model));
  }

  /**
   * Post-edit: arm the pending mark onto the just-typed text (the input's
   * data), clear it on anything that is not that insertion, normalize the
   * emptied note after deletes, and uncheck an empty checked item after
   * Enter — all inside the group the beforeinput opened.
   */
  private handleInput(event: InputEvent): void {
    if (this.composing) {
      return;
    }
    const type = event.inputType ?? '';

    // Pending mark: wrap the inserted text, once — inside the burst's own
    // group (its beforeinput opened it), so one undo removes text + wrap.
    if (this.pendingMark !== null && type === 'insertText' && typeof event.data === 'string') {
      const mark = this.pendingMark;
      this.pendingMark = null;
      const data = event.data;
      if (data !== '') {
        const wrapped = this.commandInOpenGroup((model, coverage) => {
          if (coverage[1] > coverage[0]) {
            return { changed: false };
          }
          // Cover the just-typed characters: they end at the caret.
          const caret = coverage[0];
          const from = Math.max(caret - data.length, 0);
          return toggleMark(
            model,
            [from, caret],
            mark === 'super' ? 'sup' : mark === 'sub' ? 'sub' : FORMAT_MARKS[mark as FormatCommand],
          );
        });
        if (wrapped) {
          // Mid-burst: the caret must be a COLLAPSED caret at the wrapped
          // run's end — the wrap's keep-selected restore would otherwise
          // make the next keystroke REPLACE the just-wrapped text.
          const selection = captureOffsets(this.element);
          if (selection) {
            this.reselect(
              { anchor: selection.focus, focus: selection.focus },
              streamLengthOf(this.element),
            );
          }
        }
      }
      return;
    }
    if (this.pendingMark !== null && type !== '' && !TYPING_INPUT_TYPES.has(type)) {
      this.pendingMark = null;
    }

    // Delete normalization: the emptied note becomes truly empty.
    if (type.startsWith('delete') && !this.normalizing) {
      this.normalizeAfterDelete();
      return;
    }

    // Enter in a checklist: an empty checked continuation unchecks —
    // part of the Enter's own group.
    if (type === 'insertParagraph') {
      this.commandInOpenGroup((model) => uncheckEmptyItems(model));
    }
  }

  /**
   * Deleting everything leaves engines' skeletons (a bare br, an emptied
   * heading or list). The emptied note becomes truly empty — placeholder
   * back, caret on the first line, typing continues plain. Part of the
   * delete's own history group (the beforeinput already snapshotted the
   * pre-delete state), so one undo restores the deleted text.
   */
  private normalizeAfterDelete(): boolean {
    if (this.normalizing) {
      return false;
    }
    if (!this.isCaretInside()) {
      return false;
    }
    if (!surfaceLooksEmpty(this.element)) {
      return false;
    }
    this.normalizing = true;
    try {
      this.model = parse('');
      this.paint('');
      // The caret anchors at the very start of the surface — the only
      // position that renders on the placeholder's line.
      placeCaretAtSpot(this.element, { kind: 'element', node: this.element, childIndex: 0 });
      this.announce();
      return true;
    } finally {
      this.normalizing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Surface reads for the queries (fresher than any model: no absorb).
  // -------------------------------------------------------------------------

  private inlineAtCaret(tag: string): HTMLElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    const upper = tag.toUpperCase();
    while (el && el !== this.element) {
      if (el.tagName === upper) {
        return el;
      }
      if (el.tagName === 'LI' || el.tagName === 'TD' || el.tagName === 'TH') {
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  private blockAtCaret(): HTMLElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== this.element) {
      if (/^(DIV|P|H1|H2|H3|BLOCKQUOTE|PRE|LI|TD|TH)$/.test(el.tagName)) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  private listAtCaret(): HTMLElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== this.element) {
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** The innermost styled span at the caret carrying a given property. */
  private styledSpanAtCaret(prop: string): string | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== this.element) {
      if (el.tagName === 'SPAN') {
        const value = el.getAttribute('style')?.match(new RegExp(`${prop}:\\s*([^;]+)`))?.[1];
        if (value) {
          return value.trim();
        }
      }
      if (el.tagName === 'LI' || el.tagName === 'TD' || el.tagName === 'TH') {
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  private shellAtCaret(): HTMLElement | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const node = selection.getRangeAt(0).startContainer;
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== this.element) {
      if (el.classList.contains('padify-math')) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * The inline-style command shared by size/family/ink/highlight: a ranged
   * selection sets the declaration over the covered runs; a collapsed
   * caret plants the styled caret run (pick, then type — Docs behavior).
   */
  private applyInlineStyle(
    prop: 'color' | 'background-color' | 'font-size' | 'font-family',
    value: string,
  ): boolean {
    const selection = captureOffsets(this.element);
    if (!selection) {
      return false;
    }
    const coverage = ordered(selection);
    if (coverage[1] > coverage[0]) {
      return this.command((model) => setInlineStyle(model, coverage, prop, value));
    }
    return this.command((model) => plantStyledCaret(model, coverage[0], { [prop]: value }));
  }

  onInput(listener: () => void): () => void {
    this.element.addEventListener('input', listener);
    return () => {
      this.element.removeEventListener('input', listener);
    };
  }
}
