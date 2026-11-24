import { saveTextAsFile, exportNotesAsPDF, getFileName, getPdfFileName } from './exports';
import { getEditorText, type TabManager } from './tabs';
import { copyNotesToClipboard, deleteNotes } from './context-menu';
import { openModal, closeAllModals, hasOpenModal } from './ui/behavior/modal';
import { toggleVoiceTyping } from './voice';
import type { NotepadUI } from './selector';
import type { UnicodePickerHandle } from './unicode/picker';

export interface AppShortcutsDeps {
  notepad: NotepadUI;
  tabManager: TabManager;
  unicodePicker: UnicodePickerHandle;
}

/**
 * The app-global keyboard surface, in two pieces.
 *
 *  • The shortcuts sheet's search — the reference modal filters its rows
 *    live and resets on every open, so the sheet always starts honest.
 *  • The document-level shortcut dispatcher — every chord that is NOT the
 *    editor's own (save/export, the settings and shortcuts modals, the
 *    unicode picker, clipboard, delete, voice typing, tab cycling). The
 *    note-surface chords live elsewhere: rich notes in
 *    editor/rich-shortcuts.ts, the html editor's Tab/Backspace behaviour
 *    in app.ts, Markdown's keymaps in its surface.
 *
 * Registered with addEventListener (never `document.onkeydown =`) so the
 * handler composes with the capture-phase listeners elsewhere in the
 * codebase (context-menu.ts, voice.ts, note-type-menu.ts, help.ts)
 * instead of clobbering the only `onkeydown` slot on the document.
 */
export function initAppShortcuts(deps: AppShortcutsDeps): void {
  const { notepad, tabManager, unicodePicker } = deps;

  // ---- Keyboard shortcuts search filtering & reset ------------------
  const shortcutSearchInput = document.getElementById('shortcutSearch') as HTMLInputElement | null;
  const shortcutNoResults = document.getElementById('shortcutNoResults');
  const shortcutSections = document.querySelectorAll<HTMLElement>('.shortcut-section');

  const filterShortcuts = (query: string): void => {
    const q = query.trim().toLowerCase();
    let totalVisible = 0;

    shortcutSections.forEach((section) => {
      const rows = section.querySelectorAll<HTMLElement>('.shortcut-row');
      let sectionVisibleCount = 0;

      rows.forEach((row) => {
        const searchText = row.getAttribute('data-search') || row.textContent?.toLowerCase() || '';
        const matches = !q || searchText.includes(q);
        row.style.display = matches ? 'flex' : 'none';
        if (matches) sectionVisibleCount++;
      });

      section.style.display = sectionVisibleCount > 0 ? 'block' : 'none';
      totalVisible += sectionVisibleCount;
    });

    if (shortcutNoResults) {
      shortcutNoResults.style.display = totalVisible === 0 ? 'flex' : 'none';
    }
  };

  if (shortcutSearchInput) {
    shortcutSearchInput.addEventListener('input', (e) => {
      filterShortcuts((e.target as HTMLInputElement).value);
    });
  }

  notepad.keyboardShortcutsModal.on('show.bs.modal', function () {
    if (shortcutSearchInput) {
      shortcutSearchInput.value = '';
      filterShortcuts('');
      setTimeout(() => shortcutSearchInput.focus(), 150);
    }
  });

  // ---- the document-level dispatcher --------------------------------
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    // The app's own shortcuts still win (R2 keyboard parity): the drawing
    // canvas's vendor binds its global handler on this SAME node, bubble
    // phase, but AFTER boot — so for every chord below,
    // stopImmediatePropagation keeps it from ever seeing the event. The
    // vendor's chords the app does not own (tools, undo, Alt+Z…) are
    // untouched: they simply fall through to the later handler.
    const winChord = (): void => {
      event.stopImmediatePropagation();
    };

    // Escape belongs to the app only while an app modal is on stage — a
    // quiet page's Escape passes through so the canvas keeps its native
    // semantics (deselect, close the vendor's dialogs, leave text edit).
    if (event.key === 'Escape' && hasOpenModal()) {
      closeAllModals();
      winChord();
    }

    // On Apple keyboards Option+letter is ordinary character input. The
    // Alt-combos below call preventDefault unconditionally, which made
    // Option+S / C / V untypeable in EVERY text field (tab rename,
    // settings search, share modal, music search, the markdown source
    // pane) — the shortcut fired instead. The editor itself is the one
    // place Alt+V is a deliberate gesture, so: editable targets keep
    // their characters except the editor host.
    const shortcutTarget = event.target as unknown as HTMLElement | null;
    const targetTag = shortcutTarget?.tagName ?? '';
    const targetIsEditable =
      !!shortcutTarget &&
      (shortcutTarget.isContentEditable ||
        targetTag === 'INPUT' ||
        targetTag === 'TEXTAREA' ||
        targetTag === 'SELECT');
    const altComboBlocked =
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      targetIsEditable &&
      shortcutTarget !== notepad.note.get(0) &&
      !notepad.note.get(0)?.contains(shortcutTarget);

    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyS') {
      saveTextAsFile(getEditorText(), getFileName());
      event.preventDefault();
      winChord();
    }

    // Alt+S without the primary modifier — exact match, so Ctrl+Alt+S
    // (the snapshot chord, see snapshots.ts) never rides along.
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === 'KeyS' &&
      !altComboBlocked
    ) {
      exportNotesAsPDF(getEditorText(), getPdfFileName());
      event.preventDefault();
      winChord();
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'Comma') {
      event.preventDefault();
      winChord();

      if (notepad.preferencesModal.hasClass('in')) return;

      closeAllModals();
      openModal(notepad.preferencesModal.get(0));
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
      event.preventDefault();
      winChord();

      if (notepad.keyboardShortcutsModal.hasClass('in')) return;

      closeAllModals();
      openModal(notepad.keyboardShortcutsModal.get(0));
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyO') {
      event.preventDefault();
      winChord();
      unicodePicker.open();
    }

    if (event.altKey && event.code === 'KeyC' && !altComboBlocked) {
      event.preventDefault();
      winChord();
      copyNotesToClipboard(getEditorText());
    }

    if (
      (event.ctrlKey && event.shiftKey && event.code === 'Delete') ||
      (event.metaKey && event.shiftKey && event.code === 'Backspace')
    ) {
      event.preventDefault();
      winChord();
      void deleteNotes();
    }

    // Alt/option + v toggles voice typing.
    if (event.altKey && event.code === 'KeyV' && !altComboBlocked) {
      event.preventDefault();
      winChord();
      toggleVoiceTyping();
    }

    // Ctrl/Cmd + Alt + Arrow keys move between note tabs.
    if (
      (event.ctrlKey || event.metaKey) &&
      event.altKey &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      winChord();
      tabManager.cycle(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
}
