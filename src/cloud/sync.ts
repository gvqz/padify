/**
 * Padify cloud sync — notes (tabs) mirrored to the padify API (Turso).
 *
 * Design rules:
 *  • Local-first. The on-device storage layer (IndexedDB — see
 *    src/storage/) stays the source of truth for the UI; the cloud is a
 *    durable backup + transport between devices. Every feature works
 *    exactly as before while signed out.
 *  • Last-write-wins per note, compared by the client `updatedAt` clock that
 *    padify already stamps on every edit. Conflicts resolve to the most
 *    recent edit; snapshots (local, unsynced) still hold every prior version.
 *  • Deletions are tombstoned (row kept with deleted=true) so closing a tab
 *    on one device removes it everywhere.
 *  • Every cloud failure is non-fatal: the UI degrades to an error/offline
 *    state and retries on the next change, `online` event or 30s tick.
 *
 * The API is a tiny bun service (see server/) backed by a Turso database;
 * sessions are bearer tokens stored under the padifySession storage key.
 */

import { api as apiCall, ApiError } from './api';
import { stateGet, stateSet, stateRemove } from '../storage';
import { normalizeNoteType } from '../editor/note-types';
import type { NoteTab, TabManager, TabTombstone, TabsSyncPayload } from '../tabs';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type CloudStatus =
  | { state: 'unconfigured' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; email: string; sync: SyncPhase; lastSyncAt: number | null }
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
  user_id: string;
  name: string | null;
  html: string;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  /** The note kind; null = the default (standard). Absent on old servers. */
  note_type: string | null;
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

function authErrorMessage(message: string): string {
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Could not reach the sync server. Check your connection and try again.';
  }
  if (/already exists/i.test(message)) {
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
  };
}

function signedInStatus(phase: SyncPhase): CloudStatus {
  return {
    state: 'signed-in',
    email: currentUserEmail ?? '',
    sync: phase,
    lastSyncAt,
  };
}

