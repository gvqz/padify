import $ from 'jquery';
import Swal from 'sweetalert2';
import { selector } from './selector';
import {
  calculateCharactersAndWords,
  calculateNoteStatistics,
  copyNotesToClipboard,
  debounce,
  saveTextAsFile,
  deleteNotes,
  toggleFullScreen,
  exportNotesAsPDF,
  exportNotesAsDocx,
  downloadHTML,
  updateWordCountPill,
  getFileName,
  getPdfFileName,
  getDocxFileName,
  getHtmlFileName,
} from './utils';
import { initUnicodePicker } from './unicode/picker';
import { TabManager, setTabManager, getEditorText, getEditorHtml, sanitizeNoteHtml } from './tabs';
import {
  setEditorPort,
  getEditorPort,
} from './editor/port';
import { ContentEditablePort } from './editor/contenteditable-port';
import { initMusicPlayer } from './music-player';
import { storageReady } from './storage';
import { initCloudSync } from './cloud/sync';
import { initCloudUI } from './cloud/ui';
import { initCloudShare } from './cloud/share';
import { initShareUI } from './cloud/share-ui';
import { initVoiceTyping, toggleVoiceTyping, handleTabSwitchedWhileListening } from './voice';
import { initTypingEffects } from './typing-effects';
import { initPipWindow } from './pip-window';
import { initSaveIndicator } from './save-indicator';
import { initTabRailDrawer } from './tab-rail-drawer';
import { initThemeController } from './theme-controller';
import { initEditorPreferences, clearTabIndentation } from './editor-preferences';
import { setBreakRemindersEnabled, trackWritingActivity } from './break-reminder';
import { registerServiceWorker, initInstallPrompt } from './install-pwa';

// Bootstrap 3's jQuery plugins (registered globally by the `bootstrap` import
// in main.ts) are not covered by @types/jquery. The `modal` member is also
// declared in utils.ts; identical declarations merge.
declare global {
  interface JQuery {
    modal(action: string | { [key: string]: unknown }): JQuery;
    tooltip(options?: Record<string, unknown>): JQuery;
  }
}

// The editor is a contenteditable <div id="note"> — see tabs.ts for the tab
// model and the storage format. Text readers go through getEditorText().
//
// app.ts is the boot orchestrator: it wires the shell (tabs, cloud, voice,
// music) and keeps the toolbar + keyboard shortcuts. Focused behaviour
// lives in its own modules — typing-effects, break-reminder, pip-window,
// save-indicator, tab-rail-drawer, theme-controller, editor-preferences
// and install-pwa.

$(document).ready(async function () {
  // Storage hydrates from IndexedDB before any state is read (boot started
  // at module evaluation in main.ts — this await is usually instant).
  await storageReady();

  const darkmodeText = 'Enable dark mode [Ctrl/Cmd + M]';
  const lightmodeText = 'Enable light mode [Ctrl/Cmd + M]';
  const darkMetaColor = '#0a0a0a';
  const lightMetaColor = '#ffffff';
  const metaThemeColor = document.querySelector('meta[name=theme-color]') as HTMLElement | null;
  const { notepad, state, setState, removeState } = selector();
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
  // this port (see editor/port.ts). The legacy contenteditable adapter is
  // installed here; the document-model editor will install its own.
  const noteElement = document.getElementById('note');
  if (noteElement) {
    setEditorPort(
      new ContentEditablePort(noteElement, {
        sanitize: sanitizeNoteHtml,
        onDocumentReplaced: () => tabManager.syncAfterExternalEdit(),
      }),
    );
  }

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

  // Music player — constructed after storage hydration (its constructor
  // restores the persisted player state). The modal markup itself is
  // already in the DOM from the module's import-time injection.
  initMusicPlayer();

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

  // Plain tags over inline CSS come with the editor port (see
  // ContentEditablePort — styleWithCSS lives with the editor now).

  // Paste always lands as plain text — the editor keeps its own
  // formatting (bold/italic/underline/strike) and nothing else.
  notepad.note.on('paste', (e) => {
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

  $('[data-toggle="tooltip"]').tooltip({
    container: 'body',
  });

  // Theme (light / dark / follow device) — see theme-controller.ts.
  const themeController = initThemeController(themeConfig);

  // Editor appearance preferences (font, texture, pill, …).
  const editorPreferences = initEditorPreferences({
    notepad,
    state,
    setState,
    editorConfig,
    optimalLineLengthPadding,
  });

  if (state.userChosenBreakReminders) {
    const isBreakRemindersEnabled = state.userChosenBreakReminders === 'Yes';
    notepad.breakReminders.prop('checked', isBreakRemindersEnabled);

    setBreakRemindersEnabled(isBreakRemindersEnabled);
  } else {
    notepad.breakReminders.prop('checked', editorConfig.defaultBreakReminders);
    setBreakRemindersEnabled(editorConfig.defaultBreakReminders);
  }

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

  notepad.note.keydown(function (e) {
    if (e.key === 'Tab') {
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

      // Replace through a text node, then re-select it so
      // Tab/Shift+Tab can be applied repeatedly.
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const inserted = document.createTextNode(replacement);
      range.insertNode(inserted);

      const reselect = document.createRange();
      reselect.setStart(inserted, 0);
      reselect.setEnd(inserted, replacement.length);
      selection.removeAllRanges();
      selection.addRange(reselect);
      notepad.note.trigger('input');
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
    // HTML export keeps the formatting the editor rendered.
    downloadHTML(sanitizeNoteHtml(getEditorHtml()), getHtmlFileName());
  });

  // Close dropdown if clicked outside
  $(document).on('click', function () {
    $('#iconDropdown').removeClass('show');
    $('#brandMenu').removeClass('show');
  });

  notepad.fullScreenButton.click(function () {
    toggleFullScreen();
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

    setBreakRemindersEnabled(isEnabled);
  });

  notepad.resetPreferences.click(function () {
    editorPreferences.resetToDefaults();
    typingEffects.reset(editorConfig);

    if (selector().state.userChosenBreakReminders) {
      removeState('userChosenBreakReminders');
    }

    setBreakRemindersEnabled(editorConfig.defaultBreakReminders);
    notepad.breakReminders.prop('checked', editorConfig.defaultBreakReminders);

    themeController.resetToDevice();
  });

  // Floating window — see pip-window.ts.
  initPipWindow();

  // This listens for keyboard shortcuts
  document.onkeydown = function (event: KeyboardEvent) {
    event = event || (window.event as KeyboardEvent);

    if (event.key === 'Escape') {
      $('.modal').modal('hide');
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

      $('.modal').modal('hide');
      notepad.preferencesModal.modal('show');
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
      event.preventDefault();

      if (notepad.keyboardShortcutsModal.hasClass('in')) return;

      $('.modal').modal('hide');
      notepad.keyboardShortcutsModal.modal('show');
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
  };

  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) {
      $('#arrowPointsIn').hide();
      $('#arrowPointsOut').show();
    }
  });

  registerServiceWorker();
  initInstallPrompt();
});
