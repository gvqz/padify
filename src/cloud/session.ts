/**
 * The stored session — its shape, its storage key, and the one reader.
 *
 * WHY ITS OWN MODULE: the sync engine stores and clears the session, the
 * API wrapper attaches its token, and both need the same parse — one
 * definition, imported by each side, so the two readers can never
 * disagree about what a stored session looks like. It also keeps the
 * session read OUT of './api' on purpose: tests mock the api module's
 * network surface wholesale, and a session reader living there would
 * ride the mock boundary for no benefit.
 */

import { stateGet } from '../storage';

/** The storage key the signed-in session lives under. */
export const SESSION_STORAGE_KEY = 'padifySession';

/** A stored session: the bearer token plus who it belongs to. */
export interface StoredSession {
  token: string;
  userId: string;
  email: string;
}

/**
 * Reads and validates the stored session. A malformed or partial entry
 * answers null (signed out) — never a half-parsed token.
 */
export function readStoredSession(): StoredSession | null {
  try {
    const raw = stateGet(SESSION_STORAGE_KEY);
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
    return null;
  } catch {
    return null;
  }
}
