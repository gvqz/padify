/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the cloud API lives, as an absolute URL (https://api.example.com).
   * Unset or empty → same-origin /api (the default; a static host routes
   * /api/* to the API — see docs/CLOUD_SETUP.md §3). ONE variable drives
   * the client, the share viewer and the generated /api proxy redirect.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
