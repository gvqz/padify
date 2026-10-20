/**
 * The Markdown surface — the 'text' content kind's editing surface, built
 * on Milkdown (the open-source WYSIWYG markdown editor over ProseMirror
 * and remark) skinned headless to Padify's own tokens (18-markdown.css —
 * Milkdown v7 ships no default styling, so every pixel it shows is ours).
 *
 * WHAT THE USER SEES. The note's SOURCE (markdown text, stored byte-exact
 * like every 'text' note) edits in the user's choice of two panes: the
 * VISUAL mode (the what-you-get-is-what-you-mean view: headings look
 * like headings, lists behave like lists, tables are editable) or the
 * SOURCE mode (the raw markdown, typed as plain text with GitHub-style
 * keyboard behavior — lists continue, Tab indents, Ctrl+B wraps). The
 * Split mode pairs the SOURCE pane with the owned renderer's live
 * output (both on screen, the preview a beat behind the typing); the
 * Preview mode swaps to that output full-width (the same pipeline share
 * links and HTML export use, so "preview" always means "the truth").
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
import {
  AllSelection,
  NodeSelection,
  TextSelection,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Fragment, Slice } from '@milkdown/kit/prose/model';
import { history as proseHistory } from '@milkdown/kit/prose/history';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { slash, hideMarkdownSlash } from './slash';
import { bubble, hideMarkdownBubble } from './bubble';
import { attachBlockHandle, blockHandle, detachBlockHandle, hideBlockHandle } from './block-handle';
import {
  applyEdit,
  continueListOnEnter,
  indentLines,
  sourceSelectionState,
  toggleWrap,
} from './source-edit';

// ProseMirror's own base styles (outline discipline, table selection,
// gap cursor) — the katex CSS import in editor/math.ts is the precedent
// for a node_modules stylesheet riding the bundle.
import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/tables/style/tables.css';
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css';

import { htmlToText } from '../note-content';
import { renderMathIn } from '../math';
import { isApplePlatform } from '../../lib/platform';
import { registerNoteSurface, type NoteSurface, type SurfaceNote } from '../surface';
import type { MarkdownSelectionState } from './selection-state';
import { renderMarkdownToHtml } from './render';
import {
  MATH_BLOCK_NODE,
  MATH_INLINE_NODE,
  indentKeymapPlugin,
  markdownMath,
  markdownNodeViews,
  openLinkClickPlugin,
  padifyParagraphSchema,
  safeImageSchema,
  taskTogglePlugin,
} from './nodes';

/** What the toolbar's pressed-state pass wants to know about the caret. */
export type { MarkdownSelectionState } from './selection-state';

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
  /** The source pane (the raw-markdown textarea), when a pane owns the edit. */
  source: HTMLTextAreaElement | null;
  /** The preview pane (owned-renderer output), rendered on demand. */
  preview: HTMLElement;
}

let live: LiveMarkdown | null = null;

/**
 * One-entry render cache for visibleText: the last (source, text) pair.
 * Pill/statistics asks for the SAME unchanged document on every typing
 * pause and modal open — the cached answer skips a whole render pass.
 */
let visibleTextCache: { source: string; text: string } | null = null;

/**
 * A fresh, empty prosemirror-history state — the value the history plugin
 * resets to when the surface replaces the document wholesale. Built once
 * through the plugin factory's own init (the same module the undo/redo
 * commands read), so a reset can never drift from what `undo` expects.
 */
const EMPTY_HISTORY_STATE: unknown = proseHistory().spec.state?.init({}, {} as never);

/**
 * The surface's presentation modes: 'edit' (the WYSIWYG alone), 'source'
 * (the raw markdown alone), 'split' (the source left, the owned
 * renderer's live output right), 'preview' (the renderer alone). The
 * working modes (edit/source/split) survive note switches; preview is a
 * reading gesture — every display resets it to the last working mode.
 */
export type MarkdownViewMode = 'edit' | 'source' | 'split' | 'preview';
let viewMode: MarkdownViewMode = 'edit';
/** The mode preview resets back to (the last working one). */
let lastWorkingMode: MarkdownViewMode = 'edit';

