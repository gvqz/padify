/**
 * Characterization suite for the Markdown surface — the safety net under
 * editor/markdown/surface.ts, toolbar.ts and the ModelPort inert switch
 * they ride on.
 *
 * Everything here runs the REAL surface (a textarea + the owned
 * renderer), a real TabManager against the REAL shell markup (read from
 * disk — markup drift fails here, the rich toolbar suite's discipline).
 * The pins that matter most:
 *
 *  • THE CONTRACT — display paints without persisting, capture answers
 *    the markdown source, visibleText answers the RENDERED projection,
 *    commit applies and leaves persistence to the caller, clear empties.
 *  • THE ANNOUNCE DISCIPLINE — opening a note never fires the host
 *    input event; a USER edit (typing, checkbox toggles) always does.
 *    That signal is the app's entire autosave chain.
 *  • THE SECURITY MODEL — the note is data run through the renderer: raw
 *    HTML meets the policy (benign tags rebuilt, everything else
 *    escaped), javascript: hrefs never reach the DOM, and the preview's
 *    only live gestures are the task checkbox and the equation click.
 *  • THE MODES — source is the working mode; preview renders the owned
 *    renderer's output; every new display comes back to the source.
 *  • THE SEAMS — surface insertText (the picker's path), the toolbar's
 *    command dispatch and pressed states, the TabManager autosave chain,
 *    the HTML export's rendered body, and the port parking.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MarkdownNoteSurface,
  markdownSelectionStateNow,
  markdownSourceActive,
  markdownSourceTextarea,
  markdownViewMode,
  onMarkdownSelection,
  onMarkdownViewMode,
  setMarkdownViewMode,
} from './surface';
import {
  initMarkdownToolbar,
  resetMarkdownToolbarForTests,
  runMarkdownToolbarAction,
} from './toolbar';
import { noteSurfaceForKind } from '../surface';
import {
  getActiveNoteExportBody,
  getTabManager,
  insertTextIntoActiveNote,
  setTabManager,
  TabManager,
} from '../../tabs';
import { resetStorageForTests, storageReady } from '../../storage';
import { $ } from '../../lib/q';
import { ModelPort } from '../model-port';
import { sanitizeNoteHtml } from '../storage-subset';

const surface = new MarkdownNoteSurface();
const noteSurface = noteSurfaceForKind('text');

// jsdom lacks scrollIntoView (rendering-dependent); the manager calls it
// on every tab switch — shim it the tabs suite's way.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

/** The REAL shell markup — TabManager and the toolbar both need it. */
function mountShell(): void {
  document.body.innerHTML = readFileSync(
    resolve(process.cwd(), 'src/ui/editor-shell.html'),
    'utf-8',
  );
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.append(toast);
}

async function bootedManager(): Promise<TabManager> {
  const hostEl = document.getElementById('note') as HTMLElement;
  const manager = new TabManager($(hostEl));
  setTabManager(manager);
  await manager.init();
  manager.addTab(true, 'markdown');
  return manager;
}

function host(): HTMLElement {
  const el = document.getElementById('note');
  if (!el) {
    throw new Error('no #note host');
  }
  return el;
}

function source(): HTMLTextAreaElement {
  const ta = host().querySelector<HTMLTextAreaElement>('textarea.markdown-source');
  if (!ta) {
    throw new Error('no source pane mounted');
  }
  return ta;
}

function preview(): HTMLElement {
  const el = host().querySelector<HTMLElement>('.markdown-preview');
  if (!el) {
    throw new Error('no preview pane mounted');
  }
  return el;
}

