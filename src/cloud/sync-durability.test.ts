import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { $ } from '../lib/q';

// The durable half of the reload-recovery fix (see cloud/sync.ts —
// seedPendingFromModel): NoteTab.unpushed is stamped by TabManager.persist
// in the SAME IndexedDB write as the content, and TabManager.init re-seeds
// the dirty set from it. These tests run the REAL manager over the REAL
// storage layer — the exact save/reboot path a browser reload takes.

import { TabManager, WELCOME_HTML } from '../tabs';
import { flushPendingWrites, resetStorageForTests, storageReady, whenNotesIdle } from '../storage';

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
  sessionStorage.clear();
  await storageReady();
}

/** Flush write-behind persists, then re-hydrate — the reload simulation. */
async function flushAndReboot(): Promise<void> {
  flushPendingWrites();
  await whenNotesIdle();
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await storageReady();
}

const liveManagers: TabManager[] = [];
function trackManager(manager: TabManager): TabManager {
  liveManagers.push(manager);
  return manager;
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mountEditorDom();
  await freshBoot();
});

afterEach(() => {
  liveManagers.splice(0).forEach((manager) => manager.cancelPendingPersist());
  vi.restoreAllMocks();
});

describe('durable unpushed flags — the reload-recovery seed', () => {
  it('an edit that never pushed re-enters the dirty set after a reboot', async () => {
    // Session one: create a note (dirty), let the persist land, and "die"
    // before any push confirmed it — pendingPush and dirtyIds were the
    // memory-only state a reload used to destroy.
    const first = trackManager(new TabManager($('#note')));
    await first.init();
    first.addTab(false);
    const created = first.allTabs.find((tab) => tab.content !== WELCOME_HTML);
    expect(created).toBeTruthy();
    await whenNotesIdle();

    // Reload: fresh storage hydration + a fresh manager.
    await flushAndReboot();
    const second = trackManager(new TabManager($('#note')));
    await second.init();

    // THE regression: the rebooted model knows the note is still unpushed.
    expect(second.exportForSync().dirty).toContain(created!.id);
    const reloaded = second.allTabs.find((tab) => tab.id === created!.id);
    expect(reloaded?.unpushed).toBe(true);

    // And the sync layer's session start would queue it for a pull-first
    // recovery cycle (pinned in sync-recovery.test.ts at the cycle level).
  });

  it('confirmPushed retires the flag durably — a synced note stays clean across boots', async () => {
    const first = trackManager(new TabManager($('#note')));
    await first.init();
    first.addTab(false);
    const created = first.allTabs.find((tab) => tab.content !== WELCOME_HTML);
    await whenNotesIdle();

    // The push confirmed: dirty cleared, flag re-stamped false by the
    // persist confirmPushed issues, and both survive the reboot.
    first.confirmPushed([created!.id]);
    await whenNotesIdle();

    await flushAndReboot();
    const second = trackManager(new TabManager($('#note')));
    await second.init();

    expect(second.exportForSync().dirty).toEqual([]);
    const reloaded = second.allTabs.find((tab) => tab.id === created!.id);
    expect(reloaded?.unpushed).toBeUndefined();
  });

  it('a trashed note carries the flag too — an offline delete survives the reload', async () => {
    const first = trackManager(new TabManager($('#note')));
    await first.init();
    first.addTab(false);
    const created = first.allTabs.find((tab) => tab.content !== WELCOME_HTML);
    await whenNotesIdle();

    // Trash it and die before the trash row ever shipped.
    vi.mocked(console.warn);
    first.requestCloseTab(created!.id);
    await whenNotesIdle();

    await flushAndReboot();
    const second = trackManager(new TabManager($('#note')));
    await second.init();

    expect(second.exportForSync().dirty).toContain(created!.id);
    const grave = second.getTrashed().find((entry) => entry.id === created!.id);
    expect(grave).toBeTruthy();
    expect(grave?.unpushed).toBe(true);
  });
});
