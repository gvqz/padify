/**
 * The sync ledger — one owner for "have these bytes changed, and has the
 * cloud seen them?"
 *
 * Before the ledger, that question was answered by four structures that
 * had to AGREE and sometimes didn't (the data-loss bug class the
 * architecture review catalogued as S1): TabManager's in-memory
 * `dirtyIds` set, the durable `unpushed` flag riding each note record,
 * cloud/sync.ts's `pendingPush` queue (fed from the model's payload on
 * every persist, re-seeded at every session start, drained on push
 * confirmation, cleared at sign-out), and the `ownEchoes` fingerprints
 * (what this device pushed and the server may echo back). Every fixed
 * bug in that list — unpushed-vs-dirty drift, orphaned pending ids, the
 * reload strand — was one of those structures drifting from the others.
 *
 * The ledger is the one structure now. The model marks ids dirty; the
 * sync layer reads the very same set as its push queue; a confirmed
 * push cleans both in one call; the durable `unpushed` flag is stamped
 * FROM the ledger in the same write as the content (see TabManager's
 * persist, which projects the stored view through the ledger), so the
 * flag is exactly as fresh as the bytes beside it and a reload re-seeds
 * the ledger from it. The queue can no longer disagree with the dirty
 * set — they are the same set.
 *
 * Tranche three widened the same ownership to the seq/base adoption
 * fields. `syncSeq`, `syncBase`, `conflict` and `unseenChange` used to
 * ride the in-memory NoteTab itself (six of its eleven fields were sync
 * state); now they live here, keyed by note id, and the tab is a pure
 * domain record. The stored row shape (StoredNoteTab) and the wire keep
 * carrying the fields — they are the PERSISTED and TRANSPORT spellings —
 * and `project()`/`adoptStoredRow()` are the two maps between domain+ledger
 * and that spelling. Because entries are keyed by id and survive the
 * live↔trash transitions, the field-copying the old model did at those
 * borders (requestCloseTab copying seq/base onto the grave, restoreNote
 * copying them back) is gone: nothing moves, the entry simply outlives
 * the note's life changes. What DOES die with a note's life is the
 * note-life state — a parked conflict, an unseen baseline — see
 * noteTrashed/drop.
 *
 * What deliberately did NOT move here: the storage layer's write-side
 * diff (the last-written index) lives beside this module as
 * sync/write-index.ts — the disk-facing half of the same question. The
 * wire shapes themselves (shared/wire.ts) never carried the local-only
 * fields and stay untouched.
 *
 * Ordering is load-bearing: the queue's iteration order decides batch
 * composition on the wire (body-capped batches), so the ledger keeps
 * the Set semantics the old structures had — a re-mark of an
 * already-dirty id leaves its place alone, and an id that goes clean
 * then dirty again moves to the back. `requeue` is the explicit
 * to-the-back move for the trash flow (a trashed note's row rides
 * behind the live rows already waiting).
 *
 * Strand invariant (the one timing rule that must never regress): bytes
 * that were already dirty when a session STARTS are strands — they
 * predate this session's first pull, so the remote truth must be merged
 * BEFORE they ship, or a stale strand would clobber a newer remote edit
 * (the server's upsert is unconditional for live-vs-live rows).
 * cloud/sync.ts's session-start hook reads hasDirty() and arms its
 * recover-first cycle; the ledger itself stays timing-agnostic.
 */

/**
 * What this device last pushed and the server may echo back: the
 * (content, updated_at) fingerprint each pushed row carried. A row
 * matching it is this device's own bytes no matter when they come back,
 * and must never outrank the typing that followed them. One entry per
 * note — the latest push replaces the last; a stale entry is harmless.
 * (Structurally the merge's OwnEcho; named here so the ledger owns its
 * vocabulary.)
 */
export interface LedgerEcho {
  content: string;
  updatedAt: number;
}

/**
 * The last version the cloud agreed to (content + name) — the common
 * ancestor a three-way merge diffs against (see src/merge/). Adopted on
 * confirmed pushes and clean adoptions, never on local edits, so it
 * always names a version that exists on the server. The stored-row
 * spelling is `syncBase`.
 */
export interface SyncBase {
  content: string;
  name: string | null;
}

/**
 * A note changed on another device while it was NOT the active one: the
 * bytes this device last had, kept so the next open can show what
 * arrived since. The stored-row spelling is `unseenChange`.
 */
export interface UnseenBaseline {
  from: string;
  fromName: string | null;
}

/**
 * An unresolved version conflict parked on a note: the note changed on
 * two devices at once, their version took the canonical row, and THIS
 * device's unpushed words wait in `mine` for the review sheet. Rides
 * storage so a review survives a reload; never crosses the wire.
 */
export interface NoteConflictRecord {
  kind: 'edit';
  /** When this device detected the divergence (epoch ms). */
  detectedAt: number;
  /** The words THIS device held when the row was lost. */
  mine: { name: string | null; content: string };
  /** The version that took the row. */
  theirs: { name: string | null; content: string; updatedAt: number };
}

