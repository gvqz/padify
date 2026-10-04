/**
 * The Markdown surface — the 'text' content kind's editing surface, built
 * on Milkdown (the open-source WYSIWYG markdown editor over ProseMirror
 * and remark) skinned headless to Padify's own tokens (18-markdown.css —
 * Milkdown v7 ships no default styling, so every pixel it shows is ours).
 *
 * WHAT THE USER SEES. The note's SOURCE (markdown text, stored byte-exact
 * like every 'text' note) is edited in a what-you-get-is-what-you-mean
 * view: headings look like headings, lists behave like lists, tables are
 * editable. A Split toggle parks the owned renderer's live output beside
 * the editor (both panes on screen, the preview a beat behind the
 * typing); a Preview toggle swaps to that output full-width (the same
 * pipeline share links and HTML export use, so "preview" always means
 * "the truth").
 *
 * HOW IT OWNS THE HOST. The surface mounts a wrapper inside the #note
 * host and sets the host itself contenteditable=false — the wrapper's
 * inner ProseMirror root is the editable. The html engine is parked for
 * the duration (ModelPort.setInert — see app.ts wiring) so its listeners
 * never see the markdown editor's events, and its getHtml() serves the
 * parked html model instead of absorbing this surface's markup. When an
 * html note opens again, the port's renderHtml repaints the host (which
 * evicts this wrapper); the next markdown display notices the detached
 * root and rebuilds.
 *
 * THE ANNOUNCE CONTRACT. Editing surfaces must speak the one input
 * signal the shell listens for: a bubbling `input` event on the host
 * (autosave, the word-count pill, the save indicator, typing effects all
 * follow it). Milkdown's listener plugin reports every markdown change
 * (200ms debounce); the surface re-dispatches it as the host event —
 * EXCEPT for the changes the surface itself applied: display/commit/
 * clear call replaceAll, and opening a note must never announce an edit
 * (the silentDoc sentinel below tells our own doc changes from the
 * user's).
 *
 * SECURITY (pinned by the characterization suite): the markdown source is
 * DATA, never markup — raw HTML in the source renders as escaped text
 * (Milkdown wraps it in inert data-type=html spans), javascript:/data:
 * link hrefs are dropped from the live DOM while their text survives,
 * and the only markup in the host is what ProseMirror's schema itself
 * generated. The stored source round-trips as text; the preview, share
 * and export paths render it through the owned renderer with the same
 * safe-href gate the html subset uses.
 */
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { slash } from './slash';
import { bubble } from './bubble';
import { attachBlockHandle, blockHandle, detachBlockHandle } from './block-handle';

// ProseMirror's own base styles (outline discipline, table selection,
// gap cursor) — the katex CSS import in editor/math.ts is the precedent
// for a node_modules stylesheet riding the bundle.
import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/tables/style/tables.css';
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css';

import { htmlToText } from '../note-content';
import { renderMathIn } from '../math';
import { registerNoteSurface, type NoteSurface, type SurfaceNote } from '../surface';
import { renderMarkdownToHtml } from './render';
import {
  MATH_BLOCK_NODE,
  MATH_INLINE_NODE,
  indentKeymapPlugin,
  markdownMath,
  markdownNodeViews,
  openLinkClickPlugin,
  safeImageSchema,
  taskTogglePlugin,
} from './nodes';

/** What the toolbar's pressed-state pass wants to know about the caret. */
export interface MarkdownSelectionState {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: boolean;
  /** The href at the caret/selection (the link chip's Open/Copy/Edit). */
  linkHref: string | null;
  /** Heading level when the caret's block IS a heading; null otherwise. */
  heading: number | null;
  blockquote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  /** The caret sits in a GFM task item (checkbox column). */
  task: boolean;
  codeBlock: boolean;
  /** The selection IS an equation node (the bubble's edit mode). */
  math: 'inline' | 'block' | null;
  /** The selection IS an image chip. */
  image: boolean;
  /** The caret sits inside a table (the table-ops menu). */
  inTable: boolean;
}

/** One mounted Milkdown instance + everything its surface needs. */
interface LiveMarkdown {
  host: HTMLElement;
  /** The wrapper this surface owns inside the host. */
  root: HTMLElement;
  editor: Editor | null;
  view: EditorView | null;
  /** Content awaiting editor readiness (the first mount is async). */
  pending: string | null;
  /**
   * The doc this surface last applied wholesale: the markdownUpdated
   * notification that still matches it is ours, not the user's, and is
   * swallowed (opening a note is not editing it).
   */
  silentDoc: ProseNode | null;
  /** The preview pane (owned-renderer output), rendered on demand. */
  preview: HTMLElement;
}

let live: LiveMarkdown | null = null;

