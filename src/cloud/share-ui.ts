/**
 * Padify share links — user interface.
 *
 * The navbar share button opens a custom modal (no navigator.share): the
 * signed-in user picks how many days a read-only link stays live, creates
 * it, copies it, and can cancel any link at any time. Signed-out visitors
 * get a sign-in prompt — sharing is a cloud-account feature.
 */

import { $ } from '../lib/q';
import { openModal, closeModal } from '../ui/behavior/modal';
import Swal from 'sweetalert2';
import { showToast } from '../utils';
import { deriveTabTitle, getEditorHtml, getTabManager } from '../tabs';
import { getCloudSync } from './sync';
import {
  createShare,
  isShareAvailable,
  listOwnedShares,
  revokeShare,
  shareUrlFor,
  type ShareRecord,
} from './share';

const DAY_MS = 86_400_000;

let shares: ShareRecord[] = [];

export function initShareUI(): void {
  if (!isShareAvailable()) {
    return;
  }

  $('#shareNotesContainer').removeAttr('hidden');

  $('#shareNotes').on('click', (event) => {
    event.preventDefault();
    openShareModal();
  });

  $('#shareSignInCta').on('click', () => {
    closeModal($('#shareModal').get(0));
    setTimeout(() => {
      openModal($('#cloudModal').get(0));
    }, 200);
  });

  $('input[name="shareDuration"]').on('change', renderExpiryPreview);

  $('#shareCreateBtn').on('click', () => {
    void createFromEditor();
  });

  $('#shareAllToggle').on('change', renderLinks);

  $('#shareModal').on('show.bs.modal', () => {
    renderNoteCard();
    renderExpiryPreview();
    void refreshShares();
  });

  // Signed-in state swaps the modal panes (also fires once at startup).
  getCloudSync().subscribe(renderPanes);
}

function openShareModal(): void {
  openModal($('#shareModal').get(0));
}

// ---- panes -----------------------------------------------------------------

function signedInNow(): boolean {
  const status = getCloudSync().getStatus();
  return status.state === 'signed-in';
}

function renderPanes(): void {
  const signedIn = signedInNow();
  $('#shareSignedOutPane').attr('hidden', signedIn ? 'hidden' : null);
  $('#shareSignedInPane').attr('hidden', signedIn ? null : 'hidden');
}

// ---- note card + expiry preview ----------------------------------------------

function activeNote(): { id: string; title: string; words: number } | null {
  const manager = getTabManager();
  const active = manager?.getActive();
  if (!manager || !active) {
    return null;
  }

  const title = deriveTabTitle(active);
  const text = manager.getActiveText();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { id: active.id, title, words };
}

function renderNoteCard(): void {
  const note = activeNote();
  if (!note) {
    return;
  }

  $('#shareNoteTitle').text(note.title);
  $('#shareNoteMeta').text(`${note.words.toLocaleString()} word${note.words === 1 ? '' : 's'}`);
}

