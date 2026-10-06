/**
 * Padify share links — read-only note sharing with expiry, backed by the
 * padify API (see server/, table `shares`).
 *
 * Model:
 *  • A share row holds a denormalised copy of the note (title + html) plus
 *    the owner, an expiry timestamp and a revoked flag. Viewers fetch it
 *    anonymously from /share/?t=<token> — the API only hands out rows that
 *    are neither revoked nor expired.
 *  • While the owner is signed in, edits to a shared note are pushed to the
 *    share row (debounced, same spirit as the note sync), so links stay
 *    fresh without re-sharing.
 *  • Closing a note revokes its links: deleted notes must not stay readable
 *    through an old URL.
 *  • Everything here is best-effort and non-fatal — a failed share action
 *    never loses note content.
 */

import { getCloudConfig } from './config';
import { getCloudUserId } from './sync';
import { deriveTabTitle, type NoteType, type TabManager, type TabsSyncPayload } from '../tabs';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ShareRecord {
  token: string;
  note_id: string | null;
  title: string;
  /**
   * The shared content. The wire carries it as both `content` and a
   * legacy `html` key during the rename transition (same value) — rows
   * and pages built before the rename read `html`, everything after it
   * reads `content`, and a deploy gap must never blank a shared note.
   */
  content: string;
  html?: string;
  /** The shared note's type; null = html (the classic note). */
  note_type: string | null;
  created_at: number;
  /** Epoch milliseconds; the link stops working after this moment. */
  expires_at: number;
  revoked: boolean;
}

export interface ShareActionResult {
  ok: boolean;
  token?: string;
  url?: string;
  message?: string;
}

const SHARE_UPDATE_DEBOUNCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signedIn(): boolean {
  return !!getCloudUserId();
}

export function shareUrlFor(token: string): string {
  // Resolved against the page, not the origin: hosts that can only hand out
  // a subpath (functionhost.alwaysdata.net/padify) need the viewer link to
  // stay inside it. The query is cleared first so a campaign parameter on
  // the page's URL never rides along into a copied link.
  const url = new URL('share/', document.baseURI);
  url.search = '';
  url.searchParams.set('t', token);
  return url.toString();
}

export function isShareAvailable(): boolean {
  return getCloudConfig() !== null;
}

interface ShareRowResponse {
  row: ShareRecord;
}

async function shareApi<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { api } = await import('./api');
  return api<T>(path, options);
}

// ---------------------------------------------------------------------------
// Actions (called from the share modal)
// ---------------------------------------------------------------------------

export async function createShare(
  noteId: string,
  title: string,
  content: string,
  days: number,
  noteType?: NoteType,
): Promise<ShareActionResult> {
  if (!signedIn()) {
    return { ok: false, message: 'Sign in to share notes.' };
  }

  try {
    const data = await shareApi<ShareRowResponse>('/api/shares', {
      method: 'POST',
      body: {
        note_id: noteId,
        title: title.slice(0, 200),
        // Both keys, same value — the transition contract (see ShareRecord).
        content,
        html: content,
        note_type: noteType ?? null,
        days,
      },
    });
    return { ok: true, token: data.row.token, url: shareUrlFor(data.row.token) };
  } catch (error) {
    console.error('[share] create failed', error);
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return {
        ok: false,
        message: 'Could not reach the sync server. Check your connection and try again.',
      };
    }
    if (/not signed in/i.test(message)) {
      return { ok: false, message: 'Sign in to share notes.' };
    }
    return { ok: false, message: 'Could not create the link. Try again.' };
  }
}

export async function listOwnedShares(): Promise<ShareRecord[]> {
  if (!signedIn()) {
    return [];
  }

  try {
    const data = await shareApi<{ rows: ShareRecord[] }>('/api/shares');
    return (data.rows ?? []).map((row) => ({ ...row, revoked: !!row.revoked }));
  } catch (error) {
    console.error('[share] list failed', error);
    return [];
  }
}

export async function revokeShare(token: string): Promise<ShareActionResult> {
  try {
    await shareApi('/api/shares', { method: 'PATCH', body: { token, revoked: true } });
    return { ok: true };
  } catch (error) {
    console.error('[share] revoke failed', error);
    return { ok: false, message: 'Could not cancel the link. Try again.' };
  }
}

// ---------------------------------------------------------------------------
// Keep links fresh (called from the tab-manager persist hook)
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingNoteIds: Set<string> = new Set();
const pendingTombstoneIds: Set<string> = new Set();

async function flushShareUpdates(): Promise<void> {
  debounceTimer = null;

  if (!signedIn()) {
    pendingNoteIds.clear();
    pendingTombstoneIds.clear();
    return;
  }

  const tombstones = [...pendingTombstoneIds];
  pendingTombstoneIds.clear();
  const noteIds = [...pendingNoteIds];
  pendingNoteIds.clear();

  try {
    // Deleted notes: revoke every link that points at them.
    if (tombstones.length > 0) {
      await shareApi('/api/shares', {
        method: 'PATCH',
        body: { note_ids: tombstones, revoked: true },
      });
    }

    // Edited notes: refresh title + content on every still-active link.
    if (noteIds.length > 0 && lastPayload) {
      const refresh = noteIds
        .map((noteId) => lastPayload?.tabs.find((entry) => entry.id === noteId))
        .filter((tab): tab is NonNullable<typeof tab> => !!tab)
        .map((tab) => ({
          note_id: tab.id,
          title: deriveTabTitle(tab).slice(0, 200),
          // Both keys, same value — the transition contract (see ShareRecord).
          content: tab.content,
          html: tab.content,
          note_type: tab.noteType ?? null,
        }));

      if (refresh.length > 0) {
        await shareApi('/api/shares', { method: 'PATCH', body: { refresh } });
      }
    }
  } catch (error) {
    console.error('[share] content refresh failed', error);
  }
}

let lastPayload: TabsSyncPayload | null = null;

function onModelPersisted(payload: TabsSyncPayload): void {
  if (!signedIn()) {
    return;
  }

  lastPayload = payload;

  payload.dirty.forEach((id) => pendingNoteIds.add(id));
  payload.tombstones.forEach((entry) => pendingTombstoneIds.add(entry.id));

  if (pendingNoteIds.size === 0 && pendingTombstoneIds.size === 0) {
    return;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(flushShareUpdates, SHARE_UPDATE_DEBOUNCE_MS);
}

/**
 * Registers the persist hook. Safe to call on any install: the hook simply
 * never does anything until the user signs in.
 */
export function initCloudShare(tabManager: TabManager): void {
  tabManager.addPersistListener(onModelPersisted);
}
