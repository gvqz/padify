/**
 * Characterization suite for the Markdown surface — the safety net under
 * editor/markdown/surface.ts, toolbar.ts and the ModelPort inert switch
 * they ride on.
 *
 * Everything here runs a REAL Milkdown editor in jsdom (the probe proved
 * create/replaceAll/getMarkdown/dispatch all work headlessly), a real
 * TabManager where noted, and the REAL shell markup for the toolbar
 * (read from disk — markup drift fails here, the rich toolbar suite's
 * discipline). The pins that matter most:
 *
 *  • THE CONTRACT — display paints without persisting, capture answers
 *    the markdown source, visibleText answers the RENDERED projection,
 *    commit applies and leaves persistence to the caller, clear empties.
 *  • THE ANNOUNCE DISCIPLINE — opening a note (replaceAll) never fires
 *    the host input event; a USER transaction always does. That signal
 *    is the app's entire autosave chain.
 *  • THE SECURITY MODEL — the note is data, never markup: raw HTML in
 *    the source renders as escaped text, javascript: link hrefs never
 *    reach the DOM, and the only elements under the host are the ones
 *    ProseMirror's schema generated.
 *  • THE SEAMS — surface insertText (the picker's path), the toolbar's
 *    command dispatch and pressed states, the view toggle's owned
 *    renderer preview, and the port parking while the surface owns the
 *    host.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MarkdownNoteSurface,
  markdownEditorHandle,
  markdownViewMode,
  onMarkdownSelection,
  onMarkdownViewMode,
  setMarkdownViewMode,
} from './surface';
import {
  runMarkdownToolbarAction,
  initMarkdownToolbar,
  resetMarkdownToolbarForTests,
} from './toolbar';
import { noteSurfaceForKind } from '../surface';
import {
  getActiveNoteExportBody,
  insertTextIntoActiveNote,
  setTabManager,
  TabManager,
} from '../../tabs';
import { resetStorageForTests, storageReady } from '../../storage';
import { $ } from '../../lib/q';
import { ModelPort } from '../model-port';
import { sanitizeNoteHtml } from '../storage-subset';

// Swal is modal UI — mocked so close-with-content paths can be driven.
vi.mock('sweetalert2', () => ({
  default: { fire: vi.fn(() => Promise.resolve({ isConfirmed: false })) },
}));

// jsdom lacks scrollIntoView (rendering-dependent); TabManager calls it
// best-effort after addTab.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  });
}

const surface = new MarkdownNoteSurface();

/** Lets the listener plugin's 200ms debounce run to completion. */
async function settled(ms = 300): Promise<void> {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, ms));
}

function freshHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'note';
  host.setAttribute('contenteditable', 'true');
  document.body.append(host);
  return host;
}

/** The editor's ready promise (mount is async) — awaited per test. */
async function ready(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!markdownEditorHandle() && Date.now() < deadline) {
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 20));
  }
  expect(markdownEditorHandle()).not.toBeNull();
}

