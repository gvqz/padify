/**
 * The context menu's Markdown action layer.
 *
 * The menu's vocabulary was the html surface's (every mutation through
 * the EditorPort); Markdown notes get the same rows through THIS module
 * instead — each primitive maps onto the live Milkdown editor or the
 * toolbar's own command dispatch, so the menu never mutates DOM the
 * ProseMirror view owns (the one rule that must not bend: PM's document
 * is the only writer of PM's DOM).
 *
 * Clipboard operations ride the real browser gestures where possible
 * (execCommand on the focused view runs the clipboard plugin's
 * markdown-aware serializer); every path degrades to the async API with
 * the selection deleted by transaction, exactly like the html paths.
 */
import { callCommand } from '@milkdown/kit/utils';
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
import { AllSelection } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';

import { getTabManager, insertTextIntoActiveNote } from '../../tabs';
import { isMarkdownNote } from '../note-types';
import {
  focusMarkdownPane,
  markdownEditorHandle,
  markdownSelectionStateNow,
  markdownSourceActive,
  markdownSourceTextarea,
} from './surface';
import { linkRangeAround, runMarkdownTableAction, runMarkdownToolbarAction } from './toolbar';
import { applyEdit, removeLink as removeSourceLink } from './source-edit';

type Handle = NonNullable<ReturnType<typeof markdownEditorHandle>>;

/** True when the menu should speak Markdown (an editable markdown pane is active). */
export function markdownMenuTarget(): boolean {
  const active = getTabManager()?.getActive();
  return (
    !!active &&
    isMarkdownNote(active) &&
    (markdownEditorHandle() !== null || markdownSourceActive())
  );
}

function handle(): Handle | null {
  return markdownEditorHandle();
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
  if (source()) {
    source()?.focus();
    return;
  }
  handle()?.view.focus();
}

/** The selection's text (markdown source, '\n' between blocks). */
export function mdSelectionText(): string {
  const ta = source();
  if (ta) {
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  }
  const live = handle();
  if (!live) {
    return '';
  }
  const { from, to, empty } = live.view.state.selection;
  if (empty) {
    return '';
  }
  return live.view.state.doc.textBetween(from, to, '\n');
}

/** The caret/selection's state snapshot (link/table/format queries). */
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
  const live = handle();
  if (!text || !live) {
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
  const live = handle();
  if (!live) {
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
  if (ta) {
    if (ta.selectionStart === ta.selectionEnd) {
      return false;
    }
    applyEdit(ta, ta.selectionStart, ta.selectionEnd, '', ta.selectionStart);
    return true;
  }
  const live = handle();
  if (!live) {
    return false;
  }
  const { state } = live.view;
  if (state.selection.empty) {
    return false;
  }
  live.view.dispatch(state.tr.delete(state.selection.from, state.selection.to));
  return true;
}

/** Replaces the selection with plain text (the case converter's path). */
export function mdReplaceSelection(text: string): boolean {
  const ta = source();
  if (ta) {
    applyEdit(ta, ta.selectionStart, ta.selectionEnd, text, ta.selectionStart + text.length);
    return true;
  }
  const live = handle();
  if (!live) {
    return false;
  }
  const { state } = live.view;
  const { from, to } = state.selection;
  if (text === '') {
    live.view.dispatch(state.tr.delete(from, to));
    return true;
  }
  live.view.dispatch(state.tr.replaceWith(from, to, state.schema.text(text)));
  return true;
}

export function mdSelectAll(): boolean {
  const ta = source();
  if (ta) {
    ta.focus();
    ta.select();
    return true;
  }
  const live = handle();
  if (!live) {
    return false;
  }
  const { state } = live.view;
  live.view.dispatch(state.tr.setSelection(new AllSelection(state.doc)));
  live.view.focus();
  return true;
}

export function mdUndo(): boolean {
  const ta = source();
  if (ta) {
    focusMarkdownPane();
    try {
      return document.execCommand('undo');
    } catch {
      return false;
    }
  }
  const live = handle();
  if (!live) {
    return false;
  }
  return live.editor.action(callCommand(undoCommand.key));
}

export function mdRedo(): boolean {
  const ta = source();
  if (ta) {
    focusMarkdownPane();
    try {
      return document.execCommand('redo');
    } catch {
      return false;
    }
  }
  const live = handle();
  if (!live) {
    return false;
  }
  return live.editor.action(callCommand(redoCommand.key));
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
  if (ta) {
    return removeSourceLink(ta);
  }
  const live = handle();
  if (!live) {
    return false;
  }
  const range = linkRangeAround(live.view.state as EditorState);
  if (!range) {
    return false;
  }
  const linkMark = live.view.state.schema.marks.link;
  if (!linkMark) {
    return false;
  }
  live.view.dispatch(live.view.state.tr.removeMark(range.from, range.to, linkMark));
  return true;
}

export function mdTableOp(op: string): boolean {
  return runMarkdownTableAction(op);
}
