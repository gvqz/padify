/**
 * Padify cloud sync — notes (tabs) mirrored to a Supabase project.
 *
 * Design rules:
 *  • Local-first. localStorage stays the source of truth for the UI; the
 *    cloud is a durable backup + transport between devices. Every feature
 *    works exactly as before while signed out.
 *  • Last-write-wins per note, compared by the client `updatedAt` clock that
 *    padify already stamps on every edit. Conflicts resolve to the most
 *    recent edit; snapshots (local, unsynced) still hold every prior version.
 *  • Deletions are tombstoned (row kept with deleted=true) so closing a tab
 *    on one device removes it everywhere.
 *  • Every cloud failure is non-fatal: the UI degrades to an error/offline
 *    state and retries on the next change, `online` event or 30s tick.
 *
 * The supabase-js client is loaded through a dynamic import so it never
 * touches the initial payload, and only when a project is configured.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCloudConfig } from './config';
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
  /** Sign-up completed but the project requires email confirmation first. */
  needsConfirmation?: boolean;
}

export interface CloudSync {
  getStatus(): CloudStatus;
  subscribe(listener: (status: CloudStatus) => void): () => void;
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<AuthResult>;
  /** Pull + push right now (used by "Sync now" and the online listener). */
  syncNow(): void;
}

// ---------------------------------------------------------------------------
// Cloud row shape (supabase/public/notes — see supabase/schema.sql)
// ---------------------------------------------------------------------------

interface NoteRow {
  id: string;
  user_id: string;
  name: string | null;
  html: string;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
}

const SYNC_INTERVAL_MS = 30_000;
const PUSH_DEBOUNCE_MS = 1_200;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;
let manager: TabManager | null = null;
let configured = false;

let status: CloudStatus = { state: 'unconfigured' };
const listeners = new Set<(status: CloudStatus) => void>();

let currentUserId: string | null = null;
let currentUserEmail: string | null = null;
let lastSyncAt: number | null = null;

let syncing = false;
let syncQueued = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;

/** Local tab ids that changed and still need a push. */
const pendingPush = new Set<string>();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Wires the sync layer to the tab manager. Safe to call when cloud sync is
 * not configured — the app then behaves exactly like a local-only install.
 */
export async function initCloudSync(tabManager: TabManager): Promise<void> {
  manager = tabManager;

  const config = getCloudConfig();
  if (!config) {
    setStatus({ state: 'unconfigured' });
    return;
  }

  configured = true;

  try {
    const supabase = await import('@supabase/supabase-js');
    client = supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
  } catch (error) {
    console.error('[cloud] failed to load the sync client', error);
    setStatus({ state: 'unconfigured' });
    configured = false;
    return;
  }

  manager.onPersist = (payload) => onLocalChange(payload);

  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      handleSignedOut();
      return;
    }
    // INITIAL_SESSION fires once at startup, SIGNED_IN after every login —
    // both funnel into the same guarded restore so the first sync starts
    // exactly once per fresh session.
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
      void handleSessionRestored();
    }
  });

  await handleSessionRestored();

  periodicTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      void syncCycle('periodic');
    }
  }, SYNC_INTERVAL_MS);

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

// ---------------------------------------------------------------------------
// Status plumbing
// ---------------------------------------------------------------------------

function setStatus(next: CloudStatus): void {
  status = next;
  listeners.forEach(listener => listener(next));
}

function syncingStatus(): CloudStatus {
  return {
    state: 'signed-in',
    email: currentUserEmail ?? '',
    sync: 'syncing',
    lastSyncAt
  };
}

function signedInStatus(phase: SyncPhase): CloudStatus {
  return {
    state: 'signed-in',
    email: currentUserEmail ?? '',
    sync: phase,
    lastSyncAt
  };
}

function handleSignedOut(): void {
  currentUserId = null;
  currentUserEmail = null;
  lastSyncAt = null;
  pendingPush.clear();
  setStatus({ state: 'signed-out' });
}

/**
 * Picks up the current auth session and kicks off the first sync when it is
 * new (fresh sign-in or a restored session from a previous visit).
 */
async function handleSessionRestored(): Promise<void> {
  if (!client) {
    return;
  }

  const { data } = await client.auth.getSession();
  const session = data.session;

  if (session?.user) {
    const isNewUser = currentUserId !== session.user.id;
    currentUserId = session.user.id;
    currentUserEmail = session.user.email ?? null;

    // Kick the first sync for a fresh session — or for the same user signing
    // in again after a failure (e.g. their token was revoked by a sign-out
    // on another device, or the network was down when the page loaded).
    if (isNewUser || status.state === 'error') {
      setStatus(syncingStatus());
      void syncCycle('session-restored');
    }
  } else if (currentUserId) {
    handleSignedOut();
  } else {
    setStatus({ state: 'signed-out' });
  }
}

// ---------------------------------------------------------------------------
// Auth actions (called from the cloud modal)
// ---------------------------------------------------------------------------

function authErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Could not reach the sync server. Check your connection and try again.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'This email is not confirmed yet — check your inbox for the confirmation link.';
  }
  if (/invalid login credentials/i.test(message)) {
    return 'Wrong email or password.';
  }
  if (/user already registered|email_exists/i.test(message)) {
    return 'An account with this email already exists — sign in instead.';
  }
  if (/password should be at least/i.test(message)) {
    return 'Password must be at least 6 characters.';
  }
  if (/rate limit/i.test(message)) {
    return 'Too many attempts — wait a moment and try again.';
  }
  return message || 'Something went wrong. Try again.';
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!client) {
    return { ok: false, message: 'Cloud sync is not set up.' };
  }
  setStatus({ state: 'signed-out' });

  const { error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password
  });

  if (error) {
    return { ok: false, message: authErrorMessage(error) };
  }

  // onAuthStateChange → session handling kicks the first sync off; keep the
  // modal feedback instant by returning immediately.
  return { ok: true };
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  if (!client) {
    return { ok: false, message: 'Cloud sync is not set up.' };
  }

  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password
  });

  if (error) {
    return { ok: false, message: authErrorMessage(error) };
  }

  if (!data.session) {
    return {
      ok: true,
      needsConfirmation: true,
      message: 'Account created! Check your inbox for a confirmation link, then sign in.'
    };
  }

  return { ok: true };
}

