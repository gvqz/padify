/**
 * Padify cloud sync — notes (tabs) mirrored to the padify API (Turso).
 *
 * Design rules:
 *  • Local-first. The on-device storage layer (IndexedDB — see
 *    src/storage/) stays the source of truth for the UI; the cloud is a
 *    durable backup + transport between devices. Every feature works
 *    exactly as before while signed out.
 *  • Conflicts never discard words. The merge is still last-write-wins
 *    per note, but a version that would be silently overwritten — a dirty
 *    local tab losing to a newer remote row, an unpushed edit losing to
 *    a tombstone, a clean local meeting the read-max race's equal-seq
 *    twin — is first copied to a fresh "conflicted copy" tab that rides
 *    the next push, so the losing words survive on every device.
 *  • Deletions are tombstoned (row kept with deleted=true) so closing a tab
 *    on one device removes it everywhere.
 *  • Every cloud failure is non-fatal: the UI degrades to an error/offline
 *    state and retries on the next change, `online` event or 30s tick.
 *
 * The API is a tiny bun service (see server/) backed by a Turso database;
 * sessions are bearer tokens stored under the padifySession storage key.
 */

import { api as apiCall, ApiError } from './api';
import { flushAttachmentUploads } from './attachments';
import { stateGet, stateSet, stateRemove } from '../storage';
import { normalizeNoteType } from '../editor/note-types';
import type { NoteTab, TabManager, TabTombstone, TabsSyncPayload } from '../tabs';
// The wire contract both sides of the HTTP boundary share — types below,
// and the one request-body ceiling the client batches under.
import { MAX_BODY_BYTES, MAX_ROWS_PER_PUSH } from '../../shared/wire';
import type { IncomingNoteRow } from '../../shared/wire';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type CloudStatus =
  | { state: 'unconfigured' }
  | { state: 'signed-out' }
  | {
      state: 'signed-in';
      email: string;
      sync: SyncPhase;
      lastSyncAt: number | null;
      warning?: string;
    }
  | { state: 'error'; email: string; message: string; retryable: boolean };

export type SyncPhase = 'idle' | 'syncing' | 'pending' | 'offline';

export interface AuthResult {
  ok: boolean;
  message?: string;
}

export interface CloudSync {
  getStatus(): CloudStatus;
  subscribe(listener: (status: CloudStatus) => void): () => void;
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** Pull + push right now (used by "Sync now" and the online listener). */
  syncNow(): void;
}

// ---------------------------------------------------------------------------
// Cloud row shape (server/notes — see server/schema.sql)
// ---------------------------------------------------------------------------

export interface NoteRow {
  id: string;
  /** v1-pull-only: the server's v2 pull never sends it (shared/wire.ts —
   * PullRowV2), and its PUT parser never reads it. Kept optional so the
   * lenient v1 parse keeps compiling. */
  user_id?: string;
  name: string | null;
  /**
   * The note's content. The rename transition's legacy twin is dead on
   * this wire: v2 clients emit `content` only, v2 servers answer with
   * `content` only. V1 participants (either side of a deploy gap) keep
   * speaking both keys with the same value — readers take either and
   * prefer `content`, so a gap never blanks a note's body in either
   * direction, and the twin rides v1 until every install crossed over.
   */
  content?: string;
  html?: string;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  /** The note kind; null = the default (standard). Absent on old servers. */
  note_type: string | null;
  /**
   * Sync v2: the server's sequence for this version of the row. Ordering
   * across devices keys off it. Absent on v1 servers (and on rows a
   * stamping build never wrote) — those fall back to the client clock.
   */
  seq?: number;
}

/** A v2 pull's answer: the changed rows, the full order, the next cursor. */
export interface PullResult {
  v2: boolean;
  rows: NoteRow[];
  /** The full remote position order by id (v2 only; v1 sorts by row.position). */
  order?: string[];
  /** The client's next cursor (v2 only; never advanced on v1 answers). */
  cursor?: number;
}

/**
 * A wire row's content, whichever key it arrived under. See NoteRow —
 * during the rename transition either key may be the only one present.
 */
function wireRowContent(row: { content?: string; html?: string }): string {
  return row.content ?? row.html ?? '';
}

interface StoredSession {
  token: string;
  userId: string;
  email: string;
}

const SESSION_KEY = 'padifySession';
const SYNC_INTERVAL_MS = 30_000;
const PUSH_DEBOUNCE_MS = 1_200;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let manager: TabManager | null = null;
let session: StoredSession | null = null;

let status: CloudStatus = { state: 'unconfigured' };
const listeners = new Set<(status: CloudStatus) => void>();

