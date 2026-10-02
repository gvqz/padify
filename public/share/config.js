/**
 * Padify share viewer — configuration (dev template).
 *
 * The build regenerates this file as dist/share/config.js from
 * VITE_API_BASE (scripts/build-headers.mjs), so the share page and the app
 * can never disagree about where the API is. In dev it serves the
 * same-origin default ('' = /api under the Vite proxy).
 *
 *   VITE_API_BASE unset or '' → apiBase '' (same-origin /api)
 *   VITE_API_BASE=https://api.example.com → apiBase 'https://api.example.com'
 *
 * See docs/CLOUD_SETUP.md §3.
 */
window.PADIFY_SHARE_CONFIG = {
  apiBase: ''
};
