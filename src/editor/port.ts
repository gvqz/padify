/**
 * EditorPort — the seam between the Padify app and the note editor.
 *
 * Every part of the app that reads or writes the note (snapshots, share
 * links, voice typing, the unicode picker, the context menu, statistics,
 * exports) goes through this interface instead of reaching into the editor
 * DOM or calling document.execCommand directly.
 *
 * The document-model engine (`model-port.ts` over editor/model/) is the
 * implementation behind this contract: typing flows natively through the
 * contenteditable surface, every structured change flows through a
 * canonical model — one parse, one serializer, one repaint, one history,
 * one announce (see model-port.ts for the discipline).
 *
 * Contract notes:
 *  - `setHtml` accepts arbitrary markup and sanitizes it down to the
 *    stored formatting subset before it touches the surface (the storage
 *    sanitizer in tabs.ts is the boundary — same as load).
 *  - `getText` returns `\n`-separated plain text with `&nbsp;` normalized.
 *  - Formatting/insert/undo methods return whether the engine accepted
 *    them, mirroring document.execCommand's boolean result.
 */

export type FormatCommand = 'bold' | 'italic' | 'underline' | 'strikeThrough';

/** Block formats the rich text toolbar applies to the selection's blocks. */
export type BlockFormat = 'p' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre';

export type ListKind = 'ul' | 'ol' | 'checklist';

/** Vertical script offsets (Docs-style superscript / subscript). */
export type ScriptType = 'super' | 'sub';

/** Horizontal text alignment of the selection's blocks. */
export type Alignment = 'left' | 'center' | 'right' | 'justify';

/** The caret's position inside a table, as queryTableContext reports it. */
export interface TableCellContext {
  rows: number;
  cols: number;
  rowIndex: number;
  colIndex: number;
}

/** Every mutation-style command the app performs on the editor surface. */
export type EditorCommand = FormatCommand | 'removeFormat';

export interface EditorPort {
  /** The note's HTML in the stored formatting subset. */
  getHtml(): string;

  /**
   * Replaces the whole note (sanitized on entry) and persists it.
   * The COMMIT half of the pair — external replacements (snapshot
   * restore, editor-facing features) come through here so the change
   * lands in storage exactly once.
   */
  setHtml(html: string): void;

  /**
   * Replaces the whole note for DISPLAY ONLY (sanitized on entry, math
   * rendered, empty state collapsed) — the RENDER half of the pair.
   * Opening a note uses this: painting the surface must never count as
   * an edit, so nothing persists, no autosave is announced, and the
   * caller stays in charge of when the note is written. A replacement
   * engine implements this as “put the document on screen”; the undo
   * history of a freshly opened note starts empty either way.
   */
  renderHtml(html: string): void;

  /** Plain text of the note, `\n`-separated, nbsp normalized to spaces. */
  getText(): string;

  /** True when the note carries no meaningful content. */
  isEmpty(): boolean;

  /**
   * Collapses the editor's "empty but not really" states (Chrome's bare
   * `<br>` after a delete-all, empty skeletons) to a truly empty surface,
   * so placeholder, caret and the first typed character share one line.
   * Returns true when a rewrite happened. Side-effect free otherwise —
   * opening a note may call it without persisting anything.
   */
  normalizeEmptySurface(): boolean;

  /** Moves keyboard focus into the editor. */
  focus(): void;

  /** True when the editing caret/selection currently sits inside the note. */
  isCaretInside(): boolean;

  /**
   * Parks the caret at the end of the note when it drifted outside (voice
   * dictation must never land in the void). Returns true when the caret is
   * inside afterwards.
   */
  ensureCaretInside(): boolean;

  /**
   * The single character immediately before the caret ('' at the very
   * start of the note). Powers dictation's smart spacing/capitalisation.
   */
  charBeforeCaret(): string;

  /**
   * Inserts plain text at the caret, replacing the selection (the voice,
   * unicode and tab-indentation path). Returns false if unsupported.
   */
  insertText(text: string): boolean;

  /**
   * Applies/toggles a formatting command over the current selection.
   * Returns false if the engine rejected it.
   */
  applyFormat(command: EditorCommand): boolean;

  /** True when the selection carries the given format. */
  queryFormat(command: FormatCommand): boolean;

  /**
   * Sets the block type (paragraph, heading, quote, code block) of the
   * selection's block. Returns false if the engine rejected it.
   */
  applyBlockFormat(format: BlockFormat): boolean;

  /**
   * The block type at the caret/selection ('p' covers plain divs), or null
   * when it cannot be determined. Powers the toolbar's pressed states.
   */
  queryBlockFormat(): BlockFormat | null;

  /**
   * Turns a list on or off at the selection. 'checklist' marks the produced
   * unordered list with data-rich-checklist; toggling it off returns plain
   * paragraphs, and the bullet/numbered kinds convert a checklist into the
   * equivalent plain list (Docs behavior) instead of erasing it.
   */
  toggleList(kind: ListKind): boolean;

