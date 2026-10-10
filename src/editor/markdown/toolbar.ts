/**
 * The Markdown toolbar — the Markdown note's formatting chrome, built on
 * the same markup vocabulary as the rich toolbar (#markdownToolbar in
 * editor-shell.html reuses the rich-toolbar classes, so the app's one
 * toolbar aesthetic serves both) and driving Milkdown's own commands:
 * every button is a preset command (toggleStrongCommand, the heading
 * wrap, the GFM table insert…) dispatched through the live editor — no
 * second editing grammar exists to drift from the surface.
 *
 * Beyond the command buttons this module owns six pieces of chrome:
 *  • the text-style dropdown (Normal text / Heading 1-6) — the rich
 *    toolbar's one-menu-at-a-time pattern, with the current block's
 *    label following the caret;
 *  • the link popover — the rich note flow in miniature: park the
 *    selection, type a URL (bare domains complete to https://, the
 *    SAFE_HREF gate refuses anything else with the same toast), Apply
 *    marks the selection or inserts fresh link text when the caret had
 *    nothing selected; Remove strips the link mark. When the caret
 *    already sits on a link the popover opens in CHIP mode first —
 *    Open / Copy / Edit, the rich note's vocabulary;
 *  • the equation bubble — the rich note's Docs-style symbol palette
 *    and live KaTeX preview, inserting `$…$` (inline) or `$$…$$`
 *    (block) as a live math node; clicking a rendered equation opens
 *    the bubble in edit mode (padify:md-math-click);
 *  • the table-ops menu — row/column operations when the caret sits
 *    inside a table (the rich toolbar's table menu vocabulary);
 *  • the task-list button — the Docs grammar over GFM checkboxes
 *    (wrap in tasks, swap a plain list into tasks, lift back out);
 *  • the Visual/Source/Split/Preview segmented control — the surface's
 *    view toggle (see surface.ts: source is the raw-markdown pane,
 *    split pairs it with the owned renderer's live output, preview is
 *    that output full-width — the same truth share links and HTML
 *    export show). Every formatting button speaks BOTH grammars: the
 *    Milkdown commands in the visual mode, the source-edit primitives
 *    (wrap/prefix/insert — see source-edit.ts) in source and split, so
 *    the toolbar never stands down while a pane can take the caret.
 *
 * Visibility follows the active note like the rich toolbar's: hidden
 * unless the active note IS a Markdown note (addActiveListener + the
 * boot-time sync), so switching kinds swaps the chrome for free.
 */