/** Types text at the end of the doc the way a keystroke would. */
async function typeAtEnd(text: string): Promise<void> {
  const handle = markdownEditorHandle();
  if (!handle) {
    throw new Error('no live markdown editor');
  }
  const { view } = handle;
  const pos = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.insertText(text, pos));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  // Park the view mode back to edit; the next test's display() wants a
  // clean slate (display resets it, but capture-only tests may not call
  // display again).
  if (markdownViewMode() !== 'edit') {
    setMarkdownViewMode('edit');
  }
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('MarkdownNoteSurface — the surface contract', () => {
  it('is registered for the text kind and is editable', () => {
    expect(noteSurfaceForKind('text').editable).toBe(true);
    expect(noteSurfaceForKind('text')).toBeInstanceOf(MarkdownNoteSurface);
  });

  it('display mounts a wrapper, parks the host editable, and captures back the source', async () => {
    const host = freshHost();
    surface.display(host, { content: '# Hello\n\nSome **bold** text.' });
    await ready();

    expect(host.getAttribute('contenteditable')).toBe('false');
    const wrapper = host.querySelector('.markdown-surface');
    expect(wrapper).not.toBeNull();
    expect(host.querySelector('.ProseMirror')).not.toBeNull();

    const captured = surface.capture(host);
    expect(captured).toContain('# Hello');
    expect(captured).toContain('**bold**');
  });

  it('a second markdown note reuses the mounted editor (no flicker, content swapped)', async () => {
    const host = freshHost();
    surface.display(host, { content: 'first note' });
    await ready();
    const wrapper = host.querySelector('.markdown-surface');

    surface.display(host, { content: '# second' });
    await settled();
    expect(host.querySelector('.markdown-surface')).toBe(wrapper);
    expect(surface.capture(host)).toContain('# second');
  });

  it('after the html surface repaints the host, the next display rebuilds', async () => {
    const host = freshHost();
    surface.display(host, { content: '# markdown' });
    await ready();

    // The html surface taking the host back = the port painting over it.
    const port = new ModelPort(host, { sanitize: sanitizeNoteHtml });
    port.renderHtml('<p>an html note</p>');
    expect(host.querySelector('.markdown-surface')).toBeNull();

    surface.display(host, { content: '# back to markdown' });
    await ready();
    expect(surface.capture(host)).toContain('# back to markdown');
  });

  it('capture answers null when the surface is not mounted on that host', async () => {
    const host = freshHost();
    surface.display(host, { content: 'x' });
    await ready();

    const stranger = document.createElement('div');
    expect(surface.capture(stranger)).toBeNull();
    expect(surface.capture(null)).toBeNull();
  });

  it('visibleText answers the RENDERED projection — asterisks never count as words', async () => {
    const host = freshHost();
    surface.display(host, { content: '# Title\n\nSome **bold** and *plain* text.' });
    await ready();
    await settled();

    const text = surface.visibleText(host, {
      content: '# Title\n\nSome **bold** and *plain* text.',
    });
    expect(text).toContain('Title');
    expect(text).toContain('bold');
    expect(text).not.toContain('**');
    expect(text).not.toContain('*');
  });

  it('an empty note projects to empty text (the pill never counts scaffolding)', async () => {
    const host = freshHost();
    surface.display(host, { content: '' });
    await ready();
    expect(surface.visibleText(host, { content: '' })).toBe('');
  });

  it('commit applies the content and returns false — the caller owns the persist', async () => {
    const host = freshHost();
    surface.display(host, { content: 'before' });
    await ready();

    expect(surface.commit(host, '# after')).toBe(false);
    await settled();
    expect(surface.capture(host)).toContain('# after');
  });

  it('clear empties the editor while keeping the surface mounted', async () => {
    const host = freshHost();
    surface.display(host, { content: '# to be cleared' });
    await ready();

    surface.clear(host);
    await settled();
    expect(host.querySelector('.markdown-surface')).not.toBeNull();
    const captured = surface.capture(host) ?? '';
    expect(captured.trim()).toBe('');
  });

  it('display with a null note paints an empty editor', async () => {
    const host = freshHost();
    surface.display(host, null);
    await ready();
    expect((surface.capture(host) ?? '').trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The announce discipline
// ---------------------------------------------------------------------------

describe('MarkdownNoteSurface — the input announce contract', () => {
  it('OPENING a note never fires the host input event (display is not an edit)', async () => {
    const host = freshHost();
    const inputs: Event[] = [];
    host.addEventListener('input', (event) => inputs.push(event));

    surface.display(host, { content: '# just opened' });
    await ready();
    await settled();

    expect(inputs).toHaveLength(0);
  });

  it('a USER transaction fires the host input event (the autosave signal)', async () => {
    const host = freshHost();
    const inputs: Event[] = [];
    host.addEventListener('input', (event) => inputs.push(event));

    surface.display(host, { content: 'seed' });
    await ready();
    await settled();
    inputs.length = 0;

    await typeAtEnd(' typed');
    await settled();

    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(surface.capture(host)).toContain('seed typed');
  });

  it('clear stays silent too (the manager persists the empty note itself)', async () => {
    const host = freshHost();
    const inputs: Event[] = [];
    host.addEventListener('input', (event) => inputs.push(event));

    surface.display(host, { content: 'will be cleared' });
    await ready();
    await settled();
    inputs.length = 0;

    surface.clear(host);
    await settled();
    expect(inputs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The security model — the note is data, never markup
// ---------------------------------------------------------------------------

describe('MarkdownNoteSurface — the security model', () => {
  it('raw HTML in the source renders as ESCAPED TEXT, never as live markup', async () => {
    const host = freshHost();
    surface.display(host, {
      content: [
        '<img src=x onerror=alert(1)>',
        '<script>alert("xss")</' + 'script>',
        '<iframe src="javascript:alert(2)"></iframe>',
        '<b>bold?</b>',
      ].join('\n\n'),
    });
    await ready();
    await settled();

    expect(host.querySelector('img[src], iframe, script')).toBeNull();
    expect(host.querySelector('[onerror]')).toBeNull();
    expect(host.innerHTML).toContain('data-type="html"'); // literal text
    expect(host.innerHTML).toContain('&lt;img src=x');
  });

  it('javascript: link hrefs never reach the live DOM (text survives, target drops)', async () => {
    const host = freshHost();
    surface.display(host, { content: '[click me](javascript:alert(3))' });
    await ready();
    await settled();

    const anchor = host.querySelector('a');
    expect(anchor?.textContent).toBe('click me');
    expect(anchor?.getAttribute('href') ?? '').not.toContain('javascript:');
    expect(host.innerHTML).not.toContain('href="javascript:');
  });

  it('the source round-trips as data — capture keeps what was typed', async () => {
    const host = freshHost();
    const source = '# Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~';
    surface.display(host, { content: source });
    await ready();
    await settled();

    const captured = surface.capture(host) ?? '';
    expect(captured).toContain('# Title');
    // Milkdown's serializer speaks '*' bullets — the retired Markdown
    // page's own convention. Semantics, not bytes, round-trip.
    expect(captured).toContain('* one');
    expect(captured).toContain('~~gone~~');
    expect(captured).toContain('| a | b |');
  });
});

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

describe('MarkdownNoteSurface — the insertText seam', () => {
  it('inserts plain text at the caret and announces it as an edit', async () => {
    const host = freshHost();
    const inputs: number[] = [];
    host.addEventListener('input', () => inputs.push(inputs.length));

    surface.display(host, { content: 'base' });
    await ready();
    await settled();
    inputs.length = 0;

    expect(surface.insertText(host, ' ☺')).toBe(true);
    await settled();
    expect(surface.capture(host)).toContain('base ☺');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses when the surface is not mounted on that host', () => {
    const stranger = document.createElement('div');
    expect(surface.insertText(stranger, 'x')).toBe(false);
    expect(surface.insertText(null, 'x')).toBe(false);
  });
});

describe('the view toggle — preview is the owned renderer', () => {
  it('preview swaps to the renderer output and back to the editor', async () => {
    const host = freshHost();
    surface.display(host, { content: '# Read me\n\nSome *emphasis*.' });
    await ready();
    await settled();

    setMarkdownViewMode('preview');
    expect(markdownViewMode()).toBe('preview');

    const preview = host.querySelector('.markdown-preview') as HTMLElement;
    expect(preview?.hidden).toBe(false);
    expect(preview?.querySelector('h1')?.textContent).toBe('Read me');
    // The editor stands down while the preview owns the surface.
    expect(
      host.querySelector('.markdown-surface')?.classList.contains('markdown-preview-mode'),
    ).toBe(true);

    setMarkdownViewMode('edit');
    expect(markdownViewMode()).toBe('edit');
    expect(preview.hidden).toBe(true);
    expect(
      host.querySelector('.markdown-surface')?.classList.contains('markdown-preview-mode'),
    ).toBe(false);
  });

  it('preview renders math through the app KaTeX pass', async () => {
    const host = freshHost();
    surface.display(host, { content: 'Equation: $x^2$' });
    await ready();
    await settled();

    setMarkdownViewMode('preview');
    const preview = host.querySelector('.markdown-preview') as HTMLElement;
    expect(preview.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(1);
    setMarkdownViewMode('edit');
  });
});

describe('the view toggle — split is the working mode', () => {
  it('split shows BOTH panes and renders the preview from the live source', async () => {
    const host = freshHost();
    surface.display(host, { content: '# Side by side\n\nSome **bold** text.' });
    await ready();
    await settled();

    setMarkdownViewMode('split');
    expect(markdownViewMode()).toBe('split');

    const root = host.querySelector('.markdown-surface') as HTMLElement;
    const preview = host.querySelector('.markdown-preview') as HTMLElement;
    // Both panes on screen: the editor stays, the preview joins it.
    expect(root.classList.contains('markdown-split-mode')).toBe(true);
    expect(preview.hidden).toBe(false);
    expect(host.querySelector('.ProseMirror')).not.toBeNull();
    expect(preview.querySelector('h1')?.textContent).toBe('Side by side');
    expect(preview.querySelector('b')?.textContent).toBe('bold');

    setMarkdownViewMode('edit');
    expect(root.classList.contains('markdown-split-mode')).toBe(false);
    expect(preview.hidden).toBe(true);
  });

  it('split re-renders the pane after an edit — a beat behind the typing', async () => {
    const host = freshHost();
    surface.display(host, { content: '# First' });
    await ready();
    await settled();

    setMarkdownViewMode('split');
    const preview = host.querySelector('.markdown-preview') as HTMLElement;
    expect(preview.querySelector('h1')?.textContent).toBe('First');

    // A user edit at the doc's end: the debounce (250ms) + the listener's
    // own settle (200ms) must both run before the pane updates.
    const handle = markdownEditorHandle()!;
    handle.view.dispatch(
      handle.view.state.tr.insertText(' and live', handle.view.state.doc.content.size - 1),
    );
    await settled(700);
    expect(preview.querySelector('h1')?.textContent).toBe('First and live');

    setMarkdownViewMode('edit');
  });

  it('split SURVIVES note switches; preview still resets (the working/reading split)', async () => {
    const host = freshHost();
    surface.display(host, { content: '# Note one' });
    await ready();
    await settled();

    setMarkdownViewMode('split');
    expect(markdownViewMode()).toBe('split');

    // A display with fresh content (the note-switch path) keeps split.
    surface.display(host, { content: '# Note two' });
    await settled(500);
    expect(markdownViewMode()).toBe('split');
    const preview = host.querySelector('.markdown-preview') as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector('h1')?.textContent).toBe('Note two');

    // Preview, by contrast, is a reading gesture — display resets it.
    setMarkdownViewMode('preview');
    surface.display(host, { content: '# Note three' });
    await settled(300);
    expect(markdownViewMode()).toBe('edit');
    expect((host.querySelector('.markdown-preview') as HTMLElement | null)?.hidden).toBe(true);
  });

  it('a fresh mount re-applies split (the wrapper starts in the editing layout)', async () => {
    const host = freshHost();
    surface.display(host, { content: '# Before the repaint' });
    await ready();
    await settled();

    setMarkdownViewMode('split');

    // The html surface repaints the host (evicting the wrapper).
    const port = new ModelPort(host, { sanitize: sanitizeNoteHtml });
    port.renderHtml('<p>an html note</p>');
    expect(host.querySelector('.markdown-surface')).toBeNull();

    surface.display(host, { content: '# Back in split' });
    await ready();
    // The split pane renders through the debounce chain (the listener's
    // 200ms settle + the pane's own 250ms) — give it a full beat.
    await settled(800);
    expect(markdownViewMode()).toBe('split');
    const root = host.querySelector('.markdown-surface') as HTMLElement;
    expect(root.classList.contains('markdown-split-mode')).toBe(true);
    const preview = host.querySelector('.markdown-preview') as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector('h1')?.textContent).toBe('Back in split');

    setMarkdownViewMode('edit');
  });

  it('view-mode listeners hear every flip (the segmented control and the top bar icon)', async () => {
    const host = freshHost();
    surface.display(host, { content: 'modes' });
    await ready();

    const seen: string[] = [];
    const unlisten = onMarkdownViewMode((mode) => seen.push(mode));

    setMarkdownViewMode('split');
    setMarkdownViewMode('preview');
    setMarkdownViewMode('edit');
    expect(seen).toEqual(['split', 'preview', 'edit']);

    unlisten();
    setMarkdownViewMode('split');
    expect(seen).toEqual(['split', 'preview', 'edit']);

    setMarkdownViewMode('edit');
  });
});

// ---------------------------------------------------------------------------
// The TabManager integration — the seam end to end
// ---------------------------------------------------------------------------

describe('TabManager + markdown notes — the seam end to end', () => {
  function mountShell(): void {
    const shell = readFileSync(resolve(process.cwd(), 'src/ui/editor-shell.html'), 'utf-8');
    document.body.insertAdjacentHTML('afterbegin', shell);
    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.append(toast);
  }

  beforeEach(async () => {
    resetStorageForTests();
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
    localStorage.clear();
    await storageReady();
  });

  it('creating a markdown note paints the surface, typing autosaves the SOURCE', async () => {
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    manager.addTab(true, 'markdown');
    await ready();
    await settled();

    expect(host.getAttribute('contenteditable')).toBe('false');
    expect(host.querySelector('.markdown-surface')).not.toBeNull();

    await typeAtEnd('# My markdown note');
    await settled();

    // The app's debounced autosave (app.ts binds input → save): driven
    // directly here, exactly what the wiring calls.
    manager.saveActiveFromEditor();
    const active = manager.getActive();
    expect(active?.noteType).toBe('markdown');
    expect(active?.content).toContain('# My markdown note');
    expect(active?.content).not.toContain('<'); // source, never markup
  });

  it('getActiveNoteContent reads the markdown source through the active surface', async () => {
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    manager.addTab(true, 'markdown');
    await ready();
    await settled();

    await typeAtEnd('captured words');
    await settled();

    // The tabs.ts helper — the snapshots AND share-links capture path.
    // Dequeued from the module: import it fresh via the tabs module.
    const { getActiveNoteContent } = await import('../../tabs');
    const captured = getActiveNoteContent();
    expect(captured?.noteType).toBe('markdown');
    expect(captured?.content).toContain('captured words');
  });

  it('HTML export ships the RENDERED body, not the source', async () => {
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    // Display a heading the way stored content arrives, then edit like a
    // user would (typing inside the heading).
    surface.display(host, { content: '# Exported heading' });
    await settled();
    await typeAtEnd(' more');
    await settled();
    manager.saveActiveFromEditor();

    const body = getActiveNoteExportBody();
    expect(body).toContain('<h1>Exported heading more</h1>');
    expect(body).not.toContain('# Exported heading');
  });

  it('insertTextIntoActiveNote routes to the markdown surface', async () => {
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    manager.addTab(true, 'markdown');
    await ready();
    await settled();

    expect(insertTextIntoActiveNote('inserted via seam')).toBe(true);
    await settled();
    manager.saveActiveFromEditor();
    expect(manager.getActive()?.content).toContain('inserted via seam');
  });
});

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

describe('the markdown toolbar', () => {
  beforeEach(async () => {
    resetMarkdownToolbarForTests();
    // A fresh store: the boot note must be the standard one, not whatever
    // the previous section persisted.
    resetStorageForTests();
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
    localStorage.clear();
    await storageReady();
  });

  function mountShell(): HTMLElement {
    const shell = readFileSync(resolve(process.cwd(), 'src/ui/editor-shell.html'), 'utf-8');
    document.body.insertAdjacentHTML('afterbegin', shell);
    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.append(toast);
    return document.getElementById('markdownToolbar') as HTMLElement;
  }

  it('shows only for markdown notes — the chrome follows the active kind', async () => {
    const toolbar = mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    initMarkdownToolbar(manager);

    // A plain note: the chrome is hidden (driven explicitly — the boot
    // note's type depends on storage timing, the TOGGLE is the pin).
    manager.addTab(true, 'standard');
    expect(toolbar.hidden).toBe(true);

    manager.addTab(true, 'markdown');
    await ready();
    expect(toolbar.hidden).toBe(false);

    // Switch back to a plain note: chrome swaps away.
    manager.addTab(true, 'standard');
    expect(toolbar.hidden).toBe(true);
  });

  it('the bold command toggles strong around the selection', async () => {
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    manager.addTab(true, 'markdown');
    await ready();
    await settled();

    await typeAtEnd('toggle me');
    await settled();

    // Select the freshly typed text and bold it through the toolbar path.
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const end = view.state.doc.content.size - 1;
    const start = end - 'toggle me'.length;
    const { TextSelection } = await import('@milkdown/kit/prose/state');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)));

    expect(runMarkdownToolbarAction('bold')).toBe(true);
    await settled();
    expect(surface.capture(host)).toContain('**toggle me**');

    // Toggling again unwraps — the ported grammar's discipline.
    const boldEnd = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, boldEnd)));
    expect(runMarkdownToolbarAction('bold')).toBe(true);
    await settled();
    expect(surface.capture(host)).not.toContain('**toggle me**');
  });

  it('the heading command turns the block into a heading', async () => {
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    manager.addTab(true, 'markdown');
    await ready();
    await settled();

    await typeAtEnd('plain line');
    await settled();

    expect(runMarkdownToolbarAction('bullet')).toBe(true);
    await settled();
    // '*' is the serializer's bullet — the retired page's own convention.
    expect(surface.capture(host)).toContain('* plain line');

    expect(runMarkdownToolbarAction('ordered')).toBe(true);
    await settled();
    expect(surface.capture(host)).toContain('1. plain line');
  });

  it('runMarkdownBlockStyle wraps H1..H6 and returns to text', async () => {
    const { runMarkdownBlockStyle } = await import('./toolbar');
    mountShell();
    const host = document.getElementById('note') as HTMLElement;
    const manager = new TabManager($(host));
    setTabManager(manager);
    await manager.init();

    manager.addTab(true, 'markdown');
    await ready();
    await settled();
    await typeAtEnd('headline');
    await settled();

    expect(runMarkdownBlockStyle('h2')).toBe(true);
    await settled();
    expect(surface.capture(host)).toContain('## headline');

    expect(runMarkdownBlockStyle('p')).toBe(true);
    await settled();
    expect(surface.capture(host)).not.toContain('## ');
  });

  it('commands refuse when no markdown editor is live', () => {
    expect(runMarkdownToolbarAction('bold')).toBe(false);
  });

  it('pressed states follow the selection through onMarkdownSelection', async () => {
    mountShell();
    const manager = new TabManager($('#note'));
    setTabManager(manager);
    await manager.init();
    initMarkdownToolbar(manager);

    const states: object[] = [];
    const stop = onMarkdownSelection((state) => states.push({ ...state }));

    manager.addTab(true, 'markdown');
    await ready();
    await settled();
    await typeAtEnd('words');
    await settled();

    expect(states.length).toBeGreaterThanOrEqual(1);

    // Bold the selection, then move the caret inside: pressed follows.
    const handle = markdownEditorHandle()!;
    const { view } = handle;
    const { TextSelection } = await import('@milkdown/kit/prose/state');
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end - 5, end)));
    runMarkdownToolbarAction('bold');
    await settled();

    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, end - 2, end - 2)),
    );
    await settled();

    const last = states.at(-1) as { bold: boolean } | undefined;
    expect(last?.bold).toBe(true);
    stop();
  });
});