/**
 * The surface's presentation modes: 'edit' (the WYSIWYG alone), 'split'
 * (WYSIWYG left, the owned renderer's live output right), 'preview'
 * (the renderer alone). Split is a WORKING mode — it survives note
 * switches; preview is a reading gesture — every display resets it.
 */
export type MarkdownViewMode = 'edit' | 'split' | 'preview';
let viewMode: MarkdownViewMode = 'edit';

const selectionListeners = new Set<(state: MarkdownSelectionState) => void>();
const viewModeListeners = new Set<(mode: MarkdownViewMode) => void>();

/** The live surface's host — null when no markdown surface is mounted. */
export function markdownHost(): HTMLElement | null {
  return live?.root.isConnected ? live.host : null;
}

/** The live editor pair (toolbar commands drive it); null when unmounted. */
export function markdownEditorHandle(): { editor: Editor; view: EditorView } | null {
  if (!live || !live.root.isConnected || !live.editor || !live.view) {
    return null;
  }
  return { editor: live.editor, view: live.view };
}

/** Registers for caret-driven pressed-state updates; returns unlisten. */
export function onMarkdownSelection(fn: (state: MarkdownSelectionState) => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

/** Registers for view-mode flips (the segmented control, the top bar's split icon); returns unlisten. */
export function onMarkdownViewMode(fn: (mode: MarkdownViewMode) => void): () => void {
  viewModeListeners.add(fn);
  return () => viewModeListeners.delete(fn);
}

/**
 * Flips the view mode (edit / split / preview). Split and preview
 * re-render the pane from the LIVE markdown — the same owned-renderer
 * pass, so all three views agree by construction.
 */
export function setMarkdownViewMode(mode: MarkdownViewMode): void {
  viewMode = mode;
  if (live && live.root.isConnected) {
    live.root.classList.toggle('markdown-preview-mode', mode === 'preview');
    live.root.classList.toggle('markdown-split-mode', mode === 'split');
    live.preview.hidden = mode === 'edit';
    if (mode !== 'edit') {
      renderLivePreview();
    }
  }
  viewModeListeners.forEach((fn) => fn(mode));
}

/** The current view mode (the toolbar's segmented control reads it). */
export function markdownViewMode(): MarkdownViewMode {
  return viewMode;
}

/** Renders the preview pane from the live editor's markdown. */
function renderLivePreview(): void {
  if (!live || !live.editor) {
    return;
  }
  const source = live.editor.action(getMarkdown());
  live.preview.innerHTML = renderMarkdownToHtml(source);
  renderMathIn(live.preview);
}

/** The split pane's re-render debounce — typing stays smooth, the pane settles a beat behind. */
const SPLIT_RENDER_DEBOUNCE_MS = 250;
let splitRenderTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedules the split pane's re-render (the markdownUpdated hook). */
function scheduleSplitRender(): void {
  if (viewMode !== 'split') {
    return;
  }
  if (splitRenderTimer !== null) {
    clearTimeout(splitRenderTimer);
  }
  splitRenderTimer = setTimeout(() => {
    splitRenderTimer = null;
    if (viewMode === 'split') {
      renderLivePreview();
    }
  }, SPLIT_RENDER_DEBOUNCE_MS);
}

/**
 * The Markdown editing surface for 'text' notes. One instance serves any
 * host (the registry contract): the wrapper's connectivity decides
 * whether the live editor still owns the host or a rebuild is needed.
 */
export class MarkdownNoteSurface implements NoteSurface {
  readonly kind = 'text' as const;
  readonly editable = true;

  display(host: HTMLElement, note: SurfaceNote | null): void {
    // The wrapper's inner root is the editable; the host itself must not
    // be one (nested editables scramble the caret).
    host.setAttribute('contenteditable', 'false');
    const content = note?.content ?? '';

    if (live && live.root.isConnected && live.host === host) {
      this.apply(content);
    } else {
      this.mount(host, content);
    }
    // Preview is a reading gesture, not a per-note setting — every
    // display resets it. Split is a working mode: it survives note
    // switches, and a fresh mount re-applies it (the wrapper starts
    // in the editing layout).
    setMarkdownViewMode(viewMode === 'preview' ? 'edit' : viewMode);
    host.scrollTop = 0;
  }

  capture(host: HTMLElement | null): string | null {
    if (!live || live.host !== host || !live.root.isConnected) {
      return null;
    }
    if (live.editor) {
      return live.editor.action(getMarkdown());
    }
    // Still building: the honest capture is the content we are about to
    // paint — the note's own source, not an empty string.
    return live.pending;
  }

  visibleText(host: HTMLElement | null, note: SurfaceNote): string {
    // The rendered projection: the pill, statistics, the close prompt and
    // share word counts should count the words the reader SEES, not the
    // asterisks that produce them.
    const source = this.capture(host) ?? note.content;
    const text = htmlToText(renderMarkdownToHtml(source)).replace(/\u00a0/g, ' ');
    return text.trim() === '' ? '' : text;
  }

  commit(host: HTMLElement | null, content: string): boolean {
    if (host) {
      this.display(host, { content });
    }
    // The caller owns the persist — no port channel exists for this kind.
    return false;
  }

  insertText(host: HTMLElement | null, text: string): boolean {
    if (!live || live.host !== host || !live.view) {
      return false;
    }
    const { state } = live.view;
    const { from, to } = state.selection;
    // User-initiated: the next markdownUpdated must announce.
    live.silentDoc = null;
    live.view.dispatch(state.tr.insertText(text, from, to));
    return true;
  }

  clear(host: HTMLElement): void {
    // An empty markdown note is an empty markdown EDITOR — the surface
    // stays mounted (the manager writes the model and persists itself).
    this.display(host, { content: '' });
  }

  // ---- mounting -----------------------------------------------------------

  private mount(host: HTMLElement, content: string): void {
    const previous = live;
    if (previous) {
      void teardown(previous);
    }

    // The html surface's DOM (the last html note) is evicted; its port
    // model is untouched and repaints when an html note opens again.
    host.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'markdown-surface';
    const preview = document.createElement('div');
    preview.className = 'markdown-preview';
    preview.hidden = true;
    root.append(preview);
    host.append(root);

    live = { host, root, editor: null, view: null, pending: content, silentDoc: null, preview };

    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            class: 'padify-markdown',
            spellcheck: 'true',
            role: 'textbox',
            'aria-multiline': 'true',
            translate: 'no',
            // The empty editor's placeholder — the host's own copy (the
            // CSS in 18-markdown.css reads it through attr()).
            'data-placeholder':
              host.dataset.placeholder ??
              'Type your notes here and when you come back all your notes will be right here...',
          },
          // Math equations and image chips are Padify's own pixels — see
          // nodes.ts (the app's KaTeX pipeline; never an <img> fetch).
          nodeViews: markdownNodeViews(),
        }));
        slash.configure(ctx);
        bubble.configure(ctx);
        ctx.get(listenerCtx).markdownUpdated(() => {
          announceIfUserEdit();
          // The split pane follows every doc change — user edits and the
          // surface's own replaceAll alike (it is a presentation concern,
          // not an announce one).
          scheduleSplitRender();
        });
        ctx.get(listenerCtx).selectionUpdated((_ctx, selection) => {
          notifySelection(selection);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(clipboard)
      .use(markdownMath)
      .use(safeImageSchema)
      .use(listener)
      .use(history)
      .use(taskTogglePlugin)
      .use(indentKeymapPlugin)
      .use(openLinkClickPlugin)
      .use(slash.plugins)
      .use(bubble.plugins)
      .use([...blockHandle.plugins])
      .create()
      .then((editor) => {
        if (!live || live.root !== root) {
          // Superseded (another mount happened first) — stand down.
          void editor.destroy();
          return;
        }
        live.editor = editor;
        live.view = editor.action((ctx) => ctx.get(editorViewCtx));
        // The drag grip binds THIS editor's block service (the provider
        // is per-editor; superseded editors detached below/teardown).
        attachBlockHandle(editor);
        if (live.pending !== null) {
          const pending = live.pending;
          live.pending = null;
          applyContent(pending);
        }
      })
      .catch((error: unknown) => {
        if (live?.root === root) {
          // The note's data is safe in the model (capture answers the
          // pending content); the surface is simply not there.
          live = null;
        }
        console.error('[padify] markdown surface failed to mount', error);
      });
  }

  private apply(content: string): void {
    if (!live) {
      return;
    }
    if (!live.editor) {
      live.pending = content;
      return;
    }
    applyContent(content);
  }
}

