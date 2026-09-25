/**
 * Characterization suite for the note pipeline in tabs.ts — the safety net
 * the editor revamp will run on.
 *
 * Unlike tabs.test.ts (spec-style: what the functions SHOULD do), this file
 * pins what the functions ACTUALLY do today, quirk for quirk, so any
 * refactor (EditorPort extraction, ProseMirror/TipTap adapter, storage
 * reshapes) that changes observable behaviour fails loudly here.
 *
 * Everything in this file was written against the behaviour of the live app
 * at commit 44e8b11. If a test here fails after an intentional behaviour
 * change, update the test in the same commit and say why in the message.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

import {
  deriveTabTitle,
  escapeHtml,
  htmlToText,
  legacyTextToHtml,
  sanitizeNoteHtml,
  TabManager,
  WELCOME_HTML,
  type NoteTab,
} from './tabs';
import {
  flushPendingWrites,
  loadNotes,
  resetStorageForTests,
  saveNotes,
  storageReady,
  type StoredNoteTab,
} from './storage';

// Swal is modal UI — mocked so close-with-content paths can be driven.
vi.mock('sweetalert2', () => ({
  default: { fire: vi.fn(() => Promise.resolve({ isConfirmed: false })) },
}));

import Swal from 'sweetalert2';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// jsdom does not implement innerText (it depends on CSS rendering). The app
// reads innerText in TabManager.getActiveText(); for characterization we
// approximate it with textContent, which agrees on every string these tests
// use (no CSS-hidden text, no display-dependent collapsing).
beforeAll(() => {
  if (typeof HTMLElement.prototype.innerText === 'undefined') {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      get(this: HTMLElement) {
        return this.textContent;
      },
      configurable: true,
    });
  }
});

// jsdom lacks scrollIntoView (rendering-dependent); the manager calls it
// best-effort after addTab.
beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => {},
      configurable: true,
    });
  }
});

function mountEditorDom(): void {
  document.body.innerHTML = `
    <div id="tabStripTabs"></div>
    <div id="addTab"></div>
    <div id="tabRailCount"></div>
    <div id="note" contenteditable="true"></div>
    <div id="toast"></div>
  `;
}

/** Deletes the padify database so every test starts from an empty store. */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('padify');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function freshBoot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await deleteDatabase();
  localStorage.clear();
  await storageReady();
}

/**
 * Flush write-behind persists to IndexedDB, then re-hydrate the storage
 * layer. loadNotes() deliberately serves the BOOT-time snapshot (it never
 * re-reads the store), so reading back what the app persisted requires a
 * re-boot — exactly what storage.test.ts does.
 */
