/**
 * The write index — the ledger's write-side view.
 *
 * S1's tranche two. Before this module, the storage layer answered "did
 * this row change since I last wrote it to disk?" with a hand-rolled
 * diff: an eleven-field `LastWrittenEntry` interface, a ten-condition
 * comparison chain, and four bespoke equality helpers (`sameSyncBase`,
 * `sameUnseen`, `sameConflict`, `sameGraveBase`) — each one a place where
 * a field could be silently forgotten. Two were: a conflict record whose
 * `theirs.name` or `detectedAt` moved alone never re-wrote (the persisted
 * review record went stale), and a `syncSeq` adopted by an echo with no
 * other change never persisted (the reload fell back to an older anchor).
 * That is the same drift class the ledger exists to close — parallel
 * structures that must agree, compared field by field by hand.
 *
 * Here the comparison is structural instead. ONE function projects a row
 * (plus its strip layout) onto the canonical write signature — every
 * field whose change must reach the database, and nothing else — and the
 * index compares whole signatures. A field joins persistence by joining
 * `signatureOf`'s one list; there is no second place to forget it.
 *
 * Deliberately NOT in the signature:
 *  • `content` — content changes always bump `updatedAt` on the write
 *    paths (TabManager.nextUpdatedAt), so comparing the bytes themselves
 *    would copy every keystroke's full string into the index for nothing.
 *    The bump is the change signal; the sync-layer fields below it
 *    (`syncBase`, `conflict`) move only on sync events, never keystrokes.
 *  • `colorTheme` — a theme flip with no edit rides the next content
 *    write, exactly as it always has (the re-ink on open is the safety).
 *  • `copyOf` — legacy lineage; nothing writes it anymore, values ride
 *    unread (they still ship inside any upsert the diff does issue).
 *
 * What joined the index from the old module globals (per the review's
 * tranche map): the externally-deleted blacklist (another tab of this
 * browser deleted the note — the mirror's `storage` event says so, and
 * the diff refuses to upsert a live row back over that delete) and the
 * swept-trash seeding (rows the boot retention sweep retired, indexed
 * only so the next save derives their database delete).
 *
 * Naming: this is "the ledger's write-side view" because the rows it
 * signatures are the (domain + ledger) projection the model persists —
 * after tranche three the sync fields in a signature ARE ledger state
 * viewed through the stored shape. The ledger (sync/ledger.ts) owns
 * "have these bytes changed, and has the cloud seen them?" for the PUSH
 * side; this index owns the same question for the DISK side, against
 * the very same projected rows.
 */

import type { NoteType } from '../editor/note-types';
import type { NoteConflictRecord, SyncBase, UnseenBaseline } from './ledger';

/**
 * A row in signature range: the stored shape's sync-carrying fields plus
 * the domain fields the write diff must see. Structural on purpose —
 * StoredNoteTab and TrashedNote both satisfy it without an import edge
 * back into the storage layer (that import would be a cycle:
 * storage/notes.ts is this module's consumer).
 */
export interface WriteSignatureRow {
  id: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  noteType?: NoteType;
  syncSeq?: number;
  syncBase?: SyncBase;
  unseenChange?: UnseenBaseline;
  conflict?: NoteConflictRecord;
  unpushed?: boolean;
}

/** Where the row sits in the persisted model: strip slot, or the grave. */
export interface WriteLayout {
  position: number;
  deleted: boolean;
  deletedAt: number;
}

/**
 * The canonical signature. Built in exactly one place (`signatureOf`) so
 * both sides of any comparison — the indexed entry and the candidate —
 * share key sets by construction (the structural compare relies on it).
 */
interface WriteSignature {
  name: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  noteType: NoteType | undefined;
  deleted: boolean;
  deletedAt: number;
  syncSeq: number | undefined;
  syncBase: SyncBase | undefined;
  unseenChange: UnseenBaseline | undefined;
  conflict: NoteConflictRecord | undefined;
  unpushed: boolean;
}

/**
 * Projects a row onto its write signature — THE list of fields whose
 * change must reach the database. Adding a persisted field means adding
 * it here (and nowhere else); the diff, the seeding and the rollback
 * paths all compare whole signatures, so there is no helper to forget
 * to update.
 */
export function signatureOf(row: WriteSignatureRow, layout: WriteLayout): WriteSignature {
  return {
    name: row.name,
    position: layout.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    noteType: row.noteType,
    deleted: layout.deleted,
    deletedAt: layout.deletedAt,
    syncSeq: row.syncSeq,
    syncBase: row.syncBase,
    unseenChange: row.unseenChange,
    conflict: row.conflict,
    unpushed: row.unpushed === true,
  };
}

/**
 * Structural equality over signature shapes. Reference equality short-
 * circuits the common case (the row was not touched since the last
 * write); the walk only runs when an object was replaced wholesale (a
 * sync merge re-adopted a field) and must decide whether the VALUE
 * survived. Plain JSON-shaped data only — no arrays, no cycles, by
 * construction of `signatureOf`.
 */
