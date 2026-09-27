/**
 * Docs-style keyboard shortcuts for rich text notes.
 *
 * Lives on the note surface (not the global document handler) so it only
 * ever fires while typing in the note, and only for rich notes — the
 * standard note keeps its bare bones. Ctrl+Shift+X strikes like the
 * floating window's handler, Ctrl+. superscripts, the Ctrl+Shift+L/E/R/J
 * cluster aligns, Ctrl+\ clears formatting — and inside lists Tab /
 * Shift+Tab indent and outdent instead of typing a literal tab, which is
 * also why this module registers BEFORE app.ts's legacy Tab handler and
 * stops that handler when a list claims the key.
 */
import type { TabManager } from '../tabs';
import { getEditorPort } from './port';
import { isRichNote } from './note-types';

export function initRichShortcuts(tabManager: TabManager): void {
  const note = document.getElementById('note');
  if (!note) {
    return;
  }

  const ALIGN_KEYS: Readonly<Record<string, 'left' | 'center' | 'right' | 'justify'>> = {
    KeyL: 'left',
    KeyE: 'center',
    KeyR: 'right',
    KeyJ: 'justify',
  };

  note.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!isRichNote(tabManager.getActive())) {
      return;
    }

    const mod = event.ctrlKey || event.metaKey;

    // Inside a list, Tab/Shift+Tab structure the list (the port nests
    // natively); stop the legacy literal-tab handler from also firing.
    if (event.key === 'Tab' && getEditorPort()?.queryListKind() !== null) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) {
        getEditorPort()?.outdent();
      } else {
        getEditorPort()?.indent();
      }
      return;
    }

    if (!mod || event.altKey) {
      return;
    }

    if (event.shiftKey && event.code === 'KeyX') {
      event.preventDefault();
      getEditorPort()?.applyFormat('strikeThrough');
    } else if (!event.shiftKey && event.code === 'Period') {
      event.preventDefault();
      getEditorPort()?.applyScript('super');
    } else if (event.code === 'Backslash') {
      event.preventDefault();
      getEditorPort()?.applyFormat('removeFormat');
    } else if (event.shiftKey && ALIGN_KEYS[event.code]) {
      event.preventDefault();
      getEditorPort()?.applyAlignment(ALIGN_KEYS[event.code]);
    }
  });
}
