import { $ } from './lib/q';
import { showToast } from './ui/toast';
import { saveTextAsFile, getFileName } from './exports';
import { getEditorText, deriveTabTitle, type NoteTab, type TabManager } from './tabs';
import { isListening, stopVoiceTyping } from './voice';
import { htmlToText } from './editor/note-content';
import {
  NOTE_TYPE_ICONS,
  isHtmlContent,
  normalizeNoteType,
  noteTypeLabel,
  type KnownNoteType,
} from './editor/note-types';

/**
 * Picture-in-Picture floating window — moves the editor into a small
 * always-on-top window (Document Picture-in-Picture API), keeps its
 * theme in sync with the main window and supports the formatting
 * shortcuts while floating. The button only shows when supported AND
 * only for standard notes: the floating window hosts the bare editor
 * surface (no rich toolbar, no type-specific chrome), so it is a
 * plain-typing feature — a rich or Markdown note active means the
 * button hides and an open floating window closes itself.
 *
 * The floating window carries a NOTE BROWSER in its header — browse
 * every note, switch the plain ones, start a fresh one — so it works
 * as a standalone scratchpad, not just a displaced editor.
 *
 * While the note floats, the MAIN window stays fully usable: the
 * editor's slot shows a dock placeholder (with a "Bring it back"
 * button) instead of a blocking wash, and the navbar — including the
 * toggle that closes the floating window — never gets an overlay.
 */