import type { TabManager } from '../../tabs';
import { showToast } from '../../ui/toast';
import { sanitizeHref } from '../storage-subset';
import { isMarkdownNote } from '../note-types';
import { mountMathPalette } from '../math-palette';
import { renderMathPreview } from '../math';
import {
  focusMarkdownPane,
  markdownEditorHandle,
  markdownSourceTextarea,
  markdownViewMode,
  onMarkdownSelection,
  onMarkdownViewMode,
  refreshMarkdownSelectionState,
  setMarkdownViewMode,
  type MarkdownSelectionState,
  type MarkdownViewMode,
} from './surface';
import { MD_MATH_CLICK_EVENT } from './nodes';
import {
  applyEdit,
  applyLink as applySourceLink,
  clearFormatting as clearSourceFormatting,
  insertBlock,
  linkAroundCaret,
  removeLink as removeSourceLink,
  setHeadingLevel,
  tableTemplate,
  toggleLinePrefix,
  toggleOrderedList,
  toggleWrap,
  wrapCodeBlock,
  type SourceLink,
} from './source-edit';
import { callCommand } from '@milkdown/kit/utils';
import { NodeSelection, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { liftListItem } from '@milkdown/kit/prose/schema-list';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
} from '@milkdown/kit/prose/tables';
import type { CmdKey } from '@milkdown/kit/core';
import {
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history';

interface ToolbarElements {
  toolbar: HTMLElement;
  buttons: HTMLElement[];
  menuHost: HTMLElement | null;
  menuButton: HTMLElement | null;
  menuPanel: HTMLElement | null;
  menuLabel: HTMLElement | null;
  tableMenuHost: HTMLElement | null;
  tableMenuButton: HTMLElement | null;
  tableMenuPanel: HTMLElement | null;
  popover: HTMLElement | null;
  input: HTMLInputElement | null;
  apply: HTMLButtonElement | null;
  remove: HTMLButtonElement | null;
  linkChipRow: HTMLElement | null;
  linkEditRow: HTMLElement | null;
  linkOpen: HTMLButtonElement | null;
  linkCopy: HTMLButtonElement | null;
  linkEdit: HTMLButtonElement | null;
  linkHrefLabel: HTMLElement | null;
  mathPopover: HTMLElement | null;
  mathPalette: HTMLElement | null;
  mathInput: HTMLInputElement | null;
  mathInsert: HTMLButtonElement | null;
  mathPreview: HTMLElement | null;
  mathKindButtons: HTMLElement[];
  viewButtons: HTMLElement[];
}

let elements: ToolbarElements | null = null;
let menuOpen = false;
let tableMenuOpen = false;

/** Test seam: forget the wired toolbar so a fresh shell can boot it. */
export function resetMarkdownToolbarForTests(): void {
  elements = null;
  menuOpen = false;
  tableMenuOpen = false;
  parked = null;
  mathPaletteMounted = false;
  mathKind = 'inline';
}

/** The selection the popover parks (PM keeps it while the input is focused). */
let parked: { from: number; to: number } | null = null;

/** The link range for chip mode (the mark's own extent, not the caret). */
let chipRange: { from: number; to: number } | null = null;

/** The source pane's parked link (source/split mode's chip target). */
let sourceLink: SourceLink | null = null;

/** The equation bubble's insertion kind (segmented control state). */
let mathKind: 'inline' | 'block' = 'inline';

/** The equation palette builds once, on the first open. */
let mathPaletteMounted = false;

const BLOCK_LABELS: Record<string, string> = {
  p: 'Normal text',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
};

/**
 * Boots the Markdown toolbar. Called from app.ts beside initRichToolbar;
 * the markup lives in editor-shell.html (hidden — the visibility sync
 * below owns showing it).
 */
export function initMarkdownToolbar(tabManager: TabManager): void {
  const toolbar = document.getElementById('markdownToolbar');
  if (!toolbar || elements) {
    return;
  }

  elements = {
    toolbar,
    buttons: Array.from(toolbar.querySelectorAll<HTMLElement>('[data-md-action]')),
    menuHost: toolbar.querySelector('[data-md-menu="block"]')?.parentElement ?? null,
    menuButton: toolbar.querySelector('[data-md-menu="block"]'),
    menuPanel: toolbar.querySelector('[data-md-block]')?.closest('.rich-menu-panel') ?? null,
    menuLabel: toolbar.querySelector('[data-md-label="block"]'),
    tableMenuHost: toolbar.querySelector('[data-md-menu="table"]')?.parentElement ?? null,
    tableMenuButton: toolbar.querySelector('[data-md-menu="table"]'),
    tableMenuPanel: toolbar.querySelector('[data-md-table]')?.closest('.rich-menu-panel') ?? null,
    popover: document.getElementById('markdownLinkPopover'),
    input: document.getElementById('markdownLinkInput') as HTMLInputElement | null,
    apply: document.getElementById('markdownLinkApply') as HTMLButtonElement | null,
    remove: document.getElementById('markdownLinkRemove') as HTMLButtonElement | null,
    linkChipRow: toolbar.querySelector('[data-md-link-mode="chip"]'),
    linkEditRow: toolbar.querySelector('[data-md-link-mode="edit"]'),
    linkOpen: document.getElementById('markdownLinkOpen') as HTMLButtonElement | null,
    linkCopy: document.getElementById('markdownLinkCopy') as HTMLButtonElement | null,
    linkEdit: document.getElementById('markdownLinkEdit') as HTMLButtonElement | null,
    linkHrefLabel: document.getElementById('markdownLinkHrefLabel'),
    mathPopover: document.getElementById('markdownMathPopover'),
    mathPalette: document.getElementById('markdownMathPalette'),
    mathInput: document.getElementById('markdownMathInput') as HTMLInputElement | null,
    mathInsert: document.getElementById('markdownMathInsert') as HTMLButtonElement | null,
    mathPreview: document.getElementById('markdownMathPreview'),
    mathKindButtons: Array.from(toolbar.querySelectorAll<HTMLElement>('[data-md-math-kind]')),
    viewButtons: Array.from(toolbar.querySelectorAll<HTMLElement>('[data-md-view]')),
  };

  wireCommandButtons();
  wireBlockMenu();
  wireTableMenu();
  wireLinkPopover();
  wireMathPopover();
  wireViewToggle();
  wireDocumentEvents();

  // Pressed states follow the caret (the rich toolbar's discipline).
  onMarkdownSelection(syncPressedStates);
  // The segmented control follows EVERY mode flip — its own buttons,
  // the top bar's split icon, the surface's own resets — so the chrome
  // never disagrees with the surface (one source of truth: surface.ts).
  onMarkdownViewMode(syncViewToggle);

  // Chrome follows the active note — Markdown notes only.
  const sync = (): void => {
    const show = isMarkdownNote(tabManager.getActive());
    toolbar.hidden = !show;
    if (!show) {
      closeBlockMenu();
      closeTableMenu();
      closeLinkPopover();
      closeMathPopover();
    }
  };
  tabManager.addActiveListener(sync);
  sync();
}

// ---------------------------------------------------------------------------
// Command buttons
// ---------------------------------------------------------------------------

function wireCommandButtons(): void {
  if (!elements) {
    return;
  }
  for (const button of elements.buttons) {
    button.addEventListener('click', () => {
      const action = button.dataset.mdAction;
      if (!action) {
        return;
      }
      closeBlockMenu();
      closeTableMenu();
      if (action === 'link') {
        openMarkdownLinkPopover();
        return;
      }
      if (action === 'math') {
        openMarkdownEquationBubble();
        return;
      }
      runMarkdownToolbarAction(action);
    });
  }
}

/** Dispatches a toolbar action, then refreshes the pressed states. */
export function runMarkdownToolbarAction(action: string): boolean {
  const applied = dispatchToolbarAction(action);
  if (applied) {
    // The gesture began on a toolbar BUTTON, and a click leaves the
    // focus there. Without handing it back, the next keystrokes drive
    // the ARIA toolbar (Space/Enter activate the focused button — a
    // space in a sentence multiplied tables) instead of typing into the
    // note. The pane that owns the edit takes the caret back.
    focusMarkdownPane();
    // A toggle does not move the selection — the buttons must not wait
    // for one to learn the document changed.
    refreshMarkdownSelectionState();
  }
  return applied;
}

/**
 * Puts the caret in the fresh table's first cell — where Docs and Notion
 * park it after an insert. The insert command alone leaves the caret in
 * the host paragraph, so the table sits untyped and the user's next
 * keystrokes never reach it. The FRESH table is the one nearest the
 * insertion point (a note may already carry others), so the pick is by
 * distance from the post-insert selection.
 */
function parkCaretInFreshTable(handle: NonNullable<ReturnType<typeof markdownEditorHandle>>): void {
  const { view } = handle;
  const doc = view.state.doc;
  const anchor = view.state.selection.from;
  const tables: { pos: number; dist: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole !== 'table') {
      return true;
    }
    tables.push({
      pos,
      dist:
        anchor >= pos && anchor <= pos + node.nodeSize
          ? 0
          : Math.min(Math.abs(anchor - pos), Math.abs(anchor - (pos + node.nodeSize))),
    });
    return true;
  });
  if (tables.length === 0) {
    return;
  }
  const fresh = tables.reduce((nearest, table) => (table.dist < nearest.dist ? table : nearest));
  const selection = TextSelection.near(doc.resolve(fresh.pos + 1), 1);
  view.dispatch(view.state.tr.setSelection(selection));
  view.focus();
}

