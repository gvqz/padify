/**
 * Padify cloud sync — configuration.
 *
 * Cloud sync stores notes (tabs) on the padify API (see server/), which
 * keeps everything in a Turso (libSQL) database so long-term users can
 * recover their notes on a new device or browser. The app itself stays
 * local-first: the on-device storage layer (see src/storage/) remains the
 * source of truth and nothing leaves the device until the user signs in.
 *
 * The client talks to the API at ONE origin, answered by VITE_API_BASE at
 * build time:
 *  • unset or '' (default) → same-origin, endpoints under /api/… . Works
 *    with the Vite dev proxy and with a static host that routes /api/* to
 *    the API (docs/CLOUD_SETUP.md §3).
 *  • Any absolute URL (https://api.example.com) → a separately hosted API.
 *    The same variable is mirrored into the share viewer's generated
 *    dist/share/config.js and the CSP connect-src (scripts/build-headers.mjs),
 *    so the app, the /share/ page and the security policy can never
 *    disagree about where the API is. The API answers with permissive CORS
 *    for allowed origins.
 *
 * A runtime override (storage key `padifyCloudConfig`, set as JSON
 * {apiBase}) wins over the build-time constant. It exists for local
 * development and testing; it is intentionally not exposed in the UI. (Set
 * it with localStorage.setItem — the storage layer mirrors both ways.)
 *
 * To run the app fully local-only (no cloud icon, no sync), remove the
 * cloud wiring from src/main.ts — the app degrades gracefully.
 */

import { stateGet } from '../storage';

const RUNTIME_CONFIG_KEY = 'padifyCloudConfig';

export interface CloudConfig {
  /** URL prefix for every cloud endpoint; '' = same origin (/api/…). */
  apiBase: string;
}

/** Shipped default: whatever VITE_API_BASE said at build time ('' = same-origin /api). */
export const CLOUD_BUILD_CONFIG: CloudConfig = {
  apiBase: normalizeBase(import.meta.env.VITE_API_BASE ?? ''),
};

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/**
 * Resolves the active configuration. Cloud sync is always available: the
 * default points at the same origin, so a deployment with the API routed
 * under /api just works.
 */
export function getCloudConfig(): CloudConfig {
  try {
    const raw = stateGet(RUNTIME_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CloudConfig> | null;
      if (parsed && typeof parsed.apiBase === 'string') {
        return { apiBase: normalizeBase(parsed.apiBase) };
      }
    }
  } catch {
    /* malformed override — fall through to the default */
  }
  return { apiBase: normalizeBase(CLOUD_BUILD_CONFIG.apiBase) };
}

export function isCloudConfigured(): boolean {
  return true;
}