/** True when the raw-textarea pane owns the editing (source or split). */
function usesSourcePane(mode: MarkdownViewMode): boolean {
  return mode === 'source' || mode === 'split';
}

/** True while the source textarea is the live editing pane. */
export function markdownSourceActive(): boolean {
  return !!live && live.root.isConnected && usesSourcePane(viewMode) && !!live.source;
}

/** The live source textarea (the toolbar/context-menu seam); null when absent. */
export function markdownSourceTextarea(): HTMLTextAreaElement | null {
  return live && live.root.isConnected && usesSourcePane(viewMode) ? live.source : null;
}

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

/**
 * Puts the caret in the pane that owns the edit — the toolbar's view
 * buttons and the top bar's split icon call this right after a flip (a
 * click parks focus on the button; without handing it back, the next
 * Space would activate the ARIA toolbar instead of typing).
 */
export function focusMarkdownPane(): void {
  const target = live && live.root.isConnected ? focusTargetForMode() : null;
  target?.focus();
}

function focusTargetForMode(): HTMLElement | null {
  if (!live) {
    return null;
  }
  if (usesSourcePane(viewMode)) {
    return live.source;
  }
  return live.view?.dom ?? null;
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
 * Flips the view mode (edit / source / split / preview). Crossing into
 * or out of the source pane syncs its content (the WYSIWYG is the
 * source of truth leaving, the textarea entering — every view of the
 * note agrees by construction). Split and preview re-render the pane
 * from the LIVE markdown — the same owned-renderer pass.
 */
export function setMarkdownViewMode(mode: MarkdownViewMode): void {
  const previous = viewMode;
  viewMode = mode;
  if (mode !== 'preview') {
    lastWorkingMode = mode;
  }
  if (live && live.root.isConnected) {
    if (usesSourcePane(mode) && !usesSourcePane(previous)) {
      pullEditorIntoSource();
    }
    if (!usesSourcePane(mode) && usesSourcePane(previous)) {
      pushSourceIntoEditor();
    }
    live.root.classList.toggle('markdown-source-mode', mode === 'source');
    live.root.classList.toggle('markdown-split-mode', mode === 'split');
    live.root.classList.toggle('markdown-preview-mode', mode === 'preview');
    live.preview.hidden = mode !== 'split' && mode !== 'preview';
    if (mode !== 'edit') {
      // The WYSIWYG-only chrome stands down while another pane owns the
      // surface (the bubble/slash live in document.body; the grip floats
      // over blocks that are no longer visible).
      hideMarkdownBubble();
      hideMarkdownSlash();
      hideBlockHandle();
      renderLivePreview();
    }
  }
  viewModeListeners.forEach((fn) => fn(mode));
}

/** Copies the WYSIWYG's markdown into a fresh source pane (entering source/split). */
function pullEditorIntoSource(): void {
  if (!live) {
    return;
  }
  const content = live.editor ? live.editor.action(getMarkdown()) : (live.pending ?? '');
  rebuildSourcePane(content);
  scheduleSplitRender();
}

/**
 * Hands the source pane's markdown back to the WYSIWYG (leaving
 * source/split). A wholesale replace — only when the text actually
 * changed — with the history reset it implies (the doc changed through
 * a path the history cannot merge; undo never crosses it).
 */
function pushSourceIntoEditor(): void {
  if (!live || !live.source || !live.editor) {
    return;
  }
  const text = live.source.value;
  if (text !== live.editor.action(getMarkdown())) {
    applyContent(text);
  }
}

/** The current view mode (the toolbar's segmented control reads it). */
export function markdownViewMode(): MarkdownViewMode {
  return viewMode;
}

/** The markdown the note currently holds — the pane that owns the edit answers. */
function liveMarkdown(): string {
  if (live && live.root.isConnected && usesSourcePane(viewMode) && live.source) {
    return live.source.value;
  }
  if (live?.editor) {
    return live.editor.action(getMarkdown());
  }
  return live?.pending ?? '';
}

/** Renders the preview pane from the live markdown. */
function renderLivePreview(): void {
  if (!live) {
    return;
  }
  const source = liveMarkdown();
  live.preview.innerHTML = renderMarkdownToHtml(source);
  renderMathIn(live.preview);
  if (viewMode === 'split' && live.source) {
    syncSplitScroll(live.source, live.preview);
  }
}

/**
 * The task-line scan for the preview toggle: the same shapes the renderer
 * reads as task items (a list marker, one to four spaces, the bracket) in
 * document order — the nth match is the nth checkbox the preview shows.
 */
const PREVIEW_TASK_LINE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ ]{1,4}\[([ xX])\]/gm;