/** Dispatches a toolbar action to the live editing pane. */
function dispatchToolbarAction(action: string): boolean {
  const source = markdownSourceTextarea();
  if (source) {
    return dispatchSourceAction(source, action);
  }
  const handle = markdownEditorHandle();
  if (!handle) {
    return false;
  }
  const { editor } = handle;
  // The preset commands are $Command handles; callCommand reads .key.
  // (CmdKey<any> is the kit's own escape hatch for mixed-key dispatch.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (command: { key: CmdKey<any> }, payload?: unknown): boolean =>
    editor.action(callCommand(command.key, payload));

  switch (action) {
    case 'undo':
      return call(undoCommand);
    case 'redo':
      return call(redoCommand);
    case 'bold':
      return call(toggleStrongCommand);
    case 'italic':
      return call(toggleEmphasisCommand);
    case 'strikethrough':
      return call(toggleStrikethroughCommand);
    case 'code':
      return call(toggleInlineCodeCommand);
    case 'quote':
      return call(wrapInBlockquoteCommand);
    case 'bullet':
      return toggleList(handle, 'bullet');
    case 'ordered':
      return toggleList(handle, 'ordered');
    case 'task':
      return toggleTaskList(handle);
    case 'clear':
      return clearMarkdownFormatting(handle);
    case 'codeblock':
      return call(createCodeBlockCommand);
    case 'hr':
      return call(insertHrCommand);
    case 'table':
      if (!call(insertTableCommand, { row: 2, col: 3 })) {
        return false;
      }
      parkCaretInFreshTable(handle);
      return true;
    default:
      return false;
  }
}

/**
 * The source pane's action dispatch — the same toolbar vocabulary as
 * markdown syntax edits (the primitives in source-edit.ts). Undo and
 * redo ride the textarea's own native stacks.
 */
function dispatchSourceAction(source: HTMLTextAreaElement, action: string): boolean {
  switch (action) {
    case 'undo':
    case 'redo':
      try {
        // The click that got here moved focus to the BUTTON — a text
        // control's native undo stack is only reachable while the control
        // itself is focused (the context menu gets this right; the toolbar
        // buttons used to be silent no-ops on Windows/Linux).
        source.focus();
        return document.execCommand(action);
      } catch {
        return false;
      }
    case 'bold':
      toggleWrap(source, '**');
      return true;
    case 'italic':
      toggleWrap(source, '*');
      return true;
    case 'strikethrough':
      toggleWrap(source, '~~');
      return true;
    case 'code':
      toggleWrap(source, '`');
      return true;
    case 'quote':
      toggleLinePrefix(source, '> ');
      return true;
    case 'bullet':
      toggleLinePrefix(source, '- ');
      return true;
    case 'ordered':
      toggleOrderedList(source);
      return true;
    case 'task':
      toggleLinePrefix(source, '- [ ] ');
      return true;
    case 'clear':
      clearSourceFormatting(source);
      return true;
    case 'codeblock':
      wrapCodeBlock(source);
      return true;
    case 'hr':
      insertBlock(source, '---');
      return true;
    case 'table':
      insertBlock(source, tableTemplate(), [2, 10]);
      return true;
    default:
      return false;
  }
}

/**
 * The list buttons' Docs grammar: no list → wrap; the OTHER list type →
 * swap the list's type in place (both hold the same list_item children,
 * so one setNodeMarkup is the whole change); the SAME type → lift the
 * item out (the toggle's off ramp). The preset's wrapIn alone cannot
 * answer the swap — wrapIn refuses when a list already wraps the block.
 */
function toggleList(
  handle: NonNullable<ReturnType<typeof markdownEditorHandle>>,
  kind: 'bullet' | 'ordered',
): boolean {
  const { view } = handle;
  const { state } = view;
  const { $from } = state.selection;
  const targetName = kind === 'bullet' ? 'bullet_list' : 'ordered_list';

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const ancestor = $from.node(depth);
    if (ancestor.type.name === 'bullet_list' || ancestor.type.name === 'ordered_list') {
      if (ancestor.type.name === targetName) {
        const itemType = state.schema.nodes.list_item;
        if (!itemType) {
          return false;
        }
        return liftListItem(itemType)(state, (tr) => view.dispatch(tr));
      }
      const target = state.schema.nodes[targetName];
      if (!target) {
        return false;
      }
      view.dispatch(state.tr.setNodeMarkup($from.before(depth), target));
      return true;
    }
  }

  return kind === 'bullet'
    ? handle.editor.action(callCommand(wrapInBulletListCommand.key))
    : handle.editor.action(callCommand(wrapInOrderedListCommand.key));
}