  /** The list kind active at the selection, or null when not in a list. */
  queryListKind(): ListKind | null;

  /**
   * Links the current selection with the given href. Returns false when
   * there is nothing to link (collapsed selection) or the engine refused.
   */
  insertLink(href: string): boolean;

  /**
   * Docs' paste-a-link gesture at a bare caret: the href itself becomes the
   * linked text. Returns false when the engine refused.
   */
  insertLinkAsText(href: string): boolean;

  /** Removes the link under the caret/selection, keeping its text. */
  removeLink(): boolean;

  /**
   * The href of the link at/around the selection, or null when the caret is
   * not on a link. Powers the toolbar's link popover prefill.
   */
  queryLinkHref(): string | null;

  /**
   * Repoints the link at/around the selection to href. Returns false when
   * there is no link under the caret/selection.
   */
  retargetLink(href: string): boolean;

  /**
   * Inserts a KaTeX equation shell at the caret (rendered in place right
   * after; one native undo step removes the whole thing). Returns false
   * when the engine refused.
   */
  insertMath(latex: string): boolean;

  /**
   * The equation the caret sits in (nearest padify-math shell), or null.
   * Powers the equation bubble's edit mode and the toolbar's state. The
   * id is an engine-side handle (see math.ts) — never a DOM element — so
   * any engine, DOM-backed or document-modeled, can answer it.
   */
  queryMathAtCaret(): { latex: string; id: string } | null;

  /**
   * Re-points the equation with this handle to new LaTeX and re-renders
   * it. Returns false when no equation with that handle sits in this
   * note.
   */
  updateMath(id: string, latex: string): boolean;

  undo(): boolean;
  redo(): boolean;

  /**
   * True when there is something to undo/redo — the history availability
   * the undo/redo buttons dim against. An engine answers from its own
   * history (the model engine's stacks), never from a browser-global.
   */
  canUndo(): boolean;
  canRedo(): boolean;

  // -------------------------------------------------------------------------
  // The Docs-style vocabulary — fonts, sizes, colors, alignment, indentation
  // and rules. Inline styles are stored as sanitized span/block styles (see
  // the style allowlist in tabs.ts); the port normalizes whatever legacy
  // markup the engine produced (e.g. <font>) into that subset.
  // -------------------------------------------------------------------------

  /** Sets the font size (px) of the selection. */
  setFontSize(px: number): boolean;

  /** Sets the font family of the selection. */
  setFontFamily(family: string): boolean;

  /** Sets the text color of the selection (any sanitized color value). */
  setTextColor(color: string): boolean;

  /**
   * The text color at the caret as '#rrggbb', or null when it cannot be
   * answered (Chrome answers queryCommandValue('foreColor') reliably; the
   * equivalent highlight query does not, so there is no pair for it).
   */
  queryTextColor(): string | null;

  /** Sets the highlight behind the selection ('transparent' clears it). */
  setHighlight(color: string): boolean;

  /** Toggles superscript/subscript at the selection (re-apply to clear). */
  applyScript(type: ScriptType): boolean;

  /** True when the selection carries the given script offset. */
  queryScript(type: ScriptType): boolean;

  /** Aligns the selection's blocks. */
  applyAlignment(align: Alignment): boolean;

  /** The alignment active at the selection, or null when indeterminate. */
  queryAlignment(): Alignment | null;

  /** Indents the selection: nests inside lists, margin-steps plain blocks. */
  indent(): boolean;

  /** Reverses indent() — unnests list items, un-steps block margins. */
  outdent(): boolean;

  /** Inserts a horizontal rule at the caret, splitting the block. */
  insertHorizontalRule(): boolean;

  /**
   * Inserts a rows×cols table at the caret (Docs-style grid pick). The
   * produced markup is the stored table subset: table > tbody > tr > td.
   */
  insertTable(rows: number, cols: number): boolean;

  /**
   * The table the caret sits in, with its shape and the caret's cell
   * coordinates — null when the caret is not inside a table. Powers the
   * table menu's visibility and its row/column operations.
   */
  queryTableContext(): TableCellContext | null;

  /**
   * Moves the caret between table cells (Tab / Shift+Tab, Docs-style).
   * Returns false when the caret is not in a table or there is no neighbor.
   */
  moveTableCellFocus(step: 1 | -1): boolean;

  /**
   * Runs a table structure operation at the caret's cell: row-above,
   * row-below, col-left, col-right, row-delete, col-delete, table-delete.
   * Returns false when the caret is not in a table.
   */
  runTableAction(action: string): boolean;

  /** Fires on user edits (typing, formatting). Returns an unsubscriber. */
  onInput(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Singleton holder — the composition root installs the port once at boot;
// features resolve it through here.
// ---------------------------------------------------------------------------

let editorPortInstance: EditorPort | null = null;

export function setEditorPort(port: EditorPort): void {
  editorPortInstance = port;
}

export function getEditorPort(): EditorPort | null {
  return editorPortInstance;
}
