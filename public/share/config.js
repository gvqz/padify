/**
 * Padify share viewer — configuration.
 *
 * apiBase is the URL prefix of the padify cloud API (see server/):
 *  • '' (default) → same origin, the API lives under /api/… on this site.
 *  • Or an absolute URL (https://api.example.com) for a separately hosted
 *    API. See docs/CLOUD_SETUP.md.
 */
window.PADIFY_SHARE_CONFIG = {
  apiBase: ''
};
