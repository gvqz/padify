import { $ } from './lib/q';
import { showToast, saveTextAsFile, getFileName } from './utils';
import { getEditorText } from './tabs';
import { isListening, stopVoiceTyping } from './voice';

/**
 * Picture-in-Picture floating window — moves the editor into a small
 * always-on-top window (Document Picture-in-Picture API), keeps its
 * theme in sync with the main window and supports the formatting
 * shortcuts while floating. The button only shows when supported.
 */
export function initPipWindow(): void {
  const pipButton = document.getElementById('pip')!;

  // Only show the Picture-in-Picture
  // button if the browser supports it
  if (!('documentPictureInPicture' in window)) {
    return;
  }

  $('#pipContainer').show();

  let pipWindow: Window | null = null;
  let pipThemeObserver: MutationObserver | null = null;
  let pipSwitching = false;

  /** Mirrors the app's dark mode onto the floating editor. */
  const applyPipTheme = () => {
    if (!pipWindow) return;
    pipWindow.document.body.classList.toggle('dark', document.body.classList.contains('dark'));
  };

  const syncPipButton = () => {
    $('#pip').attr('title', pipWindow ? 'Close Floating Window' : 'Activate Floating Window');
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
        newPipWindow.document.body?.classList.remove('pip-host', 'dark');

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
        const overlay = document.querySelector('.overlay') as HTMLElement | null;
        if (overlay) {
          overlay.style.display = 'none';
          overlay.style.pointerEvents = 'none';
        }

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
    const mainContainer = document.querySelector('#mainContainer');
    const overlay = document.querySelector('.overlay') as HTMLElement | null;

    mainContainer?.classList.add('pip');
    if (overlay) {
      overlay.style.display = 'block';
      overlay.style.pointerEvents = 'all';
    }

    // Dictation drives the main window's selection — stop
    // it when the note moves into the floating window.
    if (isListening()) {
      stopVoiceTyping();
    }

    applyPipTheme();
  });
}
