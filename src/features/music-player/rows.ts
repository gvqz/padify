/**
 * The player's row markup — pure string builders.
 *
 * Every list in the player (favorites, the local playlist, search results,
 * ambience, the queue) renders through the same row shell. Row actions are
 * direct: the heart favorites, the + enqueues, and the ⋯ menu holds the
 * rest (add to playlist). A click anywhere else on the row plays the list.
 */

import type { SpotifyTrack } from './types';
import { eqMarkup, ICONS } from './markup';
import { ambientIconFor } from './ambient';
import { formatMs, trackArtistNames, pickImage, escapeHtml } from './helpers';

/** Row art: catalog artwork, an ambience icon, or the note fallback. */
function rowArt(track: SpotifyTrack): string {
  const art = pickImage(track.album?.images, 2) ?? pickImage(track.album?.images, 0);
  if (art) return `<img src="${art}" alt="" loading="lazy">`;
  const ambient = ambientIconFor(track);
  if (ambient) return ambient;
  return ICONS.note;
}

const explicitBadge = (track: SpotifyTrack): string => (track.explicit ? ' · E' : '');

/** A track row in any list: play area, heart, enqueue, and the ⋯ menu. */
export function trackRow(track: SpotifyTrack, queueId: string): string {
  const artists = escapeHtml(trackArtistNames(track));
  const name = escapeHtml(track.name);
  return `
        <div class="sp-row" role="listitem" data-queue-id="${queueId}" data-track-id="${track.id}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" aria-label="Play ${name} by ${artists}">
                <span class="sp-row-art">${rowArt(track)}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${name}</span>
                    <span class="sp-row-sub">${artists}${explicitBadge(track)}</span>
                </span>
                ${eqMarkup('sp-row-eq')}
                <span class="sp-row-dur">${formatMs(track.duration_ms)}</span>
            </button>
            <button type="button" class="sp-row-like" data-like aria-pressed="false" title="Favorite" aria-label="Save ${name} to favorites">${ICONS.heart}</button>
            <button type="button" class="sp-row-queue" data-queue-add title="Add to queue" aria-label="Add ${name} to queue">${ICONS.plus}</button>
            <button type="button" class="sp-row-menu" data-menu aria-haspopup="true" aria-expanded="false" title="More options" aria-label="More options for ${name}">${ICONS.dots}</button>
        </div>`;
}

/** Queue rows: same shell + a remove button instead of the menu. */
export function queueRow(track: SpotifyTrack, index: number): string {
  const artists = escapeHtml(trackArtistNames(track));
  const name = escapeHtml(track.name);
  return `
        <div class="sp-row" role="listitem" data-queue-index="${index}" data-track-id="${track.id}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" aria-label="Play ${name} by ${artists}">
                <span class="sp-row-art">${rowArt(track)}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${name}</span>
                    <span class="sp-row-sub">${artists}${explicitBadge(track)}</span>
                </span>
                ${eqMarkup('sp-row-eq')}
                <span class="sp-row-dur">${formatMs(track.duration_ms)}</span>
            </button>
            <button type="button" class="sp-row-like" data-like aria-pressed="false" title="Favorite" aria-label="Save ${name} to favorites">${ICONS.heart}</button>
            <button type="button" class="sp-row-remove" data-remove title="Remove from queue" aria-label="Remove ${name} from queue">${ICONS.remove}</button>
        </div>`;
}

/**
 * The row action menu's items — pure markup from player state. The caller
 * owns mounting, focus, and teardown.
 */
export function rowMenuItems(options: { localPlaylistName: string | null }): string {
  return [
    `<button type="button" class="mp-row-menu-item" data-action="queue">${ICONS.queue}<span>Add to queue</span></button>`,
    `<button type="button" class="mp-row-menu-item" data-action="local-playlist">${ICONS.playlist}<span>${
      options.localPlaylistName
        ? `Add to ${escapeHtml(options.localPlaylistName)}`
        : 'Start your playlist'
    }</span></button>`,
  ].join('');
}
