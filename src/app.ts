import { $ } from './lib/q';
import { selector } from './selector';
import { calculateCharactersAndWords, calculateNoteStatistics } from './lib/text-stats';
import { debounce } from './lib/debounce';
import { copyNotesToClipboard, deleteNotes } from './context-menu';
import {
  saveTextAsFile,
  exportNotesAsPDF,
  exportNotesAsDocx,
  downloadHTML,
  getFileName,
  getPdfFileName,
  getDocxFileName,
  getHtmlFileName,
} from './exports';
import { updateWordCountPill } from './word-count-pill';
import { initUnicodePicker } from './unicode/picker';
import {
  TabManager,
  setTabManager,
  getEditorText,
  getActiveNoteExportBody,
  sanitizeNoteHtml,
} from './tabs';
import { setEditorPort, getEditorPort } from './editor/port';
import { ModelPort } from './editor/model-port';
import { storageReady } from './storage';
import { initCloudSync } from './cloud/sync';
import { initCloudUI } from './cloud/ui';
import { initCloudShare } from './cloud/share';
import { initShareUI } from './cloud/share-ui';
import { initVoiceTyping, toggleVoiceTyping, handleTabSwitchedWhileListening } from './voice';
import { initTypingEffects } from './typing-effects';
import { initPipWindow } from './pip-window';
import { openModal, closeAllModals } from './ui/behavior/modal';
import { initSaveIndicator } from './save-indicator';
import { initTabRailDrawer } from './tab-rail-drawer';
import { initRichToolbar } from './editor/rich-toolbar';
import { initMarkdownToolbar } from './editor/markdown/toolbar';
// The Markdown surface registers itself for the 'text' content kind at
// import time (editor/markdown/surface.ts) — one import, and every
// NoteSurface consumer (tabs, snapshots, share) can open markdown notes.
import './editor/markdown/surface';
import { isHtmlContent } from './editor/note-types';
import { initThemeColors } from './editor/theme-colors';
import { initRichShortcuts } from './editor/rich-shortcuts';
import { initNoteTypeMenu } from './ui/note-type-menu';
import { initThemeController } from './theme-controller';
import { initEditorPreferences, clearTabIndentation } from './editor-preferences';
import { setBreakRemindersEnabled, trackWritingActivity } from './break-reminder';
import { registerServiceWorker, initInstallPrompt } from './install-pwa';
import { requestPersistentStorage, checkQuotaOnce } from './storage/persistence';
import { showToast } from './ui/toast';
import { getSetting, onChangeSetting, removeSetting } from './state/settings';

// The editor is a contenteditable <div id="note"> — see tabs.ts for the tab
// model and the storage format. Text readers go through getEditorText().
//
// app.ts is the boot orchestrator: it wires the shell (tabs, cloud, voice,
// music) and keeps the toolbar + keyboard shortcuts. Focused behaviour
// lives in its own modules — typing-effects, break-reminder, pip-window,
// save-indicator, tab-rail-drawer, theme-controller, editor-preferences
// and install-pwa.

/**
 * Boots the app shell. Called by boot.ts (the composition root) once the
 * DOM is ready — this used to be a $(document).ready callback before the
 * boot sequence became explicit.
 */