function signaturesEqual(a: WriteSignature, b: WriteSignature): boolean {
  if (a === b) {
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of aKeys) {
    const left = (a as unknown as Record<string, unknown>)[key];
    const right = (b as unknown as Record<string, unknown>)[key];
    if (left === right) {
      continue;
    }
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
      return false;
    }
    if (!signaturesEqual(left as unknown as WriteSignature, right as unknown as WriteSignature)) {
      return false;
    }
  }
  return true;
}

/** One indexed id: its last-written signature, plus the swept flag. */
interface IndexEntry {
  signature: WriteSignature;
  /** A retention-swept row: indexed only so the next save derives its
   *  database delete (see sweptIds). Never an upsert candidate — the
   *  model does not hold it. */
  swept: boolean;
}

/** A retired entry, handed back to the caller so a failed write can
 *  restore it (the delete-derivation rollback). Opaque by design. */
export type RetiredEntry = IndexEntry;

export class WriteIndex {
  private readonly entries = new Map<string, IndexEntry>();
  /**
   * Note ids deleted by ANOTHER tab of this browser (learned from the
   * compatibility mirror's `storage` events). Mirror, never merge: the
   * blob IS the trash as the other tab sees it now, so a restore there
   * lifts the blacklist here (an add-only set would keep a restored note
   * blacklisted for the rest of the session — its edits would never
   * reach IndexedDB again). Owned by the index so the diff consults one
   * structure (see replaceExternallyDeleted).
   */
  private readonly externallyDeleted = new Set<string>();

  /**
   * Seeds an entry as loaded (hydrate). `swept` marks retention-retired
   * rows: they sit in the index's delete path only, so the next save
   * removes them from the database.
   */
  seed(row: WriteSignatureRow, layout: WriteLayout, options: { swept?: boolean } = {}): void {
    this.entries.set(row.id, {
      signature: signatureOf(row, layout),
      swept: options.swept === true,
    });
  }

  /**
   * True when the row must (re)write: no entry yet, or its signature
   * differs from what was last written.
   */
  changed(row: WriteSignatureRow, layout: WriteLayout): boolean {
    const entry = this.entries.get(row.id);
    if (!entry) {
      return true;
    }
    return !signaturesEqual(entry.signature, signatureOf(row, layout));
  }

  /** Indexes a row as just-written (the diff calls this when it queues
   *  the upsert, so the entry reflects the write in flight). */
  commit(row: WriteSignatureRow, layout: WriteLayout): void {
    this.entries.set(row.id, { signature: signatureOf(row, layout), swept: false });
  }
  /**
   * Removes entries — the failed-write path for upserts (the next save
   * re-derives them as changed) and the hard-purge path (the rows left
   * the database on purpose; no later save may re-derive anything for
   * them, not even a delete).
   */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      this.entries.delete(id);
    }
  }

  /**
   * Derives the deletes: indexed ids the model no longer holds (merged
   * away, retired purged placeholders). The entries leave the index but
   * ride home as `retired` — a failed write restores them so the next
   * save re-issues the delete (a delete only exists while its id sits in
   * the index).
   */
  retireAbsent(seen: Set<string>): { deletes: string[]; retired: Map<string, RetiredEntry> } {
    const deletes: string[] = [];
    this.entries.forEach((_entry, id) => {
      if (!seen.has(id)) {
        deletes.push(id);
      }
    });
    const retired = new Map<string, RetiredEntry>();
    deletes.forEach((id) => {
      const entry = this.entries.get(id);
      if (entry) {
        retired.set(id, entry);
      }
      this.entries.delete(id);
    });
    return { deletes, retired };
  }

  /** The failed-write rollback for derived deletes. */
  restore(retired: Map<string, RetiredEntry>): void {
    retired.forEach((entry, id) => {
      this.entries.set(id, entry);
    });
  }

  /** The retention-swept ids — index.ts purges them from the database
   *  right after boot so they don't linger until the first save. */
  sweptIds(): string[] {
    const ids: string[] = [];
    this.entries.forEach((entry, id) => {
      if (entry.swept) {
        ids.push(id);
      }
    });
    return ids;
  }

  /** Replaces the externally-deleted blacklist wholesale (mirror, never
   *  merge — see the field docs for the restore semantics). */
  replaceExternallyDeleted(ids: Iterable<string>): void {
    this.externallyDeleted.clear();
    for (const id of ids) {
      this.externallyDeleted.add(id);
    }
  }

  isExternallyDeleted(id: string): boolean {
    return this.externallyDeleted.has(id);
  }

  /** Test hook: wipes every structure. */
  reset(): void {
    this.entries.clear();
    this.externallyDeleted.clear();
  }
}