/**
 * Flips the clicked task item's checkbox by rewriting the SOURCE: the nth
 * task marker in the markdown corresponds to the nth checkbox in the
 * render (both walk the document in order). Returns false when the source
 * holds no matching marker — a hand-mangled note renders checkboxes the
 * source cannot express, and those stay read-only.
 */
function togglePreviewTask(item: Element): boolean {
  if (!live) {
    return false;
  }
  const checkboxes = [...live.preview.querySelectorAll('input[type="checkbox"]')];
  const index = checkboxes.findIndex((box) => item === box.parentElement);
  if (index === -1) {
    return false;
  }
  const source = liveMarkdown();
  PREVIEW_TASK_LINE.lastIndex = 0;
  let seen = 0;
  for (
    let match = PREVIEW_TASK_LINE.exec(source);
    match !== null;
    match = PREVIEW_TASK_LINE.exec(source)
  ) {
    if (seen === index) {
      // The match ends at the closing ']' — the check character sits one
      // before it.
      const toggleAt = match.index + match[0].length - 2;
      const checked = match[2] !== ' ';
      const toggled =
        source.slice(0, toggleAt) + (checked ? ' ' : 'x') + source.slice(toggleAt + 1);
      applyToggledSource(toggled);
      return true;
    }
    seen += 1;
  }
  return false;
}

/**
 * Writes a toggled source back through whichever pane owns the note — the
 * textarea directly (its native undo keeps the gesture), the WYSIWYG as a
 * wholesale replace — and announces the edit so autosave, the word count
 * and the save indicator follow, exactly as if the user had typed it.
 */
function applyToggledSource(nextSource: string): void {
  if (!live) {
    return;
  }
  if (live.source && usesSourcePane(viewMode)) {
    if (live.source.value === nextSource) {
      return;
    }
    live.source.value = nextSource;
    live.host.dispatchEvent(new Event('input', { bubbles: true }));
    scheduleSplitRender();
    return;
  }
  if (live.editor && live.view) {
    if (live.editor.action(getMarkdown()) === nextSource) {
      return;
    }
    applyContent(nextSource);
    // applyContent marks its own doc silent — the click was a USER edit,
    // so announce it here; the debounced markdownUpdated that follows is
    // the silent one and will not double-announce.
    live.host.dispatchEvent(new Event('input', { bubbles: true }));
    scheduleSplitRender();
  }
}

/** The split pane's re-render debounce — typing stays smooth, the pane settles a beat behind. */
const SPLIT_RENDER_DEBOUNCE_MS = 250;
let splitRenderTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedules the rendered pane's re-render (the markdownUpdated hook).
 *  Covers BOTH read panes: split while editing, and preview — the context
 *  menu and dictation stay live in preview mode, and their edits used to
 *  land invisibly under a frozen preview. */
