/**
 * Padify API — shared HTTP plumbing: CORS, JSON responses, body reading.
 *
 * Everything a route needs to answer a request, independent of any
 * domain. Handlers stayed testable because none of this touches Bun's
 * server runtime — Node has the same fetch globals (see
 * src/server-handlers.test.ts).
 */

import { MAX_BODY_BYTES } from '../shared/wire';

export { MAX_BODY_BYTES };

/**
 * Strips the deployment's mount prefix off an incoming pathname.
 *
 * Supervisors that hand out a subpath of a shared domain (alwaysdata
 * sites, the reference deployment) proxy the FULL original path to the
 * process: an app mounted at host/padifyapi serves /padifyapi/api/health.
 * The router speaks plain /api/…, so the prefix comes off before routing.
 * PATH_PREFIX is that mount point ('' = root deployment, nothing stripped).
 */
export function stripPathPrefix(pathname: string, prefix: string): string {
  const mount = prefix.replace(/\/+$/, '');
  if (!mount) {
    return pathname;
  }
  if (pathname === mount) {
    return '/';
  }
  if (pathname.startsWith(`${mount}/`)) {
    return pathname.slice(mount.length);
  }
  return pathname;
}

/** The PATH_PREFIX value, normalized ('' = root deployment). */
export function pathPrefixFromEnv(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

export function corsHeaders(request: Request): Record<string, string> {
  const allowList = (process.env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin');
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
  if (origin && (allowList.includes('*') || allowList.includes(origin))) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

export function json(
  request: Request,
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // API bodies are JSON, never markup: never let a proxy or browser
      // sniff them into something executable, never let a cache serve a
      // stale answer to a signed-in reader.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': 'no-store',
      ...corsHeaders(request),
      ...extraHeaders
    }
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return null;
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
