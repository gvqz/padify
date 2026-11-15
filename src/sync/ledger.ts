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
 * FROM the ledger in the same write as the content (see
 * TabManager.stampUnpushedFlags), so the flag is exactly as fresh as
 * the bytes beside it and a reload re-seeds the ledger from it. The
 * queue can no longer disagree with the dirty set — they are the same
 * set.
 *
 * What deliberately did NOT move here (yet — see the review's tranche
 * map): the storage layer's `lastWritten` diff index (the write-side
 * signature map in storage/notes.ts) and the seq/base adoption fields
 * on the note records. Those are the next tranches; this one unifies
 * the dirty/pending/echo trio without touching a wire or storage shape.
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
   * confirmation, so they stop queueing. Echoes stay for the same
   * reason as confirmPushed — a remote row for the id may still arrive
   * on a pull in flight.
   */
  drop(ids: Iterable<string>): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.dirty = false;
      }
    }
  }

  /**
   * Post-merge pruning: dirty ids the model no longer holds (a merge
   * replaced the model wholesale) stop queueing — a merged-away tab can
   * never push again, and its id would otherwise sit in the queue
   * forever, re-serialized and skipped on every cycle. Echoes survive
   * (see drop).
   */
  retainOnly(alive: Iterable<string>): void {
    const aliveIds = new Set(alive);
    this.entries.forEach((entry, id) => {
      if (entry.dirty && !aliveIds.has(id)) {
        entry.dirty = false;
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
}