let currentUserId: string | null = null;
let currentUserEmail: string | null = null;
let lastSyncAt: number | null = null;

let syncing = false;
let syncQueued = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The stuck-note warning carried by every signed-in status — null when
 * every queued note fits what the server accepts. Set by the push step
 * when a note is too large to ever leave, cleared the moment the queue
 * holds no such note (it was shortened, or its tab left as a small
 * tombstone). See rowUnsyncable.
 */
let syncWarning: string | null = null;

/** Local tab ids that changed and still need a push. */
const pendingPush = new Set<string>();

// ---------------------------------------------------------------------------
// API plumbing
// ---------------------------------------------------------------------------

function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  return apiCall<T>(path, options);
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = stateGet(SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (
      parsed &&
      typeof parsed.token === 'string' &&
      parsed.token &&
      typeof parsed.userId === 'string' &&
      parsed.userId &&
      typeof parsed.email === 'string'
    ) {
      return { token: parsed.token, userId: parsed.userId, email: parsed.email };
    }
  } catch {
    /* malformed session — treat as signed out */
  }
  return null;
}

function storeSession(next: StoredSession | null): void {
  session = next;
  try {
    if (next) {
      stateSet(SESSION_KEY, JSON.stringify(next));
    } else {
      stateRemove(SESSION_KEY);
    }
  } catch {
    /* storage unavailable — session lives for this page only */
  }
}

function authErrorMessage(message: string, mode: 'sign-in' | 'sign-up' = 'sign-in'): string {
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Could not reach the sync server. Check your connection and try again.';
  }
  if (/already exists/i.test(message)) {
    return 'An account with this email already exists — sign in instead.';
  }
  if (mode === 'sign-up' && /wrong email or password/i.test(message)) {
    // The server deliberately answers a duplicate-email signup with the
    // sign-in 401 (anti-enumeration): on a SIGN-UP form that same body
    // means the email is taken — the old copy told the user their
    // (never-set) password was wrong.
    return 'An account with this email already exists — sign in instead.';
  }
  if (/at least 6/i.test(message)) {
    return 'Password must be at least 6 characters.';
  }
  if (/too many attempts|too many requests/i.test(message)) {
    return 'Too many attempts — wait a moment and try again.';
  }
  return message || 'Something went wrong. Try again.';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Wires the sync layer to the tab manager. Always safe to call: without a
 * signed-in session the app behaves exactly like a local-only install.
 */
export async function initCloudSync(tabManager: TabManager): Promise<void> {
  manager = tabManager;
  manager.onPersist = (payload) => onLocalChange(payload);

  session = loadStoredSession();

  // Validate any stored session against the API (this also slides the
  // session's expiry forward on the server side).
  if (session) {
    setStatus(syncingStatus());
    try {
      const me = await api<{ user: { id: string; email: string } }>('/api/me');
      currentUserId = me.user.id;
      currentUserEmail = me.user.email;
      if (me.user.email !== session.email) {
        storeSession({ ...session, email: me.user.email });
      }
      setStatus(signedInStatus('syncing'));
      startSyncTimer();
      void syncCycle('session-restored');
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        // Token expired or revoked — back to signed-out.
        storeSession(null);
        currentUserId = null;
        currentUserEmail = null;
        setStatus({ state: 'signed-out' });
      } else {
        setStatus({
          state: 'error',
          email: session.email,
          message: offlineMessage(error),
          retryable: true,
        });
      }
    }
  } else {
    setStatus({ state: 'signed-out' });
  }

  window.addEventListener('online', () => {
    if (currentUserId) {
      void syncCycle('back-online');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUserId && navigator.onLine) {
      void syncCycle('visible');
    }
  });
}

function offlineMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const offline = !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(message);
  return offline ? 'Offline — changes are safe on this device and will sync later.' : message;
}

// ---------------------------------------------------------------------------
// Status plumbing
// ---------------------------------------------------------------------------

function setStatus(next: CloudStatus): void {
  status = next;
  listeners.forEach((listener) => listener(next));
}

function syncingStatus(): CloudStatus {
  return {
    state: 'signed-in',
    email: currentUserEmail ?? '',
    sync: 'syncing',
    lastSyncAt,
    ...(syncWarning ? { warning: syncWarning } : {}),
  };
}

function signedInStatus(phase: SyncPhase): CloudStatus {
  return {
    state: 'signed-in',
    email: currentUserEmail ?? '',
    sync: phase,
    lastSyncAt,
    ...(syncWarning ? { warning: syncWarning } : {}),
  };
}

