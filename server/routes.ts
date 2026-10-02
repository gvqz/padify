/**
 * Padify API — the router.
 *
 * Every endpoint is one row in the ROUTES table below: method, path
 * pattern, auth requirement, rate-limit bucket, handler. The dispatcher
 * applies the cross-cutting rules uniformly — CORS preflight, the
 * per-bucket rate limits, session resolution, the 401 gate — so a new
 * route is a row, not a correctly-ordered if-branch.
 *
 * The old if/else chain had two structural traps this removes:
 *  • positional auth — a public route only worked if it physically sat
 *    above the userForRequest() call; moving a route silently changed
 *    its auth story.
 *  • no 405 — a wrong method on a known path answered 404, hiding the
 *    mistake from every client and every API explorer. Now it answers
 *    405 with an Allow header built from the table.
 *
 * Auth order is deliberate and test-pinned: authed routes resolve the
 * session, take the 'api' bucket (keyed on the account when present),
 * and only then 401 — so unauthenticated probing burns rate budget,
 * never server time. Same for the fallthrough: an unknown /api path
 * still passes the auth gate before its 404.
 */

import { type Db } from './db';
import { corsHeaders, json } from './http';
import { rateLimited } from './ratelimit';
import { userForRequest, destroySession, type SessionUser } from './auth';
import { handleNotesGet, handleNotesPut } from './notes';
import {
  handleSharesGet,
  handleSharesPost,
  handleSharesPatch,
  handlePublicShareGet
} from './shares';
import { handleSignup, handleSignin } from './auth-routes';
import {
  handleAttachmentsList,
  handleAttachmentPost,
  handleAttachmentGet,
  handleAttachmentDelete
} from './attachments';
import {
  handleMusicCapabilities,
  handleMusicSearch,
  handleMusicResolve
} from './music';

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Route handlers see (db, request, user, params). `user` is undefined for
 * public routes and guaranteed non-undefined for 'required' routes; the
 * table below adapts each domain handler's natural signature.
 */
export type RouteHandler = (
  db: Db,
  request: Request,
  user: SessionUser | undefined,
  params: string[]
) => Promise<Response>;

export interface Route {
  method: RouteMethod;
  /** Executed against the pathname; capture groups arrive as params. */
  pattern: RegExp;
  /**
   * 'public'  — no session resolved, no 'api' bucket consumed; the route's
   *             own bucket (if any) applies before the handler.
   * 'required'— session resolved, 'api' bucket taken (keyed on the account
   *             when present), 401 when missing.
   * 'optional'— like 'required' but missing session is not an error
   *             (signout works signed-out).
   */
  auth: 'public' | 'required' | 'optional';
  bucket?: 'auth' | 'share' | 'music-search' | 'music-resolve';
  handler: RouteHandler;
}

const ATTACHMENT_PATH = /^\/api\/attachments\/([A-Za-z0-9_-]{8,64})$/;
const SHARE_TOKEN_PATH = /^\/api\/share\/([A-Za-z0-9_-]+)$/;

const ROUTES: Route[] = [
  // ---- public ----------------------------------------------------------
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    auth: 'public',
    handler: async (_db, request) => handleHealth(request)
  },
  {
    method: 'GET',
    pattern: SHARE_TOKEN_PATH,
    auth: 'public',
    // Share tokens are unguessable, but the endpoint itself is public and
    // unauthenticated — cap the request rate so a scraper cannot hammer
    // the shares table (and the database behind it) through it.
    bucket: 'share',
    handler: (db, request, _user, params) => handlePublicShareGet(db, request, params[0]!)
  },
  {
    method: 'GET',
    pattern: /^\/api\/music\/capabilities$/,
    auth: 'public',
    handler: (_db, request) => handleMusicCapabilities(request)
  },
  {
    method: 'GET',
    pattern: /^\/api\/music\/search$/,
    auth: 'public',
    bucket: 'music-search',
    handler: (_db, request) => handleMusicSearch(request)
  },
  {
    method: 'GET',
    pattern: /^\/api\/music\/resolve$/,
    auth: 'public',
    bucket: 'music-resolve',
    handler: (db, request) => handleMusicResolve(db, request)
  },

  // ---- auth (rate limited, no session needed) --------------------------
  {
    method: 'POST',
    pattern: /^\/api\/auth\/signup$/,
    auth: 'public',
    bucket: 'auth',
    handler: (db, request) => handleSignup(db, request)
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/signin$/,
    auth: 'public',
    bucket: 'auth',
    handler: (db, request) => handleSignin(db, request)
  },

  // ---- authenticated ----------------------------------------------------
  {
    method: 'POST',
    pattern: /^\/api\/auth\/signout$/,
    auth: 'optional',
    handler: async (db, request) => {
      await destroySession(db, request);
      return json(request, { ok: true });
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/me$/,
    auth: 'required',
    handler: async (_db, request, user) => json(request, { user })
  },
  {
    method: 'GET',
    pattern: /^\/api\/notes$/,
    auth: 'required',
    handler: (db, request, user) => handleNotesGet(db, request, user!)
  },
  {
    method: 'PUT',
    pattern: /^\/api\/notes$/,
    auth: 'required',
    handler: (db, request, user) => handleNotesPut(db, request, user!)
  },
  {
    method: 'GET',
    pattern: /^\/api\/shares$/,
    auth: 'required',
    handler: (db, request, user) => handleSharesGet(db, request, user!)
  },
  {
    method: 'POST',
    pattern: /^\/api\/shares$/,
    auth: 'required',
    handler: (db, request, user) => handleSharesPost(db, request, user!)
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/shares$/,
    auth: 'required',
    handler: (db, request, user) => handleSharesPatch(db, request, user!)
  },
  {
    method: 'GET',
    pattern: /^\/api\/attachments$/,
    auth: 'required',
    handler: (db, request, user) => handleAttachmentsList(db, request, user!)
  },
  {
    method: 'POST',
    pattern: /^\/api\/attachments$/,
    auth: 'required',
    handler: (db, request, user) => handleAttachmentPost(db, request, user!)
  },
  {
    method: 'GET',
    pattern: ATTACHMENT_PATH,
    auth: 'required',
    handler: (db, request, user, params) => handleAttachmentGet(db, request, user!, params[0]!)
  },
  {
    method: 'DELETE',
    pattern: ATTACHMENT_PATH,
    auth: 'required',
    handler: (db, request, user, params) => handleAttachmentDelete(db, request, user!, params[0]!)
  }
];