export function initPipWindow(tabManager: TabManager): void {
  const pipButton = document.getElementById('pip')!;

  // Only show the Picture-in-Picture
  // button if the browser supports it
  if (!('documentPictureInPicture' in window)) {
    return;
  }

  let pipWindow: Window | null = null;
  let pipThemeObserver: MutationObserver | null = null;
  let pipSwitching = false;
  let pipDock: HTMLElement | null = null;
  // The floating window's header pieces, held by reference (the
  // architecture test's rule: ids that can't live in static markup are
  // reached through createElement-held nodes, not string lookups).
  let pipHeader: HTMLElement | null = null;
  let pipHeaderTitle: HTMLElement | null = null;
  // The note browser — the header's one control. Held the same way.
  let pipNotesButton: HTMLButtonElement | null = null;
  let pipNotesPanel: HTMLElement | null = null;
  let pipNotesOutsideClick: ((event: Event) => void) | null = null;

  /** The floating window is a plain-typing surface — standard notes only. */
  const syncAvailability = (): void => {
    const standard = normalizeNoteType(tabManager.getActive()?.noteType) === undefined;
    if (standard) {
      $('#pipContainer').show();
    } else {
      // Closing returns the editor to the main window (pagehide below).
      if (pipWindow) {
        pipWindow.close();
      }
      $('#pipContainer').hide();
    }
  };

  // Visibility follows the active note — boot, switch, create, cloud merge.
  // The same listener keeps the floating window's header title honest when
  // the user switches notes in the main window while floating, and keeps an
  // open note browser current (highlight + titles follow the switch).
  tabManager.addActiveListener((tab) => {
    syncAvailability();
    if (pipHeaderTitle) {
      pipHeaderTitle.textContent = deriveTabTitle(tab);
    }
    if (pipWindow && pipNotesPanel && !pipNotesPanel.hidden) {
      renderNotesPanel(pipWindow);
    }
  });
  syncAvailability();

  /**
   * Body classes that carry the app's look into the floating window:
   * dark mode plus the paper textures. Whitelisted on purpose — other
   * body classes (bootstrap's modal-open, boot-time helpers) are
   * main-window state and must not leak into the floating document.
   */
  const PIP_THEME_CLASSES = [
    'dark',
    'dotted-paper',
    'graph-paper',
    'starfield-paper',
    'grain-paper',
    'recycled-paper',
  ];

  /** Mirrors the app's theme onto the floating editor. */
  const applyPipTheme = () => {
    if (!pipWindow) return;
    for (const themeClass of PIP_THEME_CLASSES) {
      pipWindow.document.body.classList.toggle(
        themeClass,
        document.body.classList.contains(themeClass),
      );
    }
  };

  const syncPipButton = () => {
    $('#pip').attr('title', pipWindow ? 'Close Floating Window' : 'Activate Floating Window');
  };

  // ---- note browser ---------------------------------------------------------

  /** One-line preview under a row's title — the browse in "browse
   *  notes". The html subset projects through the same htmlToText the
   *  titles use; other kinds preview their raw text, which reads fine
   *  for Markdown source and JSON rows alike. */
  const notePreview = (tab: NoteTab): string => {
    const text = isHtmlContent(tab.noteType) ? htmlToText(tab.content) : tab.content;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length === 0) {
      return 'Empty note';
    }
    return flat.length > 90 ? flat.slice(0, 90) + '…' : flat;
  };

  /** The row's type mark — the rail's badge vocabulary, so the two
   *  lists read as the same collection. */
  const noteRowIcon = (noteType: NoteTab['noteType']): string => {
    const icon = NOTE_TYPE_ICONS[(noteType ?? 'standard') as KnownNoteType];
    return (
      icon?.(13) ??
      `<span style="font-size:10px;font-weight:700;line-height:1">${noteTypeLabel(
        noteType ?? 'standard',
      )
        .charAt(0)
        .toLowerCase()}</span>`
    );
  };

  /** Rebuilds the browser's rows from a fresh model snapshot — every
   *  open and every active-note change re-renders, so the list never
   *  shows a stale collection. */
  const renderNotesPanel = (targetWindow: Window): void => {
    if (!pipNotesPanel) {
      return;
    }

    const tabs = tabManager.exportForSync().tabs;
    const activeId = tabManager.getActive()?.id ?? null;

    pipNotesPanel.textContent = '';

    const head = targetWindow.document.createElement('div');
    head.className = 'pip-notes-head';
    head.textContent = `Notes · ${tabs.length}`;
    pipNotesPanel.append(head);

    for (const tab of tabs) {
      const row = targetWindow.document.createElement('button');
      row.type = 'button';
      row.className = 'pip-note-row' + (tab.id === activeId ? ' active' : '');
      row.title = `Open "${deriveTabTitle(tab)}"`;

      if (normalizeNoteType(tab.noteType) === undefined) {
        row.addEventListener('click', () => {
          tabManager.switchTo(tab.id);
          setNotesPanelOpen(targetWindow, false);
        });
      } else {
        // The floating window is a plain-typing surface: rich and
        // Markdown notes need their own chrome (toolbar / WYSIWYG),
        // so they browse here but open only from the main window.
        row.disabled = true;
        row.title = `${noteTypeLabel(tab.noteType!)} — open it from the main window`;
      }

      const icon = targetWindow.document.createElement('span');
      icon.className = 'pip-note-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = noteRowIcon(tab.noteType);

      const body = targetWindow.document.createElement('span');
      body.className = 'pip-note-body';

      const title = targetWindow.document.createElement('span');
      title.className = 'pip-note-title';
      title.textContent = deriveTabTitle(tab);

      const preview = targetWindow.document.createElement('span');
      preview.className = 'pip-note-preview';
      preview.textContent = notePreview(tab);

      body.append(title, preview);
      row.append(icon, body);
      pipNotesPanel.append(row);
    }

    const newNote = targetWindow.document.createElement('button');
    newNote.type = 'button';
    newNote.className = 'pip-note-row pip-note-new';
    newNote.title = 'Start a new plain note right here';
    newNote.innerHTML =
      '<span class="pip-note-icon" aria-hidden="true">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
      '</span>' +
      '<span class="pip-note-body"><span class="pip-note-title">New note</span></span>';
    newNote.addEventListener('click', () => {
      tabManager.addTab();
      setNotesPanelOpen(targetWindow, false);
    });
    pipNotesPanel.append(newNote);
  };

  /** Opens/closes the browser, keeping the outside-click listener and
   *  the button's expanded state in step with the panel. */
  const setNotesPanelOpen = (targetWindow: Window, open: boolean): void => {
    if (!pipNotesPanel || !pipNotesButton) {
      return;
    }

    if (open && pipNotesPanel.hidden) {
      renderNotesPanel(targetWindow);
      pipNotesPanel.hidden = false;
      pipNotesButton.setAttribute('aria-expanded', 'true');
      pipNotesButton.classList.add('open');
      pipNotesOutsideClick = (event: Event) => {
        const target = event.target as Node | null;
        if (target && !pipNotesPanel?.contains(target) && !pipNotesButton?.contains(target)) {
          setNotesPanelOpen(targetWindow, false);
        }
      };
      targetWindow.document.addEventListener('click', pipNotesOutsideClick, true);
    } else if (!open && !pipNotesPanel.hidden) {
      pipNotesPanel.hidden = true;
      pipNotesButton.setAttribute('aria-expanded', 'false');
      pipNotesButton.classList.remove('open');
      if (pipNotesOutsideClick) {
        targetWindow.document.removeEventListener('click', pipNotesOutsideClick, true);
        pipNotesOutsideClick = null;
      }
    }
  };

  /** The compact header inside the floating window: the note browser
   *  plus the live note title. No dock-back button — the window's own
   *  close affordances (the OS button, Escape, the navbar toggle) all
   *  bring the note home, and a button that repeats them is furniture. */
  const buildPipHeader = (targetWindow: Window): void => {
    const header = targetWindow.document.createElement('div');
    header.className = 'pip-header';
    header.id = 'pipHeader';

    const notesButton = targetWindow.document.createElement('button');
    notesButton.type = 'button';
    notesButton.className = 'pip-notes-btn';
    notesButton.title = 'Browse notes';
    notesButton.setAttribute('aria-label', 'Browse notes');
    notesButton.setAttribute('aria-haspopup', 'true');
    notesButton.setAttribute('aria-expanded', 'false');
    notesButton.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M9.5 6h11"/><path d="M9.5 12h11"/><path d="M9.5 18h11"/>' +
      '<path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>' +
      '</svg>';
    notesButton.addEventListener('click', () => {
      if (pipNotesPanel) {
        setNotesPanelOpen(targetWindow, pipNotesPanel.hidden);
      }
    });

    const title = targetWindow.document.createElement('span');
    title.className = 'pip-header-title';
    title.id = 'pipHeaderTitle';
    const active = tabManager.getActive();
    title.textContent = active ? deriveTabTitle(active) : 'Note';
    title.title = 'The note open in this window';

    header.append(notesButton, title);
    targetWindow.document.body.append(header);
    pipHeader = header;
    pipHeaderTitle = title;
    pipNotesButton = notesButton;
  };

  /** The browser's dropdown panel — hidden until the header button
   *  opens it. */
  const buildNotesPanel = (targetWindow: Window): void => {
    const panel = targetWindow.document.createElement('div');
    panel.className = 'pip-notes';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Notes');
    targetWindow.document.body.append(panel);
    pipNotesPanel = panel;
  };

  /**
   * The placeholder that fills the editor's slot in the MAIN window while
   * the note floats: what happened, where the note went, and a one-click
   * way back. The main window keeps working the whole time — the rail
   * stays clickable, the navbar is never blocked.
   */
  const showDockPlaceholder = (): void => {
    const editorShell = document.getElementById('editorShell');
    if (!editorShell || document.querySelector('.pip-dock')) return;

    const dock = document.createElement('div');
    dock.className = 'pip-dock';
    dock.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'pip-dock-icon';
    icon.innerHTML =
      '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />' +
      '<rect x="12" y="13" width="10" height="7" rx="2" /></svg>';

    const text = document.createElement('div');
    text.className = 'pip-dock-text';
    const lineOne = document.createElement('p');
    lineOne.className = 'pip-dock-title';
    lineOne.textContent = 'This note is in the floating window';
    const lineTwo = document.createElement('p');
    lineTwo.className = 'pip-dock-sub';
    lineTwo.textContent =
      'The main window stays fully usable — pick another note or bring this one back.';
    text.append(lineOne, lineTwo);

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'pip-dock-btn';
    backButton.textContent = 'Bring it back';
    backButton.title = 'Close the floating window and return the note here';
    backButton.addEventListener('click', () => {
      pipWindow?.close();
    });

    dock.append(icon, text, backButton);
    editorShell.append(dock);
    pipDock = dock;
  };

  const removeDockPlaceholder = (): void => {
    pipDock?.remove();
    pipDock = null;
  };

  pipButton.addEventListener('click', async () => {
    if (pipSwitching) return;

    // The button toggles: while a floating window is open,
    // clicking again closes it instead of opening a second
    // one (which used to race the close handler and could
    // leave the editor stranded in the wrong document).
    if (pipWindow) {
      pipWindow.close();
      return;
    }

    const appTextarea = document.getElementById('textareaContainer');

    if (!appTextarea) return;

    pipSwitching = true;
    try {
      // Open a Picture-in-Picture window. The API can
      // reject (blocked iframe, too many windows, no
      // user gesture) — tell the user instead of
      // leaving a silent unhandled rejection.
      let newPipWindow: Window;
      try {
        newPipWindow = await documentPictureInPicture!.requestWindow({
          width: 350,
          height: 500,
        });
      } catch {
        showToast('The floating window could not be opened. Try again.');
        return;
      }
      pipWindow = newPipWindow;

      // Move the editor back into the main window
      // when the floating window closes (X button,
      // Escape, or the PiP button again).
      newPipWindow.addEventListener('pagehide', () => {
        pipWindow = null;
        pipThemeObserver?.disconnect();
        pipThemeObserver = null;
        syncPipButton();

        const floatingEditor = newPipWindow.document.getElementById('textareaContainer');
        pipHeader?.remove();
        pipHeader = null;
        pipHeaderTitle = null;
        pipNotesButton = null;
        pipNotesOutsideClick = null;
        pipNotesPanel?.remove();
        pipNotesPanel = null;
        newPipWindow.document.body?.classList.remove('pip-host', ...PIP_THEME_CLASSES);

        // The editor's slot in the main window goes back to normal first,
        // whatever happened to the editor itself.
        removeDockPlaceholder();
        if (floatingEditor) {
          // Restore it to its exact original slot: the
          // last child of #editorShell, next to the note
          // rail (appending to #mainContainer used to drop
          // it outside the shell's flex layout).
          const editorShell = document.getElementById('editorShell');
          (editorShell ?? document.getElementById('mainContainer'))?.append(floatingEditor);
          floatingEditor.classList.remove('dark');
        }

        document.getElementById('mainContainer')?.classList.remove('pip');

        // Bring the caret back so typing can continue
        // right where it left off.
        const mainEditor = document.getElementById('note');
        mainEditor?.focus({ preventScroll: true });
      });

      newPipWindow.document.title = 'Padify — Floating note';

      Array.from(document.styleSheets).forEach((styleSheet) => {
        try {
          const cssRules = Array.from(styleSheet.cssRules)
            .map((rule) => rule.cssText)
            .join('');
          const style = document.createElement('style');

          style.textContent = cssRules;
          newPipWindow.document.head.appendChild(style);
        } catch {
          const link = document.createElement('link');

          link.rel = 'stylesheet';
          link.type = styleSheet.type;
          link.media = styleSheet.media as unknown as string;
          link.href = styleSheet.href!;
          newPipWindow.document.head.appendChild(link);
        }
      });

      // Compact header (with the note browser) first, then the editor
      // under it.
      buildPipHeader(newPipWindow);
      buildNotesPanel(newPipWindow);

      // Move the editor into the floating window.
      newPipWindow.document.body.append(appTextarea);
      newPipWindow.document.body.classList.add('pip-host');
      applyPipTheme();

      // Keep the theme in sync while floating (the
      // observer fires for every body class change,
      // so radio picks, reset and device theme all
      // propagate).
      pipThemeObserver = new MutationObserver(applyPipTheme);
      pipThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

      // The main window's editor slot becomes the dock
      // placeholder — informative, not blocking.
      document.getElementById('mainContainer')?.classList.add('pip');
      showDockPlaceholder();

      // Keyboard support inside the floating window: Escape closes
      // the note browser first, then the window itself; the format
      // shortcuts edit; Ctrl/Cmd+S exports the note.
      newPipWindow.document.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          // The browser is a layer INSIDE the window — Escape peels it
          // back before it ever reaches for the window itself.
          if (pipNotesPanel && !pipNotesPanel.hidden) {
            setNotesPanelOpen(newPipWindow, false);
            return;
          }
          newPipWindow.close();
          return;
        }

        const target = event.target as HTMLElement | null;
        if (!target || (target.id !== 'note' && target.closest('#note') === null)) return;

        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          let command: string | null = null;
          if (event.shiftKey && event.code === 'KeyX') {
            command = 'strikeThrough';
          } else if (!event.shiftKey) {
            if (event.code === 'KeyB') command = 'bold';
            else if (event.code === 'KeyI') command = 'italic';
            else if (event.code === 'KeyU') command = 'underline';
            else if (event.code === 'KeyS') {
              event.preventDefault();
              saveTextAsFile(getEditorText(), getFileName());
              return;
            }
          }
          if (command) {
            event.preventDefault();
            try {
              newPipWindow.document.execCommand(command);
            } catch {
              /* command unsupported in this browser */
            }
          }
        }
      });

      // Put the caret at the end of the note so the
      // floating window is immediately typeable.
      const editor = newPipWindow.document.getElementById('note');
      if (editor) {
        editor.focus({ preventScroll: true });
        const selection = newPipWindow.document.getSelection();
        if (selection) {
          const range = newPipWindow.document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }

      syncPipButton();
    } finally {
      pipSwitching = false;
    }
  });

  documentPictureInPicture!.addEventListener('enter', () => {
    // Dictation drives the main window's selection — stop
    // it when the note moves into the floating window.
    if (isListening()) {
      stopVoiceTyping();
    }

    applyPipTheme();
  });
}
