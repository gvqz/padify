/**
 * Padify note tabs — multiple notes in one editor.
 *
 * Tabs live on the main page alongside the rich text formatting (merged in
 * from the old standalone Tabbypad tool, which no longer ships as a separate
 * page). Every tab is an independent note with its own rich content,
 * autosaved per-record into the padify IndexedDB store (see src/storage/):
 *
 *   notes store    → one row per note: { id, name, html, createdAt,
 *                    updatedAt, position } — deletions are TRASH rows
 *                    (deleted=true, deletedAt stamped, content kept),
 *                    exactly like the cloud schema; a save writes only
 *                    the changed rows
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
import { confirmDialog } from './ui/dialog';
import { showToast } from './ui/toast';
import {
  ACTIVE_TAB_KEY,
  loadNotes,
  saveNotes,
  stateGet,
  stateRemove,
  readNoteConflict,
  type NoteConflictRecord,
  type StoredNoteTab,
  type TrashedNote,
} from './storage';
import { sanitizeNoteHtml } from './editor/storage-subset';
import { currentThemeMode, transformNoteColors } from './editor/theme-colors';
import { parseTaskNoteContent } from './editor/tasks/content';
import { formatDueChip } from './editor/tasks/dates';
import {
  htmlNoteSurface,
  noteSurfaceFor,
  noteSurfaceForKind,
  type NoteSurface,
} from './editor/surface';
import { renderMarkdownToHtml } from './editor/markdown/render';
import { convertNoteContent } from './editor/note-convert';
import { deriveTabTitle, escapeHtml, legacyTextToHtml, WELCOME_HTML } from './editor/note-content';
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
  /**
   * The last version the cloud agreed to (content + name) — the common
   * ancestor of a three-way merge (see src/merge/ and storage/notes.ts's
   * StoredNoteTab.syncBase). Cloud-only metadata: adopted on confirmed
   * pushes and clean adoptions, never on local edits, so it always names
   * a version that exists on the server.
   */
  syncBase?: { content: string; name: string | null };
  /**
   * An unresolved divergence awaiting review: the note was changed on
   * two devices at once, their version took the canonical row, and THIS
   * device's unpushed words wait in `mine` (see cloud/sync.ts — the merge
   * parks instead of minting a "conflicted copy" twin). The strip badges
   * it; the review sheet resolves it; editing the note does not clear it
   * (only a resolution or the note's death does).
   */
  conflict?: NoteConflict;
  /**
   * The note changed on another device while it was NOT the active one
   * (a sync merge repainted an unopened tab). `from` holds the bytes this
   * device last had — the baseline the next open diffs against to show
   * what arrived since. Consumed by the next switchTo: cleared from the
   * note (the peek fires once per change, never on every re-open) and
   * handed to onUnseenPeek. Rides storage so a change that outlives a
   * reload still peeks on the next open; never crosses the wire. A note
   * with a parked `conflict` never gains one — the review badge owns it.
   */
  unseenChange?: { from: string; fromName: string | null };
  /**
   * Conflicted-copy lineage (LEGACY — pre-review builds minted twin notes
   * and marked them; nothing writes it anymore, existing values ride
   * storage untouched and unread).
   */
  copyOf?: string;
}

/** One parked version conflict — see NoteTab.conflict. */
export type NoteConflict = NoteConflictRecord;

const LEGACY_NOTE_KEY = 'note';

/** Notifies the rail's count badge (and any other listener) about tab count. */
const RAIL_COUNT_ID = 'tabRailCount';

/**
 * Everything the cloud sync layer needs after the model changed. The
 * `trashed` list rides along so the sync layer can push trash rows (and
 * the share layer can revoke links) — entries stay in the model until
 * retention retires them, unlike the tombstones they replaced.
 */
export interface TabsSyncPayload {
  /** Current tab list (already persisted to localStorage). */
  tabs: NoteTab[];
  /** Tab ids whose content/name changed since the last persist. */
  dirty: string[];
  /** The trash: deleted notes kept restorable for the retention window. */
  trashed: TrashedNote[];
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
  /** Every open note, in strip order — read-only for the layers that
   *  aggregate across notes (the tasks feature's views). */
  get allTabs(): readonly NoteTab[] {
    return this.tabs;
  }

