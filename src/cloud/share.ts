/**
 * Padify share links — read-only note sharing with expiry, backed by the
 * same Supabase project as cloud sync (see supabase/schema.sql, table
 * public.shares).
 *
 * Model:
 *  • A share row holds a denormalised copy of the note (title + html) plus
 *    the owner, an expiry timestamp and a revoked flag. Viewers fetch it
 *    anonymously from /share/?t=<token> — RLS only hands out rows that are
 *    neither revoked nor expired.
 *  • While the owner is signed in, edits to a shared note are pushed to the
 *    share row (debounced, same spirit as the note sync), so links stay
 *    fresh without re-sharing.
 *  • Closing a note revokes its links: deleted notes must not stay readable
 *    through an old URL.
 *  • Everything here is best-effort and non-fatal — a failed share action
 *    never loses note content.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCloudConfig } from './config';
import { getSupabaseClient, getCloudUserId } from './sync';
import { deriveTabTitle, type TabManager, type TabsSyncPayload } from '../tabs';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ShareRecord {
  token: string;
  note_id: string | null;
  title: string;
  html: string;
  created_at: number;
  /** ISO timestamp; the link stops working after this moment. */
  expires_at: string;
  revoked: boolean;
}

export interface ShareActionResult {
  ok: boolean;
  token?: string;
  url?: string;
  message?: string;
}

const SHARE_UPDATE_DEBOUNCE_MS = 2_000;
const TOKEN_BYTES = 18;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function client(): SupabaseClient | null {
  return getSupabaseClient();
}

function signedIn(): boolean {
  return !!getCloudUserId();
}

/** URL-safe random token — the only secret in a share link. */
function createToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function shareUrlFor(token: string): string {
  return `${window.location.origin}/share/?t=${encodeURIComponent(token)}`;
}

export function isShareAvailable(): boolean {
  return getCloudConfig() !== null && client() !== null;
}

// ---------------------------------------------------------------------------
// Actions (called from the share modal)
// ---------------------------------------------------------------------------

export async function createShare(
  noteId: string,
  title: string,
  html: string,
  days: number
): Promise<ShareActionResult> {
  const supabase = client();
  if (!supabase) {
    return { ok: false, message: 'Cloud is not set up on this install.' };
  }
  if (!signedIn()) {
    return { ok: false, message: 'Sign in to share notes.' };
  }

  const token = createToken();
  const row = {
    token,
    note_id: noteId,
    title: title.slice(0, 200),
    html,
    created_at: Date.now(),
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    revoked: false
  };

  const { error } = await supabase.from('shares').insert(row);

  if (error) {
    console.error('[share] create failed', error);
    return { ok: false, message: 'Could not create the link. Try again.' };
  }

  return { ok: true, token, url: shareUrlFor(token) };
}

export async function listOwnedShares(): Promise<ShareRecord[]> {
  const supabase = client();
  if (!supabase || !signedIn()) {
    return [];
  }

  const { data, error } = await supabase
    .from('shares')
    .select('token, note_id, title, html, created_at, expires_at, revoked')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('[share] list failed', error);
    return [];
  }

  return (data ?? []) as ShareRecord[];
}

export async function revokeShare(token: string): Promise<ShareActionResult> {
  const supabase = client();
  if (!supabase) {
    return { ok: false, message: 'Cloud is not set up on this install.' };
  }

  const { error } = await supabase
    .from('shares')
    .update({ revoked: true })
    .eq('token', token);

  if (error) {
    console.error('[share] revoke failed', error);
    return { ok: false, message: 'Could not cancel the link. Try again.' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Keep links fresh (called from the tab-manager persist hook)
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNoteIds: Set<string> = new Set();
let pendingTombstoneIds: Set<string> = new Set();

async function flushShareUpdates(): Promise<void> {
  debounceTimer = null;

  const supabase = client();
  if (!supabase || !signedIn()) {
    pendingNoteIds.clear();
    pendingTombstoneIds.clear();
    return;
  }

  // Deleted notes: revoke every link that points at them.
  const tombstones = [...pendingTombstoneIds];
  pendingTombstoneIds.clear();
  if (tombstones.length > 0) {
    const { error } = await supabase
      .from('shares')
      .update({ revoked: true })
      .in('note_id', tombstones);
    if (error) {
      console.error('[share] revoke-on-delete failed', error);
    }
  }

  // Edited notes: refresh title + content on every still-active link.
  const noteIds = [...pendingNoteIds];
  pendingNoteIds.clear();
  if (noteIds.length === 0 || !lastPayload) {
    return;
  }

  for (const noteId of noteIds) {
    const tab = lastPayload.tabs.find(entry => entry.id === noteId);
    if (!tab) {
      continue;
    }

    const { error } = await supabase
      .from('shares')
      .update({
        title: deriveTabTitle(tab).slice(0, 200),
        html: tab.html
      })
      .eq('note_id', noteId)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString());

    if (error) {
      console.error('[share] content refresh failed', error);
    }
  }
}

let lastPayload: TabsSyncPayload | null = null;

function onModelPersisted(payload: TabsSyncPayload): void {
  if (!client() || !signedIn()) {
    return;
  }

  lastPayload = payload;

  payload.dirty.forEach(id => pendingNoteIds.add(id));
  payload.tombstones.forEach(entry => pendingTombstoneIds.add(entry.id));

  if (pendingNoteIds.size === 0 && pendingTombstoneIds.size === 0) {
    return;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(flushShareUpdates, SHARE_UPDATE_DEBOUNCE_MS);
}

/**
 * Registers the persist hook. Safe to call on any install: without a
 * configured Supabase project the hook simply never does anything.
 */
export function initCloudShare(tabManager: TabManager): void {
  tabManager.addPersistListener(onModelPersisted);
}
