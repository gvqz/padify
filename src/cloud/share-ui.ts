/**
 * Padify share links — user interface.
 *
 * The share sheet — the History sheet's sibling: a right-side panel that
 * reads top to bottom as WHAT you are sharing (the note card), HOW LONG
 * a new link works (the expiry choice + the one primary action), and
 * WHICH keys are already out there (the links list). The signed-in user
 * picks how many days a read-only link stays live, creates it — the link
 * lands on the clipboard immediately — and manages every link from its
 * own row. Signed-out visitors get a sign-in gate — sharing is a
 * cloud-account feature.
 *
 * Nothing here opens a second dialog: cancelling a link arms the row's
 * own button (the confirm state IS the button), the same two-step
 * contract the History sheet's deletes follow.
 */

import { $ } from '../lib/q';
import { openModal, closeModal } from '../ui/behavior/modal';
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
/** How long a cancel button stays armed before it disarms itself. */
const ARM_TIMEOUT_MS = 4000;

let shares: ShareRecord[] = [];

/** The two-step cancel: the armed row's token, and its auto-disarm timer. */
let armedToken: string | null = null;
let armedTimer: number | null = null;

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
    // A stale armed button from the previous visit must not survive the
    // reopen — the confirm state belongs to this visit's list only.
    disarmCancel();
    renderNoteCard();
    renderExpiryPreview();
    void refreshShares();
  });

  // A click anywhere else disarms whatever is armed — the confirm is a
  // gesture on the button, not a state to wander away from.
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (armedToken !== null && !target?.closest('.share-chip-btn.danger')) {
      disarmCancel();
    }
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
  // The footer speaks for the links list; it has nothing to say to a
  // signed-out visitor.
  $('#shareFoot').attr('hidden', signedIn ? null : 'hidden');
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

  // The card names what will actually be shared. A freshly typed first
  // line has not reached the saved model yet — the title derives from the
  // LIVE capture, not the stale one, or the card says "Untitled" over a
  // note that visibly has words.
  const liveTitle = active.name?.trim() ? title : deriveTabTitle({ ...active, content });

  return {
    id: active.id,
    title: liveTitle,
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
  $('.share-create-label').text(busy ? 'Creating…' : 'Create link');
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
  // The sheet has room for the whole typical link; the cap only tames
  // pathological hosts. The row's own ellipsis handles the rest.
  if (url.length <= 64) {
    return url;
  }
  return `${url.slice(0, 60)}…`;
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

function isLinkActive(record: ShareRecord): boolean {
  return !record.revoked && new Date(record.expires_at).getTime() > Date.now();
}

function renderLinks(): void {
  const $list = $('#shareLinksList');
  const note = activeNote();
  const showAll = $('#shareScopeAll').is(':checked');

  // Newest first — the link you just made is the one you most likely
  // want to copy, so it leads.
  const visible = shares
    .filter((record) => (showAll ? true : note ? record.note_id === note.id : true))
    .sort((a, b) => b.created_at - a.created_at);

  $list.empty();
  disarmCancel();

  if (visible.length === 0) {
    const message = showAll
      ? 'No links yet. Create one above — anyone with it sees a read-only copy of the note.'
      : 'No links yet for this note. Create one above — anyone with it sees a read-only copy.';
    $list.append($('<p class="share-links-empty"></p>').text(message));
    renderFoot(0);
    return;
  }

  visible.forEach((record) => {
    const isActive = isLinkActive(record);
    const row = $('<div class="share-link-row"></div>');
    if (!isActive) {
      row.addClass('dim');
    }

    const top = $('<div class="share-link-top"></div>');
    top.append($('<span class="share-link-url"></span>').text(shortUrl(record.token)));
    top.append(statusBadge(record));

    const meta = $('<div class="share-link-meta"></div>');
    const parts = [relativeExpiry(record), createdAgo(record)];
    // When the list spans notes (or the link points elsewhere), say which.
    if (showAll || (note && record.note_id !== note.id)) {
      const title = record.title && record.title.trim() ? record.title : 'Untitled';
      parts.push(`\u201C${title}\u201D`);
    }
    meta.text(parts.join(' · '));

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
      cancel.attr('data-token', record.token);
      cancel.on('click', () => {
        onCancelClick(record);
      });
      actions.append(cancel);
    }

    row.append(top);
    row.append(meta);
    row.append(actions);
    $list.append(row);
  });

  renderFoot(visible.length);
}

function renderFoot(count: number): void {
  const noun = count === 1 ? 'link' : 'links';
  $('#shareFootCount').text(count === 0 ? 'No links yet' : `${count} ${noun}`);
}

// ---- the two-step cancel -------------------------------------------------------

/**
 * The confirm state IS the button: the first click arms it (the label
 * asks the question), the second commits. Auto-disarms after a few
 * seconds; a click anywhere else disarms it; only one button is armed
 * at a time. The twin of the History sheet's armed deletes.
 */
function onCancelClick(record: ShareRecord): void {
  const button = document.querySelector(
    `.share-chip-btn.danger[data-token="${CSS.escape(record.token)}"]`,
  );
  if (!button) {
    return;
  }
  if (armedToken === record.token) {
    disarmCancel();
    void commitCancel(record);
    return;
  }
  disarmCancel();
  armedToken = record.token;
  button.classList.add('is-armed');
  button.textContent = 'Really cancel?';
  armedTimer = window.setTimeout(() => disarmCancel(), ARM_TIMEOUT_MS);
}

/** Returns every cancel button to its quiet state (idempotent). */
function disarmCancel(): void {
  if (armedTimer !== null) {
    window.clearTimeout(armedTimer);
    armedTimer = null;
  }
  armedToken = null;
  document.querySelectorAll('.share-chip-btn.danger.is-armed').forEach((button) => {
    button.classList.remove('is-armed');
    button.textContent = 'Cancel link';
  });
}

async function commitCancel(record: ShareRecord): Promise<void> {
  const result = await revokeShare(record.token);
  if (!result.ok) {
    showToast(result.message ?? 'Could not cancel the link.');
    return;
  }

  record.revoked = true;
  showToast('Link cancelled — it no longer works for anyone.');
  renderLinks();
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
