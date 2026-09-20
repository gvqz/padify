/**
 * Padify cloud sync — configuration.
 *
 * Cloud sync stores notes (tabs) in a Supabase project so long-term users can
 * recover their notes on a new device or browser. The app itself stays
 * local-first: localStorage remains the source of truth and nothing leaves
 * the device until the user signs in.
 *
 * The app owner points padify at their Supabase project by filling in the
 * build-time constants below (see docs/CLOUD_SETUP.md for the full guide —
 * creating the project, running the schema, and where to find these values).
 * The publishable anon key is designed to be shipped in a client bundle;
 * row level security keeps every account's notes private.
 *
 * A runtime override (localStorage key `padifyCloudConfig`, set as JSON
 * {url, anonKey}) wins over the build-time constants. It exists for local
 * development and testing against a mock server; it is intentionally not
 * exposed in the settings UI.
 */

const RUNTIME_CONFIG_KEY = 'padifyCloudConfig';

export interface CloudConfig {
  url: string;
  anonKey: string;
}

/** Fill these in after creating the Supabase project (docs/CLOUD_SETUP.md). */
export const CLOUD_BUILD_CONFIG: CloudConfig = {
  url: '',
  anonKey: ''
};

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolves the active configuration, or null when cloud sync is not set up.
 * When the build-time config is present it is mirrored into localStorage so
 * the static mini-tools (the drawing pad) can pick it up too.
 */
export function getCloudConfig(): CloudConfig | null {
  const build = CLOUD_BUILD_CONFIG;
  if (build.url.trim() && build.anonKey.trim()) {
    const config = { url: normalizeUrl(build.url), anonKey: build.anonKey.trim() };
    mirrorConfigForMiniTools(config);
    return config;
  }

  try {
    const raw = localStorage.getItem(RUNTIME_CONFIG_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CloudConfig> | null;
    if (parsed && typeof parsed.url === 'string' && typeof parsed.anonKey === 'string'
      && parsed.url.trim() && parsed.anonKey.trim()) {
      return { url: normalizeUrl(parsed.url), anonKey: parsed.anonKey.trim() };
    }
  } catch {
    /* malformed override — treat as unconfigured */
  }

  return null;
}

export function isCloudConfigured(): boolean {
  return getCloudConfig() !== null;
}

/** The static mini-tool pages read the resolved config from localStorage. */
function mirrorConfigForMiniTools(config: CloudConfig): void {
  try {
    const raw = JSON.stringify(config);
    if (localStorage.getItem(RUNTIME_CONFIG_KEY) !== raw) {
      localStorage.setItem(RUNTIME_CONFIG_KEY, raw);
    }
  } catch {
    /* storage unavailable — mini-tools just stay offline */
  }
}