function handleSignedOut(): void {
  currentUserId = null;
  currentUserEmail = null;
  lastSyncAt = null;
  syncWarning = null;
  pendingPush.clear();
  stopSyncTimer();
  setStatus({ state: 'signed-out' });
}

// ---------------------------------------------------------------------------
// Auth actions (called from the cloud modal)
// ---------------------------------------------------------------------------

interface AuthResponse {
  token: string;
  user: { id: string; email: string };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  setStatus({ state: 'signed-out' });
  storeSession(null);

  try {
    const data = await api<AuthResponse>('/api/auth/signin', {
      method: 'POST',
      body: { email: email.trim(), password },
    });
    storeSession({ token: data.token, userId: data.user.id, email: data.user.email });
    currentUserId = data.user.id;
    currentUserEmail = data.user.email;
    setStatus(syncingStatus());
    startSyncTimer();
    void syncCycle('sign-in');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: authErrorMessage(message, 'sign-in') };
  }
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  setStatus({ state: 'signed-out' });
  storeSession(null);

  try {
    const data = await api<AuthResponse>('/api/auth/signup', {
      method: 'POST',
      body: { email: email.trim(), password },
    });
    storeSession({ token: data.token, userId: data.user.id, email: data.user.email });
    currentUserId = data.user.id;
    currentUserEmail = data.user.email;
    setStatus(syncingStatus());
    startSyncTimer();
    void syncCycle('sign-up');
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: authErrorMessage(message, 'sign-up') };
  }
}

export async function signOut(): Promise<void> {
  // Best effort: even if the API is unreachable, drop the local session.
  try {
    await api('/api/auth/signout', { method: 'POST' });
  } catch {
    /* server unreachable or already signed out */
  }
  storeSession(null);
  handleSignedOut();
}

// ---------------------------------------------------------------------------
// Local change ingestion
// ---------------------------------------------------------------------------

function onLocalChange(payload: TabsSyncPayload): void {
  if (!currentUserId) {
    return;
  }

  payload.dirty.forEach((id) => pendingPush.add(id));
  payload.tombstones.forEach((tombstone) => pendingPush.add(tombstone.id));

  if (pendingPush.size === 0) {
    return;
  }

  setStatus(signedInStatus('pending'));

  if (pushTimer) {
    clearTimeout(pushTimer);
  }
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void syncCycle('local-change');
  }, PUSH_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Sync cycle — push pending, pull remote, merge, push the diff
// ---------------------------------------------------------------------------

async function syncCycle(_reason: string): Promise<void> {
  if (!manager || !currentUserId || !session) {
    return;
  }
  if (syncing) {
    syncQueued = true;
    return;
  }

  syncing = true;
  setStatus(syncingStatus());

  try {
    await runSyncOnce();
    lastSyncAt = Date.now();
    setStatus(signedInStatus(pendingPush.size > 0 ? 'pending' : 'idle'));
    // Attachments ride along after the cycle — never inside it, so a
    // multi-megabyte upload can never delay note sync. Fire-and-forget:
    // the flush reports its own failures to the console.
    void flushAttachmentUploads();
  } catch (error) {
    console.warn('[cloud] sync failed', error);

    if (error instanceof ApiError && error.statusCode === 401) {
      // Session was revoked elsewhere — stop syncing, keep local notes.
      storeSession(null);
      handleSignedOut();
      return;
    }

    setStatus({
      state: 'error',
      email: currentUserEmail ?? '',
      message: offlineMessage(error),
      retryable: true,
    });
  } finally {
    syncing = false;
    if (syncQueued) {
      syncQueued = false;
      scheduleSync(1_000);
    }
  }
}