function scheduleSplitRender(): void {
  if (viewMode !== 'split' && viewMode !== 'preview') {
    return;
  }
  if (splitRenderTimer !== null) {
    clearTimeout(splitRenderTimer);
  }
  splitRenderTimer = setTimeout(() => {
    splitRenderTimer = null;
    if (viewMode === 'split' || viewMode === 'preview') {
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
    // display resets it to the last working mode. The working modes
    // (edit/source/split) survive note switches, and a fresh mount
    // re-applies the current one (the wrapper starts unstyled).
    setMarkdownViewMode(viewMode === 'preview' ? lastWorkingMode : viewMode);
    host.scrollTop = 0;
  }

  capture(host: HTMLElement | null): string | null {
    if (!live || live.host !== host || !live.root.isConnected) {
      return null;
    }
    // The pane that owns the edit answers — the textarea while the
    // source/split view is live, the WYSIWYG otherwise.
    if (live.source && usesSourcePane(viewMode)) {
      return live.source.value;
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
    // asterisks that produce them. The render is cached by source: the
    // pill asks on every 500ms typing pause and statistics on every open
    // — re-rendering an unchanged document each time was pure cost (and
    // pathological documents make that cost seconds; see
    // MAX_NESTING_DEPTH in the renderer).
    const source = this.capture(host) ?? note.content;
    if (visibleTextCache && visibleTextCache.source === source) {
      return visibleTextCache.text;
    }
    const text = htmlToText(renderMarkdownToHtml(source)).replace(/\u00a0/g, ' ');
    const trimmed = text.trim() === '' ? '' : text;
    visibleTextCache = { source, text: trimmed };
    return trimmed;
  }

  commit(host: HTMLElement | null, content: string): boolean {
    if (host) {
      this.display(host, { content });
    }
    // The caller owns the persist — no port channel exists for this kind.
    return false;
  }

  insertText(host: HTMLElement | null, text: string): boolean {
    if (!live || live.host !== host || !live.root.isConnected) {
      return false;
    }
    if (live.source && usesSourcePane(viewMode)) {
      // The textarea's own edit path: native undo, input announce.
      const ta = live.source;
      applyEdit(ta, ta.selectionStart, ta.selectionEnd, text, ta.selectionStart + text.length);
      scheduleSplitRender();
      return true;
    }
    if (!live.view) {
      return false;
    }
    const { state } = live.view;
    const { from, to } = state.selection;
    // User-initiated: the next markdownUpdated must announce.
    live.silentDoc = null;
    live.view.dispatch(state.tr.insertText(text, from, to));
    return true;
  }

  focusTarget(host: HTMLElement): HTMLElement | null {
    if (!live || live.host !== host || !live.root.isConnected) {
      return null;
    }
    // The pane that owns the edit: the textarea in source/split, the
    // ProseMirror root otherwise. The host itself is contenteditable=false
    // and cannot take the caret — focusing it landed on <body>, so the first
    // keystrokes after a switch went nowhere until the user clicked.
    if (live.source && usesSourcePane(viewMode)) {
      return live.source;
    }
    return live.view ? live.view.dom : null;
  }

  /**
   * The shell's stand-down call: another surface is about to paint the
   * host, so everything this surface keeps alive goes NOW — the editor,
   * its history, and every widget it parked outside the host (the block
   * grip lives in document.body and would otherwise stay visible over
   * the NEXT note, frozen at its last hover position). Teardown used to
   * wait for the next markdown mount; a lazy cleanup meant an html or
   * rich note inherited the previous note's floating chrome.
   */
  dismiss(host: HTMLElement): void {
    // The floating chrome first: bubble + slash live in document.body
    // and their own close paths (mousedown outside, editor destroy) do
    // not cover a keyboard or still-mounting transition.
    hideMarkdownBubble();
    hideMarkdownSlash();
    if (live && (live.host === host || !live.root.isConnected)) {
      void teardown(live);
    }
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
    const source = buildSourcePane(host, content);
    const preview = document.createElement('div');
    preview.className = 'markdown-preview';
    preview.hidden = true;
    root.append(source, preview);
    host.append(root);

    live = {
      host,
      root,
      editor: null,
      view: null,
      pending: content,
      silentDoc: null,
      source,
      preview,
    };

    // Ctrl/Cmd+K opens the link popover — the shortcuts reference and the
    // bubble button both advertise it, but the document-level binding used
    // to win and pop the keyboard-shortcuts modal instead. Claimed here on
    // the surface root so BOTH panes (WYSIWYG and source textarea) get it.
    root.addEventListener('keydown', (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.code === 'KeyK'
      ) {
        event.preventDefault();
        event.stopPropagation();
        document.dispatchEvent(new CustomEvent('padify:open-link'));
      }
    });

    // Task checkboxes in the rendered panes are LIVE — the one GFM gesture
    // the preview owns. The renderer emits them disabled (a preview is a
    // reading surface), so the pointer-events trick hands the click to the
    // list item, and the toggle is written back into the SOURCE — the same
    // note the WYSIWYG and the textarea edit — then announced like any
    // other user edit (autosave, word count, the save pill all follow).
    preview.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const item = target.closest('li');
      if (!item || !item.querySelector(':scope > input[type="checkbox"]')) {
        return;
      }
      if (togglePreviewTask(item)) {
        event.preventDefault();
        renderLivePreview();
      }
    });

    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            class: 'padify-markdown',
            // The host's own spellcheck state (the Settings > Text
            // toggle writes it there); ON by default when unset.
            spellcheck: host.getAttribute('spellcheck') === 'false' ? 'false' : 'true',
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
          // Plain-text paste parity — see handleMarkdownPaste. A direct
          // prop runs ahead of the clipboard plugin's handlePaste.
          handlePaste: handleMarkdownPaste,
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
      .use(padifyParagraphSchema)
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
    if (usesSourcePane(viewMode)) {
      // The source pane is rebuilt wholesale: a fresh textarea carries a
      // fresh NATIVE undo stack, so undo can never resurrect the previous
      // note's words (the same doctrine the WYSIWYG's history reset holds).
      if (!live.source) {
        live.source = buildSourcePane(live.host, content);
        live.root.prepend(live.source);
      } else {
        rebuildSourcePane(content);
      }
    }
    if (!live.editor) {
      live.pending = content;
      return;
    }
    applyContent(content);
  }
}

