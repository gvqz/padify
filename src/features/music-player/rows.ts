/**
 * The player's row markup — pure string builders.
 *
 * Every list in the player (favorites, the local playlist, search results,
 * the queue) renders through the same row shell. These functions were
 * private methods on the controller that happened to never touch `this`;
 * moving them out is behavior-neutral and finally makes the markup
 * pinnable: escaping, dataset wiring, and the explicit badge are now
 * contract, not coincidence.
 */

import type { SpotifyTrack } from './types';
import { eqMarkup, ICONS } from './markup';
import { formatMs, trackArtistNames, pickImage, escapeHtml } from './helpers';

/** A track row in any list: play area, heart, and the more-options menu. */
export function trackRow(track: SpotifyTrack, queueId: string): string {
  const art = pickImage(track.album?.images, 2) ?? pickImage(track.album?.images, 0);
  const artists = escapeHtml(trackArtistNames(track));
  const name = escapeHtml(track.name);
  return `
        <div class="sp-row" role="listitem" data-queue-id="${queueId}" data-track-id="${track.id}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" aria-label="Play ${name} by ${artists}">
                <span class="sp-row-art">${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.note}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${name}</span>
                    <span class="sp-row-sub">${artists}${track.explicit ? ' · E' : ''}</span>
                </span>
                ${eqMarkup('sp-row-eq')}
                <span class="sp-row-dur">${formatMs(track.duration_ms)}</span>
            </button>
            <button type="button" class="sp-row-like" data-like aria-pressed="false" title="Favorite" aria-label="Save ${name} to favorites">${ICONS.heart}</button>
            <button type="button" class="sp-row-menu" data-menu aria-haspopup="true" aria-expanded="false" title="More options" aria-label="More options for ${name}">${ICONS.plus}</button>
        </div>`;
}

/** Queue rows: same shell + a remove button instead of the menu. */
export function queueRow(track: SpotifyTrack, index: number): string {
  const art = pickImage(track.album?.images, 2) ?? pickImage(track.album?.images, 0);
  const artists = escapeHtml(trackArtistNames(track));
  const name = escapeHtml(track.name);
  return `
        <div class="sp-row" role="listitem" data-queue-index="${index}" data-track-id="${track.id}" data-track-uri="${track.uri}">
            <button type="button" class="sp-row-main" aria-label="Play ${name} by ${artists}">
                <span class="sp-row-art">${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.note}</span>
                <span class="sp-row-copy">
                    <span class="sp-row-name">${name}</span>
                    <span class="sp-row-sub">${artists}${track.explicit ? ' · E' : ''}</span>
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
    `<button type="button" class="mp-row-menu-item" data-action="queue">${ICONS.queueTab}<span>Add to queue</span></button>`,
    `<button type="button" class="mp-row-menu-item" data-action="local-playlist">${ICONS.playlist}<span>${
      options.localPlaylistName
        ? `Add to ${escapeHtml(options.localPlaylistName)}`
        : 'Start your playlist'
    }</span></button>`,
  ].join('');
}
