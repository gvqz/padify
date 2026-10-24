/**
 * Settings — the typed choke point over Padify's persisted state.
 *
 * History: persisted settings were a stringly-typed key/value bag. Every
 * feature wrote through `stateSet(key, value)` with raw string keys and
 * nobody could observe a change — preferences UI, the editor and feature
 * modules all poked the bag independently and hoped for the best, and the
 * only "defaults" table (selector.ts's defaultConfig) covered a fraction
 * of the keys.
 *
 * This module is the one place that:
 *  - enumerates every persisted key (compile-checked: `SettingKey`)
 *  - owns the editor defaults (DEFAULT_EDITOR_CONFIG)
 *  - exposes get/set/remove that keep the storage layout byte-compatible
 *    (values persist exactly as before — no migration) and fire change
 *    notifications
 *  - offers onChangeSetting(key | keys | '*', cb) so features can REACT to
 *    preference changes instead of polling or re-reading stale snapshots
 *
 * All writes go through here. selector.ts's setState delegates to
 * settings.set, and the last direct stateSet callers (theme, font
 * selection, typing-effects resets) migrated — see the choke-point pin in
 * architecture.test.ts, which fails the build if a raw write comes back.
 */

import { stateGet, stateRemove, stateSet } from '../storage';

/** Every key that exists in persisted state. */
export const SETTING_KEYS = [
  'note',
  'mode',
  'isUserPreferredTheme',
  'userChosenFontSize',
  'userChosenLineHeight',
  'hasUserDismissedDonationPopup',
  'userChosenWriteDirection',
  'userChosenTexture',
  'userChosenOptimalLineLengthSelected',
  'monospaced',
  'dyslexicFont',
  'serifFont',
  'userChosenSpellCheck',
  'userChosenBreakReminders',
  'userChosenExplodingEffect',
  'userChosenExplodingEffectStyle',
  'selectedFont',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Editor defaults, moved verbatim from selector.ts (the numbers/booleans
 * mirror the original shape so every existing consumer keeps working).
 * These are also the values the "reset preferences" flow restores.
 */
export interface EditorDefaults {
  defaultFontSize: number;
  defaultLineHeight: number;
  defaultFont: string;
  defaultWriteDirection: string;
  defaultTexture: string;
  defaultOptimalLineLength: boolean;
  defaultOptimalLineLengthPadding: string;
  defaultSpellCheck: boolean;
  defaultBreakReminders: boolean;
  defaultExplodingEffect: boolean;
  defaultExplodingEffectStyle: string;
}

export const DEFAULT_EDITOR_CONFIG: EditorDefaults = {
  defaultFontSize: 18,
  defaultLineHeight: 26,
  defaultFont: 'default',
  defaultWriteDirection: 'ltr',
  defaultTexture: 'normal',
  defaultOptimalLineLength: false,
  defaultOptimalLineLengthPadding: '15px 24px 80px',
  defaultSpellCheck: true,
  defaultBreakReminders: false,
  defaultExplodingEffect: false,
  defaultExplodingEffectStyle: 'classic',
};

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Change notifications
// ---------------------------------------------------------------------------

export type SettingChange = { key: SettingKey; value: string | null };
type Listener = (change: SettingChange) => void;

const listeners = new Map<symbol, { keys: SettingKey | SettingKey[] | '*'; listener: Listener }>();

/**
 * Subscribes to changes of one setting, several settings, or everything
 * ('*'). Returns an unsubscriber. Notifications fire for writes made
 * through settings.setSetting / settings.removeSetting — which, via
 * selector.setState's delegation, is effectively every legacy write path.
 */
export function onChangeSetting(
  keys: SettingKey | SettingKey[] | '*',
  listener: (change: SettingChange) => void,
): () => void {
  const id = Symbol('settings-listener');
  listeners.set(id, { keys, listener });
  return () => {
    listeners.delete(id);
  };
}

function notify(key: SettingKey, value: string | null): void {
  for (const { keys, listener } of listeners.values()) {
    if (keys === '*' || (Array.isArray(keys) ? keys.includes(key) : keys === key)) {
      listener({ key, value });
    }
  }
}

// ---------------------------------------------------------------------------
// Read/write — same storage layout as before, plus notifications
// ---------------------------------------------------------------------------

/** Reads a setting (null when never set). Same shape as the old getState. */
export function getSetting(key: SettingKey): string | null {
  return stateGet(key);
}

/**
 * Writes a setting and notifies subscribers. Values persist exactly as
 * they always have (plain strings in the storage layer), so nothing needs
 * migrating. Every enumerated-key write in the codebase routes through
 * here — enforced by architecture.test.ts (no raw stateSet/stateRemove on
 * a setting key outside this module and the storage layer).
 */
export function setSetting(key: SettingKey, value: string): void {
  stateSet(key, value);
  notify(key, value);
}

/** Clears a setting and notifies subscribers with the null value. */
export function removeSetting(key: SettingKey): void {
  stateRemove(key);
  notify(key, null);
}