/**
 * Builds the source pane (the raw-markdown textarea) wired for the
 * source/split modes. The textarea inherits #note's spellcheck state —
 * the Settings > Text toggle reaches it live, the one thing the
 * WYSIWYG root cannot do (it pins its own attribute at mount).
 */
function buildSourcePane(host: HTMLElement, content: string): HTMLTextAreaElement {
  const source = document.createElement('textarea');
  source.className = 'markdown-source';
  source.value = content;
  source.setAttribute('aria-label', 'Markdown source');
  source.placeholder =
    host.dataset.placeholder ??
    'Type your notes here and when you come back all your notes will be right here...';
  wireSourcePane(source);
  return source;
}

/**
 * Replaces the source pane with a fresh one carrying the content — the
 * reliable way to reset the textarea's native undo stack between notes.
 */
function rebuildSourcePane(content: string): void {
  if (!live) {
    return;
  }
  const fresh = buildSourcePane(live.host, content);
  if (live.source && live.source.parentElement === live.root) {
    live.source.replaceWith(fresh);
  } else {
    live.root.prepend(fresh);
  }
  live.source = fresh;
}

/** The source pane's keyboard grammar (GitHub's source editor). */
function wireSourcePane(source: HTMLTextAreaElement): void {
  // Every keystroke that can move the caret or change the selection
  // refreshes the toolbar's pressed states (the selectionUpdated parity).
  const notify = (): void => {
    if (markdownSourceTextarea() === source) {
      selectionListeners.forEach((fn) => fn(sourceSelectionState(source)));
    }
  };
  for (const type of ['keyup', 'mouseup', 'click', 'focus', 'input'] as const) {
    source.addEventListener(type, () => {
      notify();
      if (type === 'input') {
        scheduleSplitRender();
      }
    });
  }

  source.addEventListener('keydown', (event) => {
    // Ctrl/Cmd shortcuts — the WYSIWYG's own bindings, source-edition.
    if (event[isApplePlatform() ? 'metaKey' : 'ctrlKey'] && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        toggleWrap(source, '**');
        notify();
        return;
      }
      if (key === 'i') {
        event.preventDefault();
        toggleWrap(source, '*');
        notify();
        return;
      }
      if (key === 'e') {
        event.preventDefault();
        toggleWrap(source, '`');
        notify();
        return;
      }
      if (key === 'x' && event.shiftKey) {
        event.preventDefault();
        toggleWrap(source, '~~');
        notify();
        return;
      }
      return; // Ctrl+Z/Y and friends stay native.
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      indentLines(source, event.shiftKey ? -1 : 1);
      notify();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (continueListOnEnter(source)) {
        event.preventDefault();
        notify();
      }
    }
  });

  // The split preview follows the pane's scroll, proportionally.
  source.addEventListener('scroll', () => {
    if (viewMode === 'split' && live?.preview) {
      syncSplitScroll(source, live.preview);
    }
  });
}