async function flushAndReboot(): Promise<void> {
  flushPendingWrites();
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await storageReady();
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mountEditorDom();
  await freshBoot();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// sanitizeNoteHtml — the security + content boundary
// ---------------------------------------------------------------------------

describe('sanitizeNoteHtml (characterization)', () => {
  it('passes every tag of the editor formatting subset through', () => {
    const subset =
      '<b>b</b><strong>s</strong><i>i</i><em>e</em><u>u</u><s>s</s>' +
      '<strike>k</strike><del>d</del><span>n</span><p>p</p><div>v</div>';
    expect(sanitizeNoteHtml(subset)).toBe(subset);
  });

  it('keeps br as a void element', () => {
    expect(sanitizeNoteHtml('a<br>b')).toBe('a<br>b');
  });

  it('strips every attribute from surviving tags — classes, styles, handlers', () => {
    expect(
      sanitizeNoteHtml('<b class="x" id="y" style="color:red" onclick="evil()">hi</b>'),
    ).toBe('<b>hi</b>');
    expect(sanitizeNoteHtml('<div data-note="7">v</div>')).toBe('<div>v</div>');
  });

  it('a javascript: href cannot survive — the anchor itself is unwrapped', () => {
    expect(sanitizeNoteHtml('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  it('unwraps unknown tags to their text content', () => {
    expect(sanitizeNoteHtml('<h1>title</h1>')).toBe('title');
    expect(sanitizeNoteHtml('<custom-el>hey</custom-el>')).toBe('hey');
  });

  it('unwraps <script> to inert text, not executable markup', () => {
    expect(sanitizeNoteHtml('<script>alert(1)</script>')).toBe('alert(1)');
  });

  it('drills into unknown wrappers and rescues allowed children', () => {
    expect(sanitizeNoteHtml('<table><tr><td><b>kept</b></td></tr></table>')).toBe('<b>kept</b>');
  });

  it('iframe content is raw text per the HTML spec — it comes back escaped, inert', () => {
    // Quirk pinned: <iframe> is a raw-text element, so the inner <b> never
    // becomes markup. The sanitizer can only return its text, escaped.
    expect(sanitizeNoteHtml('<iframe><b>inner</b></iframe>')).toBe('&lt;b&gt;inner&lt;/b&gt;');
  });

  it('drops HTML comments entirely', () => {
    expect(sanitizeNoteHtml('a<!-- hidden -->b')).toBe('ab');
  });

  it('preserves nesting among allowed tags', () => {
    expect(sanitizeNoteHtml('<div><b>bold <i>both</i></b></div>')).toBe(
      '<div><b>bold <i>both</i></b></div>',
    );
  });

  it('keeps entity-escaped text escaped (no double-decoding round trip)', () => {
    expect(sanitizeNoteHtml('a &amp; b &lt;tag&gt;')).toBe('a &amp; b &lt;tag&gt;');
  });

  it('normalizes uppercase tags to lowercase serialization', () => {
    expect(sanitizeNoteHtml('<B>x</B><DIV>y</DIV>')).toBe('<b>x</b><div>y</div>');
  });

  it('returns the empty string for empty input', () => {
    expect(sanitizeNoteHtml('')).toBe('');
  });

  it('is idempotent — sanitizing twice equals sanitizing once', () => {
    const dirty =
      '<div class="row"><b style="x">keep</b><script>bad()</script><table><tr><td><i>deep</i></td></tr></table><!--c--></div>';
    const once = sanitizeNoteHtml(dirty);
    expect(sanitizeNoteHtml(once)).toBe(once);
  });

  it('survives deeply hostile nesting without throwing', () => {
    const hostile =
      '<div><div><div>' + '<b onclick=alert(1)>x</b>' + '</div></div></div><svg><circle/></svg>';
    expect(() => sanitizeNoteHtml(hostile)).not.toThrow();
    expect(sanitizeNoteHtml(hostile)).toBe('<div><div><div><b>x</b></div></div></div>');
  });
});

// ---------------------------------------------------------------------------
// htmlToText — titles, statistics, voice, share links all read through this
// ---------------------------------------------------------------------------

describe('htmlToText (characterization)', () => {
  it('joins block divs with a newline and never emits a leading one', () => {
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb');
    expect(htmlToText('<div>only</div>')).toBe('only');
  });

  it('reads br as a newline inside a block', () => {
    expect(htmlToText('<div>line1<br>line2</div>')).toBe('line1\nline2');
  });

  it('emits a newline for an empty div (blank line in the note)', () => {
    expect(htmlToText('<div>a</div><div></div><div>b</div>')).toBe('a\n\nb');
  });

  it('keeps inline formatting tags invisible to the text', () => {
    expect(htmlToText('<b>a</b><i>b</i>c')).toBe('abc');
  });

  it('decodes entities', () => {
    expect(htmlToText('fish &amp; chips')).toBe('fish & chips');
  });

  it('includes text hidden inside unknown elements (incl. script bodies)', () => {
    // Quirk pinned on purpose: htmlToText has no notion of "non-visible"
    // elements. sanitizeNoteHtml is what defuses markup upstream.
    expect(htmlToText('<script>hidden()</script>visible')).toBe('hidden()visible');
  });
});

// ---------------------------------------------------------------------------
// deriveTabTitle — rail labels, share links, snapshots
// ---------------------------------------------------------------------------

describe('deriveTabTitle (characterization)', () => {
  const tab = (html: string, name: string | null = null): NoteTab => ({
    id: 't',
    name,
    html,
    createdAt: 0,
    updatedAt: 0,
  });

  it('treats a whitespace-only name as unnamed', () => {
    expect(deriveTabTitle(tab('<div>real</div>', '   '))).toBe('real');
  });

  it('skips blank and whitespace-only lines when deriving', () => {
    expect(deriveTabTitle(tab('<div><br></div><div>   </div><div>third</div>'))).toBe('third');
  });

  it('keeps a 42-char line whole and ellipsises a 43-char one to 42', () => {
    const line42 = 'x'.repeat(42);
    const line43 = 'y'.repeat(43);
    expect(deriveTabTitle(tab(`<div>${line42}</div>`))).toBe(line42);
    expect(deriveTabTitle(tab(`<div>${line43}</div>`))).toBe('y'.repeat(41) + '…');
  });

  it('trims the derived line before measuring', () => {
    expect(deriveTabTitle(tab('<div>   padded heading   </div>'))).toBe('padded heading');
  });
});

// ---------------------------------------------------------------------------
// legacyTextToHtml — one-time `note` key migration
// ---------------------------------------------------------------------------

describe('legacyTextToHtml (characterization)', () => {
  it('converts bold before italic on the same line', () => {
    expect(legacyTextToHtml('**bold** and *ital*')).toBe('<b>bold</b> and <i>ital</i>');
  });

  it('converts underline and strikethrough wrappers', () => {
    expect(legacyTextToHtml('__u__ ~~s~~')).toBe('<u>u</u> <s>s</s>');
  });

  it('leaves unclosed markers as literal text', () => {
    expect(legacyTextToHtml('**nope nope')).toBe('**nope nope');
  });

  it('quirk: a stray * pairs with a later one, even after an unclosed **', () => {
    // Pinned verbatim: '**nope *also nope' — the italic regex pairs the
    // second bold star with the star before "also". Documented here so the
    // editor revamp can decide whether to keep or fix it.
    expect(legacyTextToHtml('**nope *also nope')).toBe('*<i>nope </i>also nope');
  });

  it('never lets raw html through — it is escaped first', () => {
    expect(legacyTextToHtml('<img src=x onerror=alert(1)>')).toBe(
      escapeHtml('<img src=x onerror=alert(1)>'),
    );
  });

  it('markers do not match across newlines', () => {
    expect(legacyTextToHtml('**a\nb**')).toBe('**a\nb**');
  });
});

// ---------------------------------------------------------------------------
// TabManager — model, editor sync, strip, tombstones
// ---------------------------------------------------------------------------

describe('TabManager (characterization)', () => {
  const stored = (id: string, html: string, overrides: Partial<StoredNoteTab> = {}): StoredNoteTab => ({
    id,
    name: null,
    html,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  });

  async function bootedManager(): Promise<TabManager> {
    const manager = new TabManager($('#note'));
    await manager.init();
    return manager;
  }

  it('bootstraps a welcome tab into empty storage and paints the editor', async () => {
    const manager = await bootedManager();

    expect(manager.getActive()).not.toBeNull();
    expect(document.getElementById('note')!.innerHTML).toBe(WELCOME_HTML);
    expect(document.getElementById('tabRailCount')!.textContent).toBe('1');

    await flushAndReboot();
    const persisted = await loadNotes();
    expect(persisted.tabs).toHaveLength(1);
    expect(persisted.tabs[0].html).toBe(WELCOME_HTML);
  });

  it('rehydrates stored tabs and sanitizes their html on the way in', async () => {
    saveNotes(
      {
        tabs: [stored('t1', '<b>clean</b>'), stored('t2', '<script>bad()</script><i>ok</i>')],
        tombstones: [],
      },
      't1',
      { immediate: true },
    );
    await flushAndReboot();

    const manager = await bootedManager();

    expect(manager.getActive()!.id).toBe('t1');
    const tabs = manager.exportForSync().tabs;
    // script TEXT survives (inert), the tag itself does not — matches the
    // sanitizeNoteHtml characterization above.
    expect(tabs.find((t) => t.id === 't2')!.html).toBe('bad()<i>ok</i>');
    expect(tabs).toHaveLength(2);
  });

  it('falls back to the first tab when the saved active id is unknown', async () => {
    saveNotes(
      { tabs: [stored('t1', '<b>one</b>'), stored('t2', '<b>two</b>')], tombstones: [] },
      'gone',
      { immediate: true },
    );
    await flushAndReboot();

    const manager = await bootedManager();
    expect(manager.getActive()!.id).toBe('t1');
  });

  it('switchTo writes the outgoing editor content back into its tab', async () => {
    saveNotes(
      { tabs: [stored('t1', '<b>one</b>'), stored('t2', '<b>two</b>')], tombstones: [] },
      't1',
      { immediate: true },
    );
    await flushAndReboot();
    const manager = await bootedManager();

    $('#note').html('<b>one edited</b>');
    manager.switchTo('t2', false);

    expect(manager.getActive()!.id).toBe('t2');
    expect(manager.exportForSync().tabs.find((t) => t.id === 't1')!.html).toBe('<b>one edited</b>');
    expect(document.getElementById('note')!.innerHTML).toBe('<b>two</b>');
  });

  it('addTab appends an empty active tab and resets the editor', async () => {
    const manager = await bootedManager();
    const before = manager.exportForSync().tabs.length;

    manager.addTab(false);

    expect(manager.exportForSync().tabs).toHaveLength(before + 1);
    expect(manager.getActive()!.html).toBe('');
    expect(document.getElementById('note')!.innerHTML).toBe('');
    expect(document.getElementById('tabRailCount')!.textContent).toBe(String(before + 1));
  });

  it('closes an empty tab immediately with no confirm dialog', async () => {
    const manager = await bootedManager();
    manager.addTab(false);
    const emptyId = manager.getActive()!.id;

    manager.switchTo(manager.exportForSync().tabs[0].id, false);
    // (fire the close through the public path via strip click simulation)
    $(`#tabStripTabs .tab-strip-tab[data-tab-id="${emptyId}"] .tab-strip-close`).trigger('click');

    expect(Swal.fire).not.toHaveBeenCalled();
    expect(manager.exportForSync().tabs.some((t) => t.id === emptyId)).toBe(false);
  });

  it('asks for confirmation before closing a tab that has content', async () => {
    const manager = await bootedManager();
    const contentId = manager.getActive()!.id;
    $('#note').html('<b>precious words</b>');

    $(`#tabStripTabs .tab-strip-tab[data-tab-id="${contentId}"] .tab-strip-close`).trigger('click');

    expect(Swal.fire).toHaveBeenCalledTimes(1);
    // mock resolves isConfirmed:false — the tab must still be there
    await Promise.resolve();
    expect(manager.exportForSync().tabs.some((t) => t.id === contentId)).toBe(true);
  });

  it('closing the last tab leaves a fresh empty one active', async () => {
    const manager = await bootedManager();
    const onlyId = manager.getActive()!.id;
    $('#note').html(''); // make it empty so no confirm is needed

    $(`#tabStripTabs .tab-strip-tab[data-tab-id="${onlyId}"] .tab-strip-close`).trigger('click');

    const tabs = manager.exportForSync().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).not.toBe(onlyId);
    expect(manager.getActive()!.html).toBe('');
  });

  it('records a tombstone on close and clears it once confirmed', async () => {
    const manager = await bootedManager();
    manager.addTab(false);
    const extraId = manager.getActive()!.id;
    manager.switchTo(manager.exportForSync().tabs[0].id, false);

    $(`#tabStripTabs .tab-strip-tab[data-tab-id="${extraId}"] .tab-strip-close`).trigger('click');
    expect(manager.exportForSync().tombstones.some((t) => t.id === extraId)).toBe(true);

    manager.confirmTombstones([extraId]);
    expect(manager.exportForSync().tombstones.some((t) => t.id === extraId)).toBe(false);
  });

  it('rename commits on Enter and updates the strip label', async () => {
    const manager = await bootedManager();
    const tabId = manager.getActive()!.id;

    manager.switchTo(tabId, false); // ensure active strip element exists
    // The strip binds NATIVE listeners, so dispatch a real bubbling event
    // (jQuery .trigger only runs jQuery-bound handlers).
    $(`#tabStripTabs .tab-strip-tab[data-tab-id="${tabId}"]`)
      .get(0)!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const input = $('#tabStripTabs .tab-strip-rename');
    expect(input).toHaveLength(1);

    input.val('My recipe');
    input.trigger($.Event('keydown', { key: 'Enter' }));

    expect(manager.getActive()!.name).toBe('My recipe');
    expect($(`#tabStripTabs .tab-strip-tab[data-tab-id="${tabId}"] .tab-strip-title`).text()).toBe(
      'My recipe',
    );
  });

  it('cycles forward and backward with wraparound', async () => {
    saveNotes(
      {
        tabs: [stored('t1', 'one'), stored('t2', 'two'), stored('t3', 'three')],
        tombstones: [],
      },
      't2',
      { immediate: true },
    );
    await flushAndReboot();
    const manager = await bootedManager();
    expect(manager.getActive()!.id).toBe('t2');

    manager.cycle(1);
    expect(manager.getActive()!.id).toBe('t3');
    manager.cycle(1);
    expect(manager.getActive()!.id).toBe('t1');
    manager.cycle(-1);
    expect(manager.getActive()!.id).toBe('t3');
    manager.cycle(-1);
    expect(manager.getActive()!.id).toBe('t2');
  });

  it('marks changed tabs dirty for the sync payload and unmarks nothing silently', async () => {
    saveNotes(
      { tabs: [stored('t1', 'one'), stored('t2', 'two')], tombstones: [] },
      't1',
      { immediate: true },
    );
    await flushAndReboot();
    const manager = await bootedManager();

    expect(manager.exportForSync().dirty).toEqual([]);

    $('#note').html('new words');
    manager.saveActiveFromEditor();

    expect(manager.exportForSync().dirty).toEqual(['t1']);
  });

  it('saveActiveFromEditor is a no-op when the editor content is unchanged', async () => {
    saveNotes({ tabs: [stored('t1', '<b>same</b>')], tombstones: [] }, 't1', { immediate: true });
    await flushAndReboot();
    const manager = await bootedManager();

    $('#note').html('<b>same</b>');
    manager.saveActiveFromEditor();

    expect(manager.exportForSync().dirty).toEqual([]);
  });

  it('debounces typing persistence — two keystrokes inside 400ms persist once', async () => {
    vi.useFakeTimers();
    const manager = await bootedManager();
    const fired: string[] = [];
    manager.addPersistListener((payload) => fired.push(String(payload.tabs.length)));

    $('#note').html('keystroke one');
    manager.saveActiveFromEditor();
    $('#note').html('keystroke one two');
    manager.saveActiveFromEditor();

    vi.advanceTimersByTime(399);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['1']);
  });

  it('notifies persist listeners with a full sync snapshot on every persist', async () => {
    const manager = await bootedManager();
    const payloads: ReturnType<typeof manager.exportForSync>[] = [];
    manager.addPersistListener((payload) => payloads.push(payload));

    manager.addTab(false);

    expect(payloads.length).toBeGreaterThanOrEqual(1);
    const last = payloads[payloads.length - 1];
    expect(last.tabs).toHaveLength(2);
    expect(last.tabs[1].html).toBe('');
  });

  it('getActiveText reads the editor surface and normalizes nbsp to spaces', async () => {
    const manager = await bootedManager();
    $('#note').html('a&nbsp;b');

    const text = manager.getActiveText();
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).not.toContain('\u00a0');
  });

  it('applyExternalMerge replaces the model, re-sanitizes, and keeps the editor untouched while focused', async () => {
    const manager = await bootedManager();
    const activeId = manager.getActive()!.id;
    $('#note').trigger('focus');
    $('#note').html('<b>user is typing here</b>');

    manager.applyExternalMerge([
      stored(activeId, '<div>fresh from the cloud</div>', { updatedAt: 999 }),
    ]);

    expect(manager.exportForSync().tabs).toHaveLength(1);
    // editor not clobbered: user was focused
    expect(document.getElementById('note')!.innerHTML).toBe('<b>user is typing here</b>');
    // but the model holds the merged (sanitized) row
    expect(manager.getActive()!.html).toBe('<div>fresh from the cloud</div>');
  });

  it('applyExternalMerge recreates a welcome tab when the merge empties the list', async () => {
    const manager = await bootedManager();

    manager.applyExternalMerge([]);

    const tabs = manager.exportForSync().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].html).toBe(WELCOME_HTML);
  });
});
