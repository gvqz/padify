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
import { createTab, domainTabOf, nextUpdatedAt, type NoteTab } from './notes/domain';
import { NotesModel, validatedTabFromRow } from './notes/model';
import { TabStripView } from './notes/strip-view';
import { TrashStore } from './notes/trash-store';
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
import { noteExportHtmlBody } from './editor/note-projections';
import {
  htmlNoteSurface,
  noteSurfaceFor,
  noteSurfaceForKind,
  type NoteSurface,
} from './editor/surface';
import { convertNoteContent } from './editor/note-convert';
import { deriveTabTitle, legacyTextToHtml } from './editor/note-content';
import {
  DEFAULT_NOTE_TYPE,
  isHtmlContent,
  normalizeNoteType,
  noteTypeLabel,
  type NoteType,
} from './editor/note-types';
import { SyncLedger } from './sync/ledger';

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

/** One parked version conflict — see the ledger's NoteConflictRecord. */
export type NoteConflict = NoteConflictRecord;

// The domain record lives in notes/domain.ts now (S2); re-exported here for
// the ~20 existing importers. New code imports it from its home.
export type { NoteTab } from './notes/domain';

const LEGACY_NOTE_KEY = 'note';

/**
 * Everything the cloud sync layer needs after the model changed. The
 * `trashed` list rides along so the sync layer can push trash rows (and
 * the share layer can revoke links) — entries stay in the model until
 * retention retires them, unlike the tombstones they replaced.
 *
 * The tabs and trashed rows are the PROJECTED view — domain records with
 * the ledger's sync state stamped on (the stored spelling) — so the
 * merge can arbitrate on seq/base/conflict exactly as it always did,
 * from one projection built in one place (exportForSync).
 */