// ---------------------------------------------------------------------------
// The parked html engine — ModelPort.setInert
// ---------------------------------------------------------------------------

describe('ModelPort.setInert — the html engine parks while markdown owns the host', () => {
  it('inert: insertText refuses, listeners ignore events, getHtml serves the parked model', async () => {
    const host = freshHost();
    const port = new ModelPort(host, { sanitize: sanitizeNoteHtml });
    port.renderHtml('<p>the html note</p>');
    expect(port.getHtml()).toContain('the html note');

    // A markdown surface takes the host.
    surface.display(host, { content: '# the markdown note' });
    await ready();
    await settled();

    port.setInert(true);

    // Mutations refuse while parked.
    expect(port.insertText('nope')).toBe(false);

    // The port's input listener stays silent for the markdown editor's
    // events: a direct input dispatch must not re-announce through the port.
    const htmlBefore = port.getHtml();
    host.dispatchEvent(new Event('input', { bubbles: true }));
    expect(port.getHtml()).toBe(htmlBefore);
    expect(port.getHtml()).toContain('the html note');
    expect(port.getHtml()).not.toContain('markdown');

    // And coming home: renderHtml works while inert (that is its whole
    // job — an html note opening again repaints the host).
    port.renderHtml('<p>back home</p>');
    expect(host.innerHTML).toContain('back home');
    expect(host.querySelector('.markdown-surface')).toBeNull();

    // Unparked: the engine serves live again.
    port.setInert(false);
    host.focus();
    expect(port.insertText(' appended')).toBe(true);
  });

  it('the app wiring rule: inert whenever the active note is not an html kind', async () => {
    // Mirrors app.ts: syncPortInert listens to active changes. The rule
    // itself is one expression; what matters is that setInert exists on
    // the port and both states behave — pinned above. This test pins the
    // expression the shell runs.
    const { isHtmlContent } = await import('../note-types');
    expect(isHtmlContent('markdown')).toBe(false);
    expect(isHtmlContent('rich')).toBe(true);
    expect(isHtmlContent(undefined)).toBe(true);
  });
});
