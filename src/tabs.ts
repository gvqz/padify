/**
 * Padify note tabs — multiple notes in one editor.
 *
 * Tabs live on the main page alongside the rich text formatting (merged in
 * from the old standalone Tabbypad tool, which no longer ships as a separate
 * page). Every tab is an independent note with its own rich content,
 * autosaved per-record into the padify IndexedDB store (see src/storage/):
 *
 *   notes store    → one row per note: { id, name, html, createdAt,
 *                    updatedAt, position } — deletions are rows with
 *                    deleted=true (tombstones), exactly like the cloud
 *                    schema; a save writes only the changed rows
 *   kv store       → padifyActiveTab holds the id of the tab in the editor
 *
 * A legacy blob mirror keeps the old `padifyTabs` localStorage key fresh for
 * service-worker-cached pre-storage app versions (bounded cadence — see
 * storage/notes.ts), and IndexedDB-unavailable browsers fall back to the
 * blob format entirely.
 *
 * The legacy single-note `note` key (plain text, optionally with markdown
 * style **bold** / *italic* / __underline__ / ~~strikethrough__ wrappers) is
 * migrated into the first tab on first run, converting the markers into real
 * formatting tags so the text renders the way it was written.
 *
 * Content is stored as a small HTML subset (b/strong/i/em/u/s/strike/del/br/
 * div/span + text). Everything that goes into the editor from storage passes
 * through sanitizeNoteHtml, which strips unknown tags and attributes, so the
 * editor surface only ever contains the formatting the app itself produces.
 * The subset's definition — tags, attributes, style properties and their
 * value patterns — lives in editor/storage-subset.ts, shared with the
 * editor engine so its model can only ever occupy the stored format.
 */

import { $, type Q } from './lib/q';
import Swal from 'sweetalert2';
import { showToast } from './ui/toast';
import {
  ACTIVE_TAB_KEY,
  loadNotes,
  saveNotes,
  stateGet,
  stateRemove,
  type StoredNoteTab,
} from './storage';
import { sanitizeNoteHtml } from './editor/storage-subset';
import { currentThemeMode, transformNoteColors } from './editor/theme-colors';
import {
  htmlNoteSurface,
  noteSurfaceFor,
  noteSurfaceForKind,
  type NoteSurface,
} from './editor/surface';
import { renderMarkdownToHtml } from './editor/markdown/render';
import {
  deriveTabTitle,
  escapeHtml,
  htmlToText,
  legacyTextToHtml,
  WELCOME_HTML,
} from './editor/note-content';
import {
  DEFAULT_NOTE_TYPE,
  isHtmlContent,
  normalizeNoteType,
  NOTE_TYPE_ICONS,
  noteTypeLabel,
  type KnownNoteType,
  type NoteType,
} from './editor/note-types';
import { isInstalledDisplayMode } from './install-pwa';

export type { NoteType } from './editor/note-types';

/** Frames a deferred focus ask may keep retrying an async mount (~2s). */
const MAX_FOCUS_RETRIES = 120;

export { sanitizeNoteHtml } from './editor/storage-subset';
// Re-exported for their existing importers (snapshots, the share layers, the
// test suites): the functions themselves live in editor/note-content.ts now,
// where the cross-domain consumers can reach them without dragging the tab
// model along.
export {
  deriveTabTitle,
  escapeHtml,
  htmlToText,
  legacyTextToHtml,
  WELCOME_HTML,
} from './editor/note-content';

export interface NoteTab {
  id: string;
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  /**
   * The note's content, in the format its type owns (see
   * editor/note-types.ts — contentKindFor). For the classic types that is
   * the sanitized HTML subset; for every other type it is that type's
   * format — Markdown source, JSON, an unknown build's bytes — verbatim,
   * and the sanitizer never touches it. Named `content` since the typed
   * content model; it was born as `html` because that is all the first
   * Padify stored, and the name outlived its accuracy by a year.
   */
  content: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The note kind — absent means the default (standard). See
   * editor/note-types.ts; kept optional so existing rows need no migration.
   */
  noteType?: NoteType;
  /**
   * The theme the note's inline colors were last written under — rich text
   * notes only (editor/theme-colors.ts). Absent on legacy notes, which are
   * left exactly as stored until their next edit.
   */
  colorTheme?: 'light' | 'dark';
  /**
   * Sync v2: the server sequence stamped on the version this row last
   * synced as (see cloud/sync.ts). Ordering across devices keys off it —
   * client clocks only arbitrate rows that never carried one. Sync
   * metadata, never user content: it rides storage and the merge, and
   * edits clear nothing (an edit keeps the seq of the version it edits
   * FROM, until its own push lands a new one).
   */
  syncSeq?: number;
}

