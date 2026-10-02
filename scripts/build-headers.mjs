/**
 * Post-build step: generates the deploy-time files in dist/ that depend on
 * the build's configuration — one variable, VITE_API_BASE, feeds all of
 * them so the parts can never disagree about where the API lives:
 *
 *  • dist/_headers (Netlify header rules) with a content security policy
 *    whose script-src pins every inline script the build actually contains
 *    and whose connect-src admits the API origin when one is configured.
 *  • dist/share/config.js — the share viewer (public/share/) is static and
 *    cannot read src/cloud/config.ts; the build writes its API origin
 *    instead of leaving a hand-edited file to drift (the public/ copy is a
 *    dev-only template, same-origin default).
 *  • dist/_redirects (Netlify) — a forced /api/* proxy to the API origin,
 *    generated only when VITE_API_BASE is set, replacing the placeholder
 *    host that used to sit in netlify.toml and 502 in production.
 *
 * A malformed VITE_API_BASE fails the build loudly rather than shipping a
 * site whose client, share page and CSP each guess differently.
 *
 * The entry page keeps exactly one inline script by design (the pre-paint
 * theme block in index.html — it must run before first paint, so it cannot
 * wait for the bundle). Instead of opening script-src to 'unsafe-inline',
 * the generator hashes each inline block at build time and pins the hashes:
 * the CSP stays strict, and editing the inline script simply produces a new
 * hash on the next build — nothing to update by hand.
 *
 * Every directive below is derived from what the app actually does, not
 * from a template:
 *  • script-src 'self' — the Vite bundle; https://sdk.scdn.co — the Spotify
 *    Web Playback SDK (src/features/music-player/spotify/sdk.ts).
 *  • style-src 'unsafe-inline' — features style the DOM through inline
 *    style attributes (color pickers, typing effects, art positioning);
 *    CSS cannot execute script, so this stays open.
 *  • img-src / media-src 'https:' — album art and resolved stream URLs are
 *    Spotify/CDN hosts chosen at runtime, not at build time.
 *  • connect-src — the client fetches its own API (same-origin /api by
 *    default, or the VITE_API_BASE origin, see src/cloud/config.ts) and
 *    the Spotify Web API + SDK websockets.
 *
 * Self-hosted deployments behind a reverse proxy should mirror these
 * headers from dist/_headers; scripts/ and dist/ carry the source of truth.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VITE_API_BASE must be '' (same-origin /api) or an absolute origin —
 * scheme://host[:port], nothing after it. A path would silently produce a
 * redirect target and a fetch base that disagree about the API's shape.
 */
