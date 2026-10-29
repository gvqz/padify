/**
 * The Markdown toolbar — the Markdown note's formatting chrome, built on
 * the same markup vocabulary as the rich toolbar (#markdownToolbar in
 * editor-shell.html reuses the rich-toolbar classes, so the app's one
 * toolbar aesthetic serves both). Every button speaks the SOURCE's own
 * grammar — the primitives in source-edit.ts (wrap/prefix/insert) — the
 * same edits typing Ctrl+B in the textarea makes. There is no second
 * editing grammar to drift from the surface: the textarea is the editor,
 * and the toolbar is its keyboard.
 *
 * Beyond the command buttons this module owns five pieces of chrome:
 *  • the text-style dropdown (Normal text / Heading 1-6) — the rich
 *    toolbar's one-menu-at-a-time pattern, with the current block's
 *    label following the caret;
 *  • the link popover — the rich note flow in miniature: park the
 *    selection, type a URL (bare domains complete to https://, the
 *    SAFE_HREF gate refuses anything else with the same toast), Apply
 *    wraps the selection as [text](url) or inserts fresh link text when
 *    the caret had nothing selected; Remove strips the link's markup.
 *    When the caret already sits inside a [text](href) span the popover
 *    opens in CHIP mode first — Open / Copy / Edit;
 *  • the equation bubble — the rich note's Docs-style symbol palette
 *    and live KaTeX preview, inserting `$…$` (inline) or `$$…$$`
 *    (block); clicking a rendered equation in the PREVIEW opens the
 *    bubble with its source filled in (padify:md-math-click);
 *  • the task-list button — the Docs grammar over GFM checkboxes
 *    (arm a plain list's items, lift back out);
 *  • the Source/Preview segmented control — the surface's view toggle
 *    (see surface.ts: source is the raw markdown, preview is the owned
 *    renderer's full-width output — the same truth share links and HTML
 *    export show). While the preview owns the surface the command
 *    buttons stand down: formatting an invisible document is a no-op.
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
  markdownSourceTextarea,
  markdownViewMode,
  onMarkdownSelection,
  onMarkdownViewMode,
  refreshMarkdownSelectionState,
  setMarkdownViewMode,
  type MarkdownSelectionState,
  type MarkdownViewMode,
} from './surface';
import {
  applyEdit,
  applyLink as applySourceLink,
  clearFormatting as clearSourceFormatting,
  insertBlock,
  linkAroundCaret,
  removeLink as removeSourceLink,
  selectMathSource,
  setHeadingLevel,
  tableTemplate,
  toggleLinePrefix,
  toggleOrderedList,
  toggleWrap,
  wrapCodeBlock,
  type SourceLink,
} from './source-edit';

/** A click on a rendered equation (the preview fires it; see surface.ts). */
const MD_MATH_CLICK_EVENT = 'padify:md-math-click';

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

/** Test seam: forget the wired toolbar so a fresh shell can boot it. */
export function resetMarkdownToolbarForTests(): void {
  elements = null;
  menuOpen = false;
  sourceLink = null;
  mathPaletteMounted = false;
  mathKind = 'inline';
}

/** The source pane's parked link (the chip mode's target). */
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
  wireLinkPopover();
  wireMathPopover();
  wireViewToggle();
  wireDocumentEvents();

  // Pressed states follow the caret (the rich toolbar's discipline).
  onMarkdownSelection(syncPressedStates);
  // The segmented control follows EVERY mode flip — its own buttons and
  // the surface's own resets — so the chrome never disagrees with the
  // surface (one source of truth: surface.ts).
  onMarkdownViewMode(syncViewToggle);

  // Chrome follows the active note — Markdown notes only.
  const sync = (): void => {
    const show = isMarkdownNote(tabManager.getActive());
    toolbar.hidden = !show;
    if (!show) {
      closeBlockMenu();
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
    // note. The source pane takes the caret back.
    focusMarkdownPane();
    // A toggle does not move the selection — the buttons must not wait
    // for one to learn the document changed.
    refreshMarkdownSelectionState();
  }
  return applied;
}

/**
 * The source pane's action dispatch — the toolbar vocabulary as markdown
 * syntax edits (the primitives in source-edit.ts). Undo and redo ride the
 * textarea's own native stacks.
 */