/**
 * The task button's Docs grammar: no list → wrap in a bullet list and
 * arm every item as a task; a plain list → arm its items (become
 * checkboxes); task items → disarm (become a plain list).
 */
function toggleTaskList(handle: NonNullable<ReturnType<typeof markdownEditorHandle>>): boolean {
  const { view, editor } = handle;
  let { state } = view;
  const { from, to } = state.selection;

  const collectItems = (
    doc: ProseNode,
    start: number,
    end: number,
  ): { pos: number; node: ProseNode }[] => {
    const items: { pos: number; node: ProseNode }[] = [];
    doc.nodesBetween(start, end, (node, pos) => {
      if (node.type.name === 'list_item') {
        items.push({ pos, node });
        return false;
      }
      return true;
    });
    return items;
  };

  const items = collectItems(state.doc, from, to);
  if (items.length > 0) {
    const anyTask = items.some(({ node }) => node.attrs.checked != null);
    const tr = state.tr;
    for (const { pos, node } of items) {
      const nextChecked = anyTask ? null : false;
      if ((node.attrs.checked ?? null) !== nextChecked) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: nextChecked });
      }
    }
    if (tr.docChanged) {
      view.dispatch(tr);
    }
    return true;
  }

  // No list: wrap first, then arm the fresh items.
  const wrapped = editor.action(callCommand(wrapInBulletListCommand.key));
  if (!wrapped) {
    return false;
  }
  state = view.state;
  const rangeStart = Math.min(from, state.selection.from);
  const rangeEnd = Math.max(to, state.selection.to);
  const tr = state.tr;
  for (const { pos, node } of collectItems(state.doc, rangeStart, rangeEnd)) {
    if (node.attrs.checked == null) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
    }
  }
  if (tr.docChanged) {
    view.dispatch(tr);
  }
  return true;
}

/** Strips every inline mark from the selection (the caret's typing marks too). */
function clearMarkdownFormatting(
  handle: NonNullable<ReturnType<typeof markdownEditorHandle>>,
): boolean {
  const { view } = handle;
  const { state } = view;
  const { from, to, empty } = state.selection;
  if (empty) {
    view.dispatch(state.tr.setStoredMarks([]));
    return true;
  }
  view.dispatch(state.tr.removeMark(from, to));
  return true;
}

/** Applies a block style from the dropdown (p / h1..h6). */
export function runMarkdownBlockStyle(block: string): boolean {
  const source = markdownSourceTextarea();
  if (source) {
    if (block === 'p') {
      setHeadingLevel(source, null);
    } else {
      const level = Number(block.slice(1));
      if (!(Number.isInteger(level) && level >= 1 && level <= 6)) {
        return false;
      }
      setHeadingLevel(source, level);
    }
    focusMarkdownPane();
    refreshMarkdownSelectionState();
    return true;
  }
  const handle = markdownEditorHandle();
  if (!handle) {
    return false;
  }
  let applied = false;
  if (block === 'p') {
    applied = handle.editor.action(callCommand(turnIntoTextCommand.key));
  } else {
    const level = Number(block.slice(1));
    if (Number.isInteger(level) && level >= 1 && level <= 6) {
      applied = handle.editor.action(callCommand(wrapInHeadingCommand.key, level));
    }
  }
  if (applied) {
    refreshMarkdownSelectionState();
  }
  return applied;
}

/** Runs a table structure operation at the caret's cell (the visual
 *  mode's grammar — the raw source has no cell cursor to operate on). */
export function runMarkdownTableAction(op: string): boolean {
  if (markdownSourceTextarea()) {
    return false;
  }
  const handle = markdownEditorHandle();
  if (!handle) {
    return false;
  }
  const { view } = handle;
  const { state } = view;
  const commands: Record<
    string,
    (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean
  > = {
    'row-above': addRowBefore,
    'row-below': addRowAfter,
    'col-left': addColumnBefore,
    'col-right': addColumnAfter,
    'row-delete': deleteRow,
    'col-delete': deleteColumn,
    'table-delete': deleteTable,
  };
  const command = commands[op];
  if (!command) {
    return false;
  }
  return command(state, (tr) => view.dispatch(tr));
}

// ---------------------------------------------------------------------------
// The text-style dropdown
// ---------------------------------------------------------------------------

function wireBlockMenu(): void {
  if (!elements?.menuButton || !elements.menuPanel) {
    return;
  }
  const { menuButton, menuPanel } = elements;

  menuButton.addEventListener('click', () => {
    if (menuOpen) {
      closeBlockMenu();
    } else {
      closeTableMenu();
      openBlockMenu();
    }
  });

  menuPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>('[data-md-block]');
    if (!item) {
      return;
    }
    closeBlockMenu();
    runMarkdownBlockStyle(item.dataset.mdBlock ?? 'p');
  });

  document.addEventListener('click', (event) => {
    if (!menuOpen || !elements?.menuHost) {
      return;
    }
    if (event.target instanceof Node && elements.menuHost.contains(event.target)) {
      return;
    }
    closeBlockMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuOpen) {
      closeBlockMenu();
      elements?.menuButton?.focus();
    }
  });
}