async function runSyncOnce(): Promise<void> {
  if (!manager || !currentUserId || !session) {
    return;
  }

  const userId = currentUserId;

  // An empty queue means nothing is stuck: clear any size warning that
  // no longer has a note behind it (the oversized note was shortened, or
  // its tab — now a small tombstone — finally left the device).
  if (pendingPush.size === 0) {
    syncWarning = null;
  }

  // 1. Push whatever is pending (a no-op with an empty queue). Rows go out
  //    in body-capped batches (see batchRowsForPush) so one oversized note
  //    can never hold the rest of the queue hostage — it fails alone.
  if (pendingPush.size > 0) {
    const payload = manager.exportForSync();
    const rows: NoteRow[] = [];
    const byId = new Map(payload.tabs.map((tab) => [tab.id, tab]));

    pendingPush.forEach((id) => {
      const tab = byId.get(id);
      if (tab) {
        rows.push(tabToRow(tab, payload.tabs.indexOf(tab)));
        return;
      }
      const tombstone = payload.tombstones.find((entry) => entry.id === id);
      if (tombstone) {
        rows.push(tombstoneToRow(tombstone));
      }
    });

    const pushed: string[] = [];

    // Rows the server would refuse on size never leave the device — but
    // they stay queued (a stuck id costs one stringify per cycle and ships
    // the moment the note is trimmed under the cap), the rest of the queue
    // flows on without them, and the failure stops being silent: the
    // status carries the reason until the note shrinks or goes.
    const { shippable, stuckNames } = partitionRowsForPush(rows);
    syncWarning = sizeWarningFor(stuckNames);

    try {
      for (const batch of batchRowsForPush(shippable)) {
        await api('/api/notes', { method: 'PUT', body: { v: 2, rows: batch } });
        batch.forEach((row) => pushed.push(row.id));
      }
    } finally {
      // Whatever reached the server is no longer pending: on the happy
      // path the whole queue drains; when one batch fails, the notes that
      // made it out still count as pushed and stop re-announcing on every
      // future persist. The ids the server never saw stay queued for the
      // next cycle — nothing is dropped.
      pushed.forEach((id) => pendingPush.delete(id));
      manager.confirmPushed(pushed);
    }
  }

  // 2. Pull (v2: only what changed past the stored cursor; v1 servers
  //    answer the full list and no cursor — the merge falls back to the
  //    client clock and the cursor never advances).
  const pull = await pullNotes(userId);
  const remoteRows = pull.rows.map((row) => ({ ...row, deleted: !!row.deleted }));

  // Capture the live editor into the model BEFORE building the merge
  // payload. Without this, up to ~700ms of debounce lag (Milkdown ~200ms
  // + the app's 500ms input debounce) can sit in the DOM while the merge
  // arbitrates a stale capture — keystrokes that were never in `payload`
  // can neither win the merge nor seed a conflicted copy, so they would
  // simply vanish when the winner repaints the editor.
  manager.saveActiveFromEditor();

  const payload = manager.exportForSync();
  const merge = mergeRemote(remoteRows, payload, { order: pull.order });

  if (merge.changed) {
    manager.applyExternalMerge(merge.tabs);
  }
  // NOW the cursor may advance: the pulled rows are merged and the
  // persist has been issued. A throw above leaves the cursor where it
  // was, so the next cycle re-pulls instead of skipping.
  if (pull.v2 && typeof pull.cursor === 'number') {
    storeCursor(userId, pull.cursor);
  }

  if (merge.conflicts.length > 0) {
    // A rescue the user never sees is half a rescue. The toast is loaded
    // lazily so this module stays import-clean for its tests.
    void import('../ui/toast')
      .then(({ showToast }) => {
        showToast(`${merge.conflicts.join('. ')}.`);
      })
      .catch(() => {
        /* the merge itself already succeeded — a lost toast is cosmetic */
      });
  }

  // 3. Push anything the pull revealed as missing or newer locally, and
  //    confirm tombstones the cloud already has. Under v2, rows outside
  //    the changed set are known-unchanged (their seq sits at or below the
  //    cursor): they are only pushed for position drift, so an untouched
  //    account stops re-publishing its whole list every cycle.
  const confirmIds: string[] = [];
  const diffRows: NoteRow[] = [];
  const remoteById = new Map(remoteRows.map((row) => [row.id, row]));
  const positionOf = pull.order
    ? new Map(pull.order.map((id, index) => [id, index] as const))
    : null;
  const mergedTabs = manager.exportForSync().tabs;

  mergedTabs.forEach((tab, index) => {
    const remote = remoteById.get(tab.id);
    // The remote place of an unchanged row: the pulled row's position
    // (v1) or the order array's index (v2 — unchanged rows are not in the
    // changed set but their place still matters).
    const remotePosition = remote ? remote.position : (positionOf?.get(tab.id) ?? null);
    if (!remote) {
      // A row the pull did not deliver: under v2 that means unchanged
      // since the cursor (its place alone decides), or brand-new to the
      // server — the first upload of a local-only note.
      if (remotePosition === null || remotePosition !== index) {
        diffRows.push(tabToRow(tab, index));
      }
      return;
    }
    // After the merge kept the local version, its updatedAt is the newer
    // one; equal clocks mean nothing changed — no churn.
    if (remote.updated_at < tab.updatedAt || remotePosition !== index) {
      diffRows.push(tabToRow(tab, index));
    }
  });

  payload.tombstones.forEach((tombstone) => {
    const remote = remoteById.get(tombstone.id);
    if (remote?.deleted) {
      confirmIds.push(tombstone.id);
    } else if (!remote || remote.updated_at < tombstone.updatedAt) {
      diffRows.push(tombstoneToRow(tombstone));
    }
  });

  manager.confirmTombstones(confirmIds);

  if (diffRows.length > 0) {
    // The same gate as step 1: oversized rows never leave the device
    // (they would 400 the whole body — one big note used to wedge EVERY
    // first sync and every re-push cycle), and the rest ship in
    // body-capped batches.
    const { shippable: shippableDiff, stuckNames: stuckDiffNames } = partitionRowsForPush(diffRows);
    const diffWarning = sizeWarningFor(stuckDiffNames);
    if (diffWarning) {
      // Fold into step 1's copy when both found stuck rows.
      syncWarning = syncWarning ? `${syncWarning} ${diffWarning}` : diffWarning;
    }
    for (const batch of batchRowsForPush(shippableDiff)) {
      await api('/api/notes', { method: 'PUT', body: { v: 2, rows: batch } });
    }
  }
}

