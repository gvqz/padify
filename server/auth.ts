/**
 * Padify API — password hashing and bearer sessions.
 *
 * Passwords: scrypt (node:crypto) with a per-user random salt, stored as
 * "scrypt$<saltHex>$<hashHex>". Verification is constant-time.
 *
 * Sessions: 32 random bytes handed to the client as a bearer token; only
 * sha256(token) is stored, so a database leak cannot impersonate anyone.
 * Sessions expire after 30 days without a validated /api/me call.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db';

const KEY_LENGTH = 64;
export const SESSION_TTL_MS = 30 * 86_400_000;
/** Sessions slide forward when they would expire within two weeks. */
const SESSION_RENEW_THRESHOLD_MS = 15 * 86_400_000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(password, salt, expected.length || KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface SessionUser {
  id: string;
  email: string;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  await db.run(
    'insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)',
    [sha256(token), userId, now, now + SESSION_TTL_MS]
  );
  return token;
}

/** Resolves the bearer token to its user, or null when missing/expired. */
export async function userForRequest(db: Db, request: Request): Promise<SessionUser | null> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return null;
  }

  const tokenHash = sha256(match[1].trim());
  const rows = await db.all(
    `select sessions.expires_at as expires_at, users.id as user_id, users.email as email
     from sessions join users on users.id = sessions.user_id
     where sessions.token_hash = ?`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  const expiresAt = Number(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await db.run('delete from sessions where token_hash = ?', [tokenHash]);
    return null;
  }

  // Sliding renewal — throttled to avoid a write on every request.
  if (expiresAt - Date.now() < SESSION_RENEW_THRESHOLD_MS) {
    await db.run('update sessions set expires_at = ? where token_hash = ?', [
      Date.now() + SESSION_TTL_MS,
      tokenHash
    ]);
  }

  return { id: String(row.user_id), email: String(row.email) };
}

export async function destroySession(db: Db, request: Request): Promise<void> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (match) {
    await db.run('delete from sessions where token_hash = ?', [sha256(match[1].trim())]);
  }
}