function openBlockMenu(): void {
  if (!elements?.menuButton || !elements.menuPanel) {
    return;
  }
  menuOpen = true;
  elements.menuPanel.hidden = false;
  elements.menuButton.setAttribute('aria-expanded', 'true');
}

function closeBlockMenu(): void {
  if (!elements?.menuButton || !elements.menuPanel) {
    return;
  }
  menuOpen = false;
  elements.menuPanel.hidden = true;
  elements.menuButton.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// The table-ops menu (visible while the caret sits inside a table)
// ---------------------------------------------------------------------------

function wireTableMenu(): void {
  if (!elements?.tableMenuButton || !elements.tableMenuPanel) {
    return;
  }
  const { tableMenuButton, tableMenuPanel } = elements;

  tableMenuButton.addEventListener('click', () => {
    if (tableMenuOpen) {
      closeTableMenu();
    } else {
      closeBlockMenu();
      tableMenuOpen = true;
      tableMenuPanel.hidden = false;
      tableMenuButton.setAttribute('aria-expanded', 'true');
    }
  });

  tableMenuPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>('[data-md-table]');
    if (!item) {
      return;
    }
    closeTableMenu();
    runMarkdownTableAction(item.dataset.mdTable ?? '');
  });

  document.addEventListener('click', (event) => {
    if (!tableMenuOpen || !elements?.tableMenuHost) {
      return;
    }
    if (event.target instanceof Node && elements.tableMenuHost.contains(event.target)) {
      return;
    }
    closeTableMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && tableMenuOpen) {
      closeTableMenu();
      elements?.tableMenuButton?.focus();
    }
  });
}

function closeTableMenu(): void {
  if (!elements?.tableMenuButton || !elements.tableMenuPanel) {
    return;
  }
  tableMenuOpen = false;
  elements.tableMenuPanel.hidden = true;
  elements.tableMenuButton.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// The link popover (chip mode + edit mode)
// ---------------------------------------------------------------------------

function wireLinkPopover(): void {
  if (!elements?.popover || !elements.input) {
    return;
  }
  elements.apply?.addEventListener('click', () => {
    applyLink();
  });
  elements.remove?.addEventListener('click', () => {
    removeLink();
  });
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyLink();
    } else if (event.key === 'Escape') {
      closeLinkPopover();
    }
  });
  elements.linkOpen?.addEventListener('click', () => {
    const href = chipHref();
    if (href) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
    closeLinkPopover();
  });
  elements.linkCopy?.addEventListener('click', () => {
    const href = chipHref();
    if (!href) {
      return;
    }
    void copyText(href);
  });
  elements.linkEdit?.addEventListener('click', () => {
    if (!elements?.input || !elements.popover) {
      return;
    }
    const href = chipHref() ?? '';
    showLinkMode('edit');
    elements.input.value = href.replace(/^https:\/\//, '');
    elements.input.focus();
    elements.input.select();
  });
}

/** The href the chip acts on (parked range or chip range). */
function chipHref(): string | null {
  if (sourceLink) {
    return sourceLink.href;
  }
  const handle = markdownEditorHandle();
  if (!handle) {
    return null;
  }
  const range = chipRange ?? parked;
  if (!range) {
    return null;
  }
  let href: string | null = null;
  handle.view.state.doc.nodesBetween(range.from, Math.max(range.from + 1, range.to), (node) => {
    const link = node.marks.find((mark) => mark.type.name === 'link');
    if (link && typeof link.attrs.href === 'string') {
      href = link.attrs.href;
    }
    return true;
  });
  return href;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Link copied.');
  } catch {
    showToast('Copy failed — your browser blocked clipboard access.');
  }
}

/**
 * The link mark's full extent around the caret (or the selection's own
 * range when one is open) — the chip's acting range, since a bare caret
 * carries no extent. Shared with the context menu's markdown layer.
 */
export function linkRangeAround(state: EditorState): { from: number; to: number } | null {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty) {
    let hasLink = false;
    state.doc.nodesBetween(selection.from, selection.to, (node) => {
      if (node.marks.some((mark) => mark.type.name === 'link')) {
        hasLink = true;
      }
      return true;
    });
    return hasLink ? { from: selection.from, to: selection.to } : null;
  }

  const caretMark = ($from.marks() ?? []).find((mark) => mark.type.name === 'link');
  if (!caretMark || !$from.parent.isTextblock) {
    return null;
  }
  const parent = $from.parent;
  const index = $from.index();
  const carries = (node: ProseNode): boolean => node.marks.some((mark) => caretMark.eq(mark));

  let start = index;
  while (start > 0 && carries(parent.child(start - 1))) {
    start -= 1;
  }
  let end = index;
  while (end < parent.childCount && carries(parent.child(end))) {
    end += 1;
  }
  if (start === end) {
    return null;
  }
  const contentStart = $from.pos - $from.parentOffset;
  let from = contentStart;
  for (let i = 0; i < start; i += 1) {
    from += parent.child(i).nodeSize;
  }
  let to = from;
  for (let i = start; i < end; i += 1) {
    to += parent.child(i).nodeSize;
  }
  return { from, to };
}

