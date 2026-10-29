/**
 * The Markdown surface — the 'text' content kind's editing surface: the
 * note's SOURCE and its PREVIEW, one at a time, nothing else.
 *
 * WHAT THE USER SEES. The note's markdown text (stored byte-exact like
 * every 'text' note) edits in the SOURCE mode — a textarea with
 * GitHub-source-editor keyboard behavior (lists continue on Enter, Tab
 * indents, Ctrl+B/I/E wrap, Ctrl+Shift+X strikes; the primitives live in
 * source-edit.ts). The PREVIEW mode swaps to the owned renderer's output
 * full-width — the same pipeline share links and HTML export use, so
 * "preview" always means "the truth". Both panes stay mounted; the mode
 * is a visibility flip, so the textarea's value, selection and native
 * undo stack survive every round trip.
 *
 * WHY NO VISUAL EDITOR. The WYSIWYG layer (Milkdown over ProseMirror)
 * is gone: what-you-see was a THIRD grammar between the source and the
 * preview, and every divergence between the three was a bug the user
 * paid for. Source is the truth, preview is the truth rendered — the
 * editor is the textarea in between, and its keyboard grammar is
 * GitHub's own source mode.
 *
 * HOW IT OWNS THE HOST. The surface mounts a wrapper inside the #note
 * host and sets the host itself contenteditable=false — the textarea is
 * the editable. The html engine is parked for the duration
 * (ModelPort.setInert — see app.ts wiring) so its listeners never see
 * the markdown editor's events, and its getHtml() serves the parked html
 * model instead of absorbing this surface's markup. When an html note
 * opens again, the port's renderHtml repaints the host (which evicts
 * this wrapper); the next markdown display notices the detached root
 * and rebuilds.
 *
 * THE ANNOUNCE CONTRACT. Editing surfaces must speak the one input
 * signal the shell listens for: a bubbling `input` event on the host
 * (autosave, the word-count pill, the save indicator, typing effects all
 * follow it). The textarea's own input event bubbles to the host by the
 * DOM's own rules — the one path that mutates the note announces
 * itself for free. Task-checkbox toggles in the preview dispatch the
 * event by hand after rewriting the source (the click is a user edit
 * like any other).
 *
 * SECURITY (pinned by the torture suites): the markdown source is DATA
 * rendered through the owned renderer — its raw HTML meets the policy
 * (benign tags rebuilt sanitized, everything else escaped), its link and
 * image URLs meet the safe-href gate, and the preview's only live
 * gesture is the task checkbox. The stored source round-trips as text.
 */
import { htmlToText } from '../note-content';
import { renderMathIn } from '../math';
import { isApplePlatform } from '../../lib/platform';
import { registerNoteSurface, type NoteSurface, type SurfaceNote } from '../surface';
import type { MarkdownSelectionState } from './selection-state';
import { renderMarkdownToHtml } from './render';
import {
  applyEdit,
  continueListOnEnter,
  dedupeTypedMarkerOverContinuation,
  indentLines,
  sourceSelectionState,
  toggleWrap,
} from './source-edit';

/** What the toolbar's pressed-state pass wants to know about the caret. */
export type { MarkdownSelectionState } from './selection-state';

/** One mounted surface: the host, the wrapper, and the two panes. */
interface LiveMarkdown {
  host: HTMLElement;
  /** The wrapper this surface owns inside the host. */
  root: HTMLElement;
  /** The source pane — the textarea the note edits through. */
  source: HTMLTextAreaElement;
  /** The preview pane (the owned renderer's output), rendered on demand. */
  preview: HTMLElement;
  /** The scroll fraction the last preview↔source flip carried across. */
  scrollFraction: number;
}

let live: LiveMarkdown | null = null;

/**
 * One-entry render cache for visibleText: the last (source, text) pair.
 * Pill/statistics asks for the SAME unchanged document on every typing
 * pause and modal open — the cached answer skips a whole render pass.
 */
let visibleTextCache: { source: string; text: string } | null = null;

/**
 * The surface's two modes: 'source' (the textarea, the working mode) and
 * 'preview' (the renderer's output — a reading gesture; every new note
 * display comes back to the source).
 */