  private tabs: NoteTab[] = [];
  private activeId: string | null = null;
  private readonly editor: Q;
  private readonly strip: Q;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The trash — deleted notes kept restorable for the retention window
   *  (content included). Lives beside the tabs, syncs as deleted rows. */
  private trashed: TrashedNote[] = [];
  private dirtyIds: Set<string> = new Set();
  private persistListeners: Set<(payload: TabsSyncPayload) => void> = new Set();
  private activeListeners: Set<(tab: NoteTab) => void> = new Set();
  private trashListeners: Set<() => void> = new Set();
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
    this.trashed = snapshot.trashed.filter(
      (entry) => entry && typeof entry.id === 'string' && typeof entry.deletedAt === 'number',
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
          syncBase: entry.syncBase,
          unseenChange: entry.unseenChange,
          conflict: readNoteConflict(entry.conflict),
          copyOf: typeof entry.copyOf === 'string' && entry.copyOf ? entry.copyOf : undefined,
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
    saveNotes({ tabs: this.tabs, trashed: this.trashed }, this.activeId, { immediate });

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

  /**
   * Fires whenever a note moved to the trash — the delete receipt the
   * History button in the top bar turns into its trash flash (the toast
   * owns the words and the Undo; this owns the "where did it go" gesture
   * on the door the note just arrived behind).
   */
  addTrashListener(listener: () => void): () => void {
    this.trashListeners.add(listener);
    return () => {
      this.trashListeners.delete(listener);
    };
  }

  // ---- sync support ---------------------------------------------------------

  /** Snapshot of the model for the cloud sync layer. */
  exportForSync(): TabsSyncPayload {
    return {
      tabs: this.tabs.map((tab) => ({ ...tab })),
      dirty: [...this.dirtyIds],
      trashed: this.trashed.map((entry) => ({ ...entry })),
    };
  }

  /**
   * Replaces the trash list after a sync merge. Called only when the merge
   * actually changed it — the strip never depends on trash rows, so this
   * is a silent model+persist swap (the rail badge refresh is the UI's to
   * own through its persist listener).
   */
  applyExternalTrash(trashed: TrashedNote[]): void {
    this.trashed = trashed.map((entry) => ({ ...entry }));
    this.persist();
    this.renderRailCount();
  }

  /** The trash, newest first — the trash sheet's read. */
  getTrashed(): readonly TrashedNote[] {
    return [...this.trashed]
      .filter((entry) => !entry.purged)
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /**
   * Called by the cloud sync layer after a push confirmed that the given
   * note ids are now stored on the server. Without this, the local dirtyIds
   * set grew monotonically — every persist notification re-added every
   * historical dirty id to the pendingPush set, so the same rows were
   * pushed on every 30 s sync cycle forever, byte-for-byte identical.
   *
   * A confirmed push also retires PURGED placeholders (trash rows emptied
   * for a delete-forever whose sweeper row just landed — see purgeNote):
   * their job is done the moment the cloud accepted them.
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
    // Purged placeholders leave once their sweeper row is stored — there is
    // nothing left to show, restore or push for them.
    const confirmed = new Set(ids);
    if (this.trashed.some((entry) => entry.purged && confirmed.has(entry.id))) {
      this.trashed = this.trashed.filter((entry) => !(entry.purged && confirmed.has(entry.id)));
      this.persist();
      this.renderRailCount();
    }
  }

  /**
   * Called by the cloud sync layer after a push whose response carried the
   * stamped rows (trash-aware servers answer with what landed): each note
   * adopts its fresh seq AND its merge base — the exact (content, name)
   * the server now holds, the ancestor every future three-way merge diffs
   * from. A note whose words moved on since the snapshot keeps them; only
   * the sync metadata moves.
   */
  adoptPushedRows(
    rows: Array<{ id: string; seq: number; content: string; name: string | null }>,
  ): void {
    if (rows.length === 0) {
      return;
    }
    let touchedAny = false;
    for (const row of rows) {
      const tab = this.tabs.find((entry) => entry.id === row.id);
      if (!tab) {
        continue;
      }
      if (row.seq > 0 && row.seq !== tab.syncSeq) {
        tab.syncSeq = row.seq;
        touchedAny = true;
      }
      const nextBase = { content: row.content, name: row.name };
      if (tab.syncBase?.content !== nextBase.content || tab.syncBase?.name !== nextBase.name) {
        tab.syncBase = nextBase;
        touchedAny = true;
      }
    }
    if (touchedAny) {
      this.persist();
    }
  }

  /**
   * Replaces the model with a merged tab list coming from the sync layer.
   * The editor only reloads when the user is not actively typing in it, so a
   * background pull can never swallow keystrokes.
   *
   * `forceRepaintIds` names notes the sync layer AUTO-MERGED (both devices'
   * edits now live in one version, see src/merge/): those repaint even when
   * the editor holds the caret — the editor's pre-merge bytes do NOT
   * contain the other device's words, and the next capture would overwrite
   * the merged version with them, silently dropping half the merge. The
   * capture that fed the merge already saved the local words, so the
   * repaint costs nothing but the caret's place.
   */
  applyExternalMerge(nextTabs: NoteTab[], forceRepaintIds: readonly string[] = []): void {
    const activeBefore = this.getActive();
    const forceRepaint = new Set(forceRepaintIds);
    // The pre-merge model, keyed for the unseen-change stamp below — the
    // merge's rows replace this.tabs wholesale, so the "what did this
    // device last have" question must be asked before the swap.
    const beforeById = new Map(this.tabs.map((tab) => [tab.id, tab]));

    this.tabs = nextTabs.map((tab) => {
      const next: NoteTab = {
        ...tab,
        // Sanitize is the html discipline; every other kind crosses the
        // merge byte-exact.
        content: isHtmlContent(tab.noteType) ? sanitizeNoteHtml(tab.content) : tab.content,
      };
      // Words arrived on a note nobody is looking at — park what this
      // device last had, so opening it can show the delta (see
      // NoteTab.unseenChange). The note you are watching is exempt (the
      // merge toast already speaks for it), and so is a parked conflict
      // (the review badge is the louder surface; stacking a peek on it
      // would be noise). A stamp already present keeps its ORIGINAL
      // baseline: consecutive pulls while the note stays unopened extend
      // the delta, they do not restart it.
      const before = beforeById.get(tab.id);
      if (
        before &&
        !next.conflict &&
        next.id !== this.activeId &&
        before.content !== next.content
      ) {
        next.unseenChange = before.unseenChange ?? { from: before.content, fromName: before.name };
      }
      return next;
    });

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

    // A merged-away tab can never push again — its pending dirty id would
    // otherwise sit in the set forever, re-serialized (and skipped) on
    // every cycle.
    if (this.dirtyIds.size > 0) {
      const alive = new Set(this.tabs.map((tab) => tab.id));
      for (const id of [...this.dirtyIds]) {
        if (!alive.has(id)) {
          this.dirtyIds.delete(id);
        }
      }
    }

    const active = this.getActive();
    if (active) {
      const editorFocused = this.isEditorFocused();
      const identityChanged = !activeBefore || activeBefore.id !== active.id;
      const contentChanged =
        identityChanged ||
        activeBefore!.content !== active.content ||
        activeBefore!.name !== active.name;
      const mergedActive = forceRepaint.has(active.id);

      // An identity change ALWAYS repaints, even mid-typing: the editor's
      // DOM belongs to a note that no longer exists (closed elsewhere),
      // and the next capture would write its words into whichever tab
      // landed active — cross-note contamination. The merge already
      // rescued the unpushed words into a conflicted copy, so the repaint
      // costs at most the last ~700ms of un-captured keystrokes. A
      // content change on the SAME note still defers to the typist: the
      // conflict machinery preserves the divergent words instead. An
      // auto-merged note breaks that deference on purpose — its new bytes
      // carry words the editor has never seen.
      if (identityChanged || mergedActive || (contentChanged && !editorFocused)) {
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

  /**
   * Drains a pending debounced persist NOW — the page is about to die.
   * saveActiveFromEditor (the unload hook's capture) only SCHEDULES the
   * write; without this flush, the last ~400ms of a session's edits sit
   * in a timer that dies with the page (a note completed and the tab
   * closed inside the window restored stale — the tasks e2e caught it).
   */
  flushPendingPersist(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.persist();
  }

  /**
   * Drops a pending debounced persist WITHOUT writing — the teardown
   * counterpart of schedulePersist. A 400ms trailing save that fires after
   * its owner's context is gone (a test boundary, a discarded surface)
   * resurrects rows the next boot just reseeded: the storage diff index is
   * wiped on reset, so the stale snapshot re-writes every row it holds as
   * if new. Tests call this in their teardown; production teardown paths
   * (a future PiP window close) are the natural next callers.
   */
  cancelPendingPersist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  getActive(): NoteTab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  /** Read-only view of the rail's notes — the note context menu finds its
   *  target note (the one under the cursor, not the active one) here. */
  getTabs(): readonly NoteTab[] {
    return this.tabs;
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
  focusEditor(attempt = 0, forTabId = this.activeId): void {
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
   * commit through the surface (the port sanitizes and persists); every
   * other kind is written to the model directly,
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

    // A parked version conflict gets the review badge. Its click is
    // DELEGATED through the strip (the single listener bindStripEvents
    // owns), per the listener-lifecycle rules — nothing per-node.
    if (tab.conflict) {
      const conflictBadge = document.createElement('span');
      conflictBadge.className = 'tab-strip-type tab-strip-conflict';
      conflictBadge.title = 'Changed on two devices — review the versions';
      conflictBadge.setAttribute('role', 'button');
      conflictBadge.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="12" r="2.6"/><path d="M8.2 7.4 15.5 11M8.2 16.6 15.5 13"/></svg>';
      button.appendChild(conflictBadge);
    }

    if (tab.noteType === 'tasks') {
      // A task list's badge is its own colored circle — the rail shows
      // the note AS a list (see editor/tasks/content.ts for the model).
      const listDot = document.createElement('span');
      listDot.className = 'tab-strip-type tab-strip-list-dot';
      listDot.title = 'Task list';
      listDot.setAttribute('aria-hidden', 'true');
      listDot.dataset.color = parseTaskNoteContent(tab.content).color;
      button.appendChild(listDot);
    } else if (tab.noteType && tab.noteType !== DEFAULT_NOTE_TYPE) {
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
    close.setAttribute('aria-label', `Move ${deriveTabTitle(tab)} to trash`);
    close.title = 'Move to trash';
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
    // A task list's strip badge is its color — the same save that lands
    // the new color in the note repaints the circle (the rail's dot
    // follows the aggregate; the strip needed its own refresh).
    const listDot = element.find('.tab-strip-list-dot');
    if (listDot.length > 0) {
      listDot.attr('data-color', parseTaskNoteContent(tab.content).color);
    }
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

      if (target.closest('.tab-strip-conflict')) {
        // The review badge is its own gesture — opening the review sheet
        // must not also switch notes under it.
        event.stopPropagation();
        this.onConflictReview?.(tabId);
        return;
      }

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
    // Opening the note answers the question a parked unseenChange was
    // holding: the marker is consumed HERE (before the persist, so the
    // clear rides this very save) and the peek fires after the editor
    // painted the new bytes — once per change, never on re-click.
    const opened = this.tabs.find((entry) => entry.id === tabId);
    const unseen = opened?.unseenChange;
    if (opened && unseen) {
      delete opened.unseenChange;
    }
    this.persist();
    this.renderStrip();
    this.loadActiveIntoEditor();

    if (focusEditor) {
      this.focusEditor();
    }

    this.notifyActiveChanged();

    // The peek defers to a parked conflict: the review badge on the same
    // note is the louder, more demanding surface — two sheets over one
    // open would be the stacking the review flow just removed.
    if (opened && unseen && !opened.conflict) {
      this.onUnseenPeek?.(opened, unseen);
    }
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

  /**
   * Appends a note WITHOUT activating it — the migration and the tasks
   * rail's "New Task List" use it to add fully-formed notes in a row.
   * The strip gets the tab; the editor never notices until the note is
   * opened. Returns the note (null when the cap said no).
   */
  addBackgroundNote(name: string, noteType: NoteType, content: string): NoteTab | null {
    const tab = createTab(content, name, noteType);
    if (name) {
      tab.name = name;
    }
    this.tabs.push(tab);
    this.dirtyIds.add(tab.id);
    this.strip.get(0)!.appendChild(this.buildTabElement(tab));
    this.renderRailCount();
    this.persist();
    return tab;
  }

  /**
   * Duplicates a note — the note menu's Duplicate. The copy carries the
   * source's content, type and ink theme under a "Copy of …" name, lands
   * right after the source in the rail, and opens (the gesture reads as
   * "here is my fresh copy"). Deliberately NOT a conflicted copy: the
   * clone has no copyOf lineage and wears no fork badge — it is a
   * duplicate the user asked for, not a sync accident.
   */
  duplicateNote(tabId: string): void {
    const source = this.tabs.find((entry) => entry.id === tabId);
    if (!source) {
      return;
    }
    if (source.id === this.activeId) {
      this.saveActiveFromEditor();
    }

    const copy = createTab(
      source.content,
      `Copy of ${deriveTabTitle(source)}`,
      source.noteType ?? DEFAULT_NOTE_TYPE,
    );
    if (source.colorTheme) {
      copy.colorTheme = source.colorTheme;
    }
    const index = this.tabs.findIndex((entry) => entry.id === tabId);
    this.tabs.splice(index + 1, 0, copy);
    this.dirtyIds.add(copy.id);
    this.persist();

    this.renderStrip();
    this.switchTo(copy.id);
    showToast(`Created "${deriveTabTitle(copy)}".`);
  }

  /**
   * Changes a note's type in place — the note menu's Change type submenu.
   * Switches to the note first (the painter and every chrome that reads
   * the kind follow the ACTIVE note), then converts the content through
   * the pair matrix (editor/note-convert.ts) instead of re-landing the
   * old bytes under the new kind — the verbatim move was how a rich note
   * turned into HTML soup in the markdown source and a task list read as
   * wiped. A lossy conversion asks first: the original rides into a
   * snapshot, the same deal closing a tab offers.
   */
  changeNoteType(tabId: string, noteType: NoteType): void {
    const target = this.tabs.find((entry) => entry.id === tabId);
    if (!target || (target.noteType ?? DEFAULT_NOTE_TYPE) === noteType) {
      return;
    }
    // The active note's newest words still live in the editor — capture
    // them so the conversion reads what the user sees (duplicateNote's deal).
    if (tabId === this.activeId) {
      this.saveActiveFromEditor();
    }
    const from = target.noteType ?? DEFAULT_NOTE_TYPE;
    const conversion = convertNoteContent(target.content, from, noteType);
    if (!conversion.convertible) {
      showToast(
        `"${deriveTabTitle(target)}" is a note type this Padify doesn't know — it can't be converted here.`,
      );
      return;
    }
    if (conversion.lossy) {
      void confirmDialog({
        title: `Convert to ${noteTypeLabel(noteType)}?`,
        text: `${conversion.lossNote ?? 'Some content cannot carry over.'} A snapshot of the note is saved first.`,
        confirm: 'Convert',
        cancel: 'Keep it',
      }).then((confirmed) => {
        if (confirmed) {
          void this.convertAfterSnapshot(target.id, noteType, conversion.content);
        }
      });
      return;
    }
    this.applyTypeConversion(tabId, noteType, conversion.content);
    showToast(`Note type: ${noteTypeLabel(noteType).toLowerCase()}.`);
  }

  /** The lossy arm: the confirmed conversion snapshots the original
   *  first (best effort — a snapshots outage must not block the move),
   *  then lands the converted content. */
  private async convertAfterSnapshot(
    tabId: string,
    noteType: NoteType,
    content: string,
  ): Promise<void> {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (tab && window.snapshotsManager) {
      try {
        await window.snapshotsManager.createSnapshotFromNote(
          tab.content,
          tab.noteType,
          tab.id,
          `Before converting "${deriveTabTitle(tab)}" to ${noteTypeLabel(noteType).toLowerCase()}`,
          tab.colorTheme,
          tab.name ?? undefined,
        );
      } catch {
        /* snapshots unavailable — the conversion still proceeds */
      }
    }
    this.applyTypeConversion(tabId, noteType, content);
    showToast(`Note type: ${noteTypeLabel(noteType).toLowerCase()}.`);
  }

  /** Lands converted content under the new kind — switch-to-first, then
   *  the restore path applySnapshotToActive owns (painter swap, the html
   *  commit, the re-ink). The strip re-renders so the type badge follows:
   *  a task list's dot, a markdown note's icon — the label refresh alone
   *  left a stale badge behind. */
  private applyTypeConversion(tabId: string, noteType: NoteType, content: string): void {
    if (this.getActive()?.id !== tabId) {
      this.switchTo(tabId);
    }
    const active = this.getActive();
    if (!active || active.id !== tabId) {
      return;
    }
    this.applySnapshotToActive(content, noteType, active.colorTheme);
    this.renderStrip();
  }

  /**
   * Renames a tab programmatically — the tasks surface's page title and
   * the rail's quick-rename flows. Same rules as the strip's inline
   * rename (blank never wins; the model leads, the label follows), minus
   * the toast (the caller owns the feedback).
   */
  renameTab(tabId: string, name: string): boolean {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) return false;
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed || trimmed === tab.name) return false;
    tab.name = trimmed;
    tab.updatedAt = nextUpdatedAt(tab.updatedAt);
    this.dirtyIds.add(tab.id);
    this.persist();
    this.refreshTabLabel(tab.id);
    return true;
  }

  /**
   * Writes a note's content from OUTSIDE the editor — the tasks hub and
   * the reminder sweep edit task notes that are not (necessarily) the
   * active one. The ACTIVE note repaints through its surface (so a task
   * list open behind the hub stays truthful); a background note just
   * takes the bytes. Persistence flows the normal dirty-note path.
   */
  writeNoteContent(tabId: string, content: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab || tab.content === content) return;
    tab.content = content;
    tab.updatedAt = nextUpdatedAt(tab.updatedAt);
    this.dirtyIds.add(tab.id);
    if (tab.id === this.activeId) {
      // The live surface repaints from the new bytes; commit answers
      // false (the caller owns persistence) so persist exactly once.
      noteSurfaceFor(tab).commit(this.editorHost(), content);
    }
    this.persist();
  }

  /**
   * Moves a note to the trash — the strip's ×, the middle-click and the note
   * menu's "Move to trash".
   *
   * The trash IS the undo path, so there is no confirmation dialog and no
   * safety snapshot: the note's full record (content, name, type, ink theme)
   * moves to the trashed list with a fresh deletedAt stamp, restorable for
   * the retention window, and the move rides the next cloud push as a
   * deleted row that keeps its bytes. The pre-trash flow asked "Close this
   * tab?" and fired a snapshot behind the user's back because closing was
   * DESTRUCTIVE — recoverable deletes make both the ask and the snapshot
   * theater (the same rule the snapshot restore already follows).
   */
  requestCloseTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }

    const isActive = tabId === this.activeId;
    // Capture the live editor FIRST when trashing the active tab: the model
    // is what moves to the trash, and inside the input debounce window it
    // can lag the surface — the trashed entry must carry the last words.
    if (isActive) {
      this.saveActiveFromEditor();
    }

    const title = deriveTabTitle(tab);
    const index = this.tabs.findIndex((entry) => entry.id === tabId);
    this.tabs = this.tabs.filter((entry) => entry.id !== tabId);
    this.dirtyIds.delete(tabId);
    // A trashed note replaces any stale entry (re-trash after a restore
    // keeps the newest stamp; the entry never survives a live row).
    this.trashed = this.trashed.filter((entry) => entry.id !== tabId);
    this.trashed.push({
      id: tab.id,
      name: tab.name,
      content: tab.content,
      createdAt: tab.createdAt,
      updatedAt: nextUpdatedAt(tab.updatedAt),
      noteType: tab.noteType,
      colorTheme: tab.colorTheme,
      syncSeq: tab.syncSeq,
      copyOf: tab.copyOf,
      deletedAt: Date.now(),
    });
    // The trash row rides the next push — the same dirty set the tabs use
    // (the sync layer resolves pending ids against tabs FIRST, trash second).
    this.dirtyIds.add(tab.id);

    // The flash fires BEFORE the persist calls below so its first tick
    // lands clean — the receipt should never start behind the persist's
    // own work in the same beat.
    this.trashListeners.forEach((listener) => listener());

    if (this.tabs.length === 0) {
      const fresh = createTab('');
      this.tabs.push(fresh);
      this.activeId = fresh.id;
      this.persist();
      this.renderStrip();
      this.loadActiveIntoEditor();
      this.focusEditor();
      this.notifyActiveChanged();
      showToast(`"${title}" moved to trash. A fresh tab is ready.`, 'neutral', {
        label: 'Undo',
        run: () => this.undoTrash(tab.id, title),
      });
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

    showToast(`"${title}" moved to trash.`, 'neutral', {
      label: 'Undo',
      run: () => this.undoTrash(tab.id, title),
    });
  }

  /** The delete toast's Undo — the trash round trip without the trip:
   *  most visits to the trash happen seconds after the delete, so the
   *  restore is offered ON the receipt. The note returns under its own
   *  id (restoreNote), and the undo confirms itself — the strip visibly
   *  grows back, but a line of confirmation closes the loop cleanly. */
  private undoTrash(noteId: string, title: string): void {
    if (this.restoreNote(noteId)) {
      showToast(`"${title}" is back in the notes list.`, 'success');
    }
  }

  /**
   * Restores a trashed note — the trash sheet's Restore. The note comes back
   * to the END of the strip (its old neighbors have moved on) under its own
   * id, so share links and everything else keyed to the id keep working; the
   * restore rides the next push as a live row, and the server's delete-race
   * guard accepts it because it carries a strictly newer updated_at than the
   * trash it reverses.
   */
  restoreNote(noteId: string): boolean {
    const grave = this.trashed.find((entry) => entry.id === noteId);
    if (!grave || grave.purged) {
      return false;
    }
    this.trashed = this.trashed.filter((entry) => entry.id !== noteId);
    const restored: NoteTab = {
      id: grave.id,
      name: grave.name,
      content: grave.content,
      createdAt: grave.createdAt,
      updatedAt: nextUpdatedAt(grave.updatedAt),
      noteType: normalizeNoteType(grave.noteType),
      colorTheme: grave.colorTheme,
      syncSeq: grave.syncSeq,
    };
    if (grave.copyOf) {
      restored.copyOf = grave.copyOf;
    }
    this.tabs.push(restored);
    this.dirtyIds.add(restored.id);
    this.persist();
    this.renderStrip();
    return true;
  }

  /**
   * Deletes a trashed note forever — the trash sheet's "Delete forever".
   *
   * The local row is hard-deleted, and a sweeper row rides the next push:
   * deleted, content emptied, deleted_at backdated past the retention
   * window. The server's boot sweep retires it, every other device's hydrate
   * sweep drops it on sight (a trash row past cutoff never joins the model)
   * — "delete forever" propagates everywhere without a second protocol.
   * The placeholder itself (purged, invisible) exists only until the push
   * confirms, then confirmPushed retires it.
   */
  purgeNote(noteId: string): boolean {
    const grave = this.trashed.find((entry) => entry.id === noteId);
    if (!grave) {
      return false;
    }
    this.trashed = this.trashed.filter((entry) => entry.id !== noteId);
    const purgedAt = nextUpdatedAt(grave.updatedAt);
    this.trashed.push({
      id: grave.id,
      name: null,
      content: '',
      createdAt: grave.createdAt,
      updatedAt: purgedAt,
      deletedAt: 1,
      purged: true,
    });
    this.dirtyIds.add(grave.id);
    // Delete forever means forever: the note's snapshots go with it, or
    // the History sheet would keep offering a resurrection after the
    // toast said "for good". Best-effort — a snapshots outage must not
    // block the purge itself.
    try {
      void window.snapshotsManager?.deleteSnapshotsForNotes([noteId]);
    } catch {
      /* the sweep is best-effort */
    }
    this.persist();
    this.renderRailCount();
    return true;
  }

  /**
   * Empties the whole trash in one move — every visible entry purged by the
   * same sweeper-row mechanism (see purgeNote). Returns how many went.
   */
  emptyTrash(): number {
    const visible = this.trashed.filter((entry) => !entry.purged);
    if (visible.length === 0) {
      return 0;
    }
    const visibleIds = new Set(visible.map((entry) => entry.id));
    const now = Date.now();
    this.trashed = this.trashed
      .filter((entry) => !visibleIds.has(entry.id))
      .concat(
        visible.map((grave) => ({
          id: grave.id,
          name: null,
          content: '',
          createdAt: grave.createdAt,
          updatedAt: Math.max(now, grave.updatedAt + 1),
          deletedAt: 1,
          purged: true,
        })),
      );
    visible.forEach((grave) => this.dirtyIds.add(grave.id));
    // Forever means forever — every emptied note's snapshots sweep with
    // it (see purgeNote). Best-effort, never blocking the empty itself.
    try {
      void window.snapshotsManager?.deleteSnapshotsForNotes(visible.map((grave) => grave.id));
    } catch {
      /* the sweep is best-effort */
    }
    this.persist();
    this.renderRailCount();
    return visible.length;
  }

  beginRename(tabId: string): void {
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

    // The commit settles ONCE: Enter fires it, and the blur that follows
    // (the input is replaced, focus moves) would fire it again — a double
    // persist, a double "renamed" toast, and two DOM swaps racing the
    // browser's own blur fixup (Chromium's replaceWith can throw
    // NotFoundError when the node's focus bookkeeping moves mid-swap —
    // its error text says as much). The second and later calls no-op.
    let settled = false;
    const commit = (keep: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = String(input.val() ?? '').trim();
      if (keep && raw && raw !== currentName) {
        tab.name = raw;
        tab.updatedAt = nextUpdatedAt(tab.updatedAt);
        this.dirtyIds.add(tab.id);
        this.persist();
        showToast('Tab renamed.');
      }
      // Presentation-only swap: the name is already in the model. A sync
      // merge may have rebuilt the strip while the input was open (the
      // input then sits in a detached subtree), and the swap itself can
      // lose the browser's blur race — either way the LIVE strip gets its
      // label from the model and the user never sees the difference.
      if (input.get(0)?.isConnected) {
        try {
          element
            .find('.tab-strip-rename')
            .replaceWith($('<span class="tab-strip-title"></span>').text(deriveTabTitle(tab)));
        } catch {
          this.refreshTabLabel(tab.id);
        }
        element.attr('title', tab.name ? tab.name : 'Double-click to rename');
      } else {
        this.refreshTabLabel(tab.id);
      }
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

  /**
   * Hook for the review sheet — fires when a strip conflict badge is
   * clicked. The sheet owns the gesture; the manager only knows the note.
   */
  onConflictReview: ((tabId: string) => void) | null = null;

  /**
   * Hook for the "changed while you were away" peek — fires when a note
   * whose words arrived from another device while it sat unopened is
   * switched to. The sheet owns the gesture; the manager only knows the
   * note and the bytes this device last had.
   */
  onUnseenPeek:
    ((tab: NoteTab, baseline: { from: string; fromName: string | null }) => void) | null = null;

  /** The note a parked conflict belongs to (the sheet's read). */
  getConflictedNote(tabId: string): NoteTab | null {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    return tab?.conflict ? tab : null;
  }

  /** Every note carrying an unresolved review (badge state, counts). */
  getConflictedIds(): string[] {
    return this.tabs.filter((tab) => tab.conflict).map((tab) => tab.id);
  }

  /**
   * Resolves a parked version conflict — the review sheet's three buttons.
   *
   *  • 'theirs' (the note already holds their version) just clears the
   *    record: the row was always theirs, nothing moves.
   *  • 'mine' applies this device's parked words as a new edit (dirty,
   *    re-pushed; the next cycle makes them canonical everywhere).
   *  • 'both' restores the parked words AND keeps their version as an
   *    explicit copy — the pre-review "conflicted copy" behavior, but as
   *    a user decision instead of an accident, landing beside its source
   *    and opening like a duplicate.
   */
  resolveConflict(tabId: string, resolution: 'mine' | 'theirs' | 'both'): boolean {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab || !tab.conflict) {
      return false;
    }
    const record = tab.conflict;
    delete tab.conflict;

    const applyMine = (): void => {
      tab.name = record.mine.name;
      tab.content = record.mine.content;
      tab.updatedAt = nextUpdatedAt(tab.updatedAt);
      this.dirtyIds.add(tab.id);
      if (tab.id === this.activeId) {
        // The active note repaints through the restore seam — the same
        // path a snapshot restore owns (painter swap, html commit).
        this.applySnapshotToActive(record.mine.content, tab.noteType, tab.colorTheme);
        tab.name = record.mine.name;
      }
    };

    if (resolution === 'mine') {
      applyMine();
    } else if (resolution === 'both') {
      // Their version (the current bytes) becomes the copy; the note goes
      // back to this device's words.
      const copy = createTab(
        tab.content,
        `${deriveTabTitle({ ...tab, name: record.theirs.name ?? tab.name })} (other version)`,
        tab.noteType ?? DEFAULT_NOTE_TYPE,
      );
      if (tab.colorTheme) {
        copy.colorTheme = tab.colorTheme;
      }
      const index = this.tabs.findIndex((entry) => entry.id === tabId);
      this.tabs.splice(index + 1, 0, copy);
      this.dirtyIds.add(copy.id);
      applyMine();
    }
    // 'theirs': the note already holds their version — nothing but the
    // record ever needed to move.

    this.persist();
    this.renderStrip();
    return true;
  }

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
  if (captured.noteType === 'tasks') {
    // A task list exports as the checklist it is — the same projection
    // the word count reads, dressed for HTML (all strings escaped).
    return renderTaskListExportBody(captured.content);
  }
  if (isHtmlContent(captured.noteType)) {
    return sanitizeNoteHtml(captured.content);
  }
  return `<pre>${escapeHtml(captured.content)}</pre>`;
}

/** The tasks note's HTML export: a quiet checklist, list color included. */
function renderTaskListExportBody(content: string): string {
  const model = parseTaskNoteContent(content);
  const items = model.tasks
    .map((task) => {
      const title = escapeHtml(task.title);
      let line = `<li class="padify-task${task.completed ? ' is-done' : ''}"><span class="padify-task-title">${title}</span>`;
      if (task.dueDate) {
        line += `<span class="padify-task-meta">due ${escapeHtml(formatDueChip(task.dueDate, new Date()))}</span>`;
      }
      if (task.notes) {
        line += `<span class="padify-task-meta">${escapeHtml(task.notes)}</span>`;
      }
      return `${line}</li>`;
    })
    .join('');
  return `<ul class="padify-task-list" data-color="${model.color}">${items}</ul>`;
}