export async function initApp(): Promise<void> {
  // Storage hydrates from IndexedDB before any state is read (hydration is
  // kicked at module evaluation in main.ts — this await is usually instant).
  await storageReady();

  const darkmodeText = 'Enable dark mode [Ctrl/Cmd + M]';
  const lightmodeText = 'Enable light mode [Ctrl/Cmd + M]';
  const darkMetaColor = '#0a0a0a';
  const lightMetaColor = '#ffffff';
  const metaThemeColor = document.querySelector('meta[name=theme-color]') as HTMLElement | null;
  const { notepad, setState } = selector();
  const optimalLineLengthPadding = '15px 15vw 40px';

  const editorConfig = selector().defaultConfig;

  const themeConfig = {
    lightmodeText,
    darkmodeText,
    lightMetaColor,
    darkMetaColor,
    metaThemeColor,
  };

  const unicodePicker = initUnicodePicker(notepad);

  // Note tabs — multiple notes inside the one editor, shown as a rail
  // on the left of the page (see tabs.ts).
  const tabManager = new TabManager(notepad.note);
  setTabManager(tabManager);

  // The editor seam — every reader/writer of the note surface goes through
  // this port (see editor/port.ts). The document-model engine is installed
  // here: typing flows natively through the contenteditable surface, every
  // structured change flows through the canonical model (see
  // editor/model-port.ts and editor/model/).
  const noteElement = document.getElementById('note');
  if (noteElement) {
    setEditorPort(
      new ModelPort(noteElement, {
        sanitize: sanitizeNoteHtml,
        onDocumentReplaced: () => tabManager.syncAfterExternalEdit(),
      }),
    );
  }

  // The html engine parks while ANOTHER surface owns the host: a Markdown
  // note mounts its own editor inside #note, and the port's listeners must
  // never see that editor's events (editor/model-port.ts setInert). The
  // host comes home through renderHtml/setHtml, which stay live.
  const syncPortInert = (): void => {
    getEditorPort()?.setInert(!isHtmlContent(tabManager.getActive()?.noteType));
  };
  tabManager.addActiveListener(syncPortInert);

  tabManager.onActiveChanged = () => {
    updateWordCountPill(tabManager.getActiveText());
    handleTabSwitchedWhileListening();
  };
  await tabManager.init();

  // Share links stay fresh through the persist hook (no-op without a
  // configured cloud project).
  initCloudShare(tabManager);

  // Voice typing (Web Speech API) — hides its own UI when unsupported.
  initVoiceTyping();

  // Music + ambience — the app's heaviest subsystem (~5k lines) loads on
  // demand now. The modal markup is in the DOM from boot (features/
  // music-player/markup.ts); the engines arrive on the first attempt to
  // open the player — see initMusicSubsystem below.
  initMusicSubsystem();

  // Cloud sync boots only when a sync project is configured; the UI
  // (navbar icon, modal, settings section) stays hidden otherwise.
  void initCloudSync(tabManager).then(() => {
    initCloudUI();
    initShareUI();
  });
  const characterAndWordCountText = calculateCharactersAndWords(tabManager.getActiveText());

  // Typewriter sounds + exploding keys (see typing-effects.ts).
  const typingEffects = initTypingEffects(notepad, editorConfig);

  // Handle editor auto-scroll for long notes
  let pendingAutoScrollRaf: number | null = null;

  notepad.note.on('input', () => {
    if (pendingAutoScrollRaf) return;

    pendingAutoScrollRaf = requestAnimationFrame(() => {
      pendingAutoScrollRaf = null;

      const editor = notepad.note.get(0) as HTMLElement | undefined;
      if (!editor) return;

      // Only follow the caret when it sits at the very end
      // of the note (same rule the textarea used). While the
      // note floats in a Picture-in-Picture window, read the
      // selection from the document that owns the editor.
      const selection = editor.ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;

      const range = selection.getRangeAt(0);
      if (!editor.contains(range.startContainer)) return;

      const tail = editor.ownerDocument.createRange();
      tail.selectNodeContents(editor);
      tail.setStart(range.endContainer, range.endOffset);

      if (tail.toString().length === 0) {
        editor.scrollTop = editor.scrollHeight;
      }
    });
  });
  // Handle editor auto-scroll for long notes

  notepad.note.on('input', () => {
    trackWritingActivity();
  });

  notepad.wordCount.text(characterAndWordCountText);

  // Paste always lands as plain text — the editor keeps its own
  // formatting (bold/italic/underline/strike) and nothing else.
  notepad.note.on('paste', (e) => {
    // Markdown notes own their paste path (ProseMirror handles it); the
    // html-engine insertion below must not steal the event from them.
    if (!isHtmlContent(tabManager.getActive()?.noteType)) {
      return;
    }
    const event = e.originalEvent as ClipboardEvent | undefined;
    const text = event?.clipboardData?.getData('text/plain');
    if (text === null || text === undefined) {
      return; // no plain text available — let the browser decide
    }

    e.preventDefault();
    if (text.length === 0) {
      return;
    }

    const port = getEditorPort();
    if (!(port ? port.insertText(text) : document.execCommand('insertText', false, text))) {
      // Fallback: splice a text node into the current range.
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        notepad.note.trigger('input');
      }
    }
  });

  // Theme (light / dark / follow device) — see theme-controller.ts.
  const themeController = initThemeController(themeConfig);

  // Editor appearance preferences (font, texture, pill, …).
  const editorPreferences = initEditorPreferences({
    notepad,
    setState,
    editorConfig,
    optimalLineLengthPadding,
  });

  // Break reminders react to the setting itself, not to whoever wrote it:
  // the checkbox, the boot restore and "Reset to defaults" all flow through
  // one subscription instead of three copies of the same apply logic.
  const applyBreakReminders = (value: string | null): void => {
    const isEnabled = value === null ? editorConfig.defaultBreakReminders : value === 'Yes';
    notepad.breakReminders.prop('checked', isEnabled);
    setBreakRemindersEnabled(isEnabled);
  };
  applyBreakReminders(getSetting('userChosenBreakReminders'));
  onChangeSetting('userChosenBreakReminders', ({ value }) => {
    applyBreakReminders(value);
  });

  notepad.note.on(
    'input',
    debounce(function () {
      tabManager.saveActiveFromEditor();
      updateWordCountPill(tabManager.getActiveText());
    }, 500),
  );

  // ---- save-state indicator (see save-indicator.ts) -----------------
  initSaveIndicator(notepad, tabManager);

  // ---- left note rail (mobile drawer) — see tab-rail-drawer.ts ------
  initTabRailDrawer(tabManager);

  // ---- rich text toolbar — visible only for rich notes, see
  // editor/rich-toolbar.ts ----
  initThemeColors(tabManager);
  initRichToolbar(tabManager);

  // ---- markdown toolbar — visible only for Markdown notes, see
  // editor/markdown/toolbar.ts ----
  initMarkdownToolbar(tabManager);

  // Docs-style shortcuts for rich notes — registered BEFORE the legacy Tab
  // handler below so lists can claim Tab/Shift+Tab first.
  initRichShortcuts(tabManager);

  // ---- note-type menu — the chevron beside "New note", see
  // ui/note-type-menu.ts ----
  initNoteTypeMenu((type) => tabManager.addTab(true, type));

  notepad.note.keydown(function (e) {
    if (e.key === 'Tab') {
      // Markdown notes own their Tab handling (ProseMirror list indent);
      // the html-engine indent below must not claim the key from them.
      if (!isHtmlContent(tabManager.getActive()?.noteType)) {
        return;
      }
      e.preventDefault();

      const selection = window.getSelection();
      const tabCharacter = '\t';

      const selectedText = selection && selection.rangeCount > 0 ? selection.toString() : '';

      if (!selection || selection.rangeCount === 0 || selectedText.indexOf('\n') === -1) {
        // Single caret/selection (no line spans): insert a tab.
        const port = getEditorPort();
        if (port) {
          port.insertText(tabCharacter);
        } else {
          document.execCommand('insertText', false, tabCharacter);
        }
        return;
      }

      // Multi-line selection: indent / outdent every line.
      const lines = selectedText.split('\n');
      const replacement = (
        e.shiftKey
          ? lines.map((line) =>
              line.startsWith(tabCharacter) ? line.substring(tabCharacter.length) : line,
            )
          : lines.map((line) => tabCharacter + line)
      ).join('\n');

      // The replacement rides the editor port, like every structured
      // edit: one command, one history group — undo removes the whole
      // indent, and the model/serialize/paint pipeline stays canonical.
      // (The old raw-DOM range surgery here bypassed history entirely:
      // Ctrl+Z jumped over the indent as if it never happened.)
      // selectInserted keeps the block selected so Tab/Shift+Tab can be
      // applied repeatedly.
      const port = getEditorPort();
      if (port) {
        port.insertText(replacement, { selectInserted: true });
        return;
      }
      document.execCommand('insertText', false, replacement);
    }
  });

  notepad.copyToClipboard.click(function () {
    copyNotesToClipboard(getEditorText());
  });

  notepad.downloadNotes.click(function (e) {
    e.stopPropagation(); // Stop click event from bubbling
    $('#iconDropdown').toggleClass('show');
  });

  notepad.downloadNotesPlain.click(function () {
    saveTextAsFile(getEditorText(), getFileName());
  });

  notepad.downloadNotesPdf.click(function () {
    exportNotesAsPDF(getEditorText(), getPdfFileName());
  });

  notepad.downloadNotesDocx.click(function () {
    const textToWrite = getEditorText();
    const fileNameToSaveAs = getDocxFileName();

    exportNotesAsDocx(textToWrite, fileNameToSaveAs);
  });

  notepad.downloadNotesHtml.click(function () {
    // HTML export carries the note, not the editor surface: for a non-html
    // note that surface is a read-only card, and the export must read the
    // model instead (see getActiveNoteExportBody).
    const body = getActiveNoteExportBody();
    if (body !== null) {
      downloadHTML(body, getHtmlFileName());
    }
  });

  // Close dropdown if clicked outside
  $(document).on('click', function () {
    $('#iconDropdown').removeClass('show');
    $('#brandMenu').removeClass('show');
  });

  notepad.fullScreenButton.click(function () {
    // Fullscreen is shell chrome with one caller — it lives here. The
    // arrows are the fullscreen toggle icon in the navbar.
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      $('#arrowPointsOut').hide();
      $('#arrowPointsIn').show();
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
        $('#arrowPointsIn').hide();
        $('#arrowPointsOut').show();
      }
    }
  });

  // Update statistics when modal is shown
  notepad.statisticsModal.on('show.bs.modal', function () {
    const stats = calculateNoteStatistics(getEditorText());

    $('#statWords').text(stats.words);
    $('#statCharacters').text(stats.characters);
    $('#statSentences').text(stats.sentences);
    $('#statParagraphs').text(stats.paragraphs);
    $('#statAvgWordLength').text(stats.averageWordLength);
    $('#statReadingTime').text(stats.readingTime);
    $('#statUniqueWords').text(stats.uniqueWords);
    $('#statMostCommonWord').text(stats.mostCommonWord);
    $('#statLexicalDensity').text(stats.lexicalDensityScore);
    $('#statReadabilityScore').text(stats.readabilityScore);
    $('#statEstimatedPages').text(stats.estimatedPages);
    $('#statEstimatedSpeakingTime').text(stats.estimatedSpeakingTime);
  });

  notepad.clearTabIndentation.on('click', function () {
    clearTabIndentation(notepad);
  });

  notepad.breakReminders.on('change', function () {
    const isEnabled = $(this).is(':checked');
    setState('userChosenBreakReminders', isEnabled ? 'Yes' : 'No');
  });

  notepad.resetPreferences.click(function () {
    editorPreferences.resetToDefaults();
    typingEffects.reset(editorConfig);

    // The break-reminders subscription applies the default when the
    // setting clears — no separate restore call needed here.
    removeSetting('userChosenBreakReminders');

    themeController.resetToDevice();
  });

  // Floating window — see pip-window.ts. Standard notes only.
  initPipWindow(tabManager);

  // This listens for keyboard shortcuts.
  // Use addEventListener (not document.onkeydown = ...) so the handler composes
  // with the capture-phase listeners registered elsewhere in the codebase
  // (context-menu.ts, voice.ts, note-type-menu.ts, help.ts) instead of clobbering
  // the only `onkeydown` slot on the document.
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closeAllModals();
      $('#iconDropdown').removeClass('show');
      $('#brandMenu').removeClass('show');
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
      saveTextAsFile(getEditorText(), getFileName());
      event.preventDefault();
    }

    if (event.altKey && event.code === 'KeyS') {
      exportNotesAsPDF(getEditorText(), getPdfFileName());
      event.preventDefault();
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'Comma') {
      event.preventDefault();

      if (notepad.preferencesModal.hasClass('in')) return;

      closeAllModals();
      openModal(notepad.preferencesModal.get(0));
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
      event.preventDefault();

      if (notepad.keyboardShortcutsModal.hasClass('in')) return;

      closeAllModals();
      openModal(notepad.keyboardShortcutsModal.get(0));
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyO') {
      event.preventDefault();
      unicodePicker.open();
    }

    if (event.altKey && event.code === 'KeyC') {
      event.preventDefault();
      copyNotesToClipboard(getEditorText());
    }

    if (
      (event.ctrlKey && event.shiftKey && event.code === 'Delete') ||
      (event.metaKey && event.shiftKey && event.code === 'Backspace')
    ) {
      event.preventDefault();
      deleteNotes();
    }

    // Alt/option + v toggles voice typing.
    if (event.altKey && event.code === 'KeyV') {
      event.preventDefault();
      toggleVoiceTyping();
    }

    // Ctrl/Cmd + Alt + Arrow keys move between note tabs.
    if (
      (event.ctrlKey || event.metaKey) &&
      event.altKey &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      tabManager.cycle(event.key === 'ArrowRight' ? 1 : -1);
    }
  });

  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) {
      $('#arrowPointsIn').hide();
      $('#arrowPointsOut').show();
    }
  });

  registerServiceWorker();
  initInstallPrompt();
  initDurableStorage();
}