function selectedDays(): number {
  const value = String($('input[name="shareDuration"]:checked').val() ?? '7');
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function renderExpiryPreview(): void {
  const days = selectedDays();
  const expiry = Date.now() + days * DAY_MS;
  $('#shareExpiryPreview').text(
    `Link valid until ${formatDate(expiry)} — then it stops working on its own.`,
  );
}

// ---- link list ---------------------------------------------------------------

async function refreshShares(): Promise<void> {
  if (!signedInNow()) {
    return;
  }

  renderLinksBusy(true);
  shares = await listOwnedShares();
  renderLinksBusy(false);
  renderLinks();
}

function renderLinksBusy(busy: boolean): void {
  $('#shareCreateBtn').prop('disabled', busy);
}

function relativeExpiry(record: ShareRecord): string {
  const expires = new Date(record.expires_at).getTime();
  const diff = expires - Date.now();
  if (diff <= 0) {
    return `Expired ${formatDate(expires)}`;
  }
  if (record.revoked) {
    // Cancelled before its time — show the original window, not a countdown.
    return `Was valid until ${formatDate(expires)}`;
  }
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / 3_600_000);
  if (days >= 1) {
    return days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`;
  }
  return hours === 1 ? 'Expires in 1 hour' : `Expires in ${Math.max(hours, 1)} hours`;
}

function shortUrl(token: string): string {
  const url = shareUrlFor(token);
  if (url.length <= 46) {
    return url;
  }
  return `${url.slice(0, 42)}…`;
}

function statusBadge(record: ShareRecord): string {
  if (record.revoked) {
    return '<span class="share-badge revoked">Cancelled</span>';
  }
  if (new Date(record.expires_at).getTime() <= Date.now()) {
    return '<span class="share-badge expired">Expired</span>';
  }
  return '<span class="share-badge active">Active</span>';
}

function renderLinks(): void {
  const $list = $('#shareLinksList');
  const note = activeNote();
  const showAll = $('#shareAllToggle').is(':checked');

  const visible = shares.filter((record) => {
    if (showAll) {
      return true;
    }
    return note ? record.note_id === note.id : true;
  });

  $list.empty();

  if (visible.length === 0) {
    const message = showAll
      ? 'No links yet. Create one above — anyone with it sees a read-only copy of the note.'
      : 'No links yet for this note. Create one above — anyone with it sees a read-only copy.';
    $list.append($('<p class="share-links-empty"></p>').text(message));
    return;
  }

  visible.forEach((record) => {
    const isActive = !record.revoked && new Date(record.expires_at).getTime() > Date.now();
    const row = $('<div class="share-link-row"></div>');
    if (!isActive) {
      row.addClass('dim');
    }

    const main = $('<div class="share-link-main"></div>');

    const meta = $('<div class="share-link-meta"></div>');
    meta.append(statusBadge(record));
    meta.append(document.createTextNode(relativeExpiry(record)));
    // When the list spans notes (or the link points elsewhere), say which.
    if (showAll || (note && record.note_id !== note.id)) {
      const title = record.title && record.title.trim() ? record.title : 'Untitled';
      meta.append($('<span></span>').text(`· “${title}”`));
    }

    main.append($('<span class="share-link-url"></span>').text(shortUrl(record.token)));
    main.append(meta);

    const actions = $('<div class="share-link-actions"></div>');

    const copy = $('<button type="button" class="share-chip-btn"></button>').text('Copy');
    copy.on('click', () => {
      void copyShareLink(record);
    });
    actions.append(copy);

    if (isActive) {
      const cancel = $('<button type="button" class="share-chip-btn danger"></button>').text(
        'Cancel link',
      );
      cancel.on('click', () => {
        void cancelShareLink(record);
      });
      actions.append(cancel);
    }

    row.append(main);
    row.append(actions);
    $list.append(row);
  });
}

// ---- actions -----------------------------------------------------------------

async function createFromEditor(): Promise<void> {
  const note = activeNote();
  if (!note) {
    return;
  }

  renderLinksBusy(true);
  const result = await createShare(note.id, note.title, getEditorHtml(), selectedDays());
  renderLinksBusy(false);

  if (!result.ok) {
    showToast(result.message ?? 'Could not create the link.');
    return;
  }

  showToast('Share link created — anyone with it can read this note.');
  await refreshShares();
}

async function copyShareLink(record: ShareRecord): Promise<void> {
  const url = shareUrlFor(record.token);
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard.');
  } catch {
    // Clipboard API can be unavailable (http origins, older browsers).
    const scratch = document.createElement('textarea');
    scratch.value = url;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.left = '-9999px';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    showToast(
      ok ? 'Link copied to clipboard.' : 'Could not copy the link — copy it from the list.',
    );
  }
}

async function cancelShareLink(record: ShareRecord): Promise<void> {
  const confirmation = await Swal.fire({
    title: 'Cancel this link?',
    text: 'Anyone who has it will immediately lose access to the note. This cannot be undone.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Cancel link',
    cancelButtonText: 'Keep it',
  });

  if (!confirmation.isConfirmed) {
    return;
  }

  const result = await revokeShare(record.token);
  if (!result.ok) {
    showToast(result.message ?? 'Could not cancel the link.');
    return;
  }

  record.revoked = true;
  showToast('Link cancelled — it no longer works for anyone.');
  renderLinks();
}
