/**
 * The Markdown slash menu — Notion's "/" gesture in Padify's skin.
 *
 * Type "/" at the start of a paragraph and the block menu floats under
 * the caret: filter-as-you-type, arrows walk, Enter (or Tab, or a
 * click) inserts. The kit's SlashProvider owns positioning and
 * visibility (floating-ui against the caret's rect); this module owns
 * every pixel — the panel reuses the rich-menu vocabulary (the block
 * dropdown's own look) — and every action routes through the same
 * toolbar commands the buttons dispatch, so there is exactly one
 * grammar for inserting blocks.
 *
 * The panel element lives in document.body (NOT the surface wrapper):
 * the surface rebuilds when another note kind evicts its wrapper, and
 * a body-level panel survives those remounts — the provider appends
 * its element only once.
 */
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import { SlashProvider, slashFactory } from '@milkdown/kit/plugin/slash';
import type { EditorView } from '@milkdown/kit/prose/view';

/**
 * The insert actions, injected by the composition root (app.ts) from the
 * toolbar's own exports — this module deliberately imports nothing from
 * its siblings, so the module graph stays acyclic (pinned by
 * architecture.test.ts): surface → slash, toolbar → surface, app → both.
 */
export interface MarkdownSlashHandlers {
  runToolbarAction(action: string): boolean;
  runBlockStyle(block: string): boolean;
  openEquation(options?: { kind?: 'inline' | 'block' }): void;
}

let handlers: MarkdownSlashHandlers | null = null;

/** The provider's update debounce — snappy for typing, short for tests. */
const SLASH_DEBOUNCE_MS = 30;

interface SlashItem {
  id: string;
  label: string;
  /** Extra words the filter matches beyond the label. */
  keywords: string;
  /** A block style to apply (headings). */
  block?: string;
  /** A toolbar action to dispatch. */
  action?: string;
  /** The equation bubble to open. */
  equation?: 'block' | 'inline';
}

const ITEMS: SlashItem[] = [
  { id: 'h1', label: 'Heading 1', keywords: 'title big heading', block: 'h1' },
  { id: 'h2', label: 'Heading 2', keywords: 'subtitle heading', block: 'h2' },
  { id: 'h3', label: 'Heading 3', keywords: 'section heading', block: 'h3' },
  { id: 'bullet', label: 'Bulleted list', keywords: 'unordered points ul', action: 'bullet' },
  { id: 'ordered', label: 'Numbered list', keywords: 'ordered steps ol', action: 'ordered' },
  { id: 'task', label: 'Task list', keywords: 'checkbox todo check', action: 'task' },
  { id: 'quote', label: 'Quote', keywords: 'blockquote cite', action: 'quote' },
  { id: 'codeblock', label: 'Code block', keywords: 'code snippet pre', action: 'codeblock' },
  { id: 'table', label: 'Table', keywords: 'grid rows columns cells', action: 'table' },
  { id: 'hr', label: 'Divider', keywords: 'hr rule separator line', action: 'hr' },
  { id: 'math', label: 'Equation', keywords: 'math latex katex formula', equation: 'block' },
];

/** Runs one item's insert through the injected handlers. */
function runItem(item: SlashItem): void {
  if (item.block) {
    handlers?.runBlockStyle(item.block);
  } else if (item.action) {
    handlers?.runToolbarAction(item.action);
  } else if (item.equation) {
    handlers?.openEquation({ kind: item.equation });
  }
}

const factory = slashFactory('padify');

let provider: SlashProvider | null = null;
let panel: HTMLElement | null = null;
let currentView: EditorView | null = null;
let visibleItems: SlashItem[] = [];
let activeIndex = 0;
let outsideClickListener: ((event: MouseEvent) => void) | null = null;

/** Query text before the caret ("" when the menu is not applicable). */
function queryText(view: EditorView): string {
  // Headings answer too — Notion's "/" gesture is not paragraph-only,
  // and the heading blocks are text blocks the menu serves just as well.
  // (The kit's default matches paragraphs only.)
  const content = provider?.getContent(
    view,
    (node) => node.type.name === 'paragraph' || node.type.name.startsWith('heading'),
  );
  return typeof content === 'string' ? content : '';
}

/** True when the pre-caret text is a bare "/query" at the block's start. */
function slashQueryMatches(view: EditorView): boolean {
  const text = queryText(view);
  return text !== '' && /^\/[^/\n]*$/.test(text);
}

function renderItems(): void {
  if (!panel || !currentView) {
    return;
  }
  const query = queryText(currentView).slice(1).trim().toLowerCase();
  visibleItems =
    query === ''
      ? [...ITEMS]
      : ITEMS.filter(
          (item) => item.label.toLowerCase().includes(query) || item.keywords.includes(query),
        );
  activeIndex = 0;

  panel.textContent = '';
  if (visibleItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'markdown-slash-empty';
    empty.textContent = 'No matching blocks';
    panel.append(empty);
    return;
  }

  for (const [index, item] of visibleItems.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'markdown-slash-item';
    button.dataset.slashId = item.id;
    button.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.className = 'markdown-slash-label';
    label.textContent = item.label;
    button.append(label);
    if (index === activeIndex) {
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');
    }
    button.addEventListener('mouseenter', () => {
      activeIndex = index;
      paintActive();
    });
    // mousedown (not click) so the editor never loses its selection.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      insertItem(index);
    });
    panel.append(button);
  }
}