const API_BASE_PATTERN = /^https:\/\/[^/?#]+\/?$/;
const API_BASE_ERROR =
  "[build-headers] VITE_API_BASE must be '' (same-origin /api) or an absolute origin like " +
  'https://api.example.com — no path, no query (got "{}"). It feeds the client bundle, ' +
  'dist/share/config.js, the CSP connect-src and the Netlify /api proxy redirect, so a ' +
  'malformed value must fail the build instead of shipping a site whose parts disagree.';

/** Normalizes and validates the API origin. '' = same-origin. */
export function normalizeApiBase(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return '';
  if (!API_BASE_PATTERN.test(value)) {
    throw new Error(API_BASE_ERROR.replace('{}', value));
  }
  return value.replace(/\/+$/, '');
}

/** The connect-src entry list: the app itself, the configured API origin
 * (if any) and the music player's Spotify calls. */
function connectSrcFor(apiBase) {
  return [
    "'self'",
    ...(apiBase ? [apiBase] : []),
    'https://api.spotify.com',
    'wss://*.spotify.com',
  ].join(' ');
}

const INLINE_SCRIPT_PATTERN = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Builds the _headers, share config and _redirects content for a build
 * output directory. Exported so tests can exercise the generator against
 * a fixture tree; the CLI wrapper at the bottom runs it against ../dist
 * after `vite build`.
 *
 * @param {string} distDir
 * @param {{ apiBase?: string }} [options] — apiBase is the raw VITE_API_BASE
 *   ('' = same-origin); validated here so both the CLI and tests share the
 *   invariant.
 * @returns {{ csp: string, scriptHashes: string[], headersFile: string,
 *             apiBase: string, shareConfigFile: string,
 *             redirectsFile: string | null }}
 */
export function generateHeadersFile(distDir, options = {}) {
  const apiBase = normalizeApiBase(options.apiBase ?? '');
  const entryPath = join(distDir, 'index.html');
  if (!existsSync(entryPath)) {
    throw new Error(`[build-headers] ${entryPath} not found. Run \`vite build\` first.`);
  }

  const html = readFileSync(entryPath, 'utf8');
  const scriptHashes = [];
  let match;
  while ((match = INLINE_SCRIPT_PATTERN.exec(html)) !== null) {
    scriptHashes.push(`'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
  }

  const scriptSrc = ["'self'", 'https://sdk.scdn.co', ...scriptHashes].join(' ');
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrcFor(apiBase)}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const headersFile = `# Generated by scripts/build-headers.mjs — do not edit by hand.
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=63072000
  X-Frame-Options: DENY
  Permissions-Policy: geolocation=(), payment=(), usb=()
  Content-Security-Policy: ${csp}

/sw.js
  Cache-Control: public, max-age=0, must-revalidate
`;

  const shareConfigFile = `/**
 * Padify share viewer — configuration.
 *
 * GENERATED by scripts/build-headers.mjs from VITE_API_BASE — edits to this
 * copy are overwritten on the next build. The dev template lives in
 * public/share/config.js; see docs/CLOUD_SETUP.md §3.
 */
window.PADIFY_SHARE_CONFIG = {
  // Unquoted-safe: API_BASE_PATTERN admits only scheme://host[:port].
  apiBase: '${apiBase}'
};
`;

  const redirectsFile = apiBase
    ? `# Generated by scripts/build-headers.mjs from VITE_API_BASE — do not edit by hand.
# Netlify picks this file up from the publish directory and routes the API
# under this site's origin (forced, so it wins over any static /api asset).
# Same-origin is a convenience here: the app itself and the share viewer
# call the origin directly (CORS), so this keeps /api/* reachable for other
# clients (curl, tests) on the same host.
/api/*  ${apiBase}/:splat  200!
`
    : null;

  return { csp, scriptHashes, headersFile, apiBase, shareConfigFile, redirectsFile };
}

// CLI entry point — skip when the module is imported (e.g. by vitest).
if (process.argv[1] && process.argv[1].endsWith('build-headers.mjs')) {
  const distDir = new URL('../dist', import.meta.url).pathname;
  try {
    const { csp, scriptHashes, headersFile, apiBase, shareConfigFile, redirectsFile } =
      generateHeadersFile(distDir, { apiBase: process.env.VITE_API_BASE });
    writeFileSync(join(distDir, '_headers'), headersFile);
    // The share viewer cannot read the app's bundle config; write its own.
    mkdirSync(join(distDir, 'share'), { recursive: true });
    writeFileSync(join(distDir, 'share', 'config.js'), shareConfigFile);
    if (redirectsFile) {
      writeFileSync(join(distDir, '_redirects'), redirectsFile);
    }

    console.log(`[build-headers] wrote dist/_headers`);
    console.log(`[build-headers] pinned ${scriptHashes.length} inline script hash(es)`);
    console.log(`[build-headers] api origin: ${apiBase === '' ? 'same-origin (/api)' : apiBase}`);
    if (redirectsFile) {
      console.log(`[build-headers] wrote dist/_redirects (/api/* proxy)`);
    }
    console.log(`[build-headers] wrote dist/share/config.js`);
    console.log(`[build-headers] csp: ${csp}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