/**
 * The sync fields as they ride a stored row or a sync payload — the
 * ledger's read/write spelling. Structural on purpose: StoredNoteTab
 * and TrashedNote satisfy it without an import edge (the storage layer
 * imports THIS module for the types, never the reverse).
 */
export interface StoredSyncRow {
  id: string;
  /** The server sequence of the last synced version. */
  syncSeq?: number;
  syncBase?: SyncBase;
  conflict?: NoteConflictRecord;
  unseenChange?: UnseenBaseline;
  /** DURABLE sync-dirty marker — true re-enters the dirty set at boot. */
  unpushed?: boolean;
}

/** The projection `project()` stamps onto a domain row. */
export interface SyncProjection {
  syncSeq?: number;
  syncBase?: SyncBase;
  conflict?: NoteConflictRecord;
  unseenChange?: UnseenBaseline;
  unpushed?: boolean;
}

/** One note's sync-state entry. See the module docs for the lifetime. */
interface LedgerEntry {
  /**
   * These bytes differ from what the cloud last agreed to (or the cloud
   * has never seen them). Clean entries stay in the map while they hold
   * an echo fingerprint; the dirty set is a view, not the storage.
   */
  dirty: boolean;
  /** The push fingerprint, when this device has pushed the note. */
  echo?: LedgerEcho;
  /** The server sequence of the last synced version — the merge's seq
   *  anchor (see NoteTab's stored spelling, syncSeq). */
  seq?: number;
  /** The last cloud-agreed version — the three-way merge's ancestor. */
  base?: SyncBase;
  /** A version conflict parked for review; dies with the note's life
   *  (a resolution, a trash, a merge-away) — see noteTrashed/drop. */
  conflict?: NoteConflictRecord;
  /** The "changed while away" baseline; consumed by the next open. */
  unseen?: UnseenBaseline;
}