/** Liveness probe: 200 with no body worth reading. For the e2e config
 * (which waits on it before running a spec) and for any uptime monitor —
 * a 404-for-unknown-paths router cannot serve as its own probe. */
function handleHealth(request: Request): Response {
  return json(request, { ok: true });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function route(db: Db, request: Request, pathname: string): Promise<Response> {
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  // Routes matching the path at all (any method) decide auth vs 405.
  const samePath = ROUTES.filter((r) => r.pattern.test(pathname));
  const matched = ROUTES.find(
    (r) => r.pattern.test(pathname) && r.method === (method as RouteMethod),
  );

  if (matched) {
    const params = matched.pattern.exec(pathname)?.slice(1) ?? [];
    if (matched.auth === 'public') {
      if (matched.bucket && rateLimited(request, matched.bucket)) {
        return tooManyRequests(request, matched.bucket);
      }
      return matched.handler(db, request, undefined, params);
    }
    const user = await userForRequest(db, request);
    // Keyed on the account when one is present (see rateLimited): signed-in
    // traffic cannot be paced by address games, and anonymous traffic falls
    // back to the client key — 'local' unless TRUST_PROXY_HOPS is set.
    if (rateLimited(request, 'api', user?.id)) {
      return json(request, { error: 'Too many requests — slow down a little.' }, 429);
    }
    if (!user && matched.auth === 'required') {
      return json(request, { error: 'Not signed in.' }, 401);
    }
    return matched.handler(db, request, user ?? undefined, params);
  }

  if (samePath.length > 0) {
    // Known path, wrong method. Auth first (a 401 must not reveal which
    // methods exist), rate the probe, then 405 with the allowed set.
    const needsAuth = samePath.some((r) => r.auth !== 'public');
    if (needsAuth) {
      const user = await userForRequest(db, request);
      if (rateLimited(request, 'api', user?.id)) {
        return json(request, { error: 'Too many requests — slow down a little.' }, 429);
      }
      if (!user && samePath.some((r) => r.auth === 'required')) {
        return json(request, { error: 'Not signed in.' }, 401);
      }
    }
    const allow = [...new Set(samePath.map((r) => r.method))].join(', ');
    return json(
      request,
      { error: 'Method not allowed.' },
      405,
      { allow: `${allow}, OPTIONS` }
    );
  }

  if (!pathname.startsWith('/api/')) {
    return json(request, { error: 'Not found.' }, 404);
  }
  // The music subtree is public — unknown paths under it 404 directly,
  // without resolving a session or taking an 'api' bucket.
  if (pathname.startsWith('/api/music/')) {
    return json(request, { error: 'Not found.' }, 404);
  }

  // Unknown authenticated-zone path: the auth gate still runs (unknown
  // must not mean unprobed) before the 404.
  const user = await userForRequest(db, request);
  if (rateLimited(request, 'api', user?.id)) {
    return json(request, { error: 'Too many requests — slow down a little.' }, 429);
  }
  if (!user) {
    return json(request, { error: 'Not signed in.' }, 401);
  }
  return json(request, { error: 'Not found.' }, 404);
}

function tooManyRequests(
  request: Request,
  bucket: 'auth' | 'share' | 'music-search' | 'music-resolve'
): Response {
  const message =
    bucket === 'auth'
      ? 'Too many attempts — wait a moment and try again.'
      : bucket === 'music-search'
        ? 'Too many searches — wait a moment and try again.'
        : 'Too many requests — wait a moment and try again.';
  return json(request, { error: message }, 429);
}
