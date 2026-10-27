/**
 * Post-build step: generates the deploy-time files in dist/ that depend on
 * the build's configuration — one variable, VITE_API_BASE, feeds all of
 * them so the parts can never disagree about where the API lives:
 *
 *  • dist/_headers (Netlify header rules) with a content security policy
 *    whose script-src pins every inline script the build actually contains
 *    and whose connect-src admits the API origin when one is configured.
 *  • dist/.htaccess — the same rules in Apache dialect, because the
 *    alwaysdata box serves the static site straight from Apache and
 *    silently IGNORES Netlify's _headers file. Before this file existed
 *    the production site shipped with no CSP, no HSTS and no
 *    X-Frame-Options at all. CSP also rides inside the documents via
 *    <meta http-equiv> (see below) so the policy holds even where
 *    .htaccess cannot reach (mirrors, archive copies).
 *  • dist/index.html + dist/share/index.html get a <meta
 *    http-equiv="Content-Security-Policy"> carrying the same policy the
 *    headers set — defense in depth that survives header-stripping hosts.
 *    frame-ancestors stays out of the meta form: the CSP spec ignores it
 *    there, and X-Frame-Options covers clickjacking on header-honoring
 *    hosts.
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
 *  • script-src 'self' — the Vite bundle.
 *  • style-src 'unsafe-inline' — features style the DOM through inline
 *    style attributes (color pickers, typing effects, art positioning);
 *    CSS cannot execute script, so this stays open.
 *  • img-src / media-src 'https:' — album art and resolved stream URLs are
 *    CDN hosts chosen at runtime, not at build time.
 *  • connect-src — the client fetches its own API (same-origin /api by
 *    default, or the VITE_API_BASE origin, see src/cloud/config.ts).
 *
 * Self-hosted deployments behind a reverse proxy should mirror these
 * headers from dist/_headers; scripts/ and dist/ carry the source of truth.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VITE_API_BASE must be '' (same-origin /api) or an absolute URL —
 * scheme://host[:port], optionally followed by a path segment
 * (https://host/padifyapi) for deployments where the API lives under a
 * subpath of a shared domain. Queries, fragments and relative values stay
 * malformed: they would silently produce a redirect target and a fetch
 * base that disagree about the API's shape.
 */
const API_BASE_PATTERN = /^https:\/\/[^/?#]+(?:\/[^/?#]+)*\/?$/;
const API_BASE_ERROR =
  "[build-headers] VITE_API_BASE must be '' (same-origin /api) or an absolute URL like " +
  'https://api.example.com or https://host/padifyapi — no query, no fragment (got "{}"). ' +
  'It feeds the client bundle, dist/share/config.js, the CSP connect-src and the Netlify /api ' +
  'proxy redirect, so a malformed value must fail the build instead of shipping a site whose ' +
  'parts disagree.';

/** Normalizes and validates the API origin. '' = same-origin. */
export function normalizeApiBase(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return '';
  if (!API_BASE_PATTERN.test(value)) {
    throw new Error(API_BASE_ERROR.replace('{}', value));
  }
  return value.replace(/\/+$/, '');
}

/** The connect-src entry list: the app itself, the configured API URL
 * (if any) and the music player's Spotify calls. A path-bearing base is
 * emitted with a trailing slash so CSP path matching treats it as a
 * directory and admits every endpoint under it. */
function connectSrcFor(apiBase) {
  let cspEntry = apiBase;
  if (apiBase) {
    try {
      const { pathname } = new URL(apiBase);
      if (pathname && pathname !== '/') {
        cspEntry = `${apiBase}/`;
      }
    } catch {
      // normalizeApiBase already validated the value; unreachable.
    }
  }
  return ["'self'", ...(cspEntry ? [cspEntry] : [])].join(' ');
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
 * @returns {{ csp: string, metaCsp: string, shareCsp: string,
 *             scriptHashes: string[], headersFile: string,
 *             htaccessFile: string, apiBase: string,
 *             shareConfigFile: string, redirectsFile: string | null }}
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

  const scriptSrc = ["'self'", ...scriptHashes].join(' ');
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

  // The meta-tag flavor of the policy: frame-ancestors is meaningless in a
  // <meta> (the spec ignores it there) and keeping it would only produce a
  // console warning on every load. Everything else is identical to the
  // header form, so header-CSP and meta-CSP intersect to the same policy.
  const metaCsp = csp.replace(/; frame-ancestors 'none'/, '');

  // The share viewer renders untrusted note content (sanitized markdown →
  // DOM) with external scripts only. Its own policy: no hashes needed, no
  // worker-src, images may arrive as data:/blob:/https: per the sanitizer.
  const shareCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrcFor(apiBase)}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  // Apache dialect of the same rules — alwaysdata serves the static site
  // through Apache, which ignores Netlify's _headers convention entirely.
  // Wrapped in <IfModule> so a host without mod_headers degrades to today's
  // (header-less) behavior instead of 500-ing the whole site. CSP carries
  // the inline-script hashes so it stays exactly as strict as the
  // Netlify/meta forms; meta and header CSP intersect to themselves.
  const htaccessFile = `# Generated by scripts/build-headers.mjs — do not edit by hand.
# Apache flavor of dist/_headers: alwaysdata's static hosting reads this
# file and ignores _headers (a Netlify convention).
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Strict-Transport-Security "max-age=63072000"
  Header always set X-Frame-Options "DENY"
  Header always set Permissions-Policy "geolocation=(), payment=(), usb=()"
  Header always set Content-Security-Policy "${csp}"
</IfModule>

<IfModule mod_headers.c>
  <FilesMatch "sw\\.js$">
    Header always set Cache-Control "public, max-age=0, must-revalidate"
  </FilesMatch>
</IfModule>
`;

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
  // Unquoted-safe: API_BASE_PATTERN admits scheme://host[:port] and
  // scheme://host[:port]/path only.
  apiBase: '${apiBase}'
};
`;

  const redirectsFile = apiBase
    ? `# Generated by scripts/build-headers.mjs from VITE_API_BASE — do not edit by hand.
