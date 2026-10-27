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
import { contentKindFor, type NoteType } from '../editor/note-types';
import { parseDrawingScene } from '../editor/drawing/scene';
import { taskNoteContentIsEmpty } from '../editor/tasks/content';
import { deriveTabTitle, htmlToText, type TabManager, type TabsSyncPayload } from '../tabs';

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
  /**
   * True when the server answered a create with the note's EXISTING
   * active link — the one-active-link-per-note backstop. Nothing was
   * minted; the caller should say so instead of claiming a create.
   */
  existed?: boolean;
}

const SHARE_UPDATE_DEBOUNCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signedIn(): boolean {
  return !!getCloudUserId();
}

/**
 * True when a note carries nothing worth sharing: html kinds read through
 * the tag stripper (a bare <p></p> or <br> is emptiness wearing markup),
 * task list notes read their parsed model (an empty list is JSON bytes
 * with zero reminders — not a share), drawing notes read their scene (a
 * cleared canvas is the empty envelope, not a share of nothing), and
 * every other kind reads raw. The blank note a fresh tab or a delete-all
 * leaves behind must never become a link — the recipient would get an
 * empty page and the owner a "share" of nothing.
 */
export function noteContentIsEmpty(content: string, noteType?: NoteType | null): boolean {
  if (noteType === 'tasks') {
    return taskNoteContentIsEmpty(content);
  }
  if (noteType === 'drawing') {
    // '' = a drawing note never drawn on; a parsed scene with zero
    // elements = the cleared-canvas envelope the canvas phase writes.
    // Both are emptiness wearing JSON, the same rule as the empty task
    // list. Content this build cannot parse is a NEWER build's real
    // scene — it stays shareable (the viewer shows non-html kinds as
    // raw text), so refusing to understand can never block sharing.
    if (content.trim() === '') {
      return true;
    }
    const scene = parseDrawingScene(content);
    return scene !== null && scene.elements.length === 0;
  }
  const kind = contentKindFor(noteType ?? undefined);
  if (kind === 'html') {
    return htmlToText(content).trim() === '';
  }
  return content.trim() === '';
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
  /** The one-active-link backstop: the create returned a live row. */
  existing?: boolean;
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
  // The empty note is refused here (the modal disables the button, this is
  // the safety net for every other caller) — sharing nothing is a broken
  // link, not a feature.
  if (noteContentIsEmpty(content, noteType)) {
    return { ok: false, message: 'This note is empty — write something before sharing it.' };
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
    return {
      ok: true,
      token: data.row.token,
      url: shareUrlFor(data.row.token),
      existed: !!data.existing,
    };
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

/**
 * Refreshes one link's expiry window — the dedupe path's "update": a note
 * keeps ONE active link, so a second share request for the same note
 * refreshes the first instead of minting a twin. Returns the new expiry
 * so the caller can update its record without a refetch.
 */
export async function updateShareExpiry(
  token: string,
  days: number,
): Promise<ShareActionResult & { expiresAt?: number }> {
  try {
    const data = await shareApi<{ ok: true; row?: { expires_at: number } }>('/api/shares', {
      method: 'PATCH',
      body: { token, days },
    });
    return { ok: true, token, expiresAt: data.row?.expires_at };
  } catch (error) {
    console.error('[share] expiry update failed', error);
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return {
        ok: false,
        message: 'Could not reach the sync server. Check your connection and try again.',
      };
    }
    if (/no longer active|not available/i.test(message)) {
      return { ok: false, message: 'This link is no longer active — create a new one instead.' };
    }
    return { ok: false, message: 'Could not update the link. Try again.' };
  }
}

// ---------------------------------------------------------------------------
// Keep links fresh (called from the tab-manager persist hook)
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingNoteIds: Set<string> = new Set();
const pendingTombstoneIds: Set<string> = new Set();

/**
 * Tombstone ids whose revoke PATCH already succeeded. The model's
 * tombstone list is CUMULATIVE (the cloud sync layer owns emptying it,
 * and a signed-out or offline user's deletions sit in it indefinitely)
 * — without this set, every persist re-queued the full list and every
 * typing pause re-issued the same idempotent PATCH forever (issue #118).
 * Pruned against the model on each persist, so it stays proportional.
 */
const confirmedTombstoneIds: Set<string> = new Set();

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
      // Only a SUCCESSFUL revoke is settled — a failed one must stay
      // re-queueable, so the next persist (the natural retry) resends it.
      tombstones.forEach((id) => confirmedTombstoneIds.add(id));
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

  // Settle the confirmed set against the model: tombstone ids the sync
  // layer confirmed away are gone from the payload, so they leave the
  // confirmed set too (bounded memory, no cross-session leakage).
  const modelTombstones = new Set(payload.tombstones.map((entry) => entry.id));
  for (const id of confirmedTombstoneIds) {
    if (!modelTombstones.has(id)) {
      confirmedTombstoneIds.delete(id);
    }
  }

  payload.dirty.forEach((id) => pendingNoteIds.add(id));
  payload.tombstones.forEach((entry) => {
    // Already revoked server-side — re-sending it is the issue #118 churn.
    if (!confirmedTombstoneIds.has(entry.id)) {
      pendingTombstoneIds.add(entry.id);
    }
  });

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