function paintActive(): void {
  if (!panel) {
    return;
  }
  const buttons = panel.querySelectorAll<HTMLElement>('.markdown-slash-item');
  buttons.forEach((button, index) => {
    const active = index === activeIndex;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

/** Deletes the "/query" and runs the item's action. */
function insertItem(index: number): void {
  const view = currentView;
  const item = visibleItems[index];
  if (!view || !item) {
    return;
  }
  const text = queryText(view);
  const { state } = view;
  const to = state.selection.to;
  if (text !== '') {
    view.dispatch(state.tr.delete(to - text.length, to));
  }
  provider?.hide();
  runItem(item);
}

function handlePanelKeydown(view: EditorView, event: KeyboardEvent): boolean {
  if (visibleItems.length === 0 && !['Escape'].includes(event.key)) {
    return false;
  }
  switch (event.key) {
    case 'ArrowDown':
      if (visibleItems.length === 0) return false;
      event.preventDefault();
      activeIndex = (activeIndex + 1) % visibleItems.length;
      paintActive();
      return true;
    case 'ArrowUp':
      if (visibleItems.length === 0) return false;
      event.preventDefault();
      activeIndex = (activeIndex - 1 + visibleItems.length) % visibleItems.length;
      paintActive();
      return true;
    case 'Enter':
    case 'Tab':
      event.preventDefault();
      insertItem(activeIndex);
      return true;
    case 'Escape':
      event.preventDefault();
      provider?.hide();
      return true;
    default:
      return false;
  }
}

/**
 * Notifies the provider that input happened (the handler the plugin
 * spec registers — exposed so tests can drive the same path a keystroke
 * takes; in jsdom the native insert a real browser performs has to be
 * dispatched by hand first).
 */
export function notifyMarkdownSlashInput(view: EditorView): void {
  currentView = view;
  provider?.update(view);
}

/**
 * The surface's wiring handle: configure() lands in the editor's
 * .config() phase (the plugin spec's props close over the provider),
 * plugins is what .use() takes.
 */
export const slash = {
  configure(ctx: Ctx): void {
    ctx.update(factory.key, (prev) => ({
      ...prev,
      props: {
        handleTextInput: (view: EditorView) => {
          notifyMarkdownSlashInput(view);
          return false;
        },
        handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
          currentView = view;
          if (!provider || provider.element.dataset.show !== 'true') {
            return false;
          }
          return handlePanelKeydown(view, event);
        },
      },
    }));
  },
  get plugins(): MilkdownPlugin[] {
    return [...factory];
  },
};

/**
 * Boots the slash menu (the panel + provider) with its insert actions.
 * Called from app.ts once the shell is up; safe to call again after a
 * reset.
 */
export function initMarkdownSlash(wiring: MarkdownSlashHandlers): void {
  handlers = wiring;
  if (provider) {
    return;
  }
  panel = document.createElement('div');
  panel.className = 'markdown-slash';
  panel.setAttribute('data-show', 'false');
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'Insert blocks');
  document.body.append(panel);

  provider = new SlashProvider({
    content: panel,
    debounce: SLASH_DEBOUNCE_MS,
    root: document.body,
    shouldShow: (view) => slashQueryMatches(view),
  });
  provider.onShow = () => {
    renderItems();
  };
  provider.onHide = () => {
    if (panel) {
      panel.textContent = '';
    }
    visibleItems = [];
    activeIndex = 0;
  };

  // A click outside the panel (including in the editor) closes it —
  // the provider's own visibility pass only reacts to typing. Registered
  // once per provider lifetime; reset removes it with the panel.
  outsideClickListener = (event: MouseEvent) => {
    if (
      provider &&
      provider.element.dataset.show === 'true' &&
      event.target instanceof Node &&
      !provider.element.contains(event.target)
    ) {
      provider.hide();
    }
  };
  document.addEventListener('mousedown', outsideClickListener);
}

/**
 * Hides the open menu (the surface's stand-down call — dismiss). The
 * panel lives in document.body, and its close paths are typing-on and
 * MOUSEDOWN-off: a keyboard tab switch (or any transition that isn't a
 * click) would otherwise carry the open menu over the next note.
 */
export function hideMarkdownSlash(): void {
  provider?.hide();
}

/** Test seam: the live panel element (null before init). */
export function markdownSlashPanel(): HTMLElement | null {
  return panel;
}

/** Test seam: forget the provider so a fresh shell can boot it. */
export function resetMarkdownSlashForTests(): void {
  handlers = null;
  if (outsideClickListener) {
    document.removeEventListener('mousedown', outsideClickListener);
    outsideClickListener = null;
  }
  provider?.destroy();
  panel?.remove();
  provider = null;
  panel = null;
  currentView = null;
  visibleItems = [];
  activeIndex = 0;
}
