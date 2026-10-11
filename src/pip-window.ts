import { $ } from './lib/q';
import { showToast } from './ui/toast';
import { saveTextAsFile, getFileName } from './exports';
import { getEditorText, deriveTabTitle, type TabManager } from './tabs';
import { isListening, stopVoiceTyping } from './voice';
import { normalizeNoteType } from './editor/note-types';

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
  // the user switches notes in the main window while floating.
  tabManager.addActiveListener((tab) => {
    syncAvailability();
    if (pipHeaderTitle) {
      pipHeaderTitle.textContent = deriveTabTitle(tab);
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

  /** The compact header inside the floating window: note title + dock button. */
  const buildPipHeader = (targetWindow: Window): void => {
    const header = targetWindow.document.createElement('div');
    header.className = 'pip-header';
    header.id = 'pipHeader';

    const title = targetWindow.document.createElement('span');
    title.className = 'pip-header-title';
    title.id = 'pipHeaderTitle';
    const active = tabManager.getActive();
    title.textContent = active ? deriveTabTitle(active) : 'Note';
    title.title = 'The note open in this window';

    const dockButton = targetWindow.document.createElement('button');
    dockButton.type = 'button';
    dockButton.className = 'pip-header-dock';
    dockButton.title = 'Bring the note back to the main window';
    dockButton.setAttribute('aria-label', 'Bring the note back to the main window');
    dockButton.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />' +
      '<rect x="12" y="13" width="10" height="7" rx="2" /></svg>';
    dockButton.addEventListener('click', () => {
      targetWindow.close();
    });

    header.append(title, dockButton);
    targetWindow.document.body.append(header);
    pipHeader = header;
    pipHeaderTitle = title;
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

      // Compact header first, then the editor under it.
      buildPipHeader(newPipWindow);

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

      // Keyboard support inside the floating window:
      // Escape closes it, the format shortcuts edit,
      // Ctrl/Cmd+S exports the note.
      newPipWindow.document.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
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