export interface TabsSyncPayload {
  /** Current tab list, domain + ledger (the stored spelling). */
  tabs: StoredNoteTab[];
  /** Tab ids whose content/name changed since the last persist. */
  dirty: string[];
  /** The trash: deleted notes kept restorable for the retention window. */
  trashed: TrashedNote[];
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class TabManager {
  /** Every open note, in strip order — read-only for the layers that
   *  aggregate across notes (the tasks feature's views). */
  get allTabs(): readonly NoteTab[] {
    return this.model.all();
  }

  /** The note list as STATE — who is open, which one is active (see
   *  notes/model.ts, S2 tranche two). The manager no longer holds the
   *  array or the pointer: it orchestrates AROUND the model, and the
   *  active-live and never-empty invariants hold by construction there
   *  instead of being re-implemented at every mutation site here. */
  private readonly model: NotesModel;
  private readonly editor: Q;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The one sync-state owner — the dirty set, the push queue and the
   *  echo fingerprints in a single structure (see sync/ledger.ts).
   *  Public read-only surface for the cloud layer, which reaches it
   *  through the manager it already holds. */
  readonly syncLedger = new SyncLedger();
  /** The grave lifecycle — the trash's model half (see notes/trash-store.ts):
   *  the list, the minting, the restore hand-off, the sweeper placeholders,
   *  and the delete-receipt event. The manager orchestrates AROUND it
   *  (focus, strip, snapshots, persist); the store owns what a grave IS. */
  private readonly trash: TrashStore;
  /** The strip's DOM half (see notes/strip-view.ts): rendering, delegated
   *  events, the inline rename. The manager is its host — commands flow
   *  back through the narrow TabStripHost surface wired in the constructor. */
  private readonly stripView: TabStripView;
  private persistListeners: Set<(payload: TabsSyncPayload) => void> = new Set();
  /** The surface that currently paints the host — dismissed before a
   *  different kind takes the stage (the NoteSurface.dismiss contract). */
  private paintedBy: NoteSurface | null = null;

  constructor(editor: Q) {
    this.editor = editor;
    this.trash = new TrashStore(this.syncLedger);
    // The fallback mint is a BLANK page now — the welcome prose left
    // (fresh installs start on an empty note). WELCOME_HTML survives in
    // note-content.ts only as the legacy seed marker the sync layer
    // still recognizes byte-exactly.
    this.model = new NotesModel(() => createTab(''));
    // The host surface the strip may reach — the god-object antidote: the
    // view sees the model's shape and a handful of commands, nothing else.
    // The reads go through this manager live (the tabs array is replaced,
    // not mutated, on merges), captured lexically by the arrows.
    this.stripView = new TabStripView($('#tabStripTabs'), {
      modelTabs: () => this.model.all(),
      activeTabId: () => this.model.activeTabId(),
      isConflicted: (tabId) => this.syncLedger.conflictOf(tabId) !== undefined,
      onConflictReview: (tabId) => this.onConflictReview?.(tabId),
      switchTo: (tabId) => this.switchTo(tabId),
      requestCloseTab: (tabId) => this.requestCloseTab(tabId),
      addTab: () => this.addTab(),
      focusEditor: () => this.focusEditor(),
      commitRename: (tabId, name) => this.renameTab(tabId, name),
    });
  }

  /**
   * Loads (or bootstraps) the model and paints the strip + editor. Awaited
   * by app.ts after the storage layer hydrated (see storage/index.ts).
   *
   * The boot is one seed call: the model owns the active-id fallback
   * (stored preference → first row → welcome mint) and the never-empty
   * invariant, and the boot persists ONLY when it changed something — a
   * normal boot writes nothing (the stored rows already are the truth);
   * a minting or migrating boot writes once, with the active id already
   * settled where the old code's two synchronous writes left it.
   */
  async init(): Promise<void> {
    const snapshot = await loadNotes();
    const rows = this.loadModel(snapshot.tabs);
    this.trash.seed(
      snapshot.trashed.filter(
        (entry) => entry && typeof entry.id === 'string' && typeof entry.deletedAt === 'number',
      ),
    );

    // The legacy single-note migration — the one list policy that must
    // run BEFORE the seed picks the active tab: the migrated note becomes
    // the first tab and therefore the active one. The old key leaves
    // storage either way (an existing tab list wins over the old note; a
    // blank never lands).
    const legacy = stateGet(LEGACY_NOTE_KEY);
    let migrated = false;
    if (legacy !== null) {
      stateRemove(LEGACY_NOTE_KEY);
      if (rows.length === 0 && legacy.trim() !== '') {
        rows.unshift(createTab(legacyTextToHtml(legacy)));
        migrated = true;
      }
    }

    const seeded = this.model.seed(rows, stateGet(ACTIVE_TAB_KEY));
    if (seeded.minted || migrated) {
      this.persist();
    }

    this.stripView.render();
    this.loadActiveIntoEditor();
    this.stripView.bind();
    // The title mirrors the active note from the FIRST paint — a restored
    // session (or an installed app booting straight into a note) must not
    // sit on the static "Padify" until the first switch or keystroke.
    this.stripView.syncDocumentTitle();
  }

  // ---- model ---------------------------------------------------------------

  /**
   * Validates a stored snapshot into the editor-safe domain rows and
   * adopts each row's sync state into the ledger — the boot-side map
   * between the two spellings. The row VALIDATION is the model module's
   * pure function (validatedTabFromRow); this loop is the ledger's half
   * of the same map (see the ledger's adoptStoredRow). The durable
   * unpushed flag re-enters the dirty set there: records an earlier
   * session stamped re-enter as strands, so the sync layer's session
   * start queues them for a pull-first recovery cycle instead of shipping
   * stale bytes over a newer remote edit.
   */
  private loadModel(entries: StoredNoteTab[]): NoteTab[] {
    return entries
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => {
        this.syncLedger.adoptStoredRow({
          id: entry.id,
          syncSeq:
            typeof entry.syncSeq === 'number' && entry.syncSeq > 0 ? entry.syncSeq : undefined,
          syncBase: entry.syncBase,
          conflict: readNoteConflict(entry.conflict),
          unseenChange: entry.unseenChange,
          unpushed: entry.unpushed === true ? true : undefined,
        });
        return validatedTabFromRow(entry);
      });
  }