/** Chip first when the caret sits on a link; edit mode otherwise. */
export function openMarkdownLinkPopover(): void {
  if (!elements?.popover || !elements.input) {
    return;
  }
  const source = markdownSourceTextarea();
  if (source) {
    openSourceLinkPopover(source);
    return;
  }
  const handle = markdownEditorHandle();
  if (!handle) {
    return;
  }
  closeBlockMenu();
  closeTableMenu();
  closeMathPopover();

  const { state } = handle.view;
  parked = { from: state.selection.from, to: state.selection.to };
  chipRange = linkRangeAround(state);

  if (chipRange && state.selection.empty) {
    showLinkMode('chip');
    if (elements.linkHrefLabel) {
      elements.linkHrefLabel.textContent = chipHref() ?? '';
    }
  } else {
    showLinkMode('edit');
    const empty = state.selection.empty;
    if (elements.remove) {
      elements.remove.hidden = empty;
    }
    elements.input.value = '';
    elements.input.focus();
    elements.input.select();
  }
  elements.popover.hidden = false;
}

/**
 * The source pane's popover: chip mode when the caret sits inside a
 * [text](href) span (Open/Copy/Edit on that link), edit mode otherwise
 * (the selection is the link text-to-be).
 */
function openSourceLinkPopover(source: HTMLTextAreaElement): void {
  if (!elements?.popover || !elements.input) {
    return;
  }
  closeBlockMenu();
  closeTableMenu();
  closeMathPopover();

  const link = linkAroundCaret(source);
  sourceLink = link;
  if (link) {
    showLinkMode('chip');
    if (elements.linkHrefLabel) {
      elements.linkHrefLabel.textContent = link.href;
    }
  } else {
    showLinkMode('edit');
    if (elements.remove) {
      elements.remove.hidden = source.selectionStart === source.selectionEnd;
    }
    elements.input.value = '';
    elements.input.focus();
    elements.input.select();
  }
  elements.popover.hidden = false;
}

/** Swaps the popover's chip/edit rows. */
function showLinkMode(mode: 'chip' | 'edit'): void {
  if (!elements?.linkChipRow || !elements.linkEditRow) {
    return;
  }
  elements.linkChipRow.hidden = mode !== 'chip';
  elements.linkEditRow.hidden = mode !== 'edit';
}

function closeLinkPopover(): void {
  parked = null;
  chipRange = null;
  sourceLink = null;
  if (elements?.popover) {
    elements.popover.hidden = true;
  }
}

/**
 * Bare domains complete to https:// links, the same rule the rich note
 * popover applies ("example.com" → "https://example.com").
 */
function completeHref(raw: string): string {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

function applyLink(): void {
  const source = markdownSourceTextarea();
  if (source) {
    applySourceLinkPopover(source);
    return;
  }
  const handle = markdownEditorHandle();
  if (!elements?.input || !handle || !parked) {
    closeLinkPopover();
    return;
  }
  if (elements.input.value.trim() === '') {
    closeLinkPopover();
    focusEditor(handle.view);
    return;
  }

  const href = completeHref(elements.input.value);
  if (sanitizeHref(href) === null) {
    showToast('Links must start with http://, https:// or mailto:');
    elements.input.focus();
    return;
  }

  const { view } = handle;
  const { from, to } = parked;
  parked = null;
  const retargeting = chipRange !== null;
  chipRange = null;

  if (retargeting) {
    // Chip mode's Edit: swap the href over the mark's own extent.
    const range = linkRangeAround(view.state) ?? { from, to };
    const linkMark = view.state.schema.marks.link;
    if (linkMark) {
      view.dispatch(
        view.state.tr
          .removeMark(range.from, range.to, linkMark)
          .addMark(range.from, range.to, linkMark.create({ href })),
      );
    }
  } else if (from === to) {
    // Nothing selected: insert fresh link text the caret can overtype.
    const { state } = view;
    const linkMark = state.schema.marks.link?.create({ href });
    if (!linkMark) {
      closeLinkPopover();
      return;
    }
    const text = state.schema.text('link', [linkMark]);
    const tr = state.tr.replaceSelectionWith(text);
    // Select the inserted word so overtyping replaces it wholesale.
    const start = tr.selection.from - text.nodeSize;
    tr.setSelection(TextSelection.create(tr.doc, start, start + text.nodeSize));
    view.dispatch(tr);
  } else {
    // Restore the parked selection and toggle the link mark over it.
    const tr = view.state.tr;
    tr.setSelection(TextSelection.create(tr.doc, from, to));
    view.dispatch(tr);
    handle.editor.action(callCommand(toggleLinkCommand.key, { href }));
  }

  closeLinkPopover();
  focusEditor(view);
}

/**
 * The source pane's Apply: the sanitized href wraps the selection as
 * [text](href), retargets the parked link in place, or plants fresh
 * link text at the caret — the same three shapes the visual mode has.
 */
function applySourceLinkPopover(source: HTMLTextAreaElement): void {
  if (!elements?.input) {
    closeLinkPopover();
    return;
  }
  if (elements.input.value.trim() === '') {
    closeLinkPopover();
    source.focus();
    return;
  }
  const href = completeHref(elements.input.value);
  if (sanitizeHref(href) === null) {
    showToast('Links must start with http://, https:// or mailto:');
    elements.input.focus();
    return;
  }
  applySourceLink(source, href);
  closeLinkPopover();
  source.focus();
}

function removeLink(): void {
  const source = markdownSourceTextarea();
  if (source) {
    removeSourceLink(source);
    closeLinkPopover();
    source.focus();
    return;
  }
  const handle = markdownEditorHandle();
  if (!elements?.popover || !handle) {
    closeLinkPopover();
    return;
  }
  const { view } = handle;
  const range = chipRange ?? { from: view.state.selection.from, to: view.state.selection.to };
  const linkMark = view.state.schema.marks.link;
  if (linkMark) {
    view.dispatch(view.state.tr.removeMark(range.from, range.to, linkMark));
  }
  closeLinkPopover();
  focusEditor(view);
}

function focusEditor(view: { focus: () => void }): void {
  view.focus();
}

// ---------------------------------------------------------------------------
// The equation bubble (palette + live preview + inline/block + Insert)
// ---------------------------------------------------------------------------

function wireMathPopover(): void {
  if (!elements?.mathPopover || !elements.mathInput) {
    return;
  }
  elements.mathInsert?.addEventListener('click', () => {
    applyMath();
  });
  elements.mathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyMath();
    } else if (event.key === 'Escape') {
      closeMathPopover();
    }
  });
  elements.mathInput.addEventListener('input', () => {
    if (elements?.mathInput && elements.mathPreview) {
      renderMathPreview(elements.mathPreview, elements.mathInput.value);
    }
  });
  for (const button of elements.mathKindButtons) {
    button.addEventListener('click', () => {
      mathKind = button.dataset.mdMathKind === 'block' ? 'block' : 'inline';
      syncMathKindButtons();
    });
  }
  // Outside click closes the bubble (the rich toolbar's discipline) —
  // but a click on a rendered EQUATION must not: that very click opens
  // the bubble in edit mode (nodes.ts fires padify:md-math-click), and
  // the same bubbling click would close it straight back (the rich
  // toolbar's "click on the equation being edited" guard).
  document.addEventListener('click', (event) => {
    if (
      !elements?.mathPopover ||
      elements.mathPopover.hidden ||
      elements.mathPopover.contains(event.target as Node)
    ) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.closest?.('[data-md-action="math"]') ||
      target.closest?.('.md-math-inline, .md-math-block')
    ) {
      return;
    }
    closeMathPopover();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements?.mathPopover && !elements.mathPopover.hidden) {
      closeMathPopover();
    }
  });
}

