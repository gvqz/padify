/**
 * The context menu's Markdown action layer.
 *
 * The menu's vocabulary was the html surface's (every mutation through
 * the EditorPort); Markdown notes get the same rows through THIS module
 * instead — each primitive maps onto the live source textarea or the
 * toolbar's own command dispatch, so the menu never mutates state the
 * surface does not own. Clipboard operations ride the real browser
 * gestures where possible (execCommand on the focused textarea); every
 * path degrades to the async API with the selection rewritten through
 * the source-edit primitives, exactly like the html paths.
 */
import { getTabManager, insertTextIntoActiveNote } from '../../tabs';
import { isMarkdownNote } from '../note-types';
import {
  focusMarkdownPane,
  markdownSelectionStateNow,
  markdownSourceActive,
  markdownSourceTextarea,
  markdownViewMode,
} from './surface';
import { runMarkdownToolbarAction } from './toolbar';
import { applyEdit, removeLink as removeSourceLink } from './source-edit';

/** True when the menu should speak Markdown (an editable markdown pane is active). */
export function markdownMenuTarget(): boolean {
  const active = getTabManager()?.getActive();
  return !!active && isMarkdownNote(active) && markdownSourceActive();
}

function source(): HTMLTextAreaElement | null {
  return markdownSourceTextarea();
}

function execCommand(command: string): boolean {
  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
}

// ---- focus + reads ---------------------------------------------------------

export function mdFocus(): void {
  source()?.focus();
}

/** The selection's text (markdown source). */
export function mdSelectionText(): string {
  const ta = source();
  if (!ta) {
    return '';
  }
  return ta.value.slice(ta.selectionStart, ta.selectionEnd);
}

/** The caret/selection's state snapshot (link/format queries). */
export function mdState(): ReturnType<typeof markdownSelectionStateNow> {
  return markdownSelectionStateNow();
}

// ---- clipboard -------------------------------------------------------------

/** Copies the selection as markdown (execCommand, async-API fallback). */
export async function mdCopy(): Promise<boolean> {
  const text = mdSelectionText();
  if (!text) {
    return false;
  }
  mdFocus();
  let copied = execCommand('copy');
  if (!copied) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
  }
  return copied;
}

/** Cuts the selection (execCommand, else async copy + delete). */
export function mdCut(): boolean {
  const text = mdSelectionText();
  if (!text) {
    return false;
  }
  mdFocus();
  const copied = execCommand('cut');
  if (!copied) {
    void navigator.clipboard?.writeText(text).catch(() => {
      /* clipboard unavailable — the cut still proceeds */
    });
    mdDeleteSelection();
  }
  return true;
}

/** Pastes the clipboard's text at the selection, as the surface's insert. */
export async function mdPaste(): Promise<'pasted' | 'empty' | 'blocked'> {
  if (!source()) {
    return 'blocked';
  }
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return 'blocked';
  }
  if (!text) {
    return 'empty';
  }
  if (!insertTextIntoActiveNote(text)) {
    return 'blocked';
  }
  return 'pasted';
}

// ---- mutations --------------------------------------------------------------

export function mdDeleteSelection(): boolean {
  const ta = source();
  if (!ta || ta.selectionStart === ta.selectionEnd) {
    return false;
  }
  applyEdit(ta, ta.selectionStart, ta.selectionEnd, '', ta.selectionStart);
  return true;
}

/** Replaces the selection with plain text (the case converter's path). */
export function mdReplaceSelection(text: string): boolean {
  const ta = source();
  if (!ta) {
    return false;
  }
  applyEdit(ta, ta.selectionStart, ta.selectionEnd, text, ta.selectionStart + text.length);
  return true;
}

export function mdSelectAll(): boolean {
  const ta = source();
  if (!ta) {
    return false;
  }
  ta.focus();
  ta.select();
  return true;
}

export function mdUndo(): boolean {
  if (!source()) {
    return false;
  }
  focusMarkdownPane();
  try {
    return document.execCommand('undo');
  } catch {
    return false;
  }
}

export function mdRedo(): boolean {
  if (!source()) {
    return false;
  }
  focusMarkdownPane();
  try {
    return document.execCommand('redo');
  } catch {
    return false;
  }
}

/** One of the markdown format row's ids. */
export function mdMenuFormat(format: string): boolean {
  const map: Record<string, string> = {
    bold: 'bold',
    italic: 'italic',
    strike: 'strikethrough',
    code: 'code',
  };
  const action = map[format];
  if (!action) {
    return false;
  }
  return runMarkdownToolbarAction(action);
}

export function mdClearFormatting(): boolean {
  return runMarkdownToolbarAction('clear');
}

export function mdRemoveLink(): boolean {
  const ta = source();
  if (!ta) {
    return false;
  }
  return removeSourceLink(ta);
}

/**
 * Table structure operations were the visual editor's grammar (a caret
 * inside a cell); the source has no cell cursor — the row writes the
 * template or stays out of the menu's face.
 */
export function mdTableOp(_op: string): boolean {
  return false;
}

export { markdownViewMode };