# Netlify picks this file up from the publish directory and routes the API
# under this site's origin (forced, so it wins over any static /api asset).
# Same-origin is a convenience here: the app itself and the share viewer
# call the origin directly (CORS), so this keeps /api/* reachable for other
# clients (curl, tests) on the same host. The API serves every route under
# /api/… (PATH_PREFIX already accounts for the mount point), so the splat
# is re-anchored: /api/health → ${apiBase}/api/health.
/api/*  ${apiBase}/api/:splat  200!
`
    : null;

  return {
    csp,
    metaCsp,
    shareCsp,
    scriptHashes,
    headersFile,
    htaccessFile,
    apiBase,
    shareConfigFile,
    redirectsFile,
  };
}

const META_TAG_PATTERN = /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/i;

/**
 * Inject (or replace) the CSP <meta> in a built document. Idempotent: a
 * second run over an already-stamped file replaces the tag instead of
 * stacking duplicates, so re-running the generator against dist/ is safe.
 * The tag sits right after <meta charset> — before every script, link and
 * the theme bootstrap — so the parser applies it before any resource and
 * the whole document is governed from the first byte.
 */
export function injectCspMeta(html, policy) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (META_TAG_PATTERN.test(html)) {
    return html.replace(META_TAG_PATTERN, meta);
  }
  if (/<meta[^>]+charset[^>]*>/i.test(html)) {
    return html.replace(/(<meta[^>]+charset[^>]*>)/i, `$1\n    ${meta}`);
  }
  return html.replace(/(<head[^>]*>)/i, `$1\n    ${meta}`);
}

// CLI entry point — skip when the module is imported (e.g. by vitest).
if (process.argv[1] && process.argv[1].endsWith('build-headers.mjs')) {
  const distDir = new URL('../dist', import.meta.url).pathname;
  try {
    const {
      csp,
      metaCsp,
      shareCsp,
      scriptHashes,
      headersFile,
      htaccessFile,
      apiBase,
      shareConfigFile,
      redirectsFile,
    } = generateHeadersFile(distDir, { apiBase: process.env.VITE_API_BASE });
    writeFileSync(join(distDir, '_headers'), headersFile);
    writeFileSync(join(distDir, '.htaccess'), htaccessFile);
    // The share viewer cannot read the app's bundle config; write its own.
    mkdirSync(join(distDir, 'share'), { recursive: true });
    writeFileSync(join(distDir, 'share', 'config.js'), shareConfigFile);
    if (redirectsFile) {
      writeFileSync(join(distDir, '_redirects'), redirectsFile);
    }
    // Stamp the CSP into both HTML documents (idempotent — see
    // injectCspMeta). share/index.html may be absent in exotic builds.
    const entryPath = join(distDir, 'index.html');
    writeFileSync(entryPath, injectCspMeta(readFileSync(entryPath, 'utf8'), metaCsp));
    const sharePath = join(distDir, 'share', 'index.html');
    if (existsSync(sharePath)) {
      writeFileSync(sharePath, injectCspMeta(readFileSync(sharePath, 'utf8'), shareCsp));
    }

    console.log(`[build-headers] wrote dist/_headers`);
    console.log(`[build-headers] wrote dist/.htaccess (Apache)`);
    console.log(`[build-headers] pinned ${scriptHashes.length} inline script hash(es)`);
    console.log(`[build-headers] injected CSP meta into index.html + share/index.html`);
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