const LEGACY_NOTE_KEY = 'note';

/**
 * Tabs closed on this device whose deletion has not been confirmed by the
 * cloud yet. Persisted so closing a tab offline still deletes it remotely
 * after the next sync.
 */
export interface TabTombstone {
  id: string;
  updatedAt: number;
}

/** Notifies the rail's count badge (and any other listener) about tab count. */
const RAIL_COUNT_ID = 'tabRailCount';

/** Everything the cloud sync layer needs after the model changed. */
export interface TabsSyncPayload {
  /** Current tab list (already persisted to localStorage). */
  tabs: NoteTab[];
  /** Tab ids whose content/name changed since the last persist. */
  dirty: string[];
  /** Full tombstone list (pending deletions, some possibly old news). */
  tombstones: TabTombstone[];
}

function createTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The next edit timestamp for a tab: strictly greater than the current
 * one, even when two changes land inside the same millisecond (double
 * restores, programmatic edits, automation). The storage diff and the
 * cloud merge both treat `updatedAt` as the change signal — a same-ms
 * second change would otherwise read as "nothing changed" and never
 * persist.
 */
function nextUpdatedAt(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

function createTab(
  content: string = '',
  name: string | null = null,
  noteType: NoteType = DEFAULT_NOTE_TYPE,
): NoteTab {
  const now = Date.now();
  const tab: NoteTab = { id: createTabId(), name, content, createdAt: now, updatedAt: now };
  if (noteType !== DEFAULT_NOTE_TYPE) {
    tab.noteType = noteType;
  }
  return tab;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class TabManager {
  private tabs: NoteTab[] = [];
  private activeId: string | null = null;
  private readonly editor: Q;
  private readonly strip: Q;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tombstones: TabTombstone[] = [];
  private dirtyIds: Set<string> = new Set();
  private persistListeners: Set<(payload: TabsSyncPayload) => void> = new Set();
  private activeListeners: Set<(tab: NoteTab) => void> = new Set();
  /** The surface that currently paints the host — dismissed before a
   * different kind takes the stage (the NoteSurface.dismiss contract). */
  private paintedBy: NoteSurface | null = null;

  constructor(editor: Q) {
    this.editor = editor;
    this.strip = $('#tabStripTabs');
  }

  /**
   * Loads (or bootstraps) the model and paints the strip + editor. Awaited
   * by app.ts after the storage layer hydrated (see storage/index.ts).
   */
  async init(): Promise<void> {
    const snapshot = await loadNotes();
    this.tabs = this.loadModel(snapshot.tabs);
    this.tombstones = snapshot.tombstones.filter(
      (entry) => entry && typeof entry.id === 'string' && typeof entry.updatedAt === 'number',
    );
    this.migrateLegacyNote();

    const savedActive = stateGet(ACTIVE_TAB_KEY);
    this.activeId = this.tabs.some((tab) => tab.id === savedActive)
      ? savedActive
      : (this.tabs[0]?.id ?? null);

    if (!this.activeId || !this.getActive()) {
      if (this.tabs.length === 0) {
        this.tabs.push(createTab(WELCOME_HTML));
        this.persist();
      }
      this.activeId = this.tabs[0].id;
      this.persist();
    }

    this.renderStrip();
    this.loadActiveIntoEditor();
    this.bindStripEvents();
    // The title mirrors the active note from the FIRST paint — a restored
    // session (or an installed app booting straight into a note) must not
    // sit on the static "Padify" until the first switch or keystroke.
    this.syncDocumentTitle();
  }

  // ---- model ---------------------------------------------------------------

  /** Validates + sanitises a stored row into the editor-safe model shape. */
  private loadModel(entries: StoredNoteTab[]): NoteTab[] {
    return entries
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => {
        const noteType = normalizeNoteType(entry.noteType);
        return {
          id: entry.id,
          name: typeof entry.name === 'string' ? entry.name : null,
          // The sanitizer belongs to html notes ONLY — any other format
          // passing through it would have its angle brackets rewritten and
          // its data corrupted in place.
          content:
            typeof entry.content === 'string' && isHtmlContent(noteType)
              ? sanitizeNoteHtml(entry.content)
              : typeof entry.content === 'string'
                ? entry.content
                : '',
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
          noteType,
          colorTheme:
            entry.colorTheme === 'light' || entry.colorTheme === 'dark'
              ? entry.colorTheme
              : undefined,
          syncSeq:
            typeof entry.syncSeq === 'number' && entry.syncSeq > 0 ? entry.syncSeq : undefined,
        };
      });
  }

  /**
   * One-time migration from the legacy single-note `note` key. Runs after
   * the snapshot load so an existing tab list wins over the old note.
   */
  private migrateLegacyNote(): void {
    const legacy = stateGet(LEGACY_NOTE_KEY);

    if (legacy === null) {
      return;
    }

    stateRemove(LEGACY_NOTE_KEY);

    if (this.tabs.length > 0 || legacy.trim() === '') {
      return;
    }

    this.tabs.unshift(createTab(legacyTextToHtml(legacy)));
    this.persist();
  }

  /**
   * Persists the model (write-behind — see storage/notes.ts) and notifies
   * the sync layer + persist listeners. `immediate=false` marks the typing
   * path: the IndexedDB diff still runs, the legacy blob mirror is
   * throttled.
   */
  private persist(immediate = true): void {
    saveNotes({ tabs: this.tabs, tombstones: this.tombstones }, this.activeId, { immediate });

    const payload = this.exportForSync();
    if (this.onPersist) {
      this.onPersist(payload);
    }
    this.persistListeners.forEach((listener) => listener(payload));
  }

  /**
   * Extra persist listeners (save indicator, share-link freshness, …). The
   * cloud sync layer keeps using the onPersist slot; everyone else registers
   * here so features can coexist without chaining over each other.
   */
  addPersistListener(listener: (payload: TabsSyncPayload) => void): () => void {
    this.persistListeners.add(listener);
    return () => {
      this.persistListeners.delete(listener);
    };
  }

  /**
   * Fires whenever the active note changed (switch, create, external merge).
   * Used by type-aware editor chrome (e.g. the rich text toolbar) that must
   * follow the note without each feature grabbing the single onActiveChanged
   * slot.
   */
  addActiveListener(listener: (tab: NoteTab) => void): () => void {
    this.activeListeners.add(listener);
    return () => {
      this.activeListeners.delete(listener);
    };
  }

  // ---- sync support ---------------------------------------------------------

  /**
   * Persists the tombstone list (they live as deleted rows in the notes
   * store — see storage/notes.ts).
   */
  private persistTombstones(): void {
    saveNotes({ tabs: this.tabs, tombstones: this.tombstones }, this.activeId, { immediate: true });
  }

  /** Records a tab deletion so the cloud can mirror it (tombstone). */
  private recordTombstone(tabId: string): void {
    if (this.tombstones.some((entry) => entry.id === tabId)) {
      return;
    }
    this.tombstones.push({ id: tabId, updatedAt: Date.now() });
    this.persistTombstones();
  }

  /** Snapshot of the model for the cloud sync layer. */
  exportForSync(): TabsSyncPayload {
    return {
      tabs: this.tabs.map((tab) => ({ ...tab })),
      dirty: [...this.dirtyIds],
      tombstones: this.tombstones.map((entry) => ({ ...entry })),
    };
  }

  /**
   * Called by the cloud sync layer after a pull confirmed a tombstone is
   * stored remotely — the local record is no longer needed.
   */
  confirmTombstones(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const confirmed = new Set(ids);
    this.tombstones = this.tombstones.filter((entry) => !confirmed.has(entry.id));
    this.persistTombstones();
  }

  /**
   * Called by the cloud sync layer after a push confirmed that the given
   * note ids are now stored on the server. Without this, the local dirtyIds
   * set grew monotonically — every persist notification re-added every
   * historical dirty id to the pendingPush set, so the same rows were
   * pushed on every 30 s sync cycle forever, byte-for-byte identical.
   *
   * Only entries that the server actually acknowledged are dropped. Any id
   * marked dirty after the push snapshot was taken stays dirty for the
   * next cycle — see exportForSync() for the snapshot semantics.
   */
  confirmPushed(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      this.dirtyIds.delete(id);
    }
  }

  /**
   * Replaces the model with a merged tab list coming from the sync layer.
   * The editor only reloads when the user is not actively typing in it, so a
   * background pull can never swallow keystrokes.
   */
  applyExternalMerge(nextTabs: NoteTab[]): void {
    const activeBefore = this.getActive();

    this.tabs = nextTabs.map((tab) => ({
      ...tab,
      // Sanitize is the html discipline; every other kind crosses the
      // merge byte-exact.
      content: isHtmlContent(tab.noteType) ? sanitizeNoteHtml(tab.content) : tab.content,
    }));

    if (!this.tabs.some((tab) => tab.id === this.activeId)) {
      this.activeId = this.tabs[0]?.id ?? null;
      if (!this.activeId) {
        const fresh = createTab(WELCOME_HTML);
        this.tabs.push(fresh);
        this.activeId = fresh.id;
      }
    }

    this.persist();
    this.renderStrip();

    const active = this.getActive();
    if (active) {
      const editorFocused = this.isEditorFocused();
      const contentChanged =
        !activeBefore || activeBefore.id !== active.id
          ? true
          : activeBefore.content !== active.content || activeBefore.name !== active.name;

      if (contentChanged && !editorFocused) {
        this.loadActiveIntoEditor();
      }
      this.notifyActiveChanged();
    }
  }

  /**
   * True when the user is typing in the editor (or its PiP window). The old
   * check compared activeElement against `#note` directly, which only ever
   * matches one surface — the Markdown host never holds the caret itself
   * (it lives in the nested editing root or the source textarea), so a
   * merge repaint could swallow in-flight markdown keystrokes. Containment
   * + ownerDocument covers every surface and the floating PiP document.
   */
  private isEditorFocused(): boolean {
    const el = this.editor.get(0);
    if (!el) return false;
    const owner = el.ownerDocument;
    const focused = owner?.activeElement;
    if (!focused) return false;
    return focused === el || el.contains(focused);
  }

  /** Debounced persistence for editor input — keeps typing smooth. */
  schedulePersist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist(false);
    }, 400);
  }

  getActive(): NoteTab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  /** Saves the editor's live content into the active tab. */
  saveActiveFromEditor(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }
    // Only editable surfaces have anything to save — a display-only
    // surface holds a card, not the note (see editor/surface.ts).
    const surface = noteSurfaceFor(active);
    if (!surface.editable) {
      return;
    }

    const html = surface.capture(this.editorHost());
    // Editable surfaces always answer a string; null (a display-only
    // surface) reads as "nothing to save" and exits the same way.
    if (html === null || html === active.content) {
      return;
    }

    active.content = html;
    active.updatedAt = nextUpdatedAt(active.updatedAt);
    active.colorTheme = currentThemeMode();
    this.dirtyIds.add(active.id);
    this.schedulePersist();
    this.refreshTabLabel(active.id);
  }

  /** Persists the editor content immediately (snapshot restore, clear, …). */
  syncAfterExternalEdit(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }
    // Same surface rule as saveActiveFromEditor: editable kinds only.
    const surface = noteSurfaceFor(active);
    if (!surface.editable) {
      return;
    }

    active.content = surface.capture(this.editorHost()) ?? active.content;
    active.updatedAt = nextUpdatedAt(active.updatedAt);
    active.colorTheme = currentThemeMode();
    this.dirtyIds.add(active.id);
    this.persist();
    this.refreshTabLabel(active.id);
  }

  // ---- editor sync -----------------------------------------------------------

  /** The editor host element — the DOM node surfaces paint into. */
  private editorHost(): HTMLElement | null {
    return this.editor.get(0) as HTMLElement | null;
  }

  /**
   * Focuses the active note's editable element. The html host IS the
   * editable; a Markdown note mounts its own editor inside a host the
   * manager must not focus directly (the host can't take a caret), so the
   * surface is asked for the element that can. Without this, switching to
   * a markdown note landed focus on <body> and the first keystrokes went
   * nowhere until the user clicked into the note.
   *
   * Two fallbacks keep the promise for every surface and every moment:
   * a surface WITHOUT focusTarget answers its host (the old behavior,
   * exactly) — and a surface WITH one whose editor is still building
   * (a fresh mount is async) answers null now, so the ask is retried a
   * bounded number of frames until the root exists. The retry carries
   * the tab id it was requested for: a switch that happens mid-retry
   * wins, and a retry never steals focus after the user moved on.
   */
  private focusEditor(attempt = 0, forTabId = this.activeId): void {
    const host = this.editorHost();
    if (!host) {
      return;
    }
    const surface = noteSurfaceFor(this.getActive());
    if (typeof surface.focusTarget === 'function') {
      const target = surface.focusTarget(host);
      if (target) {
        target.focus();
        return;
      }
      if (attempt < MAX_FOCUS_RETRIES && this.activeId === forTabId) {
        requestAnimationFrame(() => this.focusEditor(attempt + 1, forTabId));
      }
      return;
    }
    host.focus();
  }

  private loadActiveIntoEditor(): void {
    const host = this.editorHost();
    if (!host) {
      return;
    }
    // The surface registry owns what a note kind shows (editor/surface.ts):
    // html notes get the port-driven editing pipeline, everything this
    // build can't edit gets the read-only card. The manager no longer
    // knows how — that is the seam a new note kind (Markdown, a board)
    // plugs into.
    const incoming = noteSurfaceFor(this.getActive());
    // The lifecycle half of that seam: when the PAINTER changes, the
    // outgoing surface stands down first (its editor, history, and any
    // UI it parked outside the host — a markdown note's floating grip
    // lives in document.body and would otherwise freeze visible over
    // the next note). Within one surface the editor is reused, so
    // markdown→markdown keeps its fast re-apply path.
    if (this.paintedBy && this.paintedBy !== incoming) {
      this.paintedBy.dismiss?.(host);
    }
    this.paintedBy = incoming;
    incoming.display(host, this.getActive());
  }

  getActiveText(): string {
    const active = this.getActive();
    if (!active) {
      return '';
    }
    // The surface owns the text projection: editing surfaces read the live
    // host, display-only ones read the model's raw content — statistics
    // and exports must never report the placeholder card's copy as the
    // note's text.
    return noteSurfaceFor(active).visibleText(this.editorHost(), active);
  }

  clearActiveTab(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }

    noteSurfaceFor(active).clear(this.editorHost()!);
    active.content = '';
    active.updatedAt = nextUpdatedAt(active.updatedAt);
    this.dirtyIds.add(active.id);
    this.persist();
    this.refreshTabLabel(active.id);
    this.editor.trigger('focus');
    // The pill (and anything else riding the active-note change) refreshes
    // here too — clear used to leave the old counts up until the next
    // keystroke.
    this.notifyActiveChanged();
  }

  /**
   * Restores a snapshot into the active note — the snapshot restore path.
   * The snapshot owns the note's KIND from here on: a plain, rich or
   * markdown restore sets the type accordingly, so the chrome that reads
   * the kind (markdown toolbar, the port's inertness, the tab badge)
   * cannot disagree with the content that just landed. Html snapshots
   * commit through the surface (the port sanitizes and persists, same as
   * setEditorHtml); every other kind is written to the model directly,
   * because no editing surface exists for it.
   */
  applySnapshotToActive(content: string, noteType?: NoteType, colorTheme?: 'light' | 'dark'): void {
    const active = this.getActive();
    if (!active) {
      return;
    }

    // The type moves first: loadActiveIntoEditor and the surfaces read it
    // to pick the painter, and a stale kind means html content re-rendered
    // as markdown source after the next reload.
    if (noteType && noteType !== DEFAULT_NOTE_TYPE) {
      active.noteType = noteType;
    } else {
      delete active.noteType;
    }

    if (isHtmlContent(noteType)) {
      // Ink theme: a snapshot taken under the OTHER theme carries that
      // theme's hex colors. The normal open path re-inks on display
      // (noteRenderedForTheme) — the commit path never does, and the
      // downstream syncAfterExternalEdit stamps the CURRENT theme onto
      // foreign ink, which then persists forever (near-black text on the
      // dark surface). Re-ink the markup BEFORE it commits so the capture,
      // the stamp, and the stored bytes all agree.
      let restoredContent = content;
      const mode = currentThemeMode();
      if (colorTheme && colorTheme !== mode) {
        const scratch = document.createElement('div');
        scratch.innerHTML = content;
        transformNoteColors(scratch, colorTheme, mode);
        restoredContent = scratch.innerHTML;
      }
      // The snapshot may switch the note's kind (a markdown note restored
      // as html): the painter changes outside loadActiveIntoEditor, so the
      // outgoing surface stands down here first — its editor and floating
      // chrome must not survive into the repainted host.
      const host = this.editorHost();
      if (this.paintedBy && this.paintedBy !== htmlNoteSurface) {
        if (host) {
          this.paintedBy.dismiss?.(host);
        }
        this.paintedBy = htmlNoteSurface;
      }
      const committed = noteSurfaceForKind('html').commit(this.editorHost(), restoredContent);
      if (!committed) {
        // Bare-DOM fallback (pre-boot paths): the surface painted the
        // sanitized content; the save is ours.
        this.syncAfterExternalEdit();
      }
    } else {
      active.content = content;
      active.updatedAt = nextUpdatedAt(active.updatedAt);
      this.dirtyIds.add(active.id);
      this.persist();
      this.loadActiveIntoEditor();
    }

    // The active TAB did not change — its type did. Chrome follows active
    // changes (the toolbar visibility sync, the port's inertness, the word
    // pill), so announce the switch the same way a tab change would.
    this.notifyActiveChanged();
    this.refreshTabLabel(active.id);
  }

  // ---- strip rendering --------------------------------------------------------

  private renderStrip(): void {
    const stripElement = this.strip.get(0) as HTMLElement | undefined;
    if (!stripElement) {
      return;
    }

    // Rebuild by clearing the node directly so event handlers die with the
    // children (no retained listeners on surviving parents).
    stripElement.textContent = '';

    this.tabs.forEach((tab) => {
      stripElement.appendChild(this.buildTabElement(tab));
    });

    this.renderRailCount();
  }

  private renderRailCount(): void {
    const count = document.getElementById(RAIL_COUNT_ID);
    if (count) {
      count.textContent = String(this.tabs.length);
    }
  }

  private buildTabElement(tab: NoteTab): HTMLElement {
    const button = document.createElement('div');
    button.className = 'tab-strip-tab' + (tab.id === this.activeId ? ' active' : '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === this.activeId));
    button.dataset.tabId = tab.id;
    button.title = tab.name ? tab.name : 'Double-click to rename';

    if (tab.noteType && tab.noteType !== DEFAULT_NOTE_TYPE) {
      const typeBadge = document.createElement('span');
      typeBadge.className = 'tab-strip-type';
      typeBadge.title = `${noteTypeLabel(tab.noteType)} — created via the type menu`;
      typeBadge.setAttribute('aria-hidden', 'true');
      // Icons exist for known types; a future type still badges, with the
      // registry's plain-text mark standing in until this build learns it.
      const icon = NOTE_TYPE_ICONS[tab.noteType as KnownNoteType];
      typeBadge.innerHTML = icon
        ? icon(10)
        : `<span style="font-size:9px;font-weight:700;line-height:1">${noteTypeLabel(tab.noteType).charAt(0).toLowerCase()}</span>`;
      button.appendChild(typeBadge);
    }

    const title = document.createElement('span');
    title.className = 'tab-strip-title';
    title.textContent = deriveTabTitle(tab);
    button.appendChild(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-strip-close';
    close.setAttribute('aria-label', `Close tab ${deriveTabTitle(tab)}`);
    close.title = 'Close tab';
    close.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    button.appendChild(close);

    return button;
  }

  private refreshTabLabel(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    const element = this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`);
    if (!tab || element.length === 0) {
      return;
    }

    element.find('.tab-strip-title').text(deriveTabTitle(tab));
    if (tab.id === this.activeId) {
      this.syncDocumentTitle();
    }
  }

  /** The browser tab mirrors the note's name so a row of pinned tabs
   *  says which note each holds. Follows every path the tab strip label
   *  follows (typing, rename, switch), through the same deriveTabTitle,
   *  so the two never disagree. Two naming rules from the task list: the
   *  separator is a plain hyphen-minus " - " (nothing that can read as
   *  part of the note's own name — emdash and pipe both did), and an
   *  INSTALLED app gets the bare note name — the standalone window's
   *  chrome already says "Padify", and "Padify - Padify" is what a
   *  suffix produced there. */
  private syncDocumentTitle(): void {
    const active = this.getActive();
    if (!active) {
      document.title = 'Padify';
      return;
    }
    document.title = isInstalledDisplayMode()
      ? deriveTabTitle(active)
      : `${deriveTabTitle(active)} - Padify`;
  }

  private bindStripEvents(): void {
    const stripElement = this.strip.get(0);
    if (!stripElement) {
      return;
    }

    // Delegated: switch on click, close on ×, rename on double-click.
    stripElement.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const tabElement = target.closest<HTMLElement>('.tab-strip-tab');
      if (!tabElement) {
        return;
      }

      const tabId = tabElement.dataset.tabId!;

      if (target.closest('.tab-strip-close')) {
        event.stopPropagation();
        this.requestCloseTab(tabId);
        return;
      }

      if (tabId !== this.activeId) {
        this.switchTo(tabId);
      } else {
        this.focusEditor();
      }
    });

    stripElement.addEventListener('auxclick', (event) => {
      // Middle-click closes, like browser tabs.
      if ((event as MouseEvent).button !== 1) {
        return;
      }
      const tabElement = (event.target as HTMLElement).closest<HTMLElement>('.tab-strip-tab');
      if (tabElement) {
        event.preventDefault();
        this.requestCloseTab(tabElement.dataset.tabId!);
      }
    });

    stripElement.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement;
      const tabElement = target.closest<HTMLElement>('.tab-strip-tab');
      if (tabElement && !target.closest('.tab-strip-close')) {
        event.preventDefault();
        this.beginRename(tabElement.dataset.tabId!);
      }
    });

    $('#addTab').on('click', () => {
      this.addTab();
    });
  }

  // ---- actions -----------------------------------------------------------------

  switchTo(tabId: string, focusEditor = true): void {
    if (tabId === this.activeId) {
      return;
    }

    this.saveActiveFromEditor();
    this.activeId = tabId;
    this.persist();
    this.renderStrip();
    this.loadActiveIntoEditor();

    if (focusEditor) {
      this.focusEditor();
    }

    this.notifyActiveChanged();
  }

  addTab(focusEditor = true, noteType: NoteType = DEFAULT_NOTE_TYPE): void {
    this.saveActiveFromEditor();

    const tab = createTab('', null, noteType);
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.dirtyIds.add(tab.id);
    this.persist();

    this.strip.get(0)!.appendChild(this.buildTabElement(tab));
    this.setActiveClass();
    this.renderRailCount();
    this.loadActiveIntoEditor();
    this.scrollTabIntoView(tab.id);

    if (focusEditor) {
      this.focusEditor();
    }

    this.notifyActiveChanged();
    showToast(
      noteType === DEFAULT_NOTE_TYPE
        ? 'New note created.'
        : `New ${noteTypeLabel(noteType).toLowerCase()} created.`,
    );
  }

  private requestCloseTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }

    const isActive = tabId === this.activeId;
    // Capture the live editor FIRST when closing the active tab: the
    // emptiness gate below reads the surface, but the snapshot argument
    // reads the model — inside the input debounce window those disagree,
    // so a close could skip the safety snapshot (or store it missing the
    // last words) for exactly the content the user is trying to keep.
    if (isActive) {
      this.saveActiveFromEditor();
    }
    const text = isActive ? this.getActiveText() : htmlToText(tab.content);

    const closeNow = async (): Promise<void> => {
      // Keep a safety snapshot behind the user's back, like delete-notes does.
      // Await so the snapshot actually lands before the tab is removed.
      // The snapshot must capture THE CLOSING TAB — createSnapshot() reads
      // the ACTIVE note, so closing a background tab stored the wrong
      // note (or none, when the active note declined as empty/duplicate).
      if (text.trim() && window.snapshotsManager) {
        try {
          await window.snapshotsManager.createSnapshotFromNote(
            tab.content,
            tab.noteType,
            tab.id,
            `Before closing "${deriveTabTitle(tab)}"`,
            tab.colorTheme,
          );
        } catch {
          /* snapshots unavailable — the close still proceeds */
        }
      }

      const index = this.tabs.findIndex((entry) => entry.id === tabId);
      this.tabs = this.tabs.filter((entry) => entry.id !== tabId);
      this.dirtyIds.delete(tabId);
      this.recordTombstone(tabId);

      if (this.tabs.length === 0) {
        const fresh = createTab('');
        this.tabs.push(fresh);
        this.activeId = fresh.id;
        this.persist();
        this.renderStrip();
        this.loadActiveIntoEditor();
        this.focusEditor();
        this.notifyActiveChanged();
        showToast('Tab closed. A fresh tab is ready.');
        return;
      }

      if (isActive) {
        const neighbour = this.tabs[Math.max(0, index - 1)] ?? this.tabs[0];
        this.activeId = neighbour.id;
        this.persist();
        this.renderStrip();
        this.loadActiveIntoEditor();
        this.focusEditor();
        this.notifyActiveChanged();
      } else {
        this.persist();
        this.renderStrip();
      }

      showToast('Tab closed.');
    };

    if (!text.trim()) {
      void closeNow();
      return;
    }

    Swal.fire({
      title: 'Close this tab?',
      text: `"${deriveTabTitle(tab)}" has content. A snapshot is saved before it closes.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Close tab',
      cancelButtonText: 'Keep it',
    }).then((result) => {
      if (result.isConfirmed) {
        void closeNow();
      }
    });
  }

  private beginRename(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    const element = this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`);
    if (!tab || element.length === 0 || element.find('.tab-strip-rename').length > 0) {
      return;
    }

    const titleElement = element.find('.tab-strip-title');
    const currentName = tab.name ?? deriveTabTitle(tab);

    const input = $(
      '<input type="text" class="tab-strip-rename" maxlength="60" aria-label="Tab name">',
    ).val(currentName);
    titleElement.replaceWith(input);
    input.trigger('focus');

    const commit = (keep: boolean): void => {
      const raw = String(input.val() ?? '').trim();
      if (keep && raw && raw !== currentName) {
        tab.name = raw;
        tab.updatedAt = nextUpdatedAt(tab.updatedAt);
        this.dirtyIds.add(tab.id);
        this.persist();
        showToast('Tab renamed.');
      }
      element
        .find('.tab-strip-rename')
        .replaceWith($('<span class="tab-strip-title"></span>').text(deriveTabTitle(tab)));
      element.attr('title', tab.name ? tab.name : 'Double-click to rename');
    };

    input.on('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(true);
        this.focusEditor();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        commit(false);
      }
    });
    input.on('blur', () => commit(true));
    input.on('click', (event) => event.stopPropagation());
    input.on('dblclick', (event) => event.stopPropagation());
  }

  /** Ctrl/Cmd + Alt + ←/→ moves between tabs. */
  cycle(delta: number): void {
    if (this.tabs.length < 2) {
      return;
    }

    const index = this.tabs.findIndex((entry) => entry.id === this.activeId);
    const next = this.tabs[(index + delta + this.tabs.length) % this.tabs.length];
    this.switchTo(next.id);
  }

  private scrollTabIntoView(tabId: string): void {
    (
      this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`).get(0) as HTMLElement | undefined
    )?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private setActiveClass(): void {
    this.strip.find('.tab-strip-tab').each((_index, element) => {
      const $element = $(element);
      const isActive = $element.data('tab-id') === this.activeId;
      $element.toggleClass('active', isActive);
      $element.attr('aria-selected', String(isActive));
    });
  }

  /** Hook for app.ts to refresh the word-count pill on tab switches. */
  onActiveChanged: ((tab: NoteTab) => void) | null = null;

  /** Hook for the cloud sync layer — fires after every model persist. */
  onPersist: ((payload: TabsSyncPayload) => void) | null = null;

  private notifyActiveChanged(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }
    this.syncDocumentTitle();
    if (this.onActiveChanged) {
      this.onActiveChanged(active);
    }
    this.activeListeners.forEach((listener) => listener(active));
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor — app.ts wires it up, other modules (utils, snapshots,
// unicode picker) read it through here.
// ---------------------------------------------------------------------------

let tabManagerInstance: TabManager | null = null;

export function setTabManager(manager: TabManager): void {
  tabManagerInstance = manager;
}

export function getTabManager(): TabManager | null {
  return tabManagerInstance;
}

/** Plain text of the note currently shown in the editor. */
export function getEditorText(): string {
  return tabManagerInstance?.getActiveText() ?? '';
}

/**
 * The active note's true content — the capture path for snapshots AND
 * share links. Notes with an editing surface read the LIVE host through
 * THEIR surface (keystrokes still inside the debounce window are worth
 * keeping); display-only kinds read the model, because the host is showing
 * a placeholder card — the note's real content never entered it.
 */
export function getActiveNoteContent(): {
  content: string;
  noteType: NoteType | undefined;
} | null {
  const active = tabManagerInstance?.getActive();
  if (!active) {
    return null;
  }
  if (noteSurfaceFor(active).editable) {
    // THE ACTIVE NOTE'S surface — not the html one: a Markdown note's
    // content is its markdown source, and reading it through the html
    // host would capture the wrong surface's DOM.
    const host = document.getElementById('note');
    return {
      content: noteSurfaceFor(active).capture(host) ?? active.content,
      noteType: active.noteType,
    };
  }
  return { content: active.content, noteType: active.noteType };
}

/**
 * Inserts plain text into the ACTIVE note's surface at its caret — the
 * seam voice typing and the unicode picker use. Routes through the
 * active note's surface (every editing kind gets its own insertion path);
 * false means nobody could take it and the caller's fallbacks stand.
 */
export function insertTextIntoActiveNote(text: string): boolean {
  const active = tabManagerInstance?.getActive();
  if (!active || text === '') {
    return false;
  }
  return noteSurfaceFor(active).insertText?.(document.getElementById('note'), text) ?? false;
}

/**
 * The body for the "Download as HTML" export — the third capture path
 * beside snapshots and share links, and the same rule: notes with an
 * editing surface read the LIVE host, display-only kinds read the model.
 * Exporting must never serialize whatever the host SURFACE happens to be
 * showing: for a non-editable note that surface is a read-only placeholder
 * card, and the export would ship the card instead of the note.
 *
 * Non-html content is escaped into a <pre>: a JSON note exported as raw
 * markup would be broken by its own angle brackets, and the point of the
 * export is what the note holds, not an approximation of it re-parsed as
 * HTML. Markdown is the one exception — its source IS meant to become
 * markup, and the owned renderer (editor/markdown/render.ts) produces
 * exactly what the preview and a share link show, safe by construction.
 * Returns null when no note is open.
 */
export function getActiveNoteExportBody(): string | null {
  const captured = getActiveNoteContent();
  if (!captured) {
    return null;
  }
  if (captured.noteType === 'markdown') {
    return renderMarkdownToHtml(captured.content);
  }
  if (isHtmlContent(captured.noteType)) {
    return sanitizeNoteHtml(captured.content);
  }
  return `<pre>${escapeHtml(captured.content)}</pre>`;
}

/**
 * HTML of the note currently shown in the editor — the html surface's
 * live capture, routed through the EditorPort (see editor/port.ts) with
 * the bare-DOM fallback for the rare paths that run before the
 * composition root installed the port.
 */
export function getEditorHtml(): string {
  return htmlNoteSurface.capture(document.getElementById('note'));
}

/** Replaces the editor content (sanitized in the surface/port) and persists. */
export function setEditorHtml(html: string): void {
  const element = document.getElementById('note');
  if (htmlNoteSurface.commit(element, html)) {
    // The port applied it and persisted via its onDocumentReplaced wiring.
    return;
  }
  if (element === null) {
    return;
  }
  // Bare fallback: the surface painted the sanitized content — persist now.
  tabManagerInstance?.syncAfterExternalEdit();
}
