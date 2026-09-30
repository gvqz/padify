/**
 * The player's row and card markup — pure string builders.
 *
 * Every list in the player (favorites, the local playlist, search results,
 * Liked Songs, the queue) renders through the same row shell; every
 * collection renders through the same card shell. These functions were
 * private methods on the controller that happened to never touch `this`;
 * moving them out is behavior-neutral and finally makes the markup
 * pinnable: escaping, dataset wiring, and the explicit badge are now
 * contract, not coincidence.
 */

import type {
  SpotifyAlbum,
  SpotifyPlaylist,
  SpotifySimpleArtist,
  SpotifyTrack,
} from './spotify/api';
import { eqMarkup, ICONS } from './markup';
import { formatMs, trackArtistNames, pickImage, escapeHtml } from './helpers';

export function playlistCard(playlist: SpotifyPlaylist): string {
  const art = pickImage(playlist.images, 0);
  return `
        <button type="button" class="sp-card" data-playlist-id="${playlist.id}" data-playlist-uri="${playlist.uri}" title="${escapeHtml(playlist.name)}">
            <span class="sp-card-art">
                ${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.playlist}
            </span>
            <span class="sp-card-name">${escapeHtml(playlist.name)}</span>
            <span class="sp-card-meta">${playlist.tracks.total} songs</span>
        </button>`;
}

export function albumCard(album: SpotifyAlbum): string {
  const art = pickImage(album.images, 0);
  return `
        <button type="button" class="sp-card" data-album-id="${album.id}" data-album-uri="${album.uri}" title="${escapeHtml(album.name)}">
            <span class="sp-card-art">
                ${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.playlist}
            </span>
            <span class="sp-card-name">${escapeHtml(album.name)}</span>
            <span class="sp-card-meta">${album.artists.map((a) => a.name).join(', ')}</span>
        </button>`;
}

export function artistCard(artist: SpotifySimpleArtist): string {
  const art = pickImage(artist.images, 0);
  return `
        <button type="button" class="sp-card sp-card-artist" data-artist-id="${artist.id}" data-artist-name="${escapeHtml(artist.name)}" title="${escapeHtml(artist.name)}">
            <span class="sp-card-art sp-card-art-round">
                ${art ? `<img src="${art}" alt="" loading="lazy">` : ICONS.playlist}
            </span>
            <span class="sp-card-name">${escapeHtml(artist.name)}</span>
            <span class="sp-card-meta">Artist</span>
        </button>`;
}

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
 * The row action menu's items — pure markup from connection state.
 * Anonymous users get the local playlist action; connected users get
 * their playlists (capped), behind a divider. The caller owns mounting,
 * focus, and teardown.
 */
export function rowMenuItems(options: {
  connected: boolean;
  localPlaylistName: string | null;
  spotifyPlaylists: SpotifyPlaylist[];
  maxPlaylists?: number;
}): string {
  const items: string[] = [];
  items.push(
    `<button type="button" class="mp-row-menu-item" data-action="queue">${ICONS.queueTab}<span>Add to queue</span></button>`,
  );
  if (!options.connected) {
    items.push(
      `<button type="button" class="mp-row-menu-item" data-action="local-playlist">${ICONS.playlist}<span>${
        options.localPlaylistName
          ? `Add to ${escapeHtml(options.localPlaylistName)}`
          : 'Start your playlist'
      }</span></button>`,
    );
    return items.join('');
  }
  const playlists = options.spotifyPlaylists.slice(0, options.maxPlaylists ?? 8);
  if (playlists.length > 0) {
    items.push('<div class="mp-row-menu-divider"></div>');
    for (const playlist of playlists) {
      items.push(
        `<button type="button" class="mp-row-menu-item" data-action="spotify-playlist" data-playlist-id="${playlist.id}" title="${escapeHtml(playlist.name)}">${ICONS.playlist}<span>${escapeHtml(playlist.name)}</span></button>`,
      );
    }
  }
  return items.join('');
}