// ---------------------------------------------------------------------------
// The v2 pull
// ---------------------------------------------------------------------------

/** The stored pull cursor for a user — 0 means “deliver everything”. */
function loadCursor(userId: string): number {
  const raw = stateGet(`padifySyncCursor:${userId}`);
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function storeCursor(userId: string, cursor: number): void {
  if (cursor > 0) {
    stateSet(`padifySyncCursor:${userId}`, String(cursor));
  } else {
    stateRemove(`padifySyncCursor:${userId}`);
  }
}

/**
 * Pulls the remote rows. A v2 server answers with only what changed past
 * the stored cursor (plus the full order and the next cursor); a v1
 * server ignores the version marker and answers the full list — the
 * result is marked v2: false, the merge falls back to client clocks, and
 * the stored cursor never advances past data a v1 server cannot key.
 */
async function pullNotes(userId: string): Promise<PullResult> {
  const cursor = loadCursor(userId);
  const data = await api<{
    v?: number;
    rows?: NoteRow[];
    order?: string[];
    cursor?: number;
  }>(`/api/notes?v=2&cursor=${cursor}`);

  if (data.v === 2) {
    const nextCursor = typeof data.cursor === 'number' && data.cursor > 0 ? data.cursor : cursor;
    // The caller stores the cursor ONLY after the merge it feeds has
    // been applied: persisting it here (a synchronous localStorage
    // write) used to outrun the merged tabs' async IndexedDB write, so a
    // crash or a merge exception in between skipped the pulled rows
    // forever — the device kept a stale copy that later overwrote the
    // server's newer words.
    return {
      v2: true,
      rows: (data.rows ?? []).map((row) => ({ ...row, deleted: !!row.deleted })),
      order: data.order,
      cursor: nextCursor,
    };
  }

  return {
    v2: false,
    rows: (data.rows ?? []).map((row) => ({ ...row, deleted: !!row.deleted })),
  };
}

interface MergeResult {
  tabs: NoteTab[];
  changed: boolean;
  /**
   * One sentence per conflicted copy created this merge, phrased for the
   * toast (e.g. "Groceries — conflicted copy was kept"). Empty when no
   * version needed rescuing.
   */
  conflicts: string[];
}

/**
 * Last-write-wins merge of remote rows into the local tab list.
 *
 * Sync v2 orders by the server's sequence: a row that carries one wins
 * against a local row that carries one by seq alone (client clocks only
 * ever arbitrate rows that never did — v1 servers, rows a stamping build
 * never wrote). A local row without a seq adopts a matching remote row
 * wholesale (identical content, the seq gained — the rollout path for
 * pre-upgrade installs); differing content without a local seq still
 * falls to the clock. Tombstones lose to newer local edits: a note edited
 * here AFTER it was closed elsewhere stays, and the cycle's step 3
 * re-pushes it — the edit resurrects the note instead of the delete
 * burying the edit.
 *
 * Nothing is ever silently discarded. When the winner would overwrite
 * words the cloud never confirmed, the loser becomes a conflicted copy —
 * a fresh tab with its own id that rides the next push, so BOTH versions
 * exist everywhere. Three shapes trigger this: a dirty local tab losing
 * an edit race, a dirty local tab losing to a tombstone (the delete still
 * removes the note — the copy keeps the unconfirmed words), and the
 * equal-seq twin the old read-max race could stamp onto two different
 * versions (a clean local meeting its twin lets the remote take the row
 * and keeps the local words in a copy; a dirty local edited FROM that
 * version and simply wins).
 */
export function mergeRemote(
  remoteRows: NoteRow[],
  payload: TabsSyncPayload,
  options: { order?: string[] } = {},
): MergeResult {
  const tabs: NoteTab[] = payload.tabs.map((tab) => ({ ...tab }));
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const freshRemote: NoteTab[] = [];
  const conflicts: string[] = [];
  const dirty = new Set(payload.dirty);
  let touched = false;

  /** The local row wins the delete: newer by seq when both carry one,
   *  by clock otherwise. Equal seqs mean the delete replaced the very
   *  version this row edited from — an unpushed edit never saw it, so the
   *  clock arbitrates exactly as in v1 (later local edit survives, an
   *  identical copy goes with the delete). */
  const localSurvivesDelete = (local: NoteTab, row: NoteRow): boolean => {
    if (row.seq && local.syncSeq) {
      if (local.syncSeq !== row.seq) {
        return local.syncSeq > row.seq;
      }
    }
    return local.updatedAt > row.updated_at;
  };

  /** The remote row wins the edit: by seq when both carry one, by clock
   *  otherwise. A local row without a seq takes an identical remote row
   *  wholesale (adoption) and a differing one only on the clock. An equal
   *  seq with differing content is the read-max race's artifact — two
   *  versions, one number: a clean local defers to the row (its words
   *  leave a copy behind), a dirty local is the newer branch and keeps
   *  the note. */
  const remoteWinsEdit = (local: NoteTab, row: NoteRow, localDirty: boolean): boolean => {
    const differs = wireRowContent(row) !== local.content || row.name !== local.name;
    if (row.seq && local.syncSeq) {
      if (row.seq === local.syncSeq) {
        return !localDirty && differs;
      }
      return row.seq > local.syncSeq && differs;
    }
    if (row.seq && !local.syncSeq) {
      if (!differs) {
        return true; // adoption: identical content, the seq gained
      }
      return row.updated_at > local.updatedAt;
    }
    return row.updated_at > local.updatedAt && differs;
  };

  /** True when the row carries the same seq as the local tab's last sync
   *  — the fingerprint of the race this merge now has to heal. */
  const tieRaced = (local: NoteTab, row: NoteRow): boolean =>
    !!row.seq && !!local.syncSeq && row.seq === local.syncSeq;

  /**
   * The losing side of a race, kept as its own note. A conflicted copy is
   * a brand-new tab (fresh id, no syncSeq, nothing dirty to inherit) with
   * the exact content that was about to be overwritten: the cycle's step 3
   * pushes every local tab the pull did not deliver, so the copy rides the
   * very next push and the losing words end up backed up on every device —
   * not merely rescued on the one that typed them. Tag-stripped emptiness
   * (<p></p>, <br>) does not deserve a copy; blank losers vanish quietly.
   */
  const conflictCopyFrom = (local: NoteTab, deletedElsewhere: boolean): NoteTab => {
    const base = (local.name ?? 'Note').slice(0, 40);
    return {
      id: crypto.randomUUID(),
      name: deletedElsewhere ? `${base} — copy (deleted elsewhere)` : `${base} — conflicted copy`,
      content: local.content,
      createdAt: local.createdAt,
      updatedAt: Date.now(),
      noteType: local.noteType,
      colorTheme: local.colorTheme,
    };
  };

  /** Words worth keeping: non-blank once tags are stripped. */
  const hasWords = (content: string): boolean => content.replace(/<[^>]*>/g, '').trim() !== '';

  remoteRows.forEach((row) => {
    if (row.deleted) {
      const local = byId.get(row.id);
      if (local && localSurvivesDelete(local, row)) {
        // The local edit is newer than the remote delete. The note stays
        // exactly as it is (changed: false), and step 3 of the cycle sees
        // remote.updated_at < tab.updatedAt and re-pushes it — deleted=false
        // — so the note returns on every device. A delete may remove a
        // note; it may not bury a newer edit.
        return;
      }
      if (local) {
        if (dirty.has(local.id) && hasWords(local.content)) {
          // Unconfirmed words about to be buried by a tombstone: the
          // delete still takes the note, the copy keeps the words.
          const copy = conflictCopyFrom(local, true);
          freshRemote.push(copy);
          conflicts.push(
            `"${copy.name}" was deleted on another device — this device's unsynced changes were kept as a copy`,
          );
        }
        byId.delete(row.id);
        const index = tabs.findIndex((tab) => tab.id === row.id);
        if (index >= 0) {
          tabs.splice(index, 1);
        }
        touched = true;
      }
      return;
    }

    const local = byId.get(row.id);
    if (!local) {
      freshRemote.push({
        id: row.id,
        name: row.name,
        content: wireRowContent(row),
        createdAt: typeof row.created_at === 'number' ? row.created_at : Date.now(),
        updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Date.now(),
        noteType: normalizeNoteType(row.note_type),
        syncSeq: row.seq && row.seq > 0 ? row.seq : undefined,
      });
      touched = true;
      return;
    }

    if (remoteWinsEdit(local, row, dirty.has(local.id))) {
      const contentDiffers = wireRowContent(row) !== local.content;
      if (
        contentDiffers &&
        (dirty.has(local.id) || tieRaced(local, row)) &&
        hasWords(local.content)
      ) {
        // Words the cloud never confirmed are about to be overwritten:
        // the remote takes the canonical row, the copy takes the words.
        const copy = conflictCopyFrom(local, false);
        freshRemote.push(copy);
        conflicts.push(`"${copy.name}" was changed on two devices — both versions were kept`);
      }
      local.name = row.name;
      local.content = wireRowContent(row);
      local.createdAt = typeof row.created_at === 'number' ? row.created_at : local.createdAt;
      local.updatedAt = row.updated_at;
      // Type only ever rides along; an old server row (undefined) keeps the
      // local value instead of resetting the note to the default.
      local.noteType = normalizeNoteType(row.note_type) ?? local.noteType;
      local.syncSeq = row.seq && row.seq > 0 ? row.seq : local.syncSeq;
      touched = true;
    }
  });

  // Remote-only tabs join the strip; their final place is decided by the
  // ordering pass below.
  tabs.push(...freshRemote);

  // Positions converge instead of ping-ponging. Without this, two devices
  // that merged the same notes in different orders each see
  // remote.position !== localIndex on every cycle and each re-push their
  // own ordering forever — the full list, every 30 seconds, both ways.
  // When this device has nothing pending, the remote ordering wins (the
  // strip never reorders underneath an in-flight edit); a device with
  // dirty notes keeps its own order, and its step-3 push re-publishes it
  // for the other side to adopt. Under v2 the remote ordering is the
  // order array (unchanged rows included); under v1 it is the rows'
  // positions.
  if (!tabs.some((tab) => dirty.has(tab.id))) {
    const remotePosition = options.order
      ? new Map(options.order.map((id, index) => [id, index] as const))
      : new Map(
          remoteRows.filter((row) => !row.deleted).map((row) => [row.id, row.position] as const),
        );
    const before = tabs.map((entry) => entry.id).join('|');
    // Stable sort: notes the cloud has never seen (signed-out creations,
    // still clean because they were pushed in an earlier session) keep
    // their relative order at the end.
    tabs.sort((a, b) => {
      const pa = remotePosition.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const pb = remotePosition.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb;
    });
    if (tabs.map((entry) => entry.id).join('|') !== before) {
      touched = true;
    }
  }

  return { tabs, changed: touched, conflicts };
}

/** The server rejects request bodies over 2 MB (see shared/wire.ts). */
const PUSH_BATCH_BYTES = 1_500_000;

/** The server also rejects PUT bodies carrying over 500 rows (see
 * shared/wire.ts MAX_ROWS_PER_PUSH) — the batcher splits on BOTH caps. */
const PUSH_BATCH_ROWS = MAX_ROWS_PER_PUSH;

/**
 * Envelope of a single-row PUT body around the row's own JSON
 * ({"v":2,"rows":[…]}) plus JSON-escaping headroom for the wrapper.
 */
const BODY_ENVELOPE_SLACK = 64;

/**
 * Measures a row the way the server will: in UTF-8 bytes, not UTF-16
 * characters. The server's first gate is the Content-Length header, and a
 * CJK note is 3 bytes per character on the wire — a row counting as 1 MB in
 * .length can be 3 MB in flight. Character counts are only correct for
 * ASCII, and notes are not guaranteed to be.
 */
const utf8 = new TextEncoder();

/**
 * A row the server will always refuse, measured the way the server
 * measures it: readJson counts the body in UTF-16 characters AND the
 * runtime gates the Content-Length header in UTF-8 bytes — a CJK-heavy
 * note can pass one and fail the other, so both must clear. Such a row
 * cannot share a body (the batcher already isolates it) and cannot ride
 * one alone either: pushing it would 413 every cycle forever, pinning
 * the queue's error state and drowning notes that sync perfectly well.
 * The push step filters these out instead and tells the user why.
 */
export function rowUnsyncable(row: NoteRow): boolean {
  const json = JSON.stringify(row);
  return (
    json.length + BODY_ENVELOPE_SLACK > MAX_BODY_BYTES ||
    utf8.encode(json).length + BODY_ENVELOPE_SLACK > MAX_BODY_BYTES
  );
}

function rowBytes(row: NoteRow): number {
  return utf8.encode(JSON.stringify(row)).length;
}

/**
 * Packs rows into request bodies the server will accept. Rows join the
 * current batch while it stays under PUSH_BATCH_BYTES AND the batch holds
 * fewer than PUSH_BATCH_ROWS rows — a queue of 600 tiny notes would
 * otherwise pack into one 60 KB body that the server rejects on row count
 * alone, on every 30 s cycle, with nothing in the byte-only logic that
 * ever shrinks it. A row too large to share a body becomes a batch of
 * one. Rows too large to ride even alone never reach this function —
 * rowUnsyncable filters them out upstream — so every batch that leaves
 * here is one the server will take.
 */
/** Partitions rows for any push: oversized rows stay on the device
 *  (named for the warning), the rest batch by body cap and row count.
 *  Both push paths — the pending queue (step 1) and the diff corpus
 *  (step 3) — must go through the same gate. */
export function partitionRowsForPush(rows: NoteRow[]): {
  shippable: NoteRow[];
  stuckNames: string[];
} {
  const shippable: NoteRow[] = [];
  const stuckNames: string[] = [];
  for (const entry of rows) {
    if (rowUnsyncable(entry)) {
      stuckNames.push(entry.name ?? 'A note');
    } else {
      shippable.push(entry);
    }
  }
  return { shippable, stuckNames };
}

/** The user-facing size warning for stuck rows (null when none). */
export function sizeWarningFor(stuckNames: string[]): string | null {
  if (stuckNames.length === 0) {
    return null;
  }
  const one = `“${stuckNames[0]}” is over the 2 MB sync limit — it stays on this device until it is shortened.`;
  return stuckNames.length === 1
    ? one
    : `${stuckNames.length} notes are over the 2 MB sync limit — they stay on this device until they are shortened.`;
}

export function batchRowsForPush(rows: NoteRow[]): NoteRow[][] {
  const batches: NoteRow[][] = [];
  let current: NoteRow[] = [];
  let currentBytes = 0;

  for (const row of rows) {
    const size = rowBytes(row);
    if (
      current.length > 0 &&
      (currentBytes + size > PUSH_BATCH_BYTES || current.length >= PUSH_BATCH_ROWS)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function tabToRow(tab: NoteTab, position: number): IncomingNoteRow {
  return {
    id: tab.id,
    name: tab.name,
    // One key: v2 clients stopped emitting the rename's legacy twin (see
    // shared/wire.ts). V1 servers read either and prefer `content`.
    content: tab.content,
    position,
    created_at: tab.createdAt,
    updated_at: tab.updatedAt,
    deleted: false,
    note_type: tab.noteType ?? null,
  };
}

function tombstoneToRow(tombstone: TabTombstone): IncomingNoteRow {
  return {
    id: tombstone.id,
    name: null,
    content: '',
    position: 0,
    created_at: tombstone.updatedAt,
    updated_at: tombstone.updatedAt,
    deleted: true,
    note_type: null,
  };
}

// ---------------------------------------------------------------------------
// Manual + scheduled sync
// ---------------------------------------------------------------------------

function scheduleSync(delayMs: number): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
  }
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void syncCycle('scheduled');
  }, delayMs);
}

