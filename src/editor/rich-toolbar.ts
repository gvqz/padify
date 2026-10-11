/**
 * Rich text toolbar — the formatting surface for rich text notes.
 *
 * Rendered (not hidden) only while the ACTIVE note is a rich note — the
 * TabManager active listener drives it, so switching notes, creating notes
 * or a background cloud merge all re-evaluate visibility in one place.
 *
 * Every mutation goes through the EditorPort (see editor/port.ts), exactly
 * like the context menu: the model engine keeps its own history and every
 * command repaints + announces an input event, which drives autosave and
 * the save indicator.
 *
 * The pressed states (bold/heading/list/link) follow the caret through
 * selectionchange + input, the way word processors do.
 */
import type { TabManager } from '../tabs';
import { showToast } from '../ui/toast';
import {
  getEditorPort,
  type EditorPort,
  type BlockFormat,
  type EditorCommand,
  type ListKind,
} from './port';
import { isRichNote } from './note-types';
import { currentThemeMode, resolvePaletteColor } from './theme-colors';
import { mountColorPicker, type ColorPickerEntry, type ColorPickerHandle } from './color-picker';
import { MATH_CLASS, MATH_ID_ATTR, MATH_LATEX_PATTERN, renderMathPreview } from './math';
import { mountMathPalette } from './math-palette';

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

/** The styles-menu button echoes the caret's block format, Docs-style. */
const BLOCK_LABELS: Readonly<Record<BlockFormat, string>> = {
  p: 'Normal text',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  blockquote: 'Quote',
  pre: 'Code block',
};

interface RichToolbarElements {
  toolbar: HTMLElement;
  linkButton: HTMLButtonElement | null;
  popover: HTMLElement;
  input: HTMLInputElement;
  apply: HTMLButtonElement | null;
  remove: HTMLButtonElement | null;
  chipRow: HTMLElement | null;
  editRow: HTMLElement | null;
  view: HTMLAnchorElement | null;
  edit: HTMLButtonElement | null;
  copy: HTMLButtonElement | null;
  chipRemove: HTMLButtonElement | null;
  mathPopover: HTMLElement | null;
  mathPalette: HTMLElement | null;
  mathInput: HTMLInputElement | null;
  mathInsert: HTMLButtonElement | null;
  mathPreview: HTMLElement | null;
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
    editRow: document.querySelector('#richLinkPopover [data-link-mode="edit"]'),
    chipRow: document.querySelector('#richLinkPopover [data-link-mode="view"]'),
    view: document.getElementById('richLinkView') as HTMLAnchorElement | null,
    edit: document.getElementById('richLinkEdit') as HTMLButtonElement | null,
    copy: document.getElementById('richLinkCopy') as HTMLButtonElement | null,
    chipRemove: document.getElementById('richLinkChipRemove') as HTMLButtonElement | null,
    mathPopover: document.getElementById('richMathPopover'),
    mathPalette: document.getElementById('richMathPalette'),
    mathInput: document.getElementById('richMathInput') as HTMLInputElement | null,
    mathInsert: document.getElementById('richMathInsert') as HTMLButtonElement | null,
    mathPreview: document.getElementById('richMathPreview'),
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
    const blockLabel = toolbar.querySelector<HTMLElement>('[data-rich-label="block"]');
    if (blockLabel) {
      blockLabel.textContent = BLOCK_LABELS[blockFormat ?? 'p'] ?? BLOCK_LABELS.p;
    }

    const listKind = safeQuery(() => port.queryListKind());

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

    // The link button reads pressed while the caret sits in a link — the
    // same "state at the caret" contract as the other buttons.
    if (elements.linkButton) {
      const inLink = safeQuery(() => port.queryLinkHref());
      elements.linkButton.setAttribute('aria-pressed', String(!!inLink));
    }

