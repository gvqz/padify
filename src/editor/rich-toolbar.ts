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
import {
  getEditorPort,
  type EditorPort,
  type BlockFormat,
  type EditorCommand,
  type ListKind,
  type ScriptType,
} from './port';
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

/** data-rich-action values and the port call each one means. */
const ACTIONS: Readonly<Record<string, (port: EditorPort) => void>> = {
  undo: (port) => port.undo(),
  redo: (port) => port.redo(),
  sup: (port) => port.applyScript('super'),
  sub: (port) => port.applyScript('sub'),
  indent: (port) => port.indent(),
  outdent: (port) => port.outdent(),
  hr: (port) => port.insertHorizontalRule(),
  'align-left': (port) => port.applyAlignment('left'),
  'align-center': (port) => port.applyAlignment('center'),
  'align-right': (port) => port.applyAlignment('right'),
  'align-justify': (port) => port.applyAlignment('justify'),
};

/** Fonts the menu offers — the caret label matches against these. */
const KNOWN_FONTS: readonly string[] = [
  'arial',
  'verdana',
  'times new roman',
  'georgia',
  'courier new',
];

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
      const tableHost = document.getElementById('richTableMenuHost');
      if (tableHost) {
        tableHost.hidden = true;
      }
      refreshHistoryButtons();
      return;
    }

    // The table-ops menu only means something while the caret sits in a
    // table — it appears and disappears with the context, like Docs' hover
    // toolbar, just docked so it cannot cover the cells.
    const tableHost = document.getElementById('richTableMenuHost');
    if (tableHost) {
      tableHost.hidden = !safeQuery(() => port.queryTableContext());
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

    // Superscript/subscript and the alignments answer through queryCommand*
    // too — 'left' reports true on default-aligned blocks, so the resting
    // state shows pressed like Docs does.
    toolbar.querySelectorAll<HTMLButtonElement>('[data-rich-query]').forEach((button) => {
      const query = button.dataset.richQuery!;
      let active: boolean | null = false;
      if (query === 'super' || query === 'sub') {
        active = safeQuery(() => port.queryScript(query));
      } else if (query.startsWith('align-')) {
        active = safeQuery(() => port.queryAlignment()) === query.slice('align-'.length);
      }
      button.setAttribute('aria-pressed', String(!!active));
    });

    refreshCaretLabels();
    refreshHistoryButtons();
  };

  /**
   * Docs dims undo/redo at the ends of the history. Chrome answers
   * queryCommandEnabled for both reliably on the editor surface — the
   * buttons stay focusable and clickable (a dead undo click is a harmless
   * no-op), only the ink changes.
   */
  const refreshHistoryButtons = (): void => {
    const canUndo = safeQuery(() => document.queryCommandEnabled('undo')) ?? false;
    const canRedo = safeQuery(() => document.queryCommandEnabled('redo')) ?? false;
    const undoButton = toolbar.querySelector<HTMLElement>('[data-rich-action="undo"]');
    const redoButton = toolbar.querySelector<HTMLElement>('[data-rich-action="redo"]');
    undoButton?.setAttribute('aria-disabled', String(!canUndo));
    redoButton?.setAttribute('aria-disabled', String(!canRedo));
  };

  /**
   * The size/font buttons echo what the caret sits in, the way Docs' menus
   * do — read from the computed style of the selection's element rather
   * than the legacy queryCommandValue scale.
   */
  const refreshCaretLabels = (): void => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const anchor = selection.getRangeAt(0).startContainer;
    const element = anchor instanceof Element ? anchor : anchor.parentElement;
    if (!element) {
      return;
    }
    const style = window.getComputedStyle(element);

    const sizeLabel = toolbar.querySelector<HTMLElement>('[data-rich-label="size"]');
    if (sizeLabel) {
      const px = parseFloat(style.fontSize);
      sizeLabel.textContent = Number.isFinite(px) ? String(Math.round(px)) : '16';
    }

    const fontLabel = toolbar.querySelector<HTMLElement>('[data-rich-label="font"]');
    if (fontLabel) {
      const family = (style.fontFamily.split(',')[0] ?? '')
        .replace(/["']/g, '')
        .trim()
        .toLowerCase();
      const known = KNOWN_FONTS.find((font) => font === family);
      if (known) {
        fontLabel.textContent = known
          .split(' ')
          .map((word) => word[0]!.toUpperCase() + word.slice(1))
          .join(' ');
      } else {
        fontLabel.textContent = 'Font';
      }
    }
  };

  // ---------------------------------------------------------------------------
  // The Docs-style dropdown menus (size, font, colors). One open at a time;
  // the editor keeps its selection while choosing (pointerdown is prevented)
  // and focus lands on the first item so keyboard users are first-class.
  // ---------------------------------------------------------------------------

  const closeMenus = (refocusEditor = false): void => {
    toolbar.querySelectorAll<HTMLButtonElement>('[data-rich-menu]').forEach((button) => {
      button.setAttribute('aria-expanded', 'false');
    });
    toolbar.querySelectorAll<HTMLElement>('.rich-menu-panel').forEach((panel) => {
      panel.hidden = true;
    });
    if (refocusEditor) {
      getEditorPort()?.focus();
    }
  };

  const openMenu = (button: HTMLButtonElement): void => {
    const panel = button.parentElement?.querySelector<HTMLElement>('.rich-menu-panel');
    if (!panel) {
      return;
    }
    closeMenus();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    clampPanelToViewport(panel);
    markCurrentValue(button, panel);
    panel.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  };

  /**
   * Panels anchor to their (absolutely positioned) host with plain CSS, so a
   * wide panel beside a toolbar button near the window's right edge — the
   * table grid, the table options — paints off-screen. Shift it back inside
   * once it has its real size.
   */
  const clampPanelToViewport = (panel: HTMLElement): void => {
    panel.style.removeProperty('margin-left');
    const rect = panel.getBoundingClientRect();
    const overflow = rect.right - window.innerWidth + 4; // 4px breathing room
    if (overflow > 0) {
      panel.style.marginLeft = `${-overflow}px`;
    }
  };

  /**
   * Docs marks the size/font the caret currently sits in. The caret labels
   * already track the live values — echo the one the menu is about to offer.
   */
  const markCurrentValue = (button: HTMLButtonElement, panel: HTMLElement): void => {
    const kind = button.dataset.richMenu;
    if (kind !== 'size' && kind !== 'font') {
      return;
    }
    const current = toolbar
      .querySelector<HTMLElement>(`[data-rich-label="${kind}"]`)
      ?.textContent?.trim()
      .toLowerCase();
    panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]').forEach((item) => {
      const matches =
        current !== undefined &&
        current !== '' &&
        item.textContent!.trim().toLowerCase() === current;
      item.setAttribute('aria-checked', String(matches));
      item.classList.toggle('rich-menu-current', matches);
    });
  };

  const toggleMenu = (button: HTMLButtonElement): void => {
    const panel = button.parentElement?.querySelector<HTMLElement>('.rich-menu-panel');
    if (panel?.hidden) {
      openMenu(button);
    } else {
      closeMenus(true);
    }
  };

  const anyMenuOpen = (): boolean =>
    Array.from(toolbar.querySelectorAll<HTMLElement>('.rich-menu-panel')).some(
      (panel) => !panel.hidden,
    );

  /**
   * Arrow-key roving over a menu's items — list menus move by one, swatch
   * grids follow their column count (read from the computed grid), Home/End
   * jump to the edges, everything wraps.
   */
  const roveMenu = (panel: HTMLElement, key: string): void => {
    const items = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current === -1) {
      items[key === 'ArrowUp' ? items.length - 1 : 0]?.focus();
      return;
    }
    const columns =
      window.getComputedStyle(panel).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[key] ?? 0;
    if (step === 0 && key !== 'Home' && key !== 'End') {
      return;
    }
    const target =
      key === 'Home' ? 0 : key === 'End' ? items.length - 1 : current + step;
    const next = ((target % items.length) + items.length) % items.length;
    items[next]?.focus();
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

  // The grid picker previews the rectangle the pointer covers, the way
  // Docs' insert grid does: every cell up to the hovered row/column lights.
  const gridPanel = toolbar.querySelector<HTMLElement>('.rich-menu-panel-grid');
  const paintGrid = (hovered: HTMLElement | null): void => {
    const cells = Array.from(gridPanel?.querySelectorAll<HTMLElement>('[data-rich-grid]') ?? []);
    const [row = -1, col = -1] = (hovered?.dataset.richGrid ?? '-1,-1').split(',').map(Number);
    cells.forEach((cell) => {
      const [r = -1, c = -1] = (cell.dataset.richGrid ?? '-1,-1').split(',').map(Number);
      cell.classList.toggle('rich-grid-on', r <= row && c <= col);
    });
  };
  gridPanel?.addEventListener('mouseover', (event) => {
    paintGrid((event.target as HTMLElement).closest<HTMLElement>('[data-rich-grid]'));
  });
  gridPanel?.addEventListener('mouseleave', () => paintGrid(null));

  const closeLinkPopover = (refocusEditor = false): void => {
    elements.popover.hidden = true;
    elements.linkButton?.setAttribute('aria-expanded', 'false');
    if (refocusEditor) {
      getEditorPort()?.focus();
    }
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
    elements.input.value = safeQuery(() => getEditorPort()?.queryLinkHref()) ?? '';
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
    if (port.retargetLink(href)) {
      tabManager.saveActiveFromEditor();
      closeLinkPopover(true);
      return;
    }

    if (port.insertLink(href)) {
      closeLinkPopover(true);
    } else {
      // createLink over a collapsed caret is refused by the port — guide
      // instead of dumping the href, and get out of the note's way so the
      // user can actually select text.
      showToast('Select the text to link first.');
      closeLinkPopover(true);
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

  // Buttons and menu items must not steal the selection: prevent default on
  // pointerdown so the editor keeps its caret/selection while the command
  // runs — the menus behave like Docs' (choose a color mid-selection).
  toolbar.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('.rich-btn') || target.closest('.rich-menu-item') || target.closest('.rich-swatch')) {
      event.preventDefault();
    }
  });

  toolbar.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    // --- dropdown menus -------------------------------------------------
    const menuButton = target.closest<HTMLButtonElement>('[data-rich-menu]');
    if (menuButton) {
      toggleMenu(menuButton);
      return;
    }

    const port = getEditorPort();
    if (!port) {
      return;
    }

    const sizeItem = target.closest<HTMLButtonElement>('[data-rich-size]');
    if (sizeItem) {
      port.setFontSize(Number(sizeItem.dataset.richSize));
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    const fontItem = target.closest<HTMLButtonElement>('[data-rich-font]');
    if (fontItem) {
      port.setFontFamily(fontItem.dataset.richFont!);
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    const colorItem = target.closest<HTMLButtonElement>('[data-rich-color]');
    if (colorItem) {
      port.setTextColor(colorItem.dataset.richColor!);
      // The glyph bar previews the ink the picker last applied (session only).
      toolbar
        .querySelector<HTMLElement>('[data-rich-ink="color"]')
        ?.style.setProperty('--rich-ink', colorItem.dataset.richColor!);
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    const highlightItem = target.closest<HTMLButtonElement>('[data-rich-highlight]');
    if (highlightItem) {
      const color = highlightItem.dataset.richHighlight!;
      port.setHighlight(color);
      // The marker's swipe line previews the last ink (session only, the
      // same deal as the text-color bar); "None" returns it to plain ink.
      const hiliteGlyph = toolbar.querySelector<SVGElement>('[data-rich-hilite]');
      if (hiliteGlyph) {
        if (color === 'transparent') {
          hiliteGlyph.style.removeProperty('--rich-hilite');
        } else {
          hiliteGlyph.style.setProperty('--rich-hilite', color);
        }
      }
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    // The table grid picker: cell (r,c) inserts an (r+1)x(c+1) table.
    const gridCell = target.closest<HTMLButtonElement>('[data-rich-grid]');
    if (gridCell) {
      const [row = 0, col = 0] = (gridCell.dataset.richGrid ?? '0,0').split(',').map(Number);
      port.insertTable(row + 1, col + 1);
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    const tableItem = target.closest<HTMLButtonElement>('[data-rich-table]');
    if (tableItem) {
      port.runTableAction(tableItem.dataset.richTable!);
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    // --- plain buttons ---------------------------------------------------
    const button = target.closest<HTMLButtonElement>('.rich-btn');
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
      port.applyFormat(button.dataset.richCmd as EditorCommand);
    } else if (button.dataset.richAction) {
      ACTIONS[button.dataset.richAction]?.(port);
    } else if (button.dataset.richBlock) {
      runBlockCommand(button.dataset.richBlock as BlockFormat);
    } else if (button.dataset.richList) {
      port.toggleList(button.dataset.richList as ListKind);
    }

    scheduleStateRefresh();
  });

  // Menu keyboard: arrows rove, Escape/Tab leave the menu back into the note.
  toolbar.addEventListener('keydown', (event) => {
    const active = document.activeElement as HTMLElement | null;
    const panel = active?.closest<HTMLElement>('.rich-menu-panel');
    if (!panel) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      roveMenu(panel, event.key);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      roveMenu(panel, event.key);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenus(true);
    } else if (event.key === 'Tab') {
      closeMenus();
    }
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

  // Outside click closes the link popover AND the menus; Escape likewise.
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (
      !elements.popover.hidden &&
      !elements.popover.contains(target) &&
      !(elements.linkButton && elements.linkButton.contains(target))
    ) {
      closeLinkPopover();
    }
    if (anyMenuOpen() && !toolbar.contains(target)) {
      closeMenus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!elements.popover.hidden) {
        closeLinkPopover(true);
      }
      if (anyMenuOpen()) {
        closeMenus(true);
      }
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
    if (!show && anyMenuOpen()) {
      closeMenus();
    }
    if (show) {
      scheduleStateRefresh();
    }
  };
  tabManager.addActiveListener(sync);
  sync();
}