/**
 * Music + ambience lazy seam.
 *
 * The player engines (features/music-player — player, Spotify SDK,
 * free-song resolver — plus the white-noise mixer) used to ride the main
 * bundle so every visitor downloaded ~5k lines most never play. They now
 * live in a lazy chunk: the modal markup mounts at boot (markup.ts is
 * pure markup), and the engines load on the first attempt to open the
 * player.
 *
 * The navbar click is intercepted in the CAPTURE phase — ahead of the
 * delegated modal opener in ui/behavior/modal.ts — so the modal opens
 * only after the engine wired its handlers. Opening it first would drop
 * any click that lands during the load window (tabs, play, search: all
 * bound by the engine's init). After the engines are in, the interception
 * stands down and the normal delegated open flow takes over.
 */
function initMusicSubsystem(): void {
  const modal = document.getElementById('musicPlayerModal');
  if (!modal) return;

  let engines: Promise<void> | null = null;
  let engineReady = false;

  const loadEngines = (): Promise<void> => {
    engines ??= (async () => {
      // Ambience first: the player reads getWhiteNoisePlayer() while
      // constructing (navbar icon state), so the mixer must exist by then.
      const { initWhiteNoisePlayer } = await import('./white-noise-player');
      await initWhiteNoisePlayer();
      const { initMusicPlayer } = await import('./features/music-player');
      initMusicPlayer();
    })();
    return engines;
  };

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest<HTMLElement>('a[data-target="#musicPlayerModal"]');
      // Stand down once the engines are wired — the delegated opener in
      // ui/behavior/modal.ts owns every open from here on.
      if (!trigger || engineReady) return;

      event.preventDefault();
      event.stopPropagation();
      void loadEngines().then(() => {
        engineReady = true;
        openModal(modal, trigger);
      });
    },
    true,
  );

  // Belt and braces for opens that bypass the navbar trigger (programmatic
  // opens, tests): the modal's own show event loads the engines too, so a
  // visible-but-unwired player still finishes wiring itself.
  modal.addEventListener('show.bs.modal', () => {
    void loadEngines().then(() => {
      engineReady = true;
    });
  });
}

/**
 * Durable storage: ask for navigator.storage.persist() at boot and once
 * more after the first real interaction (the grant heuristics favour
 * engaged installs), and warn once when the quota estimate says the app
 * is nearly out of room. Silent when the browser cannot answer — the
 * fallback backend changes nothing about this wiring.
 */
function initDurableStorage(): void {
  void requestPersistentStorage().then(async () => {
    const message = await checkQuotaOnce();
    if (message) {
      showToast(message);
    }
  });

  const reask = (): void => {
    window.removeEventListener('pointerdown', reask);
    void requestPersistentStorage();
  };
  window.addEventListener('keydown', reask, { once: true });
  window.addEventListener('pointerdown', reask, { once: true });
}