    refreshCaretLabels();
    refreshHistoryButtons();
  };

  /**
   * Docs dims undo/redo at the ends of the history. The port answers from
   * its own history (engine-specific: the browser stack for the legacy
   * adapter, the model stacks for the model engine) — the buttons stay
   * focusable and clickable (a dead undo click is a harmless no-op), only
   * the ink changes.
   */
  const refreshHistoryButtons = (): void => {
    const canUndo = safeQuery(() => getEditorPort()?.canUndo()) ?? false;
    const canRedo = safeQuery(() => getEditorPort()?.canRedo()) ?? false;
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
    // The color pickers' custom section takes keyboard focus (that is how
    // text gets typed into it), which collapses the editor selection. Park
    // the range at open — the same deal as the link popover — so "select
    // text, then drag a custom color" applies to what was selected.
    if (button.dataset.richMenu === 'color' || button.dataset.richMenu === 'highlight') {
      parkedRange = selectionIsInNote() ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
    }
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

  /** Docs marks the size/font/styles the caret sits in; custom sizes echo
   * into the input row so a second visit shows what the caret is in. */
  const markCurrentValue = (button: HTMLButtonElement, panel: HTMLElement): void => {
    const kind = button.dataset.richMenu;
    if (kind === 'color' || kind === 'highlight') {
      // The picker marks the swatch matching the caret's ink; highlight has
      // no reliable queryCommandValue dialect, so nothing is marked there.
      const current =
        kind === 'color' ? (safeQuery(() => getEditorPort()?.queryTextColor()) ?? null) : null;
      (kind === 'color' ? textColorPicker : highlightPicker)?.refresh(current);
      return;
    }
    if (kind !== 'size' && kind !== 'font' && kind !== 'block') {
      return;
    }
    const current = toolbar
      .querySelector<HTMLElement>(`[data-rich-label="${kind}"]`)
      ?.textContent?.trim()
      .toLowerCase();
    let presetMatched = false;
    panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]').forEach((item) => {
      const matches =
        current !== undefined &&
        current !== '' &&
        item.textContent!.trim().toLowerCase() === current;
      if (matches) {
        presetMatched = true;
      }
      item.setAttribute('aria-checked', String(matches));
      item.classList.toggle('rich-menu-current', matches);
    });
    // A non-preset caret size (custom 1–400) — echo it into the input row.
    if (kind === 'size') {
      const input = panel.querySelector<HTMLInputElement>('[data-rich-size-custom] input');
      if (input && !presetMatched && current !== undefined && /^\d+$/.test(current)) {
        input.value = current;
      }
    }
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
    const target = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : current + step;
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

  const selectionIsInNote = (): boolean => {
    const note = document.getElementById('note');
    const selection = window.getSelection();
    return !!note && !!selection && selection.rangeCount > 0 && note.contains(selection.anchorNode);
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

  /** The link the popover is currently looking at (chip display + copy). */
  let chipHref = '';

  const showEditMode = (): void => {
    elements.chipRow!.hidden = true;
    elements.editRow!.hidden = false;
  };

  const showChipMode = (href: string): void => {
    chipHref = href;
    if (elements.view) {
      elements.view.textContent = href;
      elements.view.setAttribute('href', href);
    }
    elements.editRow!.hidden = true;
    elements.chipRow!.hidden = false;
  };

  const openLinkPopover = (): void => {
    parkedRange = selectionIsInNote() ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
    const existing = safeQuery(() => getEditorPort()?.queryLinkHref()) ?? '';
    if (existing) {
      // Docs-style chip: the link under the caret with its actions.
      showChipMode(existing);
    } else {
      elements.input.value = '';
      showEditMode();
    }
    // Anchored to the toolbar button (the default) — the link-click path
    // floats the same popover under the clicked link instead.
    resetPopoverFloat();
    elements.popover.hidden = false;
    elements.linkButton?.setAttribute('aria-expanded', 'true');
    if (existing) {
      elements.edit?.focus();
    } else {
      elements.input.focus();
      elements.input.select();
    }
  };

  /** The link whose click floated the popover (clicking it must not close). */
  let floatingAnchor: HTMLAnchorElement | null = null;

  /** Back to the toolbar-anchored position — clears the float coordinates. */
  const resetPopoverFloat = (): void => {
    floatingAnchor = null;
    elements.popover.classList.remove('rich-link-popover-floating');
    elements.popover.style.removeProperty('left');
    elements.popover.style.removeProperty('top');
  };

  /**
   * Clicking a link in the note shows its chip right under the link, the
   * way Docs answers a click on a link. Deliberately steals no focus: the
   * editor keeps it and typing flows on.
   */
  const openLinkChipAtAnchor = (anchor: HTMLAnchorElement, href: string): void => {
    parkedRange = selectionIsInNote() ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
    floatingAnchor = anchor;
    showChipMode(href);
    elements.popover.hidden = false;
    elements.popover.classList.add('rich-link-popover-floating');
    elements.linkButton?.setAttribute('aria-expanded', 'true');

    // Under the link, clamped to the viewport (the menu-opening lesson).
    const rect = anchor.getBoundingClientRect();
    const width = elements.popover.offsetWidth;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const top = Math.min(rect.bottom + 6, window.innerHeight - 48);
    elements.popover.style.left = `${Math.max(8, left)}px`;
    elements.popover.style.top = `${Math.max(8, top)}px`;
  };

  const closeLinkPopover = (refocusEditor = false): void => {
    elements.popover.hidden = true;
    elements.linkButton?.setAttribute('aria-expanded', 'false');
    resetPopoverFloat();
    if (refocusEditor) {
      getEditorPort()?.focus();
    }
  };

  /**
   * Docs completes bare domains into https:// links ("example.com" →
   * "https://example.com"); scheme-relative paths and anchors pass through.
   */
  const completeHref = (raw: string): string => {
    const value = raw.trim();
    if (SAFE_HREF_PATTERN.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
      return value;
    }
    return `https://${value}`;
  };

  const applyLink = (): void => {
    const port = getEditorPort();
    if (!port) {
      return;
    }

    const href = completeHref(elements.input.value);
    if (elements.input.value.trim() === '') {
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
      return;
    }

    // Nothing selected: Docs pastes the URL itself as the linked text.
    if (port.insertLinkAsText(href)) {
      closeLinkPopover(true);
      return;
    }
    closeLinkPopover(true);
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
    if (
      target.closest('.rich-btn') ||
      target.closest('.rich-menu-item') ||
      target.closest('.rich-swatch')
    ) {
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

    // The styles menu: choosing the active style returns the block to plain.
    const blockItem = target.closest<HTMLButtonElement>('[data-rich-block]');
    if (blockItem) {
      runBlockCommand(blockItem.dataset.richBlock as BlockFormat);
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    // The custom size row: 1–400, per the Docs-style menu contract.
    const applyCustomSize = (): void => {
      const input = document.getElementById('richSizeInput') as HTMLInputElement | null;
      if (!input) {
        return;
      }
      const parsed = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(parsed)) {
        input.focus();
        return;
      }
      const px = Math.round(parsed);
      if (px < 1 || px > 400) {
        showToast('Font size must be between 1 and 400.');
        input.focus();
        return;
      }
      // Typing into the input moved focus off the note — the port plants
      // the styled caret run through the editor surface, so hand focus
      // (and the parked caret) back before applying.
      getEditorPort()?.focus();
      port.setFontSize(px);
      closeMenus(true);
      scheduleStateRefresh();
    };
    if (target.closest('[data-rich-size-apply]')) {
      applyCustomSize();
      return;
    }
    const customHost = target.closest('[data-rich-size-custom]');
    if (customHost && event.type === 'click') {
      const input = customHost.querySelector<HTMLInputElement>('input');
      // Clicks inside the custom row mean editing, not applying — the input
      // keeps focus (it was never preventDefaulted away) and Enter applies.
      if (input && document.activeElement !== input) {
        input.focus();
      }
      return;
    }

    const fontItem = target.closest<HTMLButtonElement>('[data-rich-font]');
    if (fontItem) {
      port.setFontFamily(fontItem.dataset.richFont!);
      closeMenus(true);
      scheduleStateRefresh();
      return;
    }

    // Palette/recents/None swatches are answered inside the color picker
    // component (see the mounts below) — nothing to do here.

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

    if (button.dataset.richAction === 'math') {
      if (elements.mathPopover?.hidden) {
        openMathPopover();
      } else {
        closeMathPopover(true);
      }
      return;
    }

    if (button.dataset.richCmd) {
      port.applyFormat(button.dataset.richCmd as EditorCommand);
    } else if (button.dataset.richAction) {
      ACTIONS[button.dataset.richAction]?.(port);
    } else if (button.dataset.richList) {
      port.toggleList(button.dataset.richList as ListKind);
    }

    scheduleStateRefresh();
  });

  // Menu keyboard: arrows rove, Escape/Tab leave the menu back into the note.
  toolbar.addEventListener('keydown', (event) => {
    const active = document.activeElement as HTMLElement | null;
    // Enter in the custom size input applies it — the natural typing gesture.
    if (event.key === 'Enter' && active?.matches?.('[data-rich-size-custom] input')) {
      event.preventDefault();
      toolbar.querySelector<HTMLButtonElement>('[data-rich-size-apply]')?.click();
      return;
    }
    const panel = active?.closest<HTMLElement>('.rich-menu-panel');
    if (!panel) {
      return;
    }
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight'
    ) {
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

  /**
   * Legacy clipboard write: a transient textarea carrying the text, a
   * select-all, and the engine's copy command. Synchronous, no permissions
   * needed — good enough for a one-shot copy.
   */
  const copyViaExecCommand = (text: string): void => {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    let copied: boolean;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    scratch.remove();
    showToast(copied ? 'Link copied.' : 'Could not copy the link.');
  };

  // ---------------------------------------------------------------------------
  // The color pickers (text + highlight): one component, two mounts.
  //
  // Palette swatches carry theme KEYS for text (auto dark/light re-inking)
  // and literal pastels for highlight; recents and the custom picker store
  // literal hex (same as Docs' custom colors — they don't re-theme).
  // ---------------------------------------------------------------------------
  const TEXT_PALETTE_KEYS: ReadonlyArray<readonly [string, string]> = [
    ['ink', 'black'],
    ['gray', 'gray'],
    ['steel', 'light gray'],
    ['paper', 'white'],
    ['red', 'red'],
    ['pink', 'pink'],
    ['yellow', 'yellow'],
    ['brown', 'brown'],
    ['green', 'green'],
    ['teal', 'teal'],
    ['blue', 'blue'],
    ['purple', 'purple'],
  ];

  const textColorEntry = (key: string, label: string): ColorPickerEntry => ({
    value: key,
    label,
    swatch: `var(--rich-palette-${key})`,
    resolve: () => resolvePaletteColor(key, currentThemeMode()) ?? '#1a1a1a',
  });

  const HIGHLIGHT_PALETTE: ReadonlyArray<ColorPickerEntry> = [
    ...(
      [
        ['#fff3bf', 'yellow'],
        ['#ffe3e3', 'pink'],
        ['#d3f9d8', 'green'],
        ['#d0ebff', 'blue'],
        ['#e5dbff', 'purple'],
        ['#ffe8cc', 'orange'],
      ] as ReadonlyArray<readonly [string, string]>
    ).map(([value, label]) => ({
      value,
      label,
      swatch: value,
      resolve: () => value,
    })),
    {
      value: 'transparent',
      label: 'None',
      swatch: 'transparent',
      resolve: () => 'transparent',
    },
  ];

  const inkPreview = toolbar.querySelector<HTMLElement>('[data-rich-ink="color"]');
  const hilitePreview = toolbar.querySelector<HTMLElement>('[data-rich-hilite]');

  const colorPanel = toolbar.querySelector<HTMLElement>('[data-rich-panel-color]');
  const textColorPicker: ColorPickerHandle | null = colorPanel
    ? mountColorPicker(colorPanel, {
        ariaLabel: 'Text color',
        modeAttr: 'data-rich-color',
        palette: TEXT_PALETTE_KEYS.map(([key, label]) => textColorEntry(key, label)),
        onPick: (value) => {
          const port = getEditorPort();
          if (!port) {
            return;
          }
          // The picker's inputs moved the caret out of the note — put the
          // parked selection (or at least the caret) back before applying.
          if (parkedRange) {
            restoreParkedRange();
          } else {
            port.focus();
          }
          port.setTextColor(value);
          // The glyph bar previews the last ink (session only).
          inkPreview?.style.setProperty('--rich-ink', value);
          closeMenus(true);
          scheduleStateRefresh();
        },
      })
    : null;

  const hilitePanel = toolbar.querySelector<HTMLElement>('[data-rich-panel-hilite]');
  const highlightPicker: ColorPickerHandle | null = hilitePanel
    ? mountColorPicker(hilitePanel, {
        ariaLabel: 'Highlight color',
        modeAttr: 'data-rich-highlight',
        palette: HIGHLIGHT_PALETTE,
        onPick: (value) => {
          const port = getEditorPort();
          if (!port) {
            return;
          }
          if (parkedRange) {
            restoreParkedRange();
          } else {
            port.focus();
          }
          port.setHighlight(value);
          // The swash previews the last highlight; "None" returns plain ink.
          if (value === 'transparent') {
            hilitePreview?.style.removeProperty('--rich-hilite');
          } else {
            hilitePreview?.style.setProperty('--rich-hilite', value);
          }
          closeMenus(true);
          scheduleStateRefresh();
        },
      })
    : null;

  elements.apply?.addEventListener('click', applyLink);
  elements.remove?.addEventListener('click', removeLink);
  elements.chipRemove?.addEventListener('click', removeLink);
  elements.edit?.addEventListener('click', () => {
    elements.input.value = chipHref;
    showEditMode();
    elements.input.focus();
    elements.input.select();
  });
  elements.copy?.addEventListener('click', () => {
    // Clipboard API first; a textarea fallback covers contexts where the
    // async clipboard refuses (permissions, older webviews).
    navigator.clipboard
      ?.writeText(chipHref)
      .then(() => showToast('Link copied.'))
      .catch(() => copyViaExecCommand(chipHref));
  });
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

  // Outside click closes the link popover, the equation bubble AND the
  // menus; Escape likewise. A click on the very link that floated the chip
  // keeps it open — the toggle runs before this listener (element bubbles
  // before document).
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (
      !elements.popover.hidden &&
      !elements.popover.contains(target) &&
      !(elements.linkButton && elements.linkButton.contains(target)) &&
      !(floatingAnchor && floatingAnchor.contains(target))
    ) {
      closeLinkPopover();
    }
    if (
      elements.mathPopover &&
      !elements.mathPopover.hidden &&
      !elements.mathPopover.contains(target) &&
      // A click on the equation being edited must not close its bubble —
      // compare the click's shell handle against the open edit target.
      !(
        editingMath &&
        (event.target as HTMLElement).closest?.(`.${MATH_CLASS}`)?.getAttribute(MATH_ID_ATTR) ===
          editingMath
      ) &&
      !(event.target as HTMLElement).closest?.('[data-rich-action="math"]')
    ) {
      closeMathPopover();
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
      if (elements.mathPopover && !elements.mathPopover.hidden) {
        closeMathPopover(true);
      }
      if (anyMenuOpen()) {
        closeMenus(true);
      }
    }
  });

  // Ctrl/Cmd+K (rich-shortcuts) asks for the link bubble — the request
  // arrives as an event so the shortcut module stays decoupled from this UI.
  document.addEventListener('padify:open-link', () => {
    if (!toolbar.hidden) {
      openLinkPopover();
    }
  });

  // A click on a link in the note floats the chip under that link; with
  // Ctrl/Cmd held it opens the URL instead. Reported by the port (see its
  // click wiring) — this side decides the policy.
  document.addEventListener('padify:link-click', (event) => {
    if (toolbar.hidden) {
      return;
    }
    const detail = (event as CustomEvent).detail as {
      href: string;
      anchor: HTMLAnchorElement;
      openInNewTab: boolean;
    };
    if (detail.openInNewTab) {
      window.open(detail.href, '_blank', 'noopener,noreferrer');
      return;
    }
    openLinkChipAtAnchor(detail.anchor, detail.href);
  });

  // ---------------------------------------------------------------------------
  // The equation bubble: Docs-style symbol palettes (pick instead of typing),
  // LaTeX in, live KaTeX preview out, Insert commits.
  // Opens from the toolbar button, the context menu (padify:open-equation)
  // or a click on an existing equation (padify:math-click, edit mode).
  // ---------------------------------------------------------------------------
  /** The handle of the equation being edited, when the bubble edits one. */
  let editingMath: string | null = null;
  /** The palette builds once, on the first open (KaTeX glyphs take a beat). */
  let paletteMounted = false;

  const mountPalette = (): void => {
    if (paletteMounted || !elements.mathPalette || !elements.mathInput) {
      return;
    }
    paletteMounted = true;
    mountMathPalette(elements.mathPalette, {
      input: elements.mathInput,
      onChange: () => {
        if (elements.mathInput && elements.mathPreview) {
          renderMathPreview(elements.mathPreview, elements.mathInput.value);
        }
      },
      onEscape: () => closeMathPopover(true),
    });
  };

  const closeMathPopover = (refocusEditor = false): void => {
    if (!elements.mathPopover) {
      return;
    }
    elements.mathPopover.hidden = true;
    editingMath = null;
    if (refocusEditor) {
      getEditorPort()?.focus();
    }
  };

  const openMathPopover = (existing?: { latex: string; id: string }): void => {
    if (!elements.mathPopover || !elements.mathInput || !elements.mathPreview) {
      return;
    }
    closeMenus();
    closeMathPopover();
    closeLinkPopover();
    mountPalette();
    editingMath = existing?.id ?? null;
    elements.mathInput.value = existing?.latex ?? '';
    renderMathPreview(elements.mathPreview, elements.mathInput.value);
    // The button labels the gesture: inserting is new, applying retargets.
    if (elements.mathInsert) {
      elements.mathInsert.textContent = existing ? 'Apply' : 'Insert';
    }
    elements.mathPopover.hidden = false;
    elements.mathInput.focus();
    elements.mathInput.select();
  };

  const applyMath = (): void => {
    const port = getEditorPort();
    if (!port || !elements.mathInput) {
      return;
    }
    const latex = elements.mathInput.value.trim();
    // The stored shell's invariant (see MATH_LATEX_PATTERN) caps the
    // source at 2000 chars. Over-cap equations used to render live and
    // then silently VANISH at the next save (the sanitizer dropped the
    // shell) — refuse at the door instead, keeping the popover open so
    // the user can shorten it.
    if (latex !== '' && !MATH_LATEX_PATTERN.test(latex)) {
      showToast('Equations are capped at 2000 characters — shorten this one.');
      return;
    }
    const target = editingMath;
    // Closing refocuses the editor — Chrome restores the note's caret, so
    // a fresh insert lands where it was parked (must run BEFORE we clear
    // the edit target).
    closeMathPopover(true);
    if (latex === '') {
      return;
    }
    if (target) {
      port.updateMath(target, latex);
      return;
    }
    port.insertMath(latex);
  };

  if (elements.mathInput && elements.mathPreview) {
    elements.mathInput.addEventListener('input', () => {
      renderMathPreview(elements.mathPreview!, elements.mathInput!.value);
    });
    elements.mathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyMath();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMathPopover(true);
      }
    });
  }
  elements.mathInsert?.addEventListener('click', applyMath);

  document.addEventListener('padify:math-click', (event) => {
    if (toolbar.hidden) {
      return;
    }
    const detail = (event as CustomEvent).detail as {
      id: string;
      latex: string;
    };
    openMathPopover(detail);
  });
  document.addEventListener('padify:open-equation', () => {
    if (!toolbar.hidden) {
      openMathPopover();
    }
  });

  // Pressed states follow the caret and the edits.
  document.addEventListener('selectionchange', scheduleStateRefresh);

  // A theme flip re-inks the note (theme-colors) — the session ink preview
  // would then advertise a color that no longer matches the surface.
  document.addEventListener('padify:theme', () => {
    toolbar
      .querySelector<HTMLElement>('[data-rich-ink="color"]')
      ?.style.removeProperty('--rich-ink');
  });
  getEditorPort()?.onInput(scheduleStateRefresh);

  // Visibility follows the active note — boot, switch, create, cloud merge.
  const sync = (): void => {
    const show = isRichNote(tabManager.getActive());
    toolbar.hidden = !show;
    if (!show && !elements.popover.hidden) {
      closeLinkPopover();
    }
    if (!show && elements.mathPopover && !elements.mathPopover.hidden) {
      closeMathPopover();
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