function syncMathKindButtons(): void {
  if (!elements) {
    return;
  }
  for (const button of elements.mathKindButtons) {
    const active = button.dataset.mdMathKind === mathKind;
    button.setAttribute('aria-pressed', String(active));
  }
}

function mountMathPaletteOnce(): void {
  if (mathPaletteMounted || !elements?.mathPalette || !elements.mathInput) {
    return;
  }
  mathPaletteMounted = true;
  mountMathPalette(elements.mathPalette, {
    input: elements.mathInput,
    onChange: () => {
      if (elements?.mathInput && elements.mathPreview) {
        renderMathPreview(elements.mathPreview, elements.mathInput.value);
      }
    },
    onEscape: () => {
      closeMathPopover();
    },
  });
}

function closeMathPopover(): void {
  if (!elements?.mathPopover) {
    return;
  }
  elements.mathPopover.hidden = true;
}

/** Opens the equation bubble — fresh (insert) or over a selected node (apply). */
export function openMarkdownEquationBubble(options?: { kind?: 'inline' | 'block' }): void {
  const source = markdownSourceTextarea();
  const handle = markdownEditorHandle();
  if (!elements?.mathPopover || !elements.mathInput || !elements.mathPreview) {
    return;
  }
  closeBlockMenu();
  closeTableMenu();
  closeLinkPopover();
  mountMathPaletteOnce();

  // A node-selected equation is the edit target — its kind leads. (The
  // source pane has no node selection: a fresh insert every time.)
  const selection = source ? null : handle?.view.state.selection;
  const node =
    selection instanceof NodeSelection &&
    (selection.node.type.name === 'math_inline' || selection.node.type.name === 'math_block')
      ? selection.node
      : null;
  mathKind = node
    ? node.type.name === 'math_block'
      ? 'block'
      : 'inline'
    : options?.kind === 'block'
      ? 'block'
      : 'inline';

  elements.mathInput.value = node ? node.textContent : '';
  renderMathPreview(elements.mathPreview, elements.mathInput.value);
  if (elements.mathInsert) {
    elements.mathInsert.textContent = node ? 'Apply' : 'Insert';
  }
  syncMathKindButtons();
  elements.mathPopover.hidden = false;
  elements.mathInput.focus();
  elements.mathInput.select();
}

function applyMath(): void {
  const source = markdownSourceTextarea();
  if (source) {
    applySourceMath(source);
    return;
  }
  const handle = markdownEditorHandle();
  if (!elements?.mathInput || !handle) {
    closeMathPopover();
    return;
  }
  const latex = elements.mathInput.value.trim();
  const { view } = handle;
  const { state } = view;

  // An equation selected in the editor is the apply target.
  const selection = state.selection;
  const editing =
    selection instanceof NodeSelection &&
    (selection.node.type.name === 'math_inline' || selection.node.type.name === 'math_block');

  closeMathPopover();
  view.focus();
  if (latex === '') {
    return;
  }

  if (editing && selection instanceof NodeSelection) {
    const type = selection.node.type;
    const text = state.schema.text(latex);
    view.dispatch(state.tr.replaceWith(selection.from, selection.to, type.create(null, text)));
    return;
  }
  const type = state.schema.nodes[mathKind === 'block' ? 'math_block' : 'math_inline'];
  if (!type) {
    return;
  }
  view.dispatch(state.tr.replaceSelectionWith(type.create(null, state.schema.text(latex))));
}

