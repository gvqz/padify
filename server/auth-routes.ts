/**
 * Padify API — the signup and signin routes.
 *
 * Session and password primitives live in auth.ts; this module is the
 * route-shaped glue around them: body validation, the per-account lockout,
 * and the email-enumeration-closing error messages.
 */

import { type Db } from './db';
import { json, readJson } from './http';
import {
  clearSigninFailures,
  recordSigninFailure,
  signinBlocked
} from './ratelimit';
import {
  createSession,
  hashPassword,
  verifyPassword
} from './auth';
import { asString } from './notes';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  const email = asString(value).trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email;
}

export async function handleSignup(db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = asString(body.password);
  if (!email) {
    return json(request, { error: 'Enter a valid email address.' }, 400);
  }
  if (password.length < 6 || password.length > 200) {
    return json(request, { error: 'Password must be at least 6 characters.' }, 400);
  }

  const userId = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.run(
      'insert into users (id, email, password_hash, created_at) values (?, ?, ?, ?)',
      [userId, email, hashPassword(password), now]
    );
  } catch (err) {
    // UNIQUE violation on email — the schema's `email text not null unique`
    // constraint is the source of truth. Catching it here lets us return the
    // same generic "Wrong email or password" message the signin endpoint
    // returns, closing the email-enumeration vector the previous SELECT-then-
    // INSERT race had (an attacker could enumerate valid emails by observing
    // 409 vs 201). Also resolves the TOCTOU between the SELECT and INSERT.
    const message = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(message)) {
      return json(request, { error: 'Wrong email or password.' }, 401);
    }
    throw err;
  }
  const token = await createSession(db, userId);
  return json(request, { token, user: { id: userId, email } }, 201);
}

export async function handleSignin(db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) {
    return json(request, { error: 'Invalid request body.' }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = asString(body.password);
  if (!email || !password) {
    return json(request, { error: 'Wrong email or password.' }, 401);
  }

  // The lockout check runs before the scrypt verify: a locked account
  // costs the caller one cheap map lookup, not the expensive hash — the
  // brute-forcer's own budget is what gets spent, not the server's.
  if (signinBlocked(email)) {
    return json(request, { error: 'Too many failed attempts for this account — try again in a few minutes.' }, 429);
  }

  const rows = await db.all('select id, email, password_hash from users where email = ?', [email]);
  const user = rows[0];
  if (!user || !verifyPassword(password, String(user.password_hash))) {
    recordSigninFailure(email);
    return json(request, { error: 'Wrong email or password.' }, 401);
  }

  clearSigninFailures(email);

  const token = await createSession(db, String(user.id));
  return json(request, { token, user: { id: String(user.id), email: String(user.email) } });
}
