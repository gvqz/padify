/**
 * The trash store — the grave lifecycle, extracted from the TabManager
 * (S2). The store owns the trashed-note LIST and every grave-shaped
 * mutation: minting a grave from a dying tab, restoring, the
 * delete-forever sweeper placeholders, the empty-trash sweep, the
 * retention-filtered boot seed, and the merge adoption. The ORCHESTRATION
 * around those mutations (editor capture, neighbour focus, strip repaints,
 * toasts, snapshot deletion, the persist itself) stays with the manager —
 * the store is the model half of the trash, not its UI.
 *
 * The ledger interactions that are GRAVE-shaped live here too (the store
 * holds the same single ledger instance the manager composes):
 * minting calls noteTrashed (the note's life state — a parked conflict, an
 * unseen baseline — dies at the trash door) and requeue (the grave's row
 * rides behind the live rows already waiting); the sweeper placeholders
 * mark themselves dirty so their backdated delete rows ship. The ledger
 * entry itself is keyed by id and simply outlives the live↔trash
 * transitions — the seq/base anchor a restore needs never moves.
 *
 * The sweeper-row contract (purgeNote/emptyTrash): a "delete forever"
 * mints a placeholder grave — content emptied, deletedAt backdated to 1
 * (past any retention window), purged-flagged, invisible everywhere. The
 * row rides the next push; the server's boot sweep retires it, every
 * other device's hydrate sweep drops it on sight, and confirmPushed
 * retires the placeholder locally the moment the push lands (see
 * retirePurged).
 */

import { nextUpdatedAt, domainGraveOf, type NoteTab } from './domain';
import type { SyncLedger } from '../sync/ledger';
import type { TrashedNote } from '../storage';

export class TrashStore {
  private graves: TrashedNote[] = [];
  private readonly trashListeners = new Set<() => void>();

  constructor(private readonly ledger: SyncLedger) {}

  /**
   * The delete receipt — the History button's trash flash and the
   * snapshots' noteTrashed hook hang off this. Fires on the MINT (a note
   * just arrived in the trash), not on purge or empty: those are
   * deliberate forever-deletes with their own surfaces, and a flash on
   * the door they left through would be noise after the sheet's own
   * confirmation.
   */
  addTrashListener(listener: () => void): () => void {
    this.trashListeners.add(listener);
    return () => {
      this.trashListeners.delete(listener);
    };
  }

  /** Every grave, in model order — internal reads (the push queue's
   *  resolution, the merge's alive-set) want the raw list. */
  get all(): readonly TrashedNote[] {
    return this.graves;
  }

  /** The visible, newest-first list — the trash sheet's read. */
  list(): readonly TrashedNote[] {
    return this.graves.filter((entry) => !entry.purged).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** A grave by id, when the store holds one. */
  find(id: string): TrashedNote | undefined {
    return this.graves.find((entry) => entry.id === id);
  }

  /**
   * The boot seed: adopt each grave's sync state into the ledger (the
   * durable unpushed flag re-enters the dirty set — an offline delete is
   * a strand too) and keep the domain + stamp half in the model.
   */
  seed(rows: TrashedNote[]): void {
    this.graves = [];
    rows.forEach((grave) => {
      this.ledger.adoptStoredRow(grave);
      this.graves.push(domainGraveOf(grave));
    });
  }

  /**
   * Mints the grave a dying tab leaves behind: the full record (content,
   * name, type, ink theme) with a fresh deletedAt stamp, restorable for
   * the retention window. The note's life state dies at this door; the
   * grave's row rides the next push BEHIND the live rows already waiting
   * (requeue — the sync layer resolves pending ids against tabs first,
   * trash second).
   */
  mintFromTab(tab: NoteTab): void {
    this.graves = this.graves.filter((entry) => entry.id !== tab.id);
    this.graves.push({
      id: tab.id,
      name: tab.name,
      content: tab.content,
      createdAt: tab.createdAt,
      updatedAt: nextUpdatedAt(tab.updatedAt),
      noteType: tab.noteType,
      colorTheme: tab.colorTheme,
      copyOf: tab.copyOf,
      deletedAt: Date.now(),
    });
    this.ledger.noteTrashed(tab.id);
    this.ledger.requeue(tab.id);
    // The receipt fires inside the mint, before the caller persists and
    // repaints — the same position it held when the manager fired it
    // after this call, kept deliberate: the flash's first tick lands
    // clean, never behind the persist's own work in the same beat.
    this.trashListeners.forEach((listener) => listener());
  }

  /**
   * Removes a grave for restoration. Returns it (the caller rebuilds the
   * live tab and marks it dirty — the restore rides the next push as a
   * live row, and the server's delete-race guard accepts it because it
   * carries a strictly newer updated_at than the trash it reverses).
   */
  takeForRestore(id: string): TrashedNote | null {
    const grave = this.graves.find((entry) => entry.id === id);
    if (!grave || grave.purged) {
      return null;
    }
    this.graves = this.graves.filter((entry) => entry.id !== id);
    return grave;
  }

  /**
   * "Delete forever": the grave becomes a sweeper placeholder — content
   * emptied, deletedAt backdated past every retention window, purged and
   * invisible. See the module docs for how the row propagates.
   */
  purge(id: string): boolean {
    const grave = this.graves.find((entry) => entry.id === id);
    if (!grave) {
      return false;
    }
    this.graves = this.graves.filter((entry) => entry.id !== id);
    this.graves.push({
      id: grave.id,
      name: null,
      content: '',
      createdAt: grave.createdAt,
      updatedAt: nextUpdatedAt(grave.updatedAt),
      deletedAt: 1,
      purged: true,
    });
    this.ledger.markDirty(grave.id);
    return true;
  }

  /**
   * "Empty trash": every visible grave purged by the same sweeper-row
   * mechanism. Returns the emptied ids (empty when there was nothing to
   * empty) — the caller needs them for the snapshots sweep, which must
   * read the ids before the placeholders replaced the graves.
   */
  emptyVisible(): string[] {
    const visible = this.graves.filter((entry) => !entry.purged);
    if (visible.length === 0) {
      return [];
    }
    const now = Date.now();
    this.graves = this.graves
      .filter((entry) => entry.purged)
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
    visible.forEach((grave) => this.ledger.markDirty(grave.id));
    return visible.map((grave) => grave.id);
  }

  /**
   * The merge adoption: incoming graves replace the list, each row's sync
   * state adopted into the ledger (absent fields clear — the merged truth
   * is the truth), the model keeping the domain + stamp half.
   */
  adoptMerged(rows: TrashedNote[]): void {
    rows.forEach((grave) => this.ledger.adoptMergedRow(grave));
    this.graves = rows.map((grave) => domainGraveOf(grave));
  }

  /**
   * A confirmed push retires the placeholders whose sweeper rows landed —
   * there is nothing left to show, restore or push for them. Returns
   * whether any left (the caller re-renders the rail badge then).
   */
  retirePurged(confirmed: ReadonlySet<string>): boolean {
    const before = this.graves.length;
    this.graves = this.graves.filter((entry) => !(entry.purged && confirmed.has(entry.id)));
    return this.graves.length !== before;
  }
}