export type MarkdownViewMode = 'source' | 'preview';
let viewMode: MarkdownViewMode = 'source';

/** True while the source textarea owns the editing. */
export function markdownSourceActive(): boolean {
  return !!live && live.root.isConnected && viewMode === 'source';
}

/** The live source textarea (the toolbar/context-menu seam); null when absent. */
export function markdownSourceTextarea(): HTMLTextAreaElement | null {
  return live && live.root.isConnected ? live.source : null;
}

const selectionListeners = new Set<(state: MarkdownSelectionState) => void>();
const viewModeListeners = new Set<(mode: MarkdownViewMode) => void>();

/** The live surface's host — null when no markdown surface is mounted. */
export function markdownHost(): HTMLElement | null {
  return live?.root.isConnected ? live.host : null;
}

/**
 * Puts the caret in the pane that owns the surface — the toolbar's view
 * buttons call this right after a flip (a click parks focus on the
 * button; without handing it back, the next Space would activate the
 * ARIA toolbar instead of typing). Preview parks it nowhere: a reading
 * surface holds no caret.
 */
export function focusMarkdownPane(): void {
  if (live && live.root.isConnected && viewMode === 'source') {
    live.source.focus();
  }
}

/** Registers for caret-driven pressed-state updates; returns unlisten. */
export function onMarkdownSelection(fn: (state: MarkdownSelectionState) => void): () => void {
  selectionListeners.add(fn);
  return () => selectionListeners.delete(fn);
}

/** Registers for view-mode flips (the segmented control); returns unlisten. */
export function onMarkdownViewMode(fn: (mode: MarkdownViewMode) => void): () => void {
  viewModeListeners.add(fn);
  return () => viewModeListeners.delete(fn);
}

/**
 * Flips the view mode (source / preview). Entering the preview renders
 * it from the LIVE markdown and carries the caret's scroll position
 * across proportionally; coming back to the source restores it, so a
 * toggle round trip lands where the reader was looking.
 */
export function setMarkdownViewMode(mode: MarkdownViewMode): void {
  const previous = viewMode;
  viewMode = mode;
  if (live && live.root.isConnected && mode !== previous) {
    if (mode === 'preview') {
      live.scrollFraction = sourceScrollFraction(live.source);
      renderLivePreview();
    } else {
      restoreSourceScroll(live.source, live.scrollFraction);
    }
  }
  if (live) {
    live.root.classList.toggle('markdown-preview-mode', mode === 'preview');
    live.source.hidden = mode === 'preview';
    live.preview.hidden = mode !== 'preview';
  }
  viewModeListeners.forEach((fn) => fn(mode));
}

/** The current view mode (the toolbar's segmented control reads it). */
export function markdownViewMode(): MarkdownViewMode {
  return viewMode;
}

/** The scroll fraction of the source pane (0 at top, 1 at bottom). */
function sourceScrollFraction(source: HTMLTextAreaElement): number {
  const range = source.scrollHeight - source.clientHeight;
  return range > 0 ? source.scrollTop / range : 0;
}

