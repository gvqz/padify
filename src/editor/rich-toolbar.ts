/**
 * Rich text toolbar — the formatting surface for rich text notes.
 *
 * Rendered (not hidden) only while the ACTIVE note is a rich note — the
 * TabManager active listener drives it, so switching notes, creating notes
 * or a background cloud merge all re-evaluate visibility in one place.
 *
 * Every mutation goes through the EditorPort (see editor/port.ts), exactly
 * like the context menu: execCommand keeps the native undo stack intact and
 * fires input events, which drive autosave and the save indicator. When the
 * document-model editor arrives it implements the same port methods and
 * this toolbar keeps working unchanged.
 *
 * The pressed states (bold/heading/list/link) follow the caret through
 * selectionchange + input, the way word processors do.
 */
import type { TabManager } from '../tabs';
import { showToast } from '../utils';
import { getEditorPort, type BlockFormat, type EditorCommand, type ListKind } from './port';
import { isRichNote } from './note-types';

/** href schemes the toolbar offers inline (mirrors the storage sanitizer). */
const SAFE_HREF_PATTERN = /^(https?:\/\/|mailto:|#|\/)/i;

/** data-rich-cmd values that carry a queryable state (removeFormat does not). */
const STATE_COMMANDS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strikeThrough',
]);

interface RichToolbarElements {
  toolbar: HTMLElement;
  linkButton: HTMLButtonElement | null;
  popover: HTMLElement;
  input: HTMLInputElement;
  apply: HTMLButtonElement | null;
  remove: HTMLButtonElement | null;
}

/**
 * queryCommand* can throw in odd selection states — never crash the UI.
 */
