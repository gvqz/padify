/**
 * Padify cloud — the attachment garbage collector, the local half
 * (server half: sweepOrphanAttachments in server/attachments.ts; the
 * shared rule: shared/att-refs.ts).
 *
 * The attachment store gains tenants (captured images, flushed scene
 * files, pulled bytes) but nothing ever removed them — a deleted image
 * or an undone paste left its bytes in IndexedDB forever, and the
 * per-user quota counted ghosts. This sweep runs the SAME verdict the
 * server runs, over the SAME grammar:
 *
 *   every live tab's content + every trash grave's content (a restore
 *   must find its images) names the referenced ids; a stored attachment
 *   none of them names starts a grace clock, and one that stays
 *   unreferenced past ATTACHMENT_ORPHAN_GRACE_MS is deleted.
 *
 * THE CLOCK IS A PAIR OF LOCAL ENTRIES in the kv store: the orphan
 * stamps (id → first-seen-unreferenced) and the last-run stamp (the
 * throttle). Both self-heal: a revived reference clears its stamp on
 * the next sweep, a deleted attachment's stamp is pruned with it.
 *
 * THE TRIGGER. syncCycle fires this after a successful cycle and the
 * upload flush — never on a dirty ledger (judging references against
 * content that is still moving would be judging a lie) — and hands the
 * sweep the LIVE model (exportForSync's tabs + graves). loadNotes()
 * would be the wrong source: it serves the boot-time snapshot, so a
 * reference added mid-session would look unreferenced to it.
 *
 * NOT TENANTS, deliberately: the snapshots sheet (a restored snapshot
 * whose image was later removed from the note renders the same honest
 * placeholder the share viewer ships — counting snapshots would pin
 * every once-seen image forever) and the vendor's in-session files map
 * (the flush owns persistence; a session's undo trail is not storage).
 *
 * SAFETY NET. A wrongly-deleted byte is recoverable by construction:
 * the server copy outlives the local one under the same grace, and the
 * preview's lazy pull re-fetches and re-caches it on the next render.
 * Both clocks would have to be wrong in the same direction for a loss.
 */

import {
  ATTACHMENT_ORPHAN_GRACE_MS,
  collectNoteAttachmentIds,
  orphanVerdicts,
} from '../../shared/att-refs';
import { deleteAttachment, listAttachmentMetas, type AttachmentMeta } from '../storage/attachments';
import { stateGet, stateRemove, stateSet } from '../storage/kv';
import { storageBackend } from '../storage/idb';

/** The kv key holding the orphan stamps (id → first-seen epoch ms). */
const ORPHANS_KEY = 'att-gc-orphans';

/** The kv key holding the last-run stamp (the session throttle). */
const LAST_RUN_KEY = 'att-gc-last-run';

/**
 * The minimum spacing between runs. Sync cycles fire on every keystroke
 * burst; the sweep costs a full enumeration, so it runs at most every
 * six hours — far tighter than the 7-day grace needs, rare enough to
 * never compete with typing.
 */
const GC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The kv shape of the orphan stamps — ids are JSON keys, clocks are ms. */
type OrphanMarkers = Record<string, number>;

/**
 * Runs the local sweep. `readTenants` is the caller's projection of the
 * notes whose references count (the sync layer passes the live model's
 * tabs + graves); the rest of the seams are injectable so tests drive
 * the store without IndexedDB. Resolves with the deleted count (for the
 * log); never throws — garbage collection must not surface as sync
 * trouble.
 */
export async function sweepLocalAttachmentGarbage(
  readTenants: () => Promise<Array<{ content: string; noteType?: string | null }>>,
  overrides: {
    listMetas?: () => Promise<AttachmentMeta[]>;
    deleteOne?: (id: string) => Promise<void>;
    now?: () => number;
    degraded?: () => boolean;
    minIntervalMs?: number;
  } = {},
): Promise<number> {
  const listMetas = overrides.listMetas ?? listAttachmentMetas;
  const deleteOne = overrides.deleteOne ?? deleteAttachment;
  const now = overrides.now ?? (() => Date.now());
  const degraded = overrides.degraded ?? (() => storageBackend() !== 'indexeddb');
  const minIntervalMs = overrides.minIntervalMs ?? GC_MIN_INTERVAL_MS;
  const at = now();

  // A degraded store owns no bytes by construction (capture refuses,
  // pulls skip the cache) — nothing to judge, nothing to mark.
  if (degraded()) {
    return 0;
  }

  const lastRun = Number(stateGet(LAST_RUN_KEY) ?? '0');
  if (lastRun > 0 && at - lastRun < minIntervalMs) {
    return 0;
  }

  const referenced = new Set<string>();
  for (const tenant of await readTenants()) {
    for (const id of collectNoteAttachmentIds(tenant)) {
      referenced.add(id);
    }
  }

  const markers = readMarkers();
  const metas = await listMetas();
  const seen = new Set<string>();
  const entries = metas.map((meta) => {
    seen.add(meta.id);
    return { id: meta.id, orphanSince: markers[meta.id] ?? null };
  });
  const verdicts = orphanVerdicts(entries, referenced, at, ATTACHMENT_ORPHAN_GRACE_MS);

  for (const id of verdicts.garbage) {
    await deleteOne(id);
    // The stamp dies with the record — the prune below walks the store's
    // remaining metas, which still listed this id when they were read.
    delete markers[id];
  }

  // Apply the verdicts to the clock, then prune the stamps of records
  // the store no longer holds (deleted here, or wiped on another
  // device's behalf) — the marker map never grows past the store.
  for (const id of verdicts.clearClock) {
    delete markers[id];
  }
  for (const id of verdicts.stampClock) {
    markers[id] = at;
  }
  for (const id of Object.keys(markers)) {
    if (!seen.has(id)) {
      delete markers[id];
    }
  }
  stateSet(ORPHANS_KEY, JSON.stringify(markers));
  stateSet(LAST_RUN_KEY, String(at));

  if (verdicts.garbage.length > 0) {
    console.info(`[cloud] attachment gc: deleted ${verdicts.garbage.length} unreferenced blob(s)`);
  }
  return verdicts.garbage.length;
}

function readMarkers(): OrphanMarkers {
  const raw = stateGet(ORPHANS_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const markers: OrphanMarkers = {};
    for (const [id, stamp] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) {
        markers[id] = stamp;
      }
    }
    return markers;
  } catch {
    return {};
  }
}

/** Test hook — forget the sweep's kv state. */
export function resetAttachmentGcForTests(): void {
  stateRemove(ORPHANS_KEY);
  stateRemove(LAST_RUN_KEY);
}