/** One-way proportional scroll sync: the source pane leads, the preview follows. */
function syncSplitScroll(source: HTMLTextAreaElement, preview: HTMLElement): void {
  const sourceRange = source.scrollHeight - source.clientHeight;
  if (sourceRange <= 0) {
    return;
  }
  const previewRange = preview.scrollHeight - preview.clientHeight;
  preview.scrollTop = (source.scrollTop / sourceRange) * Math.max(0, previewRange);
}

/** Applies content to the live editor (the silent, non-announcing path). */
function applyContent(content: string): void {
  if (!live || !live.editor || !live.view) {
    return;
  }
  live.silentDoc = null;
  // The grip floats beside a block of the PREVIOUS note's doc; a
  // wholesale replace moves every block, so it hides instead of
  // opening frozen over this one.
  hideBlockHandle();
  live.editor.action(replaceAll(content));
  // The editor instance is shared across markdown notes (a switch re-applies
  // content instead of rebuilding): its undo stack belongs to the PREVIOUS
  // note, and an undo right after a switch would resurrect that note's
  // content into this one — then announce it as a user edit and AUTOSAVE
  // the corruption. A wholesale replace resets the history to empty, so
  // undo starts from whatever happens in THIS note.
  resetMarkdownHistory(live.view);
  placeCaretAtDocStart(live.view);
  live.silentDoc = live.view.state.doc ?? null;
  // The pressed states read the caret; a wholesale replace moves it (and
  // may not fire a selectionUpdated at all). Refresh so the toolbar shows
  // THIS note's state, not the previous note's last one.
  refreshMarkdownSelectionState();
}

/**
 * Puts the caret at the doc's first text position after a wholesale
 * replace. Left alone, ProseMirror maps the old caret through the replace
 * and lands it at the END of the inserted content — for a table-led note,
 * inside the LAST cell: opening the note and typing would type into the
 * table, and the toolbar's table menu would arm with the user nowhere
 * near it. The start is the deterministic contract (the html surface
 * scrolls its note to the top on display — same gesture).
 */
function placeCaretAtDocStart(view: EditorView): void {
  const { state } = view;
  const target = TextSelection.near(state.doc.resolve(0), 1);
  if (!target.eq(state.selection)) {
    view.dispatch(state.tr.setSelection(target));
  }
}

/**
 * Resets the shared editor's prosemirror-history state to empty — see
 * applyContent. The history plugin's apply checks its own meta FIRST and
 * replaces the state wholesale when present, which is exactly the lever
 * (a meta-only transaction: no doc change, no announce, no selection move).
 */
function resetMarkdownHistory(view: EditorView): void {
  // Plugin.key is runtime-assigned (not on the public type) — the string
  // is the stable handle the meta channel routes through.
  const plugin = view.state.plugins.find(
    (candidate) => (candidate as unknown as { key?: string }).key === 'history$',
  );
  if (!plugin) {
    return;
  }
  const tr = view.state.tr;
  tr.setMeta(plugin, { historyState: EMPTY_HISTORY_STATE });
  view.dispatch(tr);
}

