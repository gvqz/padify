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
import { showToast } from '../ui/toast';
import { deriveTabTitle, getActiveNoteContent, getTabManager } from '../tabs';
import { noteTypeLabel, type NoteType } from '../editor/note-types';
import { getCloudSync } from './sync';
import {
  createShare,
  isShareAvailable,
  listOwnedShares,
  noteContentIsEmpty,
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

  // The links scope: this note only, or every link the account owns.
  $('input[name="shareScope"]').on('change', renderLinks);

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

function activeNote(): {
  id: string;
  title: string;
  words: number;
  content: string;
  noteType: NoteType | null;
  empty: boolean;
} | null {
  const manager = getTabManager();
  const active = manager?.getActive();
  if (!manager || !active) {
    return null;
  }

  const title = deriveTabTitle(active);
  const text = manager.getActiveText();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  // The note's TRUE content: html notes read the live editor, every other
  // kind reads the model (its editor shows a placeholder card).
  const captured = getActiveNoteContent();
  const content = captured?.content ?? '';
  const noteType = captured?.noteType ?? null;
  return {
    id: active.id,
    title,
    words,
    content,
    noteType,
    empty: noteContentIsEmpty(content, noteType),
  };
}

function renderNoteCard(): void {
  const note = activeNote();
  if (!note) {
    return;
  }

  $('#shareNoteTitle').text(note.title);
  $('#shareNoteMeta').text(`${note.words.toLocaleString()} word${note.words === 1 ? '' : 's'}`);

  // The type chip: the default stays quiet, every other kind says its name.
  const $chip = $('#shareNoteTypeChip');
  if (!note.empty && note.noteType && note.noteType !== 'standard') {
    $chip.text(noteTypeLabel(note.noteType)).removeAttr('hidden');
  } else {
    $chip.attr('hidden', 'hidden');
  }

  // An empty note cannot be shared — the card itself turns quiet and dashed,
  // the meta line says why, and the create button goes dark. One place, one
  // message: not "Untitled / 0 words / This note is empty" stacked three
  // deep.
  $('#shareNoteCard').toggleClass('is-empty', note.empty);
  if (note.empty) {
    $('#shareNoteMeta').text('Empty — write something first. A link shares what the note says.');
    $('#shareCreateBtn').prop('disabled', true).attr('title', 'This note is empty');
  } else {
    $('#shareCreateBtn').prop('disabled', false).removeAttr('title');
  }
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

/**
 * The create button's busy state. Re-enabling must respect the empty-note
 * refusal: the links refresh runs AFTER renderNoteCard disabled the button,
 * and a blind `disabled = false` used to resurrect it mid-modal for a note
 * with nothing to share.
 */
function renderLinksBusy(busy: boolean): void {
  if (busy) {
    $('#shareCreateBtn').prop('disabled', true);
    return;
  }
  const note = activeNote();
  const shareable = !!note && !note.empty;
  $('#shareCreateBtn').prop('disabled', !shareable);
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

/** "Created 2 days ago" — the row's age, not part of the countdown. */
function createdAgo(record: ShareRecord): string {
  const diff = Date.now() - new Date(record.created_at).getTime();
  if (diff < 3_600_000) {
    return 'Just created';
  }
  const days = Math.floor(diff / DAY_MS);
  if (days >= 1) {
    return days === 1 ? 'Created 1 day ago' : `Created ${days} days ago`;
  }
  const hours = Math.floor(diff / 3_600_000);
  return hours === 1 ? 'Created 1 hour ago' : `Created ${hours} hours ago`;
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
  const showAll = $('#shareScopeAll').is(':checked');

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
    meta.append(document.createTextNode(`${relativeExpiry(record)} · ${createdAgo(record)}`));
    // When the list spans notes (or the link points elsewhere), say which.
    if (showAll || (note && record.note_id !== note.id)) {
      const title = record.title && record.title.trim() ? record.title : 'Untitled';
      meta.append(document.createTextNode(`· “${title}”`));
    }

    main.append($('<span class="share-link-url"></span>').text(shortUrl(record.token)));
    main.append(meta);

    const actions = $('<div class="share-link-actions"></div>');

    // See it the way a reader will: the viewer page, in a new tab. A link
    // you cannot sanity-check is a link you cannot trust.
    const open = $('<button type="button" class="share-chip-btn"></button>').text('Open');
    open.on('click', () => {
      window.open(shareUrlFor(record.token), '_blank', 'noopener');
    });
    actions.append(open);

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
  if (note.empty) {
    // The button is already disabled — this guards the keyboard/AT path
    // that reaches the action without the button.
    showToast('This note is empty — write something before sharing it.');
    return;
  }

  renderLinksBusy(true);
  const result = await createShare(
    note.id,
    note.title,
    note.content,
    selectedDays(),
    note.noteType ?? undefined,
  );
  renderLinksBusy(false);

  if (!result.ok) {
    showToast(result.message ?? 'Could not create the link.');
    return;
  }

  // The link was created to be handed to someone: putting it on the
  // clipboard immediately saves the one extra click for every share
  // (the list still offers Copy for later use).
  if (result.token) {
    void copyLinkText(
      shareUrlFor(result.token),
      'Share link created and copied — anyone with it can read this note.',
    );
  } else {
    showToast('Share link created — anyone with it can read this note.');
  }
  await refreshShares();
}

/** Writes a URL to the clipboard and reports the outcome as a toast. */
async function copyLinkText(url: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    showToast(message);
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
    showToast(ok ? message : 'Link created — copy it from the list below.');
  }
}

async function copyShareLink(record: ShareRecord): Promise<void> {
  await copyLinkText(shareUrlFor(record.token), 'Link copied to clipboard.');
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