beforeEach(async () => {
  resetStorageForTests();
  resetMarkdownToolbarForTests();
  document.body.innerHTML = '<div id="note" contenteditable="true"></div>';
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  localStorage.clear();
  await storageReady();
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('the Markdown surface (characterization)', () => {
  it('is the registered surface for the text content kind', () => {
    expect(noteSurface).toBeInstanceOf(MarkdownNoteSurface);
  });

  it('display mounts a textarea + preview; capture answers the source; display never announces', () => {
    const events: string[] = [];
    host().addEventListener('input', () => events.push('input'));

    surface.display(host(), { content: '# Hello\n\nworld **bold**' });
    expect(source().value).toBe('# Hello\n\nworld **bold**');
    expect(preview().hidden).toBe(true);
    expect(events).toEqual([]);

    expect(surface.capture(host())).toBe('# Hello\n\nworld **bold**');
  });

  it('typing announces through the host (the autosave chain)', () => {
    surface.display(host(), { content: '' });
    const events: Event[] = [];
    host().addEventListener('input', (e) => events.push(e));

    source().focus();
    source().value = 'typed';
    source().dispatchEvent(new Event('input', { bubbles: true }));

    expect(events).toHaveLength(1);
    expect(surface.capture(host())).toBe('typed');
  });

  it('visibleText answers the RENDERED projection', () => {
    surface.display(host(), { content: '# Heading\n\nsome *emphasis* and `code`' });
    const text = surface.visibleText(host(), {
      content: '# Heading\n\nsome *emphasis* and `code`',
    });
    expect(text).toContain('Heading');
    expect(text).toContain('some emphasis and code');
    expect(text).not.toContain('*');
    expect(text).not.toContain('`');
  });

  it('commit applies wholesale and leaves persistence to the caller', () => {
    surface.display(host(), { content: 'first' });
    expect(surface.commit(host(), 'second')).toBe(false);
    expect(surface.capture(host())).toBe('second');
  });

  it('clear empties the editor; a fresh pane per wholesale change resets undo isolation', () => {
    surface.display(host(), { content: 'note one words' });
    const first = source();
    surface.clear(host());
    expect(surface.capture(host())).toBe('');
    expect(source()).not.toBe(first); // fresh textarea, fresh native undo
  });

  it('insertText rides the textarea path (the picker / dictation seam)', () => {
    surface.display(host(), { content: 'hello' });
    const ta = source();
    ta.focus();
    ta.setSelectionRange(5, 5);
    expect(surface.insertText(host(), ' world')).toBe(true);
    expect(surface.capture(host())).toBe('hello world');
  });

  it('focusTarget is the textarea in source mode, null in preview', () => {
    surface.display(host(), { content: 'x' });
    expect(surface.focusTarget(host())).toBe(source());
    setMarkdownViewMode('preview');
    expect(surface.focusTarget(host())).toBeNull();
    setMarkdownViewMode('source');
  });

  it('dismiss tears the surface down (the next note repaints the host)', () => {
    surface.display(host(), { content: 'x' });
    expect(markdownSourceTextarea()).not.toBeNull();
    surface.dismiss(host());
    expect(markdownSourceTextarea()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The modes
// ---------------------------------------------------------------------------

describe('the source / preview modes', () => {
  it('preview renders the owned renderer output; the textarea hides but keeps its value', () => {
    surface.display(host(), { content: '# Title\n\n- [ ] task' });
    setMarkdownViewMode('preview');

    expect(markdownViewMode()).toBe('preview');
    expect(preview().hidden).toBe(false);
    expect(source().hidden).toBe(true);
    expect(preview().innerHTML).toContain('<h1>Title</h1>');
    expect(preview().innerHTML).toContain('checkbox');
    // The textarea stays mounted with its value — the flip back is free.
    expect(source().value).toBe('# Title\n\n- [ ] task');

    setMarkdownViewMode('source');
    expect(preview().hidden).toBe(true);
    expect(source().hidden).toBe(false);
    expect(markdownViewMode()).toBe('source');
  });

  it('every new display comes back to the source (preview is a reading gesture)', () => {
    surface.display(host(), { content: 'one' });
    setMarkdownViewMode('preview');
    surface.display(host(), { content: 'two' });
    expect(markdownViewMode()).toBe('source');
    expect(source().value).toBe('two');
  });

  it('the mode listener follows every flip', () => {
    const seen: string[] = [];
    const unlisten = onMarkdownViewMode((mode) => seen.push(mode));
    surface.display(host(), { content: '' });
    setMarkdownViewMode('preview');
    setMarkdownViewMode('source');
    unlisten();
    setMarkdownViewMode('preview');
    expect(seen).toEqual(['preview', 'source']);
    setMarkdownViewMode('source');
  });

  it('markdownSourceActive answers the working mode only', () => {
    surface.display(host(), { content: '' });
    expect(markdownSourceActive()).toBe(true);
    setMarkdownViewMode('preview');
    expect(markdownSourceActive()).toBe(false);
    setMarkdownViewMode('source');
  });
});

// ---------------------------------------------------------------------------
// The security model
// ---------------------------------------------------------------------------

describe('the security model (preview)', () => {
  it('raw HTML meets the policy: benign tags render rebuilt, declined tags stay text', () => {
    surface.display(host(), {
      content: '<ruby>x<rt>y</rt></ruby> and <script>alert(1)</script>',
    });
    setMarkdownViewMode('preview');
    expect(preview().innerHTML).toContain('<ruby>x<rt>y</rt></ruby>');
    expect(preview().innerHTML).not.toContain('<script>');
    expect(preview().innerHTML).toContain('&lt;script&gt;');
    setMarkdownViewMode('source');
  });

  it('hostile hrefs never reach the DOM as targets', () => {
    surface.display(host(), {
      content: '[x](javascript:alert(1)) <a href="javascript:alert(1)">y</a>',
    });
    setMarkdownViewMode('preview');
    const hrefs = [...preview().querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('javascript:alert(1)');
    setMarkdownViewMode('source');
  });

  it('the task checkbox toggle writes back into the source and announces', () => {
    const events: Event[] = [];
    surface.display(host(), { content: '- [ ] open item' });
    host().addEventListener('input', (e) => events.push(e));
    setMarkdownViewMode('preview');

    preview().querySelector('li')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(surface.capture(host())).toBe('- [x] open item');
    expect(events).toHaveLength(1);
    expect(preview().querySelector('input')!.hasAttribute('checked')).toBe(true);
    setMarkdownViewMode('source');
  });

  it('an equation click in the preview asks for the math bubble with its source', () => {
    const seen: Array<Record<string, unknown>> = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent).detail);
    };
    document.addEventListener('padify:md-math-click', listener);
    surface.display(host(), { content: '$x^2$ and\n\n$$\\sum$$' });
    setMarkdownViewMode('preview');

    preview().querySelector('.padify-math')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(seen[0]).toMatchObject({ latex: 'x^2', kind: 'inline' });

    preview().querySelector('.md-math-block .padify-math')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(seen[1]).toMatchObject({ kind: 'block' });

    document.removeEventListener('padify:md-math-click', listener);
    setMarkdownViewMode('source');
  });
});

// ---------------------------------------------------------------------------
// The toolbar + the pressed states (real shell markup)
// ---------------------------------------------------------------------------

describe('the toolbar (real shell markup)', () => {
  beforeEach(async () => {
    mountShell();
    await bootedManager();
    surface.display(host(), { content: '' });
    initMarkdownToolbar(getTabManager()!);
  });

  it('boots against the real markup and hides for non-markdown notes', () => {
    const manager = getTabManager()!;
    expect(document.getElementById('markdownToolbar')!.hidden).toBe(false);

    manager.addTab(true);
    expect(document.getElementById('markdownToolbar')!.hidden).toBe(true);
    manager.addTab(true, 'markdown');
    expect(document.getElementById('markdownToolbar')!.hidden).toBe(false);
  });

  it('the command buttons dispatch through the source primitives', () => {
    const ta = source();
    ta.focus();
    ta.value = 'plain words';
    ta.setSelectionRange(6, 11);
    ta.dispatchEvent(new Event('focus', { bubbles: true }));

    expect(runMarkdownToolbarAction('bold')).toBe(true);
    expect(surface.capture(host())).toBe('plain **words**');
    expect(document.activeElement).toBe(ta);
  });

  it('the pressed states follow the caret through the selection state', () => {
    const ta = source();
    ta.value = 'a **bold** run';
    ta.setSelectionRange(4, 8); // 'bold', inside the ** pair
    ta.dispatchEvent(new Event('keyup', { bubbles: true }));

    const bold = document.querySelector('[data-md-action="bold"]')!;
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(markdownSelectionStateNow()?.bold).toBe(true);
  });

  it('the view toggle flips the surface; preview parks the command chrome', () => {
    document.querySelector('[data-md-view="preview"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(markdownViewMode()).toBe('preview');
    expect(preview().hidden).toBe(false);
    const bold = document.querySelector('[data-md-action="bold"]') as HTMLButtonElement;
    expect(bold.disabled).toBe(true);

    document.querySelector('[data-md-view="source"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(markdownViewMode()).toBe('source');
    expect(bold.disabled).toBe(false);
  });

  it('the block dropdown writes heading levels', () => {
    const ta = source();
    ta.value = 'a line to headline';
    ta.setSelectionRange(0, 0);
    ta.focus();

    document.querySelector('[data-md-menu="block"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    document.querySelector('[data-md-block="h2"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(surface.capture(host())).toBe('## a line to headline');
  });
});

// ---------------------------------------------------------------------------
// The TabManager integration — the seam end to end
// ---------------------------------------------------------------------------

describe('TabManager + markdown notes — the seam end to end', () => {
  it('creating a markdown note paints the surface, typing autosaves the SOURCE', async () => {
    mountShell();
    const manager = await bootedManager();

    expect(host().getAttribute('contenteditable')).toBe('false');
    expect(host().querySelector('.markdown-surface')).not.toBeNull();

    const ta = source();
    ta.focus();
    ta.value = '# My markdown note';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    // The app's debounced autosave (app.ts binds input → save): driven
    // directly here, exactly what the wiring calls.
    manager.saveActiveFromEditor();
    const active = manager.getActive();
    expect(active?.noteType).toBe('markdown');
    expect(active?.content).toContain('# My markdown note');
    expect(active?.content).not.toContain('<'); // source, never markup
  });

  it('HTML export ships the RENDERED body, not the source', async () => {
    mountShell();
    await bootedManager();

    surface.display(host(), { content: '# Exported heading' });
    surface.commit(host(), '# Exported heading');

    const body = getActiveNoteExportBody();
    expect(body).toContain('<h1>Exported heading</h1>');
    expect(body).not.toContain('# Exported heading');
  });

  it('insertTextIntoActiveNote routes to the markdown surface', async () => {
    mountShell();
    await bootedManager();

    expect(insertTextIntoActiveNote('inserted via seam')).toBe(true);
    expect(surface.capture(host())).toContain('inserted via seam');
  });
});

// ---------------------------------------------------------------------------
// The port parking + the selection refresh
// ---------------------------------------------------------------------------

describe('the ModelPort inert switch', () => {
  it('the html engine parks while the markdown surface owns the host', async () => {
    mountShell();
    await bootedManager();
    const port = new ModelPort(host(), { sanitize: sanitizeNoteHtml });
    expect(port.setInert(true)).toBeUndefined();

    surface.display(host(), { content: 'md words' });
    // The parked port's html never absorbs the markdown wrapper:
    expect(host().querySelector('textarea.markdown-source')).not.toBeNull();
    expect(sanitizeNoteHtml(port.getHtml())).not.toContain('markdown-source');
  });
});

describe('refreshMarkdownSelectionState', () => {
  it('notifies the current state to every listener', async () => {
    surface.display(host(), { content: 'a **bold** run' });
    const seen: Array<boolean | undefined> = [];
    const unlisten = onMarkdownSelection((state) => seen.push(state.bold));

    const ta = source();
    ta.focus();
    ta.setSelectionRange(4, 8); // 'bold', inside the ** pair
    // Direct call — the toolbar's post-command pass.
    const mod = await import('./surface');
    mod.refreshMarkdownSelectionState();

    expect(seen).toContain(true);
    unlisten();
  });
});
