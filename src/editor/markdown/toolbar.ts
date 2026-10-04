/**
 * The Markdown toolbar — the Markdown note's formatting chrome, built on
 * the same markup vocabulary as the rich toolbar (#markdownToolbar in
 * editor-shell.html reuses the rich-toolbar classes, so the app's one
 * toolbar aesthetic serves both) and driving Milkdown's own commands:
 * every button is a preset command (toggleStrongCommand, the heading
 * wrap, the GFM table insert…) dispatched through the live editor — no
 * second editing grammar exists to drift from the surface.
 *
 * Beyond the command buttons this module owns three pieces of chrome:
 *  • the text-style dropdown (Normal text / Heading 1-6) — the rich
 *    toolbar's one-menu-at-a-time pattern, with the current block's
 *    label following the caret;
 *  • the link popover — the rich note flow in miniature: park the
 *    selection, type a URL (bare domains complete to https://, the
 *    SAFE_HREF gate refuses anything else with the same toast), Apply
 *    marks the selection or inserts fresh link text when the caret had
 *    nothing selected; Remove strips the link mark;
 *  • the Edit/Preview segmented control — the surface's view toggle
 *    (see surface.ts: preview is the OWNED renderer's output, the same
 *    truth share links and HTML export show).
 *
 * Visibility follows the active note like the rich toolbar's: hidden
 * unless the active note IS a Markdown note (addActiveListener + the
 * boot-time sync), so switching kinds swaps the chrome for free.
 */
import type { TabManager } from '../../tabs';
import { showToast } from '../../ui/toast';
import { sanitizeHref } from '../storage-subset';
import { isMarkdownNote } from '../note-types';
import {
  markdownEditorHandle,
  markdownViewMode,
  onMarkdownSelection,
  refreshMarkdownSelectionState,
  setMarkdownViewMode,
  type MarkdownSelectionState,
} from './surface';
import { callCommand } from '@milkdown/kit/utils';
import { TextSelection } from '@milkdown/kit/prose/state';
import { liftListItem } from '@milkdown/kit/prose/schema-list';
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
  popover: HTMLElement | null;
  input: HTMLInputElement | null;
  apply: HTMLButtonElement | null;
  remove: HTMLButtonElement | null;
  viewButtons: HTMLElement[];
}

let elements: ToolbarElements | null = null;
let menuOpen = false;

/** Test seam: forget the wired toolbar so a fresh shell can boot it. */
export function resetMarkdownToolbarForTests(): void {
  elements = null;
  menuOpen = false;
  parked = null;
}

/** The selection the popover parks (PM keeps it while the input is focused). */
let parked: { from: number; to: number } | null = null;

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
    popover: document.getElementById('markdownLinkPopover'),
    input: document.getElementById('markdownLinkInput') as HTMLInputElement | null,
    apply: document.getElementById('markdownLinkApply') as HTMLButtonElement | null,
    remove: document.getElementById('markdownLinkRemove') as HTMLButtonElement | null,
    viewButtons: Array.from(toolbar.querySelectorAll<HTMLElement>('[data-md-view]')),
  };

  wireCommandButtons();
  wireBlockMenu();
  wireLinkPopover();
  wireViewToggle();

  // Pressed states follow the caret (the rich toolbar's discipline).
  onMarkdownSelection(syncPressedStates);

  // Chrome follows the active note — Markdown notes only.
  const sync = (): void => {
    const show = isMarkdownNote(tabManager.getActive());
    toolbar.hidden = !show;
    if (!show) {
      closeBlockMenu();
      closeLinkPopover();
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
      if (action === 'link') {
        openLinkPopover();
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
    // A toggle does not move the selection — the buttons must not wait
    // for one to learn the document changed.
    refreshMarkdownSelectionState();
  }
  return applied;
}

/** Dispatches a toolbar action to the live Milkdown editor. */
function dispatchToolbarAction(action: string): boolean {
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
    case 'codeblock':
      return call(createCodeBlockCommand);
    case 'hr':
      return call(insertHrCommand);
    case 'table':
      return call(insertTableCommand, { row: 2, col: 3 });
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

/** Applies a block style from the dropdown (p / h1..h6). */
export function runMarkdownBlockStyle(block: string): boolean {
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
// The link popover
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
}

function openLinkPopover(): void {
  const handle = markdownEditorHandle();
  if (!elements?.popover || !elements.input || !handle) {
    return;
  }
  const { state } = handle.view;
  parked = { from: state.selection.from, to: state.selection.to };
  const empty = state.selection.empty;

  if (elements.remove) {
    elements.remove.hidden = empty;
  }
  elements.input.value = '';
  elements.popover.hidden = false;
  elements.input.focus();
  elements.input.select();
}

function closeLinkPopover(): void {
  parked = null;
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

  if (from === to) {
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

function removeLink(): void {
  const handle = markdownEditorHandle();
  if (!elements?.popover || !handle) {
    closeLinkPopover();
    return;
  }
  const { view } = handle;
  const { from, to } = view.state.selection;
  const linkMark = view.state.schema.marks.link;
  if (linkMark) {
    view.dispatch(view.state.tr.removeMark(from, to, linkMark));
  }
  closeLinkPopover();
  focusEditor(view);
}

function focusEditor(view: { focus: () => void }): void {
  view.focus();
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
    quote: state.blockquote,
    codeblock: state.codeBlock,
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
}

function wireViewToggle(): void {
  if (!elements) {
    return;
  }
  for (const button of elements.viewButtons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.mdView === 'preview' ? 'preview' : 'edit';
      setMarkdownViewMode(mode);
      syncViewToggle();
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
  // command chrome while the preview owns the surface.
  const editing = mode === 'edit';
  for (const button of elements.buttons) {
    (button as HTMLButtonElement).disabled = !editing;
  }
}