  /**
   * Persists the model (write-behind — see storage/notes.ts) and notifies
   * the sync layer + persist listeners. `immediate=false` marks the typing
   * path: the IndexedDB diff still runs, the legacy blob mirror is
   * throttled.
   *
   * One projection per persist: exportForSync() builds the stored view
   * (domain + ledger), and the SAME view feeds saveNotes and the sync
   * payload — the durable `unpushed` flag is stamped from the ledger
   * there, in the same write as the bytes it describes, so the two can
   * never drift apart across a crash.
   */
  private persist(immediate = true): void {
    const payload = this.exportForSync();
    saveNotes({ tabs: payload.tabs, trashed: payload.trashed }, this.model.activeTabId(), {
      immediate,
    });

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
   * slot. The registry lives in the model; the TIMING of each fire stays
   * the manager's (see notes/model.ts's emitActiveChanged).
   */
  addActiveListener(listener: (tab: NoteTab) => void): () => void {
    return this.model.addActiveListener(listener);
  }

  /**
   * Fires whenever a note moved to the trash — the delete receipt the
   * History button in the top bar turns into its trash flash (the toast
   * owns the words and the Undo; this owns the "where did it go" gesture
   * on the door the note just arrived behind). The registry lives in the
   * trash store now — the mint IS the moment a note arrives.
   */
  addTrashListener(listener: () => void): () => void {
    return this.trash.addTrashListener(listener);
  }

  // ---- sync support ---------------------------------------------------------

  /**
   * Snapshot of the model for the cloud sync layer — and THE projection
   * where the domain records and the ledger's sync state meet the stored
   * spelling. persist() feeds the very same view to saveNotes, so the
   * disk, the legacy mirror and the wire always see the same fields from
   * one truth. Fresh copies every call: the merge treats rows as data.
   */
  exportForSync(): TabsSyncPayload {
    return {
      tabs: this.model.all().map((tab) => this.syncLedger.project(tab)),
      dirty: this.syncLedger.dirtyIds(),
      trashed: this.trash.all.map((grave) => this.syncLedger.project(grave)),
    };
  }

  /**
   * Replaces the trash list after a sync merge. Called only when the merge
   * actually changed it — the strip never depends on trash rows, so this
   * is a silent model+persist swap (the rail badge refresh is the UI's to
   * own through its persist listener). The incoming rows carry the graves'
   * sync state in the stored spelling; the ledger adopts it and the model
   * keeps the domain + stamp half.
   */
  applyExternalTrash(trashed: TrashedNote[]): void {
    this.trash.adoptMerged(trashed);
    this.persist();
    this.stripView.renderRailCount();
  }

  /** The trash, newest first — the trash sheet's read. */
  getTrashed(): readonly TrashedNote[] {
    return this.trash.list();
  }

