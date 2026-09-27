/**
 * EditorPort — the seam between the Padify app and the note editor.
 *
 * Every part of the app that reads or writes the note (snapshots, share
 * links, voice typing, the unicode picker, the context menu, statistics,
 * exports) goes through this interface instead of reaching into the editor
 * DOM or calling document.execCommand directly.
 *
 * Why: the editor is being revamped (markdown / rich text on a real
 * document model). The revamp ships as a second EditorPort implementation
 * over that model — the app around it does not change. The current
 * implementation (`contenteditable-port.ts`) keeps the existing
 * contenteditable + execCommand editor alive behind the same contract.
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

export type ListKind = 'ul' | 'ol';

/** Every mutation-style command the app performs on the editor surface. */
export type EditorCommand = FormatCommand | 'removeFormat';

export interface EditorPort {
  /** The note's HTML in the stored formatting subset. */
  getHtml(): string;

  /** Replaces the whole note (sanitized on entry) and persists it. */
  setHtml(html: string): void;

  /** Plain text of the note, `\n`-separated, nbsp normalized to spaces. */
  getText(): string;

  /** True when the note carries no meaningful content. */
  isEmpty(): boolean;

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

  /** Turns an ordered/unordered list on or off at the selection. */
  toggleList(kind: ListKind): boolean;

  /** The list kind active at the selection, or null when not in a list. */
  queryListKind(): ListKind | null;

  /**
   * Links the current selection with the given href. Returns false when
   * there is nothing to link (collapsed selection) or the engine refused.
   */
  insertLink(href: string): boolean;

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

  undo(): boolean;
  redo(): boolean;

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