export class SyncLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  /**
   * The id's bytes differ from the cloud's last agreement. Re-marking a
   * dirty id is a no-op (its queue place stands); re-dirtying a clean
   * id moves it to the back — Set semantics, kept deliberately (see the
   * module docs on ordering).
   */
  markDirty(id: string): void {
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.dirty) {
        return;
      }
      this.entries.delete(id);
      existing.dirty = true;
      this.entries.set(id, existing);
      return;
    }
    this.entries.set(id, { dirty: true });
  }

  /** The explicit to-the-back move: the trash flow's row rides behind
   *  the live rows already queued (requestCloseTab deletes the live
   *  entry's mark and re-adds it with the grave's identity). */
  requeue(id: string): void {
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      existing.dirty = true;
      this.entries.set(id, existing);
      return;
    }
    this.entries.set(id, { dirty: true });
  }

  isDirty(id: string): boolean {
    return this.entries.get(id)?.dirty === true;
  }

  /** The dirty ids in queue order — insertion order, clean entries
   *  skipped. This is both TabsSyncPayload.dirty and the push queue. */
  dirtyIds(): string[] {
    const ids: string[] = [];
    this.entries.forEach((entry, id) => {
      if (entry.dirty) {
        ids.push(id);
      }
    });
    return ids;
  }

  hasDirty(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.dirty) {
        return true;
      }
    }
    return false;
  }

  /**
   * The server confirmed it holds these bytes — the ids go clean.
   * Returns whether any id actually flipped (the caller persists only
   * then, so the durable unpushed flags retire in the same breath).
   * Echo fingerprints stay: the server may still echo the row back on a
   * later pull.
   */
  confirmPushed(ids: Iterable<string>): boolean {
    let any = false;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.dirty) {
        entry.dirty = false;
        any = true;
      }
    }
    return any;
  }

  /**
   * The ids left the model (merged away, dropped seeds, retention-swept
   * graves): nothing behind them can ever produce a row or a
   * confirmation, so they stop queueing. Note-life state (a parked
   * conflict, an unseen baseline) dies with them; the id-history state
   * (seq/base/echo) survives — a remote row for the id may still arrive
   * on a pull in flight, and a restored note keeps its merge anchor.
   */
  drop(ids: Iterable<string>): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.dirty = false;
        entry.conflict = undefined;
        entry.unseen = undefined;
      }
    }
  }

  /**
   * Post-merge pruning: dirty ids the model no longer holds (a merge
   * replaced the model wholesale) stop queueing — a merged-away tab can
   * never push again, and its id would otherwise sit in the queue
   * forever, re-serialized and skipped on every cycle. Note-life state
   * dies with the note (see drop); echoes survive (an in-flight pull may
   * still deliver the id's row).
   */
  retainOnly(alive: Iterable<string>): void {
    const aliveIds = new Set(alive);
    this.entries.forEach((entry, id) => {
      if (!aliveIds.has(id)) {
        entry.dirty = false;
        entry.conflict = undefined;
        entry.unseen = undefined;
      }
    });
  }

  /** Records a push fingerprint — what the server may echo back. */
  setEcho(id: string, echo: LedgerEcho): void {
    const existing = this.entries.get(id);
    if (existing) {
      existing.echo = echo;
      return;
    }
    this.entries.set(id, { dirty: false, echo });
  }

  /** The echo fingerprints, keyed by note id — the merge's echo
   *  recognition input. A fresh projection: callers treat it as a
   *  snapshot of what was pushed, never as a handle into the ledger. */
  echoMap(): Map<string, LedgerEcho> {
    const echoes = new Map<string, LedgerEcho>();
    this.entries.forEach((entry, id) => {
      if (entry.echo) {
        echoes.set(id, entry.echo);
      }
    });
    return echoes;
  }

  // ---- the seq/base adoption fields (tranche three) -------------------------

  /** The entry for an id, created on demand (a pushed row for a note the
   *  ledger has never heard of still gets its seq adopted). */
  private entryFor(id: string): LedgerEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { dirty: false };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /**
   * Hydration: a stored row's sync state becomes the in-memory truth.
   * Called once per row at TabManager.init — the boot-side map between
   * the stored spelling and the ledger. The durable `unpushed` flag
   * re-enters the dirty set here (the reload-recovery seed: bytes that
   * outlived their session are strands, and the sync layer's session
   * start arms its pull-first recovery for them).
   */
  adoptStoredRow(row: StoredSyncRow): void {
    const entry = this.entryFor(row.id);
    entry.seq = row.syncSeq;
    entry.base = row.syncBase;
    entry.conflict = row.conflict;
    entry.unseen = row.unseenChange;
    if (row.unpushed === true) {
      this.markDirty(row.id);
    }
  }

  /**
   * A merge result's rows replace the entries' sync state: the merge
   * arbitrates on the STORED spelling (its rows are projected copies),
   * and whatever it left standing is the truth now. Absent fields clear
   * — a merge that dropped a conflict or consumed a marker says so by
   * omitting it. The dirty set and the echoes are deliberately
   * untouched: the queue is tranche one's law, and an in-flight echo is
   * this device's own bytes regardless of what the merge decided.
   */
  adoptMergedRow(row: StoredSyncRow): void {
    const entry = this.entryFor(row.id);
    entry.seq = row.syncSeq;
    entry.base = row.syncBase;
    entry.conflict = row.conflict;
    entry.unseen = row.unseenChange;
  }

  /**
   * A confirmed push advanced the note: fresh seq from the stamped
   * answer, and the exact (content, name) the server now holds as the
   * merge base. Returns whether anything moved (the caller persists
   * only then).
   */
  adoptPushed(id: string, seq: number, base: SyncBase): boolean {
    const entry = this.entryFor(id);
    let touched = false;
    if (seq > 0 && seq !== entry.seq) {
      entry.seq = seq;
      touched = true;
    }
    if (entry.base?.content !== base.content || entry.base?.name !== base.name) {
      entry.base = base;
      touched = true;
    }
    return touched;
  }

  /** A parked version conflict, when one exists (the strip badge, the
   *  review sheet, the note menu's read). */
  conflictOf(id: string): NoteConflictRecord | undefined {
    return this.entries.get(id)?.conflict;
  }

  /** The "changed while away" baseline, when one is parked. */
  unseenOf(id: string): UnseenBaseline | undefined {
    return this.entries.get(id)?.unseen;
  }

  /**
   * Consumes the unseen baseline — the note is being opened, the marker
   * answers its question exactly once. Read-and-clear in one step so the
   * clear rides the same persist the open triggers.
   */
  consumeUnseen(id: string): UnseenBaseline | undefined {
    const entry = this.entries.get(id);
    if (!entry?.unseen) {
      return undefined;
    }
    const baseline = entry.unseen;
    entry.unseen = undefined;
    return baseline;
  }

  /** A review resolved: the record leaves, the note stays. */
  clearConflict(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.conflict = undefined;
    }
  }

  /**
   * The note moved to the trash — its LIFE state dies with it (a parked
   * conflict, an unseen baseline: the review badge must not survive a
   * delete, and the trash has no "away" to peek at), while the id-history
   * state survives for the restore: the seq/base anchor (a restored note
   * must still three-way merge) and the dirty flag (the grave rides the
   * next push — requeue marked it already).
   */
  noteTrashed(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.conflict = undefined;
      entry.unseen = undefined;
    }
  }

  /**
   * The stored/sync view of a domain row: the row plus the ledger's
   * state stamped in the stored spelling. THE projection — persist and
   * exportForSync both build their view here, so the disk, the mirror
   * and the wire always see the same fields from the same truth. The
   * `unpushed` flag is stamped from the dirty set: exactly as fresh as
   * the row beside it, by construction.
   */
  project<T extends { id: string }>(row: T): T & SyncProjection {
    const out = { ...row } as T & SyncProjection;
    const entry = this.entries.get(row.id);
    if (entry) {
      if (entry.seq !== undefined) {
        out.syncSeq = entry.seq;
      }
      if (entry.base) {
        out.syncBase = entry.base;
      }
      if (entry.conflict) {
        out.conflict = entry.conflict;
      }
      if (entry.unseen) {
        out.unseenChange = entry.unseen;
      }
      if (entry.dirty) {
        out.unpushed = true;
      }
    }
    return out;
  }
}
