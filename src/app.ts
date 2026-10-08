import { $ } from './lib/q';
import { selector } from './selector';
import { calculateCharactersAndWords, calculateNoteStatistics } from './lib/text-stats';
import { debounce } from './lib/debounce';
import { shortcutLabel } from './lib/platform';
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
  getMarkdownFileName,
} from './exports';
import { updateWordCountPill } from './word-count-pill';
import { initUnicodePicker } from './unicode/picker';
import {
  TabManager,
  setTabManager,
  getEditorText,
  getActiveNoteContent,
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
import { registerLayer } from './ui/behavior/layers';
import { initSaveIndicator } from './save-indicator';
import { initTabRailDrawer } from './tab-rail-drawer';
import { initRichToolbar } from './editor/rich-toolbar';
import {
  initMarkdownToolbar,
  openMarkdownEquationBubble,
  openMarkdownLinkPopover,
  runMarkdownBlockStyle,
  runMarkdownToolbarAction,
} from './editor/markdown/toolbar';
import { initMarkdownSlash } from './editor/markdown/slash';
import { initMarkdownBubble } from './editor/markdown/bubble';
// The Markdown surface registers itself for the 'text' content kind at
// import time (editor/markdown/surface.ts) — one import, and every
// NoteSurface consumer (tabs, snapshots, share) can open markdown notes.
import './editor/markdown/surface';
import {
  markdownSelectionStateNow,
  markdownViewMode,
  onMarkdownViewMode,
  setMarkdownViewMode,
} from './editor/markdown/surface';
import { isHtmlContent, isMarkdownNote, isRichNote } from './editor/note-types';
import { initThemeColors } from './editor/theme-colors';
import { initRichShortcuts } from './editor/rich-shortcuts';
import { initNoteTypeMenu } from './ui/note-type-menu';
import { initThemeController } from './theme-controller';
import { initEditorPreferences } from './editor-preferences';
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

  const darkmodeText = `Enable dark mode [${shortcutLabel('mod+m')}]`;
  const lightmodeText = `Enable light mode [${shortcutLabel('mod+m')}]`;
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

  // Typing explosion effects (see typing-effects.ts).
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

  // Paste keeps the note's own formatting subset: a styled clipboard
  // (text/html — copied from this note, another note, or any web page)
  // goes in through the port's sanitize-then-insert path, so bold/italic/
  // lists survive and external fonts, colors and scripts never do. Clips
  // with no usable html flavor land as plain text — the honest reading of
  // what was copied. (Markdown notes own their paste path via
  // ProseMirror; the html-engine handling below must not steal it.)
  notepad.note.on('paste', (e) => {
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
    // Styled clip first: sanitize-then-insert keeps the subset's markup.
    const html = event?.clipboardData?.getData('text/html');
    if (port && html && html.trim() !== '' && port.insertHtml(html)) {
      notepad.note.trigger('input');
      return;
    }
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

  // ---- markdown slash menu ("/" inserts blocks) — the panel + provider;
  // the insert actions are the toolbar's own commands, injected here so
  // slash.ts imports none of its siblings (architecture.test.ts pins the
  // acyclic graph), see editor/markdown/slash.ts ----
  initMarkdownSlash({
    runToolbarAction: runMarkdownToolbarAction,
    runBlockStyle: runMarkdownBlockStyle,
    openEquation: openMarkdownEquationBubble,
  });

  // ---- markdown selection bubble (the floating format toolbar over a
  // text selection) — same injection discipline as the slash menu: the
  // actions are the toolbar's own commands, see
  // editor/markdown/bubble.ts ----
  initMarkdownBubble({
    runToolbarAction: runMarkdownToolbarAction,
    openLink: openMarkdownLinkPopover,
    openEquation: openMarkdownEquationBubble,
    selectionState: markdownSelectionStateNow,
  });

  // Docs-style shortcuts for rich notes — registered BEFORE the legacy Tab
  // handler below so lists can claim Tab/Shift+Tab first.
  initRichShortcuts(tabManager);

  // ---- note-type menu — the chevron beside "New note", see
  // ui/note-type-menu.ts ----
  initNoteTypeMenu((type) => tabManager.addTab(true, type));

  notepad.note.keydown(function (e) {
    // Docs parity for the Backspace gesture: at the start of a
    // margin-indented block the first press unwinds the indent and the
    // merge waits for the next one. The native delete did both at once —
    // and its absorb pass littered the merged line with span wrappers.
    if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Markdown notes own their Backspace (the surface's keymap).
      if (!isHtmlContent(tabManager.getActive()?.noteType)) {
        return;
      }
      // Plain notes carry the indent as text: a leading tab unwinds
      // first (Docs/VS Code parity), the merge waits for the next press.
      if (!isRichNote(tabManager.getActive()) && getEditorPort()?.unindentTabAtBlockStart?.()) {
        e.preventDefault();
        return;
      }
      if (getEditorPort()?.unindentAtBlockStart?.()) {
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'Tab') {
      // Markdown notes own their Tab handling (the surface's indent
      // keymap: lists sink/lift, code blocks take two spaces, tables
      // walk cells); the html-engine indent below must not claim the
      // key from them.
      if (!isHtmlContent(tabManager.getActive()?.noteType)) {
        return;
      }
      e.preventDefault();

      const port = getEditorPort();
      if (!port) {
        return;
      }

      // Code blocks keep literal tabs — their whitespace is content, and
      // a pre block is a single text run, so the \n-splice over a code
      // selection is correct there (and stays repeatable to boot).
      if (port.queryBlockFormat() === 'pre') {
        const selection = window.getSelection();
        const selectedText = selection && selection.rangeCount > 0 ? selection.toString() : '';
        if (selectedText.indexOf('\n') !== -1) {
          const lines = selectedText.split('\n');
          const replacement = (
            e.shiftKey
              ? lines.map((line) => (line.startsWith('\t') ? line.substring(1) : line))
              : lines.map((line) => '\t' + line)
          ).join('\n');
          port.insertText(replacement, { selectInserted: true });
          return;
        }
        if (!e.shiftKey) {
          port.insertText('\t');
        }
        return;
      }

      // Everywhere else the port decides, by what the caret sits in:
      // an element block steps its margin (Docs parity), a list nests,
      // and a bare text stream — a note that never grew element blocks,
      // where "the block" is the whole document — takes the line-oriented
      // literal tab, Shift+Tab reversing. The old handler spliced a
      // \n-joined tab-prefixed string over every selection instead —
      // which through the model pipeline merged selected paragraphs into
      // one <p> littered with tab characters and soft breaks (the worst
      // of the tab bugs), and undo could not bring the structure back.
      //
      // PLAIN notes take the text gesture at every level (tabPlainText):
      // the indent is a literal tab character, one per covered line —
      // because the selection highlight paints text runs only, a margin
      // indent never lights up and a selected range read as "not all
      // tabs are selected". A tab character selects, copies and pastes
      // as the text it is. Rich notes keep the Docs-style margin step:
      // their toolbar indent/outdent buttons format blocks, and the two
      // gestures must not disagree.
      if (!isRichNote(tabManager.getActive())) {
        const plainTab = port.tabPlainText?.(e.shiftKey);
        if (plainTab !== null && plainTab !== undefined) {
          return;
        }
        // null — lists and cells own the key, or there was nothing to
        // strip: the margin fallback below keeps those paths alive.
      } else {
        const streamTab = port.tabStream?.(e.shiftKey);
        if (streamTab !== null && streamTab !== undefined) {
          return;
        }
      }
      if (e.shiftKey) {
        port.outdent();
      } else {
        port.indent();
      }
    }
  });

  notepad.copyToClipboard.click(function () {
    copyNotesToClipboard(getEditorText());
  });

  // The download menu is a registered dismissable layer — the registry
  // closes every other menu when it opens (and closes it when another
  // layer opens, or on an outside click / Escape). No stopPropagation:
  // the capture-phase sweep has already run by the time this click
  // toggles, so the click cannot stack menus anymore.
  const downloadLayer = registerLayer({
    elements: [
      notepad.downloadNotes.get(0) as HTMLElement,
      document.getElementById('iconDropdown')!,
    ],
    isOpen: () => $('#iconDropdown').hasClass('show'),
    setOpen: (open) => {
      $('#iconDropdown').toggleClass('show', open);
    },
  });

  notepad.downloadNotes.click(function () {
    downloadLayer.toggle();
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

  // The Markdown export ships the SOURCE — the .md a user would hand to
  // any other tool — captured live through the active note's surface.
  notepad.downloadNotesMarkdown.click(function () {
    const captured = getActiveNoteContent();
    if (captured && captured.noteType === 'markdown') {
      saveTextAsFile(captured.content, getMarkdownFileName(), 'text/markdown');
    }
  });

  // The Markdown row exists only while a Markdown note is active — the
  // download menu says what THIS note can become, like the toolbar chrome.
  const syncMarkdownExportRow = (): void => {
    if (isMarkdownNote(tabManager.getActive())) {
      notepad.downloadNotesMarkdown.removeAttr('hidden');
    } else {
      notepad.downloadNotesMarkdown.attr('hidden', 'hidden');
    }
  };
  tabManager.addActiveListener(syncMarkdownExportRow);
  syncMarkdownExportRow();

  // ---- split view — the top bar's Markdown-only toggle. The icon flips
  // the surface between the editing view and the side-by-side (editor +
  // owned-renderer live preview); the toolbar's segmented control follows
  // through the same surface listener, so there is exactly one source of
  // truth for the mode (see editor/markdown/surface.ts). ----
  const splitViewButton = notepad.splitViewButton;
  splitViewButton.on('click', () => {
    setMarkdownViewMode(markdownViewMode() === 'split' ? 'edit' : 'split');
  });
  const syncSplitViewChrome = (): void => {
    splitViewButton.attr('aria-pressed', markdownViewMode() === 'split' ? 'true' : 'false');
  };
  onMarkdownViewMode(syncSplitViewChrome);
  const syncSplitViewVisibility = (): void => {
    if (isMarkdownNote(tabManager.getActive())) {
      notepad.splitViewContainer.removeAttr('hidden');
    } else {
      notepad.splitViewContainer.attr('hidden', 'hidden');
    }
  };
  tabManager.addActiveListener(syncSplitViewVisibility);
  syncSplitViewVisibility();

  // Dropdown dismissal (outside clicks, other menus, Escape) is the
  // dismissable-layer registry's job — see ui/behavior/layers.ts. The old
  // document-level click closer here was defeated by every opener's
  // stopPropagation, which is how two menus ended up open at once.

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

  // ---- statistics modal — click-to-cycle cards ------------------------------
  // One card per stat FAMILY; clicking a card advances it to the next stat
  // in that family (characters → words → sentences → …), the rotation the
  // tasks list asked for ("it says 1961 characters but when I click that
  // text it switches to 340 words"). The chosen slot per family sticks
  // across shows so the modal reopens the way you left it.
  type StatEntry = { label: string; value: string | number };
  let currentStatFamilies: Record<string, StatEntry[]> = {};
  const statIndexes: Record<string, number> = {};

  const renderStatCard = (card: HTMLElement): void => {
    const family = card.dataset.statFamily ?? '';
    const entries = currentStatFamilies[family] ?? [];
    if (entries.length === 0) {
      return;
    }
    const entry = entries[(statIndexes[family] ?? 0) % entries.length];
    const label = card.querySelector('[data-stat-label]');
    const value = card.querySelector('[data-stat-value]');
    if (label) {
      label.textContent = entry.label;
    }
    if (value) {
      value.textContent = String(entry.value);
    }
  };

  notepad.statisticsModal.on('show.bs.modal', function () {
    const stats = calculateNoteStatistics(getEditorText());
    currentStatFamilies = {
      count: [
        { label: 'Characters', value: stats.characters },
        { label: 'Characters (no spaces)', value: stats.charactersNoSpaces },
        { label: 'Words', value: stats.words },
        { label: 'Sentences', value: stats.sentences },
        { label: 'Paragraphs', value: stats.paragraphs },
      ],
      vocabulary: [
        { label: 'Unique words', value: stats.uniqueWords },
        { label: 'Most common word', value: stats.mostCommonWord },
        { label: 'Avg word length', value: stats.averageWordLength },
        { label: 'Words per sentence', value: stats.wordsPerSentence },
      ],
      time: [
        { label: 'Reading time', value: stats.readingTime },
        { label: 'Speaking time', value: stats.estimatedSpeakingTime },
        { label: 'Writing time', value: stats.writingTime },
      ],
      records: [
        { label: 'Longest word', value: stats.longestWord },
        { label: 'Longest sentence', value: stats.longestSentence },
      ],
      quality: [
        { label: 'Readability score', value: stats.readabilityScore },
        { label: 'Lexical density', value: stats.lexicalDensity },
        { label: 'Estimated pages', value: stats.estimatedPages },
      ],
    };

    document
      .querySelectorAll<HTMLElement>('#statisticsBoard .stat-card[data-stat-family]')
      .forEach(renderStatCard);
  });

  $('#statisticsBoard').on('click', '.stat-card', function () {
    const card = this as HTMLElement;
    const family = card.dataset.statFamily ?? '';
    const entries = currentStatFamilies[family] ?? [];
    if (entries.length === 0) {
      return;
    }
    statIndexes[family] = ((statIndexes[family] ?? 0) + 1) % entries.length;
    card.classList.remove('stat-flip');
    void card.offsetWidth; // restart the value-swap animation
    card.classList.add('stat-flip');
    renderStatCard(card);
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
 * Music lazy seam.
 *
 * The player engine (features/music-player — player, queue, the free-song
 * resolver and the ambience tracks) used to ride the main bundle so every
 * visitor downloaded ~5k lines most never play. It now lives in a lazy
 * chunk: the modal markup mounts at boot (markup.ts is pure markup), and
 * the engine loads on the first attempt to open the player.
 *
 * The navbar click is intercepted in the CAPTURE phase — ahead of the
 * delegated modal opener in ui/behavior/modal.ts — so the modal opens
 * only after the engine wired its handlers. Opening it first would drop
 * any click that lands during the load window (nav, play, search: all
 * bound by the engine's init). After the engine is in, the interception
 * stands down and the normal delegated open flow takes over.
 */
function initMusicSubsystem(): void {
  const modal = document.getElementById('musicPlayerModal');
  if (!modal) return;

  let engines: Promise<void> | null = null;
  let engineReady = false;

  const loadEngines = (): Promise<void> => {
    engines ??= (async () => {
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