/** Applies content to the live editor (the silent, non-announcing path). */
function applyContent(content: string): void {
  if (!live || !live.editor) {
    return;
  }
  live.silentDoc = null;
  live.editor.action(replaceAll(content));
  live.silentDoc = live.view?.state.doc ?? null;
}

/**
 * The announce gate: a markdown change is ours (display/commit/clear —
 * replaceAll) while the live doc still equals the doc we applied, and
 * the user's the moment anything else touched it.
 */
function announceIfUserEdit(): void {
  if (!live) {
    return;
  }
  const doc = live.view?.state.doc ?? null;
  if (doc && live.silentDoc && doc.eq(live.silentDoc)) {
    live.silentDoc = null;
    return;
  }
  live.silentDoc = null;
  live.host.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Destroys a superseded editor (its root left the host already). */
async function teardown(target: LiveMarkdown): Promise<void> {
  if (live === target) {
    live = null;
  }
  if (splitRenderTimer !== null) {
    clearTimeout(splitRenderTimer);
    splitRenderTimer = null;
  }
  detachBlockHandle();
  try {
    await target.editor?.destroy();
  } catch {
    // A half-built editor that fails to destroy leaks nothing the next
    // mount needs — the wrapper is already gone from the host.
  }
}

/** Reads the caret's mark/block state for the toolbar's pressed states. */
function selectionStateFrom(view: EditorView): MarkdownSelectionState {
  const { state } = view;
  const { from, to, empty } = state.selection;
  // Select-all answers an AllSelection whose $from sits at the doc level
  // (depth 0 — parent IS the doc). The pressed-state pass wants the
  // block the user is acting on: the first one.
  const $from =
    state.selection.$from.depth === 0 && state.doc.childCount > 0
      ? state.doc.resolve(Math.min(1, state.doc.content.size))
      : state.selection.$from;

  // Marks in effect: at the caret, the marks insertion would receive
  // (storedMarks win over the block's); across a range, every mark that
  // appears anywhere in it (any-of — the rich toolbar's convention).
  const collected = new Set<string>();
  let linkHref: string | null = null;
  const collectLink = (
    marks: Iterable<{ type: { name: string }; attrs: { href?: unknown } }>,
  ): void => {
    for (const mark of marks) {
      if (mark.type.name === 'link' && linkHref === null && typeof mark.attrs.href === 'string') {
        linkHref = mark.attrs.href;
      }
    }
  };
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    marks.forEach((mark) => collected.add(mark.type.name));
    collectLink(marks);
  } else {
    state.doc.nodesBetween(from, to, (node) => {
      node.marks.forEach((mark) => collected.add(mark.type.name));
      collectLink(node.marks);
      return true;
    });
  }

  const inBlock = (name: string): boolean => {
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === name) {
        return true;
      }
    }
    return false;
  };

  let task = false;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const ancestor = $from.node(depth);
    if (ancestor.type.name === 'list_item' && ancestor.attrs.checked != null) {
      task = true;
      break;
    }
  }

  // Node selections answer the atom nodes' own identity.
  let math: 'inline' | 'block' | null = null;
  let image = false;
  if (state.selection instanceof NodeSelection) {
    const name = state.selection.node.type.name;
    if (name === MATH_INLINE_NODE) {
      math = 'inline';
    } else if (name === MATH_BLOCK_NODE) {
      math = 'block';
    } else if (name === 'image') {
      image = true;
    }
  }

  const parent = $from.parent;

  return {
    bold: collected.has('strong'),
    italic: collected.has('emphasis'),
    strikethrough: collected.has('strike_through'),
    code: collected.has('inlineCode'),
    link: collected.has('link'),
    linkHref,
    heading: parent.type.name === 'heading' ? (parent.attrs.level as number) : null,
    blockquote: inBlock('blockquote'),
    bulletList: inBlock('bullet_list'),
    orderedList: inBlock('ordered_list'),
    task,
    codeBlock: parent.type.name === 'code_block',
    math,
    image,
    inTable: inBlock('table'),
  };
}