/** Scrolls the source pane to a fraction of its range. */
function restoreSourceScroll(source: HTMLTextAreaElement, fraction: number): void {
  const range = source.scrollHeight - source.clientHeight;
  if (range > 0) {
    source.scrollTop = fraction * range;
  }
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
    // The textarea is the editable; the host itself must not be one
    // (nested editables scramble the caret).
    host.setAttribute('contenteditable', 'false');
    const content = note?.content ?? '';

    if (live && live.root.isConnected && live.host === host) {
      this.apply(content);
    } else {
      this.mount(host, content);
    }
    // The caret takes the deterministic start spot on every display —
    // the same contract the rich surface holds across switches. A fresh
    // textarea otherwise parks at its value's END (and the end of a
    // table-led note is INSIDE the last row); the doc's first position is
    // where typing prepends and touches nothing structural.
    live?.source.setSelectionRange(0, 0);
    // Preview is a reading gesture, not a per-note setting — every
    // display comes back to the source (the working mode).
    if (viewMode === 'preview') {
      setMarkdownViewMode('source');
    }
    host.scrollTop = 0;
  }

  capture(host: HTMLElement | null): string | null {
    if (!live || live.host !== host || !live.root.isConnected) {
      return null;
    }
    return live.source.value;
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
    // The textarea's own edit path: native undo, input announce.
    const ta = live.source;
    applyEdit(ta, ta.selectionStart, ta.selectionEnd, text, ta.selectionStart + text.length);
    schedulePreviewRender();
    return true;
  }

  focusTarget(host: HTMLElement): HTMLElement | null {
    if (!live || live.host !== host || !live.root.isConnected) {
      return null;
    }
    // The pane that owns the surface: the textarea in source mode; the
    // preview holds no caret. The host itself is contenteditable=false
    // and cannot take the caret — focusing it landed on <body>, so the
    // first keystrokes after a switch went nowhere until the user clicked.
    return viewMode === 'source' ? live.source : null;
  }

  /**
   * The shell's stand-down call: another surface is about to paint the
   * host, so everything this surface keeps alive goes NOW — the pending
   * preview render above all (its timer would otherwise fire at a
   * detached pane, or worse, at the NEXT note's).
   */
  dismiss(host: HTMLElement): void {
    if (live && (live.host === host || !live.root.isConnected)) {
      teardown(live);
    }
  }

  clear(host: HTMLElement): void {
    // An empty markdown note is an empty markdown EDITOR — the surface
    // stays mounted (the manager writes the model and persists itself).
    this.display(host, { content: '' });
  }

  // ---- mounting -----------------------------------------------------------

  private mount(host: HTMLElement, content: string): void {
    if (live) {
      teardown(live);
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
      source,
      preview,
      scrollFraction: 0,
    };

    // Ctrl/Cmd+K opens the link popover — the shortcuts reference and
    // the bubble button both advertise it, but the document-level binding
    // used to win and pop the keyboard-shortcuts modal instead. Claimed
    // here on the surface root so the textarea gets it.
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

    // Task checkboxes in the preview are LIVE — the one GFM gesture the
    // preview owns. The renderer emits them disabled (a preview is a
    // reading surface), so the pointer-events trick hands the click to
    // the list item, and the toggle is written back into the SOURCE —
    // then announced like any other user edit (autosave, word count, the
    // save pill all follow).
    preview.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const item = target.closest('li');
      if (item && item.querySelector(':scope > input[type="checkbox"]')) {
        if (togglePreviewTask(item)) {
          event.preventDefault();
          renderLivePreview();
        }
        return;
      }
      // A rendered equation opens the math bubble with its source — the
      // preview's editing affordance for `$$…$$` and `$…$` alike.
      const math = target.closest('.padify-math');
      if (math instanceof HTMLElement) {
        const latex = math.getAttribute('data-latex') ?? '';
        const kind = math.closest('.md-math-block') ? 'block' : 'inline';
        document.dispatchEvent(
          new CustomEvent('padify:md-math-click', { detail: { latex, kind } }),
        );
      }
    });
  }

  private apply(content: string): void {
    if (!live) {
      return;
    }
    // A fresh pane per wholesale content change: a fresh textarea carries
    // a fresh NATIVE undo stack, so undo can never resurrect the previous
    // note's words (the same doctrine the html surface's history reset
    // holds).
    rebuildSourcePane(content);
  }
}