function syncNow(): void {
  if (currentUserId) {
    void syncCycle('manual');
  }
}

/**
 * The 30s sync tick runs only while a session is live. Sign-in (or a
 * restored session at boot) starts it; handleSignedOut tears it down, so
 * signed-out pages leave zero sync timers behind.
 */
function startSyncTimer(): void {
  if (syncTimer !== null) {
    return;
  }
  syncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine && currentUserId) {
      void syncCycle('periodic');
    }
  }, SYNC_INTERVAL_MS);
}

function stopSyncTimer(): void {
  if (syncTimer === null) {
    return;
  }
  clearInterval(syncTimer);
  syncTimer = null;
}

// ---------------------------------------------------------------------------
// Exported controller
// ---------------------------------------------------------------------------

let instance: CloudSync | null = null;

export function getCloudSync(): CloudSync {
  if (!instance) {
    instance = {
      getStatus: () => status,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(status);
        return () => listeners.delete(listener);
      },
      signIn,
      signUp,
      signOut,
      syncNow,
    };
  }
  return instance;
}

/** Test hook — exposes whether the engine actually booted. */
export function isCloudSyncActive(): boolean {
  return manager !== null;
}

/** Signed-in user id, or null when signed out. */
export function getCloudUserId(): string | null {
  return currentUserId;
}