  /**
   * Called by the cloud sync layer after a push confirmed that the given
   * note ids are now stored on the server. Without this, the local dirty
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
    const cleared = this.syncLedger.confirmPushed(ids);
    // Purged placeholders leave once their sweeper row is stored — there is
    // nothing left to show, restore or push for them.
    const purgedGone = this.trash.retirePurged(new Set(ids));
    if (purgedGone) {
      this.stripView.renderRailCount();
    }
    // Retire the durable unpushed flags in the same breath: a flag left
    // true on a confirmed note re-seeds it as dirty on every future boot,
    // pushing a synced note once per session forever. The persist's diff
    // write rewrites only the records whose flag actually flipped.
    if (cleared || purgedGone) {
      this.persist();
    }
  }

  /**
   * Called by the cloud sync layer after a push whose response carried the
   * stamped rows (trash-aware servers answer with what landed): each note
   * adopts its fresh seq AND its merge base — the exact (content, name)
   * the server now holds, the ancestor every future three-way merge diffs
   * from. A note whose words moved on since the snapshot keeps them; only
   * the sync metadata moves. Live tabs only (today's contract): graves
   * keep whatever anchor they carried.
   */
  adoptPushedRows(
    rows: Array<{ id: string; seq: number; content: string; name: string | null }>,
  ): void {
    if (rows.length === 0) {
      return;
    }
    let touchedAny = false;
    for (const row of rows) {
      if (!this.model.has(row.id)) {
        continue;
      }
      touchedAny =
        this.syncLedger.adoptPushed(row.id, row.seq, { content: row.content, name: row.name }) ||
        touchedAny;
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
   * The incoming rows are the merge's PROJECTED copies — domain + sync
   * state in the stored spelling (the merge arbitrates on seq/base and
   * may park a conflict or leave a marker riding). The unseen stamp is
   * minted on them FIRST (it needs the pre-merge model's bytes and the
   * ledger's pre-adoption baseline), then the ledger adopts each row's
   * sync state, and the model keeps the domain half.
   *
   * `forceRepaintIds` names notes the sync layer AUTO-MERGED (both devices'
   * edits now live in one version, see src/merge/): those repaint even when
   * the editor holds the caret — the editor's pre-merge bytes do NOT
   * contain the other device's words, and the next capture would overwrite
   * the merged version with them, silently dropping half the merge. The
   * capture that fed the merge already saved the local words, so the
   * repaint costs nothing but the caret's place.
   */
  applyExternalMerge(rows: StoredNoteTab[], forceRepaintIds: readonly string[] = []): void {
    const activeBefore = this.model.activeTab();
    const forceRepaint = new Set(forceRepaintIds);
    // The pre-merge model, keyed for the unseen-change stamp below — the
    // merge's rows replace the list wholesale, so the "what did this
    // device last have" question must be asked before the swap.
    const beforeById = new Map(this.model.all().map((tab) => [tab.id, tab]));
    // …and the pre-adoption ledger baselines: a stamp already present
    // keeps its ORIGINAL baseline (consecutive pulls while the note stays
    // unopened extend the delta, they do not restart it).
    const beforeUnseen = new Map(
      this.model.all().map((tab) => [tab.id, this.syncLedger.unseenOf(tab.id)]),
    );

    const stamped = rows.map((row) => {
      const next: StoredNoteTab = {
        ...row,
        // Sanitize is the html discipline; every other kind crosses the
        // merge byte-exact.
        content: isHtmlContent(row.noteType) ? sanitizeNoteHtml(row.content) : row.content,
      };
      // Words arrived on a note nobody is looking at — park what this
      // device last had, so opening it can show the delta (the ledger's
      // unseen baseline). The note you are watching is exempt (the
      // merge toast already speaks for it), and so is a parked conflict
      // (the review badge is the louder surface; stacking a peek on it
      // would be noise).
      const before = beforeById.get(row.id);
      const priorUnseen = beforeUnseen.get(row.id);
      if (
        before &&
        !next.conflict &&
        row.id !== this.model.activeTabId() &&
        before.content !== next.content
      ) {
        next.unseenChange = priorUnseen ?? { from: before.content, fromName: before.name };
      }
      return next;
    });

    // The merged rows' sync state is the truth now; the model keeps the
    // domain half. One replaceAll owns the active repair and the
    // never-empty mint (see notes/model.ts).
    stamped.forEach((row) => this.syncLedger.adoptMergedRow(row));
    this.model.replaceAll(stamped.map(domainTabOf));

    this.persist();
    this.stripView.render();

    // A merged-away tab can never push again — its pending dirty id would
    // otherwise sit in the set forever, re-serialized (and skipped) on
    // every cycle. Trash ids are alive too: deletes, restores and purges
    // all queue through the same dirty set (requestCloseTab, purgeNote,
    // emptyTrash), and dropping one here would clear its durable unpushed
    // flag on the next persist — a reload before the push lands could
    // then lose the delete. Ids leave the dirty set only through
    // confirmPushed (the server has the bytes) or by leaving the model.
    this.syncLedger.retainOnly([
      ...this.model.all().map((tab) => tab.id),
      ...this.trash.all.map((grave) => grave.id),
    ]);

    const active = this.model.activeTab();
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
    return this.model.activeTab();
  }

  /** Read-only view of the rail's notes — the note context menu finds its
   *  target note (the one under the cursor, not the active one) here. */
  getTabs(): readonly NoteTab[] {
    return this.model.all();
  }

  /** Saves the editor's live content into the active tab. */
  saveActiveFromEditor(): void {
    const active = this.model.activeTab();
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
    this.syncLedger.markDirty(active.id);
    this.schedulePersist();
    this.stripView.refreshLabel(active.id);
  }

  /** Persists the editor content immediately (snapshot restore, clear, …). */
  syncAfterExternalEdit(): void {
    const active = this.model.activeTab();
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
    this.syncLedger.markDirty(active.id);
    this.persist();
    this.stripView.refreshLabel(active.id);
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
  focusEditor(attempt = 0, forTabId = this.model.activeTabId()): void {
    const host = this.editorHost();
    if (!host) {
      return;
    }
    const surface = noteSurfaceFor(this.model.activeTab());
    if (typeof surface.focusTarget === 'function') {
      const target = surface.focusTarget(host);
      if (target) {
        target.focus();
        return;
      }
      if (attempt < MAX_FOCUS_RETRIES && this.model.activeTabId() === forTabId) {
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
    const incoming = noteSurfaceFor(this.model.activeTab());
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
    incoming.display(host, this.model.activeTab());
  }

  getActiveText(): string {
    const active = this.model.activeTab();
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
    const active = this.model.activeTab();
    if (!active) {
      return;
    }

    noteSurfaceFor(active).clear(this.editorHost()!);
    active.content = '';
    active.updatedAt = nextUpdatedAt(active.updatedAt);
    this.syncLedger.markDirty(active.id);
    this.persist();
    this.stripView.refreshLabel(active.id);
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
    const active = this.model.activeTab();
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
      this.syncLedger.markDirty(active.id);
      this.persist();
      this.loadActiveIntoEditor();
    }

    // The active TAB did not change — its type did. Chrome follows active
    // changes (the toolbar visibility sync, the port's inertness, the word
    // pill), so announce the switch the same way a tab change would.
    this.notifyActiveChanged();
    this.stripView.refreshLabel(active.id);
  }

  // ---- strip (the DOM half lives in notes/strip-view.ts) ---------------------

  /** Double-click-to-rename — the note context menu's entry point. */
  beginRename(tabId: string): void {
    this.stripView.beginRename(tabId);
  }

  // ---- actions -----------------------------------------------------------------

  switchTo(tabId: string, focusEditor = true): void {
    if (tabId === this.model.activeTabId()) {
      return;
    }

    this.saveActiveFromEditor();
    // The pointer move is the model's one call — and a refusal (unknown
    // id, or a re-switch that lost the race) ends the switch before any
    // orchestration fires: nothing painted, nothing announced.
    if (!this.model.setActive(tabId)) {
      return;
    }
    // Opening the note answers the question a parked unseen baseline was
    // holding: the marker is consumed HERE (read-and-clear in one ledger
    // call, before the persist, so the clear rides this very save) and the
    // peek fires after the editor painted the new bytes — once per change,
    // never on re-click.
    const opened = this.model.tabOf(tabId);
    const unseen = opened ? this.syncLedger.consumeUnseen(tabId) : undefined;
    this.persist();
    this.stripView.render();
    this.loadActiveIntoEditor();

    if (focusEditor) {
      this.focusEditor();
    }

    this.notifyActiveChanged();

    // The peek defers to a parked conflict: the review badge on the same
    // note is the louder, more demanding surface — two sheets over one
    // open would be the stacking the review flow just removed.
    if (opened && unseen && !this.syncLedger.conflictOf(opened.id)) {
      this.onUnseenPeek?.(opened, unseen);
    }
  }

  addTab(focusEditor = true, noteType: NoteType = DEFAULT_NOTE_TYPE): void {
    this.saveActiveFromEditor();

    const tab = createTab('', null, noteType);
    this.model.append(tab, { activate: true });
    this.syncLedger.markDirty(tab.id);
    this.persist();

    this.stripView.append(tab);
    this.loadActiveIntoEditor();
    this.stripView.scrollTabIntoView(tab.id);

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
    this.model.append(tab);
    this.syncLedger.markDirty(tab.id);
    this.stripView.append(tab);
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
    const source = this.model.tabOf(tabId);
    if (!source) {
      return;
    }
    if (source.id === this.model.activeTabId()) {
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
    this.model.insertAfter(tabId, copy);
    this.syncLedger.markDirty(copy.id);
    this.persist();

    this.stripView.render();
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
    const target = this.model.tabOf(tabId);
    if (!target || (target.noteType ?? DEFAULT_NOTE_TYPE) === noteType) {
      return;
    }
    // The active note's newest words still live in the editor — capture
    // them so the conversion reads what the user sees (duplicateNote's deal).
    if (tabId === this.model.activeTabId()) {
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
    const tab = this.model.tabOf(tabId);
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
    if (this.model.activeTabId() !== tabId) {
      this.switchTo(tabId);
    }
    const active = this.model.activeTab();
    if (!active || active.id !== tabId) {
      return;
    }
    this.applySnapshotToActive(content, noteType, active.colorTheme);
    this.stripView.render();
  }

  /**
   * Renames a tab programmatically — the tasks surface's page title and
   * the rail's quick-rename flows. Same rules as the strip's inline
   * rename (blank never wins; the model leads, the label follows), minus
   * the toast (the caller owns the feedback).
   */
  renameTab(tabId: string, name: string): boolean {
    const tab = this.model.tabOf(tabId);
    if (!tab) return false;
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed || trimmed === tab.name) return false;
    tab.name = trimmed;
    tab.updatedAt = nextUpdatedAt(tab.updatedAt);
    this.syncLedger.markDirty(tab.id);
    this.persist();
    this.stripView.refreshLabel(tab.id);
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
    const tab = this.model.tabOf(tabId);
    if (!tab || tab.content === content) return;
    tab.content = content;
    tab.updatedAt = nextUpdatedAt(tab.updatedAt);
    this.syncLedger.markDirty(tab.id);
    if (tab.id === this.model.activeTabId()) {
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
    const tab = this.model.tabOf(tabId);
    if (!tab) {
      return;
    }

    const isActive = tabId === this.model.activeTabId();
    // Capture the live editor FIRST when trashing the active tab: the model
    // is what moves to the trash, and inside the input debounce window it
    // can lag the surface — the trashed entry must carry the last words.
    if (isActive) {
      this.saveActiveFromEditor();
    }

    const title = deriveTabTitle(tab);
    // The list surgery is the model's one call — the neighbour policy, the
    // active repair and the never-empty mint (an EMPTY tab here, not the
    // welcome: the user just deleted their last note on purpose) live
    // behind it. The outcome says what the orchestrator must repaint.
    const outcome = this.model.remove(tabId, () => createTab(''));
    if (!outcome) {
      return;
    }
    // The grave mint (the entry replacement for a re-trash, the stamps, and
    // the ledger's trash rules — the note's life state dies at this door,
    // the grave's row rides behind the live rows) is the store's one call;
    // the delete receipt fires inside it, before the persist below.
    this.trash.mintFromTab(tab);

    if (outcome.minted) {
      // The last note left and a fresh tab took the stage.
      this.persist();
      this.stripView.render();
      this.loadActiveIntoEditor();
      this.focusEditor();
      this.notifyActiveChanged();
      showToast(`"${title}" moved to trash. A fresh tab is ready.`, 'neutral', {
        label: 'Undo',
        run: () => this.undoTrash(tab.id, title),
      });
      return;
    }

    if (outcome.activeChanged) {
      // The closed one was active — the left neighbour is on the stage now.
      this.persist();
      this.stripView.render();
      this.loadActiveIntoEditor();
      this.focusEditor();
      this.notifyActiveChanged();
    } else {
      this.persist();
      this.stripView.render();
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
    const grave = this.trash.takeForRestore(noteId);
    if (!grave) {
      return false;
    }
    const restored: NoteTab = {
      id: grave.id,
      name: grave.name,
      content: grave.content,
      createdAt: grave.createdAt,
      updatedAt: nextUpdatedAt(grave.updatedAt),
      noteType: normalizeNoteType(grave.noteType),
      colorTheme: grave.colorTheme,
      copyOf: grave.copyOf,
    };
    this.model.append(restored);
    // The ledger's entry for the id outlived the trash round trip — the
    // merge base the grave kept (a restored note's next divergence
    // three-way merges against the last cloud-agreed version, not
    // against nothing; a missing base degrades the merge into a parked
    // conflict for exactly the notes people delete and restore) and the
    // seq anchor are already where they belong.
    this.syncLedger.markDirty(restored.id);
    this.persist();
    this.stripView.render();
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
    if (!this.trash.purge(noteId)) {
      return false;
    }
    // Delete forever means forever: the note's snapshots go with it, or
    // the History sheet would keep offering a resurrection after the
    // toast said "for good". Best-effort — a snapshots outage must not
    // block the purge itself. The catch lives ON the promise: the old
    // synchronous try/catch around a voided promise never fired, and the
    // rejection went unhandled instead.
    void window.snapshotsManager?.deleteSnapshotsForNotes([noteId])?.catch(() => undefined);
    this.persist();
    this.stripView.renderRailCount();
    return true;
  }

  /**
   * Empties the whole trash in one move — every visible entry purged by the
   * same sweeper-row mechanism (see purgeNote). Returns how many went.
   */
  emptyTrash(): number {
    const emptiedIds = this.trash.emptyVisible();
    if (emptiedIds.length === 0) {
      return 0;
    }
    // Forever means forever — every emptied note's snapshots sweep with
    // it (see purgeNote). Best-effort, never blocking the empty itself;
    // the catch rides the promise (see purgeNote for why).
    void window.snapshotsManager?.deleteSnapshotsForNotes(emptiedIds)?.catch(() => undefined);
    this.persist();
    this.stripView.renderRailCount();
    return emptiedIds.length;
  }

  /** Ctrl/Cmd + Alt + ←/→ moves between tabs. */
  cycle(delta: number): void {
    const tabs = this.model.all();
    if (tabs.length < 2) {
      return;
    }

    const index = this.model.indexOf(this.model.activeTabId() ?? '');
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    this.switchTo(next.id);
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
    const tab = this.model.tabOf(tabId);
    return tab && this.syncLedger.conflictOf(tabId) ? tab : null;
  }

  /** Every note carrying an unresolved review (badge state, counts). */
  getConflictedIds(): string[] {
    return this.model
      .all()
      .filter((tab) => this.syncLedger.conflictOf(tab.id))
      .map((tab) => tab.id);
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
    const tab = this.model.tabOf(tabId);
    const record = this.syncLedger.conflictOf(tabId);
    if (!tab || !record) {
      return false;
    }
    this.syncLedger.clearConflict(tabId);

    const applyMine = (): void => {
      tab.name = record.mine.name;
      tab.content = record.mine.content;
      tab.updatedAt = nextUpdatedAt(tab.updatedAt);
      this.syncLedger.markDirty(tab.id);
      if (tab.id === this.model.activeTabId()) {
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
      this.model.insertAfter(tabId, copy);
      this.syncLedger.markDirty(copy.id);
      applyMine();
    }
    // 'theirs': the note already holds their version — nothing but the
    // record ever needed to move.

    this.persist();
    this.stripView.render();
    return true;
  }

  private notifyActiveChanged(): void {
    const active = this.model.activeTab();
    if (!active) {
      return;
    }
    this.stripView.syncDocumentTitle();
    if (this.onActiveChanged) {
      this.onActiveChanged(active);
    }
    // The registered listeners fire last, through the model's registry —
    // the timing is still the manager's call (the switch must be DONE:
    // editor painted, title synced) because listeners read surfaces.
    this.model.emitActiveChanged();
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
 * The per-kind bodies live behind the projection seam
 * (editor/note-projections.ts) — this flow asks, it does not branch.
 * Returns null when no note is open.
 */
export function getActiveNoteExportBody(): string | null {
  const captured = getActiveNoteContent();
  if (!captured) {
    return null;
  }
  return noteExportHtmlBody(captured.content, captured.noteType);
}