function safeQuery<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function initRichToolbar(tabManager: TabManager): void {
  const toolbar = document.getElementById('richToolbar');
  if (!toolbar) {
    return;
  }

  const elements: RichToolbarElements = {
    toolbar,
    linkButton: document.getElementById('richLinkButton') as HTMLButtonElement | null,
    popover: document.getElementById('richLinkPopover') as HTMLElement,
    input: document.getElementById('richLinkInput') as HTMLInputElement,
    apply: document.getElementById('richLinkApply') as HTMLButtonElement | null,
    remove: document.getElementById('richLinkRemove') as HTMLButtonElement | null,
  };

  if (!elements.popover || !elements.input) {
    return;
  }

  let stateRefreshRaf: number | null = null;

  const refreshStates = (): void => {
    const port = getEditorPort();
    if (!port) {
      return;
    }

    // A selection that no longer lives in the note (document replaced by a
    // switch/cloud merge, or the user clicked elsewhere) leaves queryCommand*
    // answering from a detached selection — the pressed states would go
    // stale garbage. Nothing selected in the note, nothing shown pressed;
    // the next selectionchange inside the note re-syncs.
    if (!port.isCaretInside()) {
      toolbar
        .querySelectorAll<HTMLButtonElement>('[aria-pressed]')
        .forEach((button) => button.setAttribute('aria-pressed', 'false'));
      return;
    }

    toolbar.querySelectorAll<HTMLButtonElement>('[data-rich-cmd]').forEach((button) => {
      const command = button.dataset.richCmd!;
      // removeFormat is an action, not a state — it never shows pressed.
      const active =
        STATE_COMMANDS.has(command) && safeQuery(() => port.queryFormat(command as never));
      button.setAttribute('aria-pressed', String(!!active));
    });

    const blockFormat = safeQuery(() => port.queryBlockFormat());
    const listKind = safeQuery(() => port.queryListKind());

    toolbar.querySelectorAll<HTMLButtonElement>('[data-rich-block]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.richBlock === blockFormat));
    });
    toolbar.querySelectorAll<HTMLButtonElement>('[data-rich-list]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.richList === listKind));
    });
  };

  const scheduleStateRefresh = (): void => {
    if (stateRefreshRaf !== null || toolbar.hidden) {
      return;
    }
    stateRefreshRaf = requestAnimationFrame(() => {
      stateRefreshRaf = null;
      refreshStates();
    });
  };

  const closeLinkPopover = (refocusEditor = false): void => {
    elements.popover.hidden = true;
    elements.linkButton?.setAttribute('aria-expanded', 'false');
    if (refocusEditor) {
      getEditorPort()?.focus();
    }
  };

  const currentAnchor = (): HTMLAnchorElement | null => {
    const selection = window.getSelection();
    const node = selection && selection.rangeCount > 0 ? selection.anchorNode : null;
    const base = node instanceof Element ? node : (node?.parentElement ?? null);
    return base?.closest('a') ?? null;
  };

  const selectionIsInNote = (): boolean => {
    const note = document.getElementById('note');
    const selection = window.getSelection();
    return (
      !!note && !!selection && selection.rangeCount > 0 && note.contains(selection.anchorNode)
    );
  };

  /**
   * The link input takes focus (that is how text gets typed into it), which
   * collapses the editor selection. Park the selection's range when the
   * popover opens and restore it before acting, so "select text, hit link"
   * behaves the way every word processor does.
   */
  let parkedRange: Range | null = null;

  const restoreParkedRange = (): void => {
    if (!parkedRange) {
      return;
    }
    getEditorPort()?.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(parkedRange);
  };

  const openLinkPopover = (): void => {
    parkedRange =
      selectionIsInNote() ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
    // Prefill with the link under the caret, if any.
    const anchor = currentAnchor();
    elements.input.value = anchor?.getAttribute('href') ?? '';
    elements.popover.hidden = false;
    elements.linkButton?.setAttribute('aria-expanded', 'true');
    elements.input.focus();
    elements.input.select();
  };

  const applyLink = (): void => {
    const port = getEditorPort();
    if (!port) {
      return;
    }

    const href = elements.input.value.trim();
    if (href === '') {
      closeLinkPopover(true);
      return;
    }
    if (!SAFE_HREF_PATTERN.test(href)) {
      showToast('Links must start with http://, https:// or mailto:');
      elements.input.focus();
      return;
    }

    // Back into the note with the selection the popover parked.
    restoreParkedRange();

    // Editing an existing link: retarget the anchor under the caret instead
    // of requiring a fresh selection.
    const anchor = currentAnchor();
    if (anchor) {
      anchor.setAttribute('href', href);
      tabManager.saveActiveFromEditor();
      closeLinkPopover(true);
      return;
    }

    if (port.insertLink(href)) {
      closeLinkPopover(true);
    } else {
      // createLink over a collapsed caret is a no-op in every engine.
      showToast('Select the text to link first.');
    }
  };

  const removeLink = (): void => {
    const port = getEditorPort();
    if (port) {
      restoreParkedRange();
      port.removeLink();
      tabManager.saveActiveFromEditor();
    }
    closeLinkPopover(true);
  };

  const runBlockCommand = (target: BlockFormat): void => {
    const port = getEditorPort();
    if (!port) {
      return;
    }
    // Clicking the active heading/quote/code block returns it to plain; the
    // ¶ button always normalizes to a paragraph.
    const current = safeQuery(() => port.queryBlockFormat());
    const next: BlockFormat = target === 'p' || current === target ? 'p' : target;
    if (current !== next) {
      port.applyBlockFormat(next);
    }
  };

  // Buttons must not steal the selection: prevent default on pointerdown so
  // the editor keeps its caret/selection while the command runs.
  toolbar.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('.rich-btn')) {
      event.preventDefault();
    }
  });

  toolbar.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.rich-btn');
    if (!button) {
      return;
    }

    if (button === elements.linkButton) {
      if (elements.popover.hidden) {
        openLinkPopover();
      } else {
        closeLinkPopover();
      }
      return;
    }

    if (button.dataset.richCmd) {
      getEditorPort()?.applyFormat(button.dataset.richCmd as EditorCommand);
    } else if (button.dataset.richBlock) {
      runBlockCommand(button.dataset.richBlock as BlockFormat);
    } else if (button.dataset.richList) {
      getEditorPort()?.toggleList(button.dataset.richList as ListKind);
    }

    scheduleStateRefresh();
  });

  elements.apply?.addEventListener('click', applyLink);
  elements.remove?.addEventListener('click', removeLink);
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLinkPopover(true);
    }
  });

  // Outside click + Escape close the link popover.
  document.addEventListener('click', (event) => {
    if (elements.popover.hidden) {
      return;
    }
    const target = event.target as Node;
    if (
      !elements.popover.contains(target) &&
      !(elements.linkButton && elements.linkButton.contains(target))
    ) {
      closeLinkPopover();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.popover.hidden) {
      closeLinkPopover(true);
    }
  });

  // Pressed states follow the caret and the edits.
  document.addEventListener('selectionchange', scheduleStateRefresh);
  getEditorPort()?.onInput(scheduleStateRefresh);

  // Visibility follows the active note — boot, switch, create, cloud merge.
  const sync = (): void => {
    const show = isRichNote(tabManager.getActive());
    toolbar.hidden = !show;
    if (!show && !elements.popover.hidden) {
      closeLinkPopover();
    }
    if (show) {
      scheduleStateRefresh();
    }
  };
  tabManager.addActiveListener(sync);
  sync();
}