/**
 * Builds the source pane (the raw-markdown textarea) — the note's editor.
 * The textarea inherits #note's spellcheck state — the Settings > Text
 * toggle reaches it live (the toggle rewrites the attribute; CSS and the
 * browser's own red squiggles follow).
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
  if (live.source.parentElement === live.root) {
    live.source.replaceWith(fresh);
  } else {
    live.root.prepend(fresh);
  }
  live.source = fresh;
}

/** The source pane's keyboard grammar (GitHub's source editor). */
function wireSourcePane(source: HTMLTextAreaElement): void {
  // Every keystroke that can move the caret or change the selection
  // refreshes the toolbar's pressed states.
  const notify = (): void => {
    if (markdownSourceTextarea() === source) {
      selectionListeners.forEach((fn) => fn(sourceSelectionState(source)));
    }
  };
  for (const type of ['keyup', 'mouseup', 'click', 'focus', 'input'] as const) {
    source.addEventListener(type, () => {
      notify();
      if (type === 'input') {
        // The preview stays live for the edits that arrive while it is
        // showing (dictation, the context menu, task toggles) — direct
        // typing cannot reach it, but the debounce costs nothing.
        schedulePreviewRender();
      }
    });
  }

  // The continuation dedupe's IME/mobile path — beforeinput carries the
  // composed text keydown never sees (the keydown hook below covers the
  // physical-key path; the one-shot slot makes the pair idempotent).
  source.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'insertText') {
      dedupeTypedMarkerOverContinuation(source, event.data);
    }
  });

  source.addEventListener('keydown', (event) => {
    // The user's own typed marker right after a continuation replaces the
    // auto one (typing stays literal); the native insert then follows.
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      dedupeTypedMarkerOverContinuation(source, event.key);
      return;
    }
    // Ctrl/Cmd shortcuts — GitHub's source-editor set.
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
}

/** Renders the preview pane from the live markdown. */
function renderLivePreview(): void {
  if (!live) {
    return;
  }
  live.preview.innerHTML = renderMarkdownToHtml(live.source.value);
  renderMathIn(live.preview);
}

/**
 * The preview's re-render debounce — for the edits that land while the
 * preview is showing (dictation, the context menu, checkbox toggles);
 * a beat behind, exactly as the split pane's always was.
 */
const PREVIEW_RENDER_DEBOUNCE_MS = 250;
let previewRenderTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePreviewRender(): void {
  if (viewMode !== 'preview' || !live) {
    return;
  }
  if (previewRenderTimer !== null) {
    clearTimeout(previewRenderTimer);
  }
  previewRenderTimer = setTimeout(() => {
    previewRenderTimer = null;
    if (viewMode === 'preview' && live) {
      renderLivePreview();
    }
  }, PREVIEW_RENDER_DEBOUNCE_MS);
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
  const source = live.source.value;
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
 * Writes a toggled source back into the textarea and announces the edit —
 * the click was a USER gesture, and autosave, the word count and the save
 * indicator follow exactly as if the user had typed it.
 */
function applyToggledSource(nextSource: string): void {
  if (!live || live.source.value === nextSource) {
    return;
  }
  live.source.value = nextSource;
  live.host.dispatchEvent(new Event('input', { bubbles: true }));
  schedulePreviewRender();
}

/** Tears a surface down (a superseded mount or the shell's stand-down). */
function teardown(target: LiveMarkdown): void {
  if (live === target) {
    live = null;
  }
  if (previewRenderTimer !== null) {
    clearTimeout(previewRenderTimer);
    previewRenderTimer = null;
  }
}

/**
 * The caret/selection's state snapshot, on demand — the context menu's
 * markdown layer (and tests) ask synchronously instead of subscribing.
 */
export function markdownSelectionStateNow(): MarkdownSelectionState | null {
  const source = markdownSourceTextarea();
  return source ? sourceSelectionState(source) : null;
}

/**
 * Recomputes and re-notifies the pressed-state listeners — the toolbar
 * calls this after every command it dispatches: a toggle does not move
 * the selection, so the selectionUpdated signal alone would leave the
 * buttons a beat behind the document.
 */
export function refreshMarkdownSelectionState(): void {
  const source = markdownSourceTextarea();
  if (!source) {
    return;
  }
  const state = sourceSelectionState(source);
  selectionListeners.forEach((fn) => fn(state));
}

/**
 * The single character before the caret ('' at the note's start) — the
 * dictation pass's smart spacing/capitalisation input, answered from the
 * live textarea.
 */
export function markdownCharBeforeCaret(): string {
  const source = markdownSourceTextarea();
  if (!source) {
    return '';
  }
  const { selectionStart, selectionEnd } = source;
  if (selectionStart !== selectionEnd || selectionStart === 0) {
    return '';
  }
  return source.value[selectionStart - 1] ?? '';
}

// The registry entry — the seam everything already routes through.
registerNoteSurface('text', new MarkdownNoteSurface());