export async function signOut(): Promise<void> {
  if (!client) {
    return;
  }
  await client.auth.signOut();
  handleSignedOut();
}

export async function sendPasswordReset(email: string): Promise<AuthResult> {
  if (!client) {
    return { ok: false, message: 'Cloud sync is not set up.' };
  }

  const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/`
  });

  if (error) {
    return { ok: false, message: authErrorMessage(error) };
  }
  return { ok: true, message: 'Password reset link sent — check your inbox.' };
}

// ---------------------------------------------------------------------------
// Local change ingestion
// ---------------------------------------------------------------------------

function onLocalChange(payload: TabsSyncPayload): void {
  if (!currentUserId) {
    return;
  }

  payload.dirty.forEach(id => pendingPush.add(id));
  payload.tombstones.forEach(tombstone => pendingPush.add(tombstone.id));

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
  if (!client || !manager || !currentUserId) {
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
    const message = error instanceof Error ? error.message : String(error);
    const offline = !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(message);
    setStatus({
      state: 'error',
      email: currentUserEmail ?? '',
      message: offline ? 'Offline — changes are safe on this device and will sync later.' : message,
      retryable: offline
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
  if (!client || !manager || !currentUserId) {
    return;
  }

  const userId = currentUserId;

  // 1. Push whatever is pending (a no-op with an empty queue).
  if (pendingPush.size > 0) {
    const payload = manager.exportForSync();
    const rows: NoteRow[] = [];
    const byId = new Map(payload.tabs.map(tab => [tab.id, tab]));

    pendingPush.forEach(id => {
      const tab = byId.get(id);
      if (tab) {
        rows.push(tabToRow(tab, userId, payload.tabs.indexOf(tab)));
        return;
      }
      const tombstone = payload.tombstones.find(entry => entry.id === id);
      if (tombstone) {
        rows.push(tombstoneToRow(tombstone, userId));
      }
    });

    if (rows.length > 0) {
      const { error } = await client.from('notes').upsert(rows);
      if (error) {
        throw new Error(error.message);
      }
    }
    pendingPush.clear();
  }

  // 2. Pull the full remote list and merge.
  const { data, error } = await client.from('notes').select('*');
  if (error) {
    throw new Error(error.message);
  }

  const remoteRows = (data ?? []) as NoteRow[];
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
  const remoteById = new Map(remoteRows.map(row => [row.id, row]));
  const mergedTabs = manager.exportForSync().tabs;

  mergedTabs.forEach((tab, index) => {
    const remote = remoteById.get(tab.id);
    if (!remote || remote.updated_at < tab.updatedAt || remote.position !== index) {
      diffRows.push(tabToRow(tab, userId, index));
    }
  });

  payload.tombstones.forEach(tombstone => {
    const remote = remoteById.get(tombstone.id);
    if (remote?.deleted) {
      confirmIds.push(tombstone.id);
    } else if (!remote || remote.updated_at < tombstone.updatedAt) {
      diffRows.push(tombstoneToRow(tombstone, userId));
    }
  });

  manager.confirmTombstones(confirmIds);

  if (diffRows.length > 0) {
    const { error } = await client.from('notes').upsert(diffRows);
    if (error) {
      throw new Error(error.message);
    }
  }
}

interface MergeResult {
  tabs: NoteTab[];
  changed: boolean;
}

/** Last-write-wins merge of remote rows into the local tab list. */
function mergeRemote(remoteRows: NoteRow[], payload: TabsSyncPayload): MergeResult {
  const tabs: NoteTab[] = payload.tabs.map(tab => ({ ...tab }));
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const removedIds: string[] = [];
  const freshRemote: NoteTab[] = [];
  let touched = false;

  remoteRows.forEach(row => {
    if (row.deleted) {
      if (byId.has(row.id)) {
        byId.delete(row.id);
        const index = tabs.findIndex(tab => tab.id === row.id);
        if (index >= 0) {
          tabs.splice(index, 1);
        }
        removedIds.push(row.id);
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
        updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Date.now()
      });
      touched = true;
      return;
    }

    if (row.updated_at > local.updatedAt
      && (row.html !== local.html || row.name !== local.name)) {
      local.name = row.name;
      local.html = row.html ?? '';
      local.createdAt = typeof row.created_at === 'number' ? row.created_at : local.createdAt;
      local.updatedAt = row.updated_at;
      touched = true;
    }
  });

  // Remote-only tabs join the end of the strip, in their stored order.
  const positionById = new Map(remoteRows.map(row => [row.id, row.position]));
  freshRemote.sort((a, b) => (positionById.get(a.id) ?? 0) - (positionById.get(b.id) ?? 0));
  tabs.push(...freshRemote);

  return { tabs, changed: touched };
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
    deleted: false
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
    deleted: true
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
      sendPasswordReset,
      syncNow
    };
  }
  return instance;
}

/** Test hook — exposes whether the engine actually booted. */
export function isCloudSyncActive(): boolean {
  return configured;
}