/**
 * PLAIN-TEXT PASTE PARITY — the normal-editing contract.
 *
 * Milkdown's clipboard plugin parses EVERY plain-text clip as markdown, so
 * pasting code or prose from an editor/terminal/plain-text source mangled
 * it: `#` lines became headings, `- ` lines became lists, indentation and
 * lines were restructured. The characters the user pasted are CONTENT, not
 * syntax to interpret.
 *
 * This direct-prop handlePaste runs AHEAD of the clipboard plugin (direct
 * props first in prosemirror-view's someProp) and answers the cases:
 *
 *  - a clip carrying text/html (a rich copy: a web page, another padify
 *    markdown note — ProseMirror's copy path always writes the HTML
 *    flavor) → unhandled, the plugin's HTML→markdown path keeps working;
 *  - the caret inside a code block → unhandled, the native path inserts
 *    the text literally (a code block's whitespace is content);
 *  - an editor clip (VS Code's `vscode-editor-data` or Lexical's
 *    `l-editor-data`, both `text/plain` + `{ mode: language }`) → OWNED
 *    HERE as a code block carrying the clip's language. The plugin's
 *    dedicated code-block path only recognizes the Lexical flavor, so a
 *    VS Code clip left to it falls into the markdown parser and mangles
 *    code into paragraphs — and even the Lexical path it does run is
 *    geometry-broken (see insertCodeBlock: at a paragraph-end caret the
 *    block lands after the caret and the code types into the PARAGRAPH,
 *    leaving the block empty). When the clip's mode is 'plaintext' (or
 *    parses to nothing), the code is CONTENT, not syntax: literal
 *    insert, like any plain clip;
 *  - anything else that is plain text only → inserted LITERALLY: one line
 *    types in at the caret, multiple lines become paragraphs (the first
 *    and last merging with the host paragraph, like an Enter between
 *    them), all in one transaction — one undo step.
 */
function handleMarkdownPaste(view: EditorView, event: ClipboardEvent): boolean {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return false;
  }
  if (clipboardData.getData('text/html') !== '') {
    return false;
  }
  if (view.state.selection.$from.node().type.spec.code) {
    return false;
  }
  const text = clipboardData.getData('text/plain');
  if (!text) {
    return false;
  }
  // VS Code and Lexical write the same clip shape: a JSON `{ mode }` under
  // a private flavor plus the code as text/plain.
  const editorData =
    clipboardData.getData('vscode-editor-data') || clipboardData.getData('l-editor-data');
  if (editorData !== '') {
    const language = editorClipLanguage(editorData);
    // A language-less editor clip (mode 'plaintext', shell dumps, stray
    // copies) is plain prose/code-as-content — the literal path below;
    // a language clip is CODE — its own block, fenced with the language.
    if (!language) {
      insertPlainLines(view, text);
      return true;
    }
    insertCodeBlock(view, language, text);
    return true;
  }
  insertPlainLines(view, text);
  return true;
}