/**
 * The source pane's equation insert: inline wraps the selection as
 * $…$ (the caret between the dollars when nothing is selected), block
 * writes a fenced $$…$$ on its own lines.
 */
function applySourceMath(source: HTMLTextAreaElement): void {
  const latex = elements?.mathInput?.value.trim() ?? '';
  closeMathPopover();
  source.focus();
  if (latex === '') {
    return;
  }
  if (mathKind === 'block') {
    insertBlock(source, `$$\n${latex}\n$$`);
    return;
  }
  const from = source.selectionStart;
  const to = source.selectionEnd;
  const selected = source.value.slice(from, to);
  const inserted = `$${selected}$`;
  applyEdit(source, from, to, inserted, from + 1, from + 1 + selected.length);
}

// ---------------------------------------------------------------------------
// Document-level handoffs (context menu, shortcuts, equation clicks)
// ---------------------------------------------------------------------------

function wireDocumentEvents(): void {
  // Ctrl/Cmd+K (rich-shortcuts) asks for the link bubble.
  document.addEventListener('padify:open-link', () => {
    if (!elements?.toolbar || elements.toolbar.hidden) {
      return;
    }
    openMarkdownLinkPopover();
  });

  // The context menu's "Insert equation" row.
  document.addEventListener('padify:open-equation', () => {
    if (!elements?.toolbar || elements.toolbar.hidden) {
      return;
    }
    openMarkdownEquationBubble();
  });

  // A click on a rendered equation (nodes.ts) opens the bubble in edit
  // mode — the click itself node-selected the atom.
  document.addEventListener(MD_MATH_CLICK_EVENT, (event) => {
    if (!elements?.toolbar || elements.toolbar.hidden) {
      return;
    }
    const detail = (event as CustomEvent<{ latex?: string; kind?: 'inline' | 'block' }>).detail;
    openMarkdownEquationBubble({ kind: detail?.kind });
  });
}

// ---------------------------------------------------------------------------
// Pressed states + the view toggle
// ---------------------------------------------------------------------------

function syncPressedStates(state: MarkdownSelectionState): void {
  if (!elements) {
    return;
  }
  const pressed: Record<string, boolean> = {
    bold: state.bold,
    italic: state.italic,
    strikethrough: state.strikethrough,
    code: state.code,
    bullet: state.bulletList,
    ordered: state.orderedList,
    task: state.task,
    quote: state.blockquote,
    codeblock: state.codeBlock,
    math: state.math !== null,
  };
  for (const button of elements.buttons) {
    const action = button.dataset.mdAction;
    if (action && action in pressed) {
      button.setAttribute('aria-pressed', pressed[action] ? 'true' : 'false');
    }
  }

  // The dropdown's label follows the caret's block.
  const blockKey = state.heading ? `h${state.heading}` : 'p';
  if (elements.menuLabel) {
    elements.menuLabel.textContent = BLOCK_LABELS[blockKey] ?? 'Normal text';
  }

  // The table-ops menu exists only inside a table — and only in the
  // visual mode (the raw source has no cell cursor).
  if (elements.tableMenuHost) {
    elements.tableMenuHost.hidden = !state.inTable || markdownViewMode() !== 'edit';
    if (!state.inTable || markdownViewMode() !== 'edit') {
      closeTableMenu();
    }
  }
}

function wireViewToggle(): void {
  if (!elements) {
    return;
  }
  for (const button of elements.viewButtons) {
    button.addEventListener('click', () => {
      const requested = button.dataset.mdView;
      const mode: MarkdownViewMode =
        requested === 'preview'
          ? 'preview'
          : requested === 'split'
            ? 'split'
            : requested === 'source'
              ? 'source'
              : 'edit';
      setMarkdownViewMode(mode);
      // A click parks focus on the button — hand it to the pane that now
      // owns the edit (preview keeps it nowhere: a reading gesture).
      focusMarkdownPane();
    });
  }
}

function syncViewToggle(): void {
  if (!elements) {
    return;
  }
  const mode = markdownViewMode();
  for (const button of elements.viewButtons) {
    const active = button.dataset.mdView === mode;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  // Formatting an invisible document is a no-op at best — park the
  // command chrome while the preview owns the surface. Source and split
  // keep a live editing pane (the textarea), so their buttons stay up.
  const editing = mode !== 'preview';
  for (const button of elements.buttons) {
    (button as HTMLButtonElement).disabled = !editing;
  }
  // The table-ops menu rides the WYSIWYG's caret-in-table state; the raw
  // source has no cell cursor to operate on (the insert-table button
  // itself keeps working — it writes the template). Hiding on non-edit
  // modes is ours; showing is the pressed-state pass's call (inTable).
  if (elements.tableMenuHost && mode !== 'edit') {
    elements.tableMenuHost.hidden = true;
    closeTableMenu();
  }
  if (elements.tableMenuButton) {
    (elements.tableMenuButton as HTMLButtonElement).disabled = mode !== 'edit';
  }
  if (mode === 'edit') {
    // Back under the WYSIWYG's grammar: recompute the menu's visibility
    // from the live selection (the caret's own inTable truth).
    refreshMarkdownSelectionState();
  }
  if (!editing) {
    closeBlockMenu();
    closeTableMenu();
    closeLinkPopover();
    closeMathPopover();
  }
}