/** Notifies the pressed-state listeners (called on selection changes). */
function notifySelection(selection: EditorView['state']['selection']): void {
  if (!live || !live.view || selectionListeners.size === 0) {
    return;
  }
  void selection;
  const state = selectionStateFrom(live.view);
  selectionListeners.forEach((fn) => fn(state));
}

/**
 * The caret/selection's state snapshot, on demand — the context menu's
 * markdown layer (and tests) ask synchronously instead of subscribing.
 */
export function markdownSelectionStateNow(): MarkdownSelectionState | null {
  const handle = markdownEditorHandle();
  if (!handle) {
    return null;
  }
  return selectionStateFrom(handle.view);
}

/**
 * Recomputes and re-notifies the pressed-state listeners — the toolbar
 * calls this after every command it dispatches: a toggle does not move
 * the selection, so the selectionUpdated signal alone would leave the
 * buttons a beat behind the document.
 */
export function refreshMarkdownSelectionState(): void {
  const handle = markdownEditorHandle();
  if (!handle) {
    return;
  }
  const state = selectionStateFrom(handle.view);
  selectionListeners.forEach((fn) => fn(state));
}

/**
 * The single character before the caret ('' at the note's start) — the
 * dictation pass's smart spacing/capitalisation input. Answers from the
 * live markdown document so voice typing behaves exactly as it does on
 * the html surface.
 */
export function markdownCharBeforeCaret(): string {
  const handle = markdownEditorHandle();
  if (!handle) {
    return '';
  }
  const { state } = handle.view;
  const { from, empty } = state.selection;
  if (!empty || from === 0) {
    return '';
  }
  return state.doc.textBetween(Math.max(0, from - 1), from);
}

// The registry entry — the seam everything already routes through.
registerNoteSurface('text', new MarkdownNoteSurface());
