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
 * codebase (context-menu.ts, voice.ts, note-type-menu.ts, ui/brand-menu.ts)
 * instead of clobbering the only `onkeydown` slot on the document.
 */
export function initAppShortcuts(deps: AppShortcutsDeps): void {
  const { notepad, tabManager, unicodePicker } = deps;

  // ---- Keyboard shortcuts search filtering & reset ------------------
  const shortcutSearchInput = document.getElementById('shortcutSearch') as HTMLInputElement | null;
  const shortcutNoResults = document.getElementById('shortcutNoResults');
  const shortcutLayout = document.getElementById('scLayout');
  const shortcutPanes = document.getElementById('shortcutList');
  const shortcutSections = document.querySelectorAll<HTMLElement>('.shortcut-section');
  const shortcutTabs = document.querySelectorAll<HTMLButtonElement>('.sc-nav-item');
  const shortcutFlow = document.querySelector<HTMLElement>('.sc-flow');

  /** The active pane: 'all' shows every section; a named pane shows only
   * its own. A non-empty SEARCH overrides the pane — a query looks
   * everywhere (searching "zen" from General must find the canvas's
   * chord, not hit a dead end). The choice persists across opens, the
   * settings' own memory: reopen lands where the reader left off. */
  let activePane = 'all';

  const PANE_MEMORY_KEY = 'padify.shortcutsPane';

  /** The remembered pane — only one the nav actually speaks (a stale
   * value from an older build falls through to All, never to a dead
   * sheet). Storage off / private mode: no memory, no harm. */
  const readSavedPane = (): string | null => {
    try {
      const saved = localStorage.getItem(PANE_MEMORY_KEY);
      if (saved && nav?.querySelector(`.sc-nav-item[data-pane="${saved}"]`)) return saved;
    } catch {
      return null;
    }
    return null;
  };

  const setPane = (pane: string): void => {
    activePane = pane;
    try {
      localStorage.setItem(PANE_MEMORY_KEY, pane);
    } catch {
      // The memory is a nicety, not a contract (the trash-view
      // preference's own rule) — the sheet works without it.
    }
    shortcutTabs.forEach((tab) => {
      const on = tab.dataset.pane === pane;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      // The roving tabindex tracks the selection: only the active item
      // joins the tab order (the settings nav's pattern).
      tab.tabIndex = on ? 0 : -1;
    });
    filterShortcuts(shortcutSearchInput?.value ?? '');
    // The pane switch lands the reader at its head, not wherever the
    // previous pane's scroll happened to be.
    if (shortcutPanes) shortcutPanes.scrollTop = 0;
  };

  shortcutTabs.forEach((tab) => {
    tab.addEventListener('click', () => setPane(tab.dataset.pane ?? 'all'));
  });

  // The nav is a roving-tabindex tablist, the settings nav's pattern:
  // arrows walk the items, focus follows the walk, Home/End jump.
  const nav = document.getElementById('scNav');
  if (nav) {
    nav.addEventListener('keydown', (event) => {
      const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const items = [...nav.querySelectorAll<HTMLButtonElement>('.sc-nav-item')];
      if (items.length === 0) return;
      const current = items.findIndex((item) => item.classList.contains('is-active'));
      let next = current;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current + 1;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current - 1;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      next = Math.max(0, Math.min(items.length - 1, next));
      event.preventDefault();
      setPane(items[next].dataset.pane ?? 'all');
      items[next].focus();
    });
  }

  const filterShortcuts = (query: string): void => {
    const q = query.trim().toLowerCase();
    const searching = q.length > 0;
    let totalVisible = 0;

    shortcutSections.forEach((section) => {
      const paneOk = searching || activePane === 'all' || section.dataset.pane === activePane;
      const rows = section.querySelectorAll<HTMLElement>('.shortcut-row');
      let sectionVisibleCount = 0;

      rows.forEach((row) => {
        const searchText = row.getAttribute('data-search') || row.textContent?.toLowerCase() || '';
        const matches = !q || searchText.includes(q);
        row.style.display = matches ? 'flex' : 'none';
        if (matches) sectionVisibleCount++;
      });

      // The Drawing pane's three cards (Tools / View / Editor) are islands
      // of their own — a card whose rows all miss the query goes away with
      // them instead of lingering as an empty shell under the section head.
      section.querySelectorAll<HTMLElement>('.shortcut-card').forEach((card) => {
        const cardRows = card.querySelectorAll<HTMLElement>('.shortcut-row');
        let visibleRows = 0;
        cardRows.forEach((row) => {
          if (row.style.display !== 'none') visibleRows++;
        });
        card.style.display = cardRows.length === 0 || visibleRows > 0 ? '' : 'none';
      });

      section.style.display = paneOk && sectionVisibleCount > 0 ? 'block' : 'none';
      if (paneOk) totalVisible += sectionVisibleCount;
    });

    // A live query flattens every pane — the nav steps aside (the
    // settings' is-searching flow) so the matches use the full width.
    shortcutLayout?.classList.toggle('is-searching', searching);

    // The two-column flow is content-gated: a wide frame around a
    // five-row answer is scenery, not service. The named Drawing pane
    // (75+ chords) and the full All pane earn it; a search's short
    // answer reads better down one column.
    shortcutFlow?.classList.toggle('is-wide', totalVisible >= 16);

    if (shortcutNoResults) {
      shortcutNoResults.style.display = totalVisible === 0 ? 'flex' : 'none';
    }
  };

  if (shortcutSearchInput) {
    shortcutSearchInput.addEventListener('input', (e) => {
      filterShortcuts((e.target as HTMLInputElement).value);
    });
  }

  // The pane the sheet opens on — an explicit request wins (the canvas's
  // "Keyboard shortcuts" menu row asks for its Drawing pane, issue #179 —
  // the vendor's shortcut story merged into this sheet, not beside it);
  // otherwise the pane the reader last visited; otherwise All.
  notepad.keyboardShortcutsModal.on('show.bs.modal', function () {
    if (shortcutSearchInput) {
      shortcutSearchInput.value = '';
    }
    setPane(pendingPane ?? readSavedPane() ?? 'all');
    pendingPane = null;
    if (shortcutSearchInput) {
      setTimeout(() => shortcutSearchInput.focus(), 150);
    }
  });

  let pendingPane: string | null = null;
  document.addEventListener('padify:open-shortcuts', (event) => {
    const detail = (event as CustomEvent<{ pane?: string }>).detail;
    pendingPane = detail?.pane ?? 'all';
    if (notepad.keyboardShortcutsModal.hasClass('in')) {
      setPane(pendingPane);
      pendingPane = null;
      return;
    }
    closeAllModals();
    openModal(notepad.keyboardShortcutsModal.get(0));
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
    // (the snapshot chord, see snapshots.ts) never rides along. On a
    // DRAWING note the chord belongs to the canvas instead: the vendor's
    // own "Snap to objects Alt+S" (its Preferences row and context menu
    // both advertise it), and a PDF of a drawing note exports nothing —
    // the deliberate conflict resolution #179 asks for, not an accident.
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === 'KeyS' &&
      !altComboBlocked &&
      !document.querySelector('#note [data-drawing-canvas] .excalidraw')
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

    // Ctrl/Cmd+Shift+E — the export center, the ONE export popup. This is
    // the vendor's own image-export chord, answered at the app layer: the
    // dispatcher registers at boot, before the canvas ever mounts, and
    // answers its chords with stopImmediatePropagation — so the SAME chord
    // opens the SAME center on every note type (the canvas menu's Export
    // image row rides the same bus with a PNG preset).
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyE') {
      event.preventDefault();
      winChord();
      document.dispatchEvent(new CustomEvent('padify:open-export'));
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