function handleSignedOut(): void {
  currentUserId = null;
  currentUserEmail = null;
  lastSyncAt = null;
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
    return { ok: false, message: authErrorMessage(message) };
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
    return { ok: false, message: authErrorMessage(message) };
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
        rows.push(tabToRow(tab, userId, payload.tabs.indexOf(tab)));
        return;
      }
      const tombstone = payload.tombstones.find((entry) => entry.id === id);
      if (tombstone) {
        rows.push(tombstoneToRow(tombstone, userId));
      }
    });

    const pushed: string[] = [];
    try {
      for (const batch of batchRowsForPush(rows)) {
        await api('/api/notes', { method: 'PUT', body: { rows: batch } });
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

  // 2. Pull the full remote list and merge.
  const data = await api<{ rows: NoteRow[] }>('/api/notes');
  const remoteRows = (data.rows ?? []).map((row) => ({ ...row, deleted: !!row.deleted }));

  const payload = manager.exportForSync();
  const merge = mergeRemote(remoteRows, payload);

  if (merge.changed) {
    manager.applyExternalMerge(merge.tabs);
  }

  // 3. Push anything the merge revealed as missing or newer locally
  //    (first sign-in upload, edits made while the pull was in flight,
  //    position drift), and confirm tombstones the cloud already has.
  const confirmIds: string[] = [];
  const diffRows: NoteRow[] = [];
  const remoteById = new Map(remoteRows.map((row) => [row.id, row]));
  const mergedTabs = manager.exportForSync().tabs;

  mergedTabs.forEach((tab, index) => {
    const remote = remoteById.get(tab.id);
    if (!remote || remote.updated_at < tab.updatedAt || remote.position !== index) {
      diffRows.push(tabToRow(tab, userId, index));
    }
  });

  payload.tombstones.forEach((tombstone) => {
    const remote = remoteById.get(tombstone.id);
    if (remote?.deleted) {
      confirmIds.push(tombstone.id);
    } else if (!remote || remote.updated_at < tombstone.updatedAt) {
      diffRows.push(tombstoneToRow(tombstone, userId));
    }
  });

  manager.confirmTombstones(confirmIds);

  if (diffRows.length > 0) {
    await api('/api/notes', { method: 'PUT', body: { rows: diffRows } });
  }
}

interface MergeResult {
  tabs: NoteTab[];
  changed: boolean;
}

/**
 * Last-write-wins merge of remote rows into the local tab list. Tombstones
 * lose to newer local edits: a note edited here AFTER it was closed
 * elsewhere stays, and the cycle's step 3 re-pushes it — the edit
 * resurrects the note instead of the delete burying the edit.
 */
export function mergeRemote(remoteRows: NoteRow[], payload: TabsSyncPayload): MergeResult {
  const tabs: NoteTab[] = payload.tabs.map((tab) => ({ ...tab }));
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const freshRemote: NoteTab[] = [];
  let touched = false;

  remoteRows.forEach((row) => {
    if (row.deleted) {
      const local = byId.get(row.id);
      if (local && local.updatedAt > row.updated_at) {
        // The local edit is newer than the remote delete. The note stays
        // exactly as it is (changed: false), and step 3 of the cycle sees
        // remote.updated_at < tab.updatedAt and re-pushes it — deleted=false
        // — so the note returns on every device. A delete may remove a
        // note; it may not bury a newer edit.
        return;
      }
      if (local) {
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
        html: row.html ?? '',
        createdAt: typeof row.created_at === 'number' ? row.created_at : Date.now(),
        updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Date.now(),
        noteType: normalizeNoteType(row.note_type),
      });
      touched = true;
      return;
    }

    if (row.updated_at > local.updatedAt && (row.html !== local.html || row.name !== local.name)) {
      local.name = row.name;
      local.html = row.html ?? '';
      local.createdAt = typeof row.created_at === 'number' ? row.created_at : local.createdAt;
      local.updatedAt = row.updated_at;
      // Type only ever rides along; an old server row (undefined) keeps the
      // local value instead of resetting the note to the default.
      local.noteType = normalizeNoteType(row.note_type) ?? local.noteType;
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
  // for the other side to adopt.
  const dirty = new Set(payload.dirty);
  if (!tabs.some((tab) => dirty.has(tab.id))) {
    const remotePosition = new Map(
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

  return { tabs, changed: touched };
}

/** The server rejects request bodies over 2 MB (its MAX_BODY_BYTES). */
const PUSH_BATCH_BYTES = 1_500_000;

/**
 * Measures a row the way the server will: in UTF-8 bytes, not UTF-16
 * characters. The server's first gate is the Content-Length header, and a
 * CJK note is 3 bytes per character on the wire — a row counting as 1 MB in
 * .length can be 3 MB in flight. Character counts are only correct for
 * ASCII, and notes are not guaranteed to be.
 */
const utf8 = new TextEncoder();

function rowBytes(row: NoteRow): number {
  return utf8.encode(JSON.stringify(row)).length;
}

/**
 * Packs rows into request bodies the server will accept. Rows join the
 * current batch while it stays under PUSH_BATCH_BYTES; a row too large to
 * share a body becomes a batch of one. Such a row can never sync — the
 * server caps bodies at 2 MB — but by failing alone it stops being able to
 * block every other note in the queue, which is the property that matters.
 */
export function batchRowsForPush(rows: NoteRow[]): NoteRow[][] {
  const batches: NoteRow[][] = [];
  let current: NoteRow[] = [];
  let currentBytes = 0;

  for (const row of rows) {
    const size = rowBytes(row);
    if (current.length > 0 && currentBytes + size > PUSH_BATCH_BYTES) {
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

function tabToRow(tab: NoteTab, userId: string, position: number): NoteRow {
  return {
    id: tab.id,
    user_id: userId,
    name: tab.name,
    html: tab.html,
    position,
    created_at: tab.createdAt,
    updated_at: tab.updatedAt,
    deleted: false,
    note_type: tab.noteType ?? null,
  };
}

function tombstoneToRow(tombstone: TabTombstone, userId: string): NoteRow {
  return {
    id: tombstone.id,
    user_id: userId,
    name: null,
    html: '',
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