/** Reads an editor clip's language id ('plaintext' and garbage → null). */
function editorClipLanguage(editorData: string): string | null {
  try {
    const parsed: unknown = JSON.parse(editorData);
    const mode =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { mode?: unknown }).mode
        : undefined;
    return typeof mode === 'string' && mode !== '' && mode !== 'plaintext' ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Lands an editor clip (VS Code / Lexical) as a code block carrying its
 * language, the pasted text as the block's content, in one transaction —
 * one undo step.
 *
 * The block goes in as a FULLY CLOSED slice (openStart 0, openEnd 0):
 * replaceSelection then splits the caret's own block around it — a
 * mid-paragraph caret keeps its tail as a separate paragraph after the
 * block, a paragraph-end caret gets the block as a sibling — and maps
 * the caret to the insertion end. The alternative the clipboard plugin
 * itself uses (replaceSelectionWith an empty block, nudge the caret
 * "2 back", insertText) is geometry-broken: whenever the block lands
 * AFTER the caret (the paragraph-end case) the nudged caret falls back
 * into the paragraph — a valid text spot — so the code types into the
 * PARAGRAPH and the block stays empty. The closed slice sidesteps the
 * caret arithmetic entirely: the text rides in as the block's content.
 */
function insertCodeBlock(view: EditorView, language: string, text: string): void {
  const { state } = view;
  const blockType = state.schema.nodes.code_block;
  if (!blockType) {
    insertPlainLines(view, text);
    return;
  }
  const code = text.replace(/\r\n?/g, '\n');
  const block = blockType.create({ language }, code ? state.schema.text(code) : null);
  const tr = state.tr
    .replaceSelection(new Slice(Fragment.from(block), 0, 0))
    .scrollIntoView()
    .setMeta('paste', true)
    .setMeta('uiEvent', 'paste');
  view.dispatch(tr);
}

/** Inserts pasted plain text literally — one line, or paragraphs per line. */
function insertPlainLines(view: EditorView, raw: string): void {
  const { state } = view;
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const pasteMeta = (tr: Transaction): Transaction =>
    tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste');

  if (lines.length === 1) {
    view.dispatch(pasteMeta(state.tr.insertText(lines[0])));
    return;
  }

  // One paragraph per line, the empty lines included; openStart/openEnd 1
  // lets the first and last merge with the caret's own paragraph (the
  // shape PM's own plain-text path would produce).
  const paragraphType = state.schema.nodes.paragraph;
  const paragraphs = lines.map((line) =>
    paragraphType.create(null, line ? state.schema.text(line) : null),
  );
  const slice = new Slice(Fragment.from(paragraphs), 1, 1);
  view.dispatch(pasteMeta(state.tr.replaceSelection(slice)));
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

/**
 * Reads the caret's mark/block state for the toolbar's pressed states —
 * from an explicit doc + selection PAIR rather than a live view.
 *
 * The WHY of the pair: the selection listener fires from inside the
 * plugin-state apply, while `view.state` is still the PREVIOUS state —
 * reading the view there answers one transaction behind (a caret moved
 * into a table reported "not in table", and the stale read happened to
 * pass the old tests by coincidence). The listener hands over the NEW
 * selection, whose `$from.doc` IS the new doc — so the pair is exact.
 */
function selectionStateFromDoc(
  doc: ProseNode,
  selection: EditorView['state']['selection'],
  storedMarks?: EditorView['state']['storedMarks'],
): MarkdownSelectionState {
  const { from, to, empty } = selection;
  // Select-all answers an AllSelection whose $from sits at the doc level
  // (depth 0 — parent IS the doc). The pressed-state pass wants the block
  // the user is acting on: the first one. A plain CARET at a doc-level
  // position (pos 0 before an atom block like a table, or after one) is
  // NOT an acting-on-block state — it answers no block at all, so it must
  // not borrow the first block's (a doc-start caret beside a table used
  // to read as "in table").
  const $from =
    selection instanceof AllSelection && doc.childCount > 0
      ? doc.resolve(Math.min(1, doc.content.size))
      : selection.$from;

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
    const marks = storedMarks ?? $from.marks();
    marks.forEach((mark) => collected.add(mark.type.name));
    collectLink(marks);
  } else {
    doc.nodesBetween(from, to, (node) => {
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
  if (selection instanceof NodeSelection) {
    const name = selection.node.type.name;
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

/** The live-view convenience wrapper — the on-demand state readers. */
function selectionStateFrom(view: EditorView): MarkdownSelectionState {
  return selectionStateFromDoc(view.state.doc, view.state.selection, view.state.storedMarks);
}

/** Notifies the pressed-state listeners (called on selection changes). */
function notifySelection(selection: EditorView['state']['selection']): void {
  if (!live || selectionListeners.size === 0) {
    return;
  }
  // The event's selection carries the doc it belongs to (see
  // selectionStateFromDoc) — the view's state is one beat behind here.
  const state = selectionStateFromDoc(selection.$from.doc, selection);
  selectionListeners.forEach((fn) => fn(state));
}

/**
 * The caret/selection's state snapshot, on demand — the context menu's
 * markdown layer (and tests) ask synchronously instead of subscribing.
 */
export function markdownSelectionStateNow(): MarkdownSelectionState | null {
  const source = markdownSourceTextarea();
  if (source) {
    return sourceSelectionState(source);
  }
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
  const source = markdownSourceTextarea();
  if (source) {
    const state = sourceSelectionState(source);
    selectionListeners.forEach((fn) => fn(state));
    return;
  }
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
 * live pane (the textarea in source/split, the markdown document in
 * edit) so voice typing behaves exactly as it does on the html surface.
 */
export function markdownCharBeforeCaret(): string {
  const source = markdownSourceTextarea();
  if (source) {
    const { selectionStart, selectionEnd } = source;
    if (selectionStart !== selectionEnd || selectionStart === 0) {
      return '';
    }
    return source.value[selectionStart - 1] ?? '';
  }
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
