/**
 * The music player's small helpers — element lookup, time formatting,
 * artist names, artwork picking, escaping. Pure functions the controller
 * and the markup builders share.
 */

import type { SpotifyTrack } from './types';
import { escapeHtml } from '../../lib/escape';

// The one implementation lives in lib/escape.ts; re-exported here so the
// feature's row/markup builders keep importing it from their own helpers.
export { escapeHtml };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Music player markup missing #${id}`);
  return el as T;
}

export function formatTime(sec: number): string {
  const clamped = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatMs(ms: number): string {
  return formatTime(Math.floor(ms / 1000));
}

export function trackArtistNames(track: SpotifyTrack): string {
  return track.artists.map((artist) => artist.name).join(', ');
}

export function pickImage(images: { url: string }[] | undefined, preferred = 2): string | null {
  if (!images || images.length === 0) return null;
  return (images[Math.min(preferred, images.length - 1)] ?? images[0]).url;
}