function dispatchToolbarAction(action: string): boolean {
  const source = markdownSourceTextarea();
  if (!source) {
    return false;
  }
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

/** Applies a block style from the dropdown (p / h1..h6). */
export function runMarkdownBlockStyle(block: string): boolean {
  const source = markdownSourceTextarea();
  if (!source) {
    return false;
  }
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

/** The href the chip acts on. */
function chipHref(): string | null {
  return sourceLink?.href ?? null;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Link copied.');
  } catch {
    showToast('Copy failed — your browser blocked clipboard access.');
  }
}

/** Chip first when the caret sits on a link; edit mode otherwise. */
export function openMarkdownLinkPopover(): void {
  const source = markdownSourceTextarea();
  if (!source || !elements?.popover || !elements.input) {
    return;
  }
  closeBlockMenu();
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

/**
 * The popover's Apply: the sanitized href wraps the selection as
 * [text](href), retargets the parked link in place, or plants fresh
 * link text at the caret.
 */
function applyLink(): void {
  const source = markdownSourceTextarea();
  if (!source || !elements?.input) {
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
  if (!source) {
    closeLinkPopover();
    return;
  }
  removeSourceLink(source);
  closeLinkPopover();
  source.focus();
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
  // the bubble with the equation's source, and the same bubbling click
  // would close it straight back (the rich toolbar's "click on the
  // equation being edited" guard).
  document.addEventListener('click', (event) => {
    if (
      !elements?.mathPopover ||
      elements.mathPopover.hidden ||
      elements.mathPopover.contains(event.target as Node)
    ) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest?.('[data-md-action="math"]') || target.closest?.('.padify-math')) {
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
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function closeMathPopover(): void {
  if (elements?.mathPopover) {
    elements.mathPopover.hidden = true;
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

/**
 * Opens the equation bubble — fresh, or (from the preview's click on a
 * rendered equation) with the equation's LaTeX filled in for editing.
 */
export function openMarkdownEquationBubble(options?: {
  kind?: 'inline' | 'block';
  latex?: string;
}): void {
  if (!elements?.mathPopover || !elements.mathInput || !elements.mathPreview) {
    return;
  }
  closeBlockMenu();
  closeLinkPopover();
  mountMathPaletteOnce();

  mathKind = options?.latex !== undefined && options.kind === 'block' ? 'block' : options?.kind === 'block' ? 'block' : 'inline';
  const editing = options?.latex !== undefined && options.latex !== '';
  elements.mathInput.value = editing ? options!.latex! : '';
  renderMathPreview(elements.mathPreview, elements.mathInput.value);
  if (elements.mathInsert) {
    elements.mathInsert.textContent = editing ? 'Apply' : 'Insert';
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
  closeMathPopover();
}

/**
 * The equation insert: the bubble's LaTeX becomes $…$ (inline) or a
 * fenced $$…$$ block (on its own lines). An EMPTY input keeps the old
 * gesture — wrap whatever the source selection holds, the caret between
 * the dollars for overtyping.
 */
function applySourceMath(source: HTMLTextAreaElement): void {
  const latex = elements?.mathInput?.value.trim() ?? '';
  closeMathPopover();
  source.focus();
  if (mathKind === 'block') {
    if (latex !== '') {
      insertBlock(source, `$$\n${latex}\n$$`);
    }
    return;
  }
  const from = source.selectionStart;
  const to = source.selectionEnd;
  if (latex !== '') {
    // The bubble's own text is the equation — Apply over a selected OLD
    // equation replaces it (selectMathSource set that selection).
    const inserted = `$${latex}$`;
    applyEdit(source, from, to, inserted, from + inserted.length);
    return;
  }
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

  // A click on a rendered equation (the preview pane) opens the bubble
  // with its source filled in — and selects the equation's own span in
  // the source, so Apply REPLACES it (the preview click has no caret to
  // offer; the old equation is the selection).
  document.addEventListener(MD_MATH_CLICK_EVENT, (event) => {
    if (!elements?.toolbar || elements.toolbar.hidden) {
      return;
    }
    const detail = (event as CustomEvent<{ latex?: string; kind?: 'inline' | 'block' }>).detail;
    if (typeof detail?.latex === 'string' && detail.latex !== '') {
      const source = markdownSourceTextarea();
      if (source) {
        selectMathSource(source, detail.latex, detail.kind === 'block' ? 'block' : 'inline');
      }
    }
    openMarkdownEquationBubble({ kind: detail?.kind, latex: detail?.latex });
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
}

function wireViewToggle(): void {
  if (!elements) {
    return;
  }
  for (const button of elements.viewButtons) {
    button.addEventListener('click', () => {
      const requested = button.dataset.mdView;
      const mode: MarkdownViewMode = requested === 'preview' ? 'preview' : 'source';
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
  // command chrome while the preview owns the surface.
  const editing = mode !== 'preview';
  for (const button of elements.buttons) {
    (button as HTMLButtonElement).disabled = !editing;
  }
  if (elements.menuButton) {
    (elements.menuButton as HTMLButtonElement).disabled = !editing;
  }
  if (!editing) {
    closeBlockMenu();
    closeLinkPopover();
    closeMathPopover();
  } else {
    // Back under the source's grammar: recompute the pressed states from
    // the live selection.
    refreshMarkdownSelectionState();
  }
}
