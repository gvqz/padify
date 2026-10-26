/**
 * Padify share links — user interface.
 *
 * The share panel is the ACT of sharing one note; the list lives next
 * door in its own popup. A note keeps ONE active link: with a link
 * already out, the panel shows it as a card (Copy / Cancel ride the
 * card) and the primary button refreshes its expiry instead of minting
 * a twin — duplication is not a thing the user can do by accident.
 * The "All links" row opens the links popup: every ACTIVE link across
 * the account, this note's or every note's, newest first — cancelled
 * and expired links leave the list instead of haunting it. Signed-out
 * visitors get a sign-in gate — sharing is a cloud-account feature.
 *
 * Nothing here opens a second dialog: cancelling a link arms the row's
 * own button (the confirm state IS the button), the same two-step
 * contract the History sheet's deletes follow.
 */

import { $ } from '../lib/q';
import { closePanel, openPanel } from '../ui/behavior/panel';
import { showToast } from '../ui/toast';
import { deriveTabTitle, getActiveNoteContent, getTabManager } from '../tabs';
import type { NoteType } from '../editor/note-types';
import { getCloudSync } from './sync';
import {
  createShare,
  isShareAvailable,
  listOwnedShares,
  noteContentIsEmpty,
  revokeShare,
  shareUrlFor,
  updateShareExpiry,
  type ShareRecord,
} from './share';

const DAY_MS = 86_400_000;
/** How long a cancel button stays armed before it disarms itself. */
const ARM_TIMEOUT_MS = 4000;
/** The panel-to-panel handoff — matches openPanel's own transition. */
const PANEL_SWAP_MS = 180;

let shares: ShareRecord[] = [];

/**
 * What the links list was last built from (the visible records' identity
 * — token, revoked, expiry, title — plus the scope). A render whose
 * signature matches keeps the DOM untouched, so a rebuild racing a
 * just-armed cancel button can never clone over the confirm state.
 */
let lastLinksSignature: string | null = null;

/** The two-step cancel: the armed row's token, and its auto-disarm timer. */
let armedToken: string | null = null;
let armedTimer: number | null = null;

const shareRoot = () => $('#shareModal').get(0);
const linksRoot = () => $('#shareLinksPanel').get(0);
const shareAnchor = () => $('#shareNotes').get(0);

export function initShareUI(): void {
  if (!isShareAvailable()) {
    return;
  }

  $('#shareNotesContainer').removeAttr('hidden');

  $('#shareNotes').on('click', (event) => {
    event.preventDefault();
    openPanel(shareRoot(), shareAnchor());
  });

  $('#shareSignInCta').on('click', () => {
    closePanel(shareRoot());
    setTimeout(() => {
      openPanel($('#cloudModal').get(0), $('#cloudNavContainer').get(0));
    }, PANEL_SWAP_MS);
  });

  // The links popup: the whole list lives here now, active links only.
  $('#shareAllLinks').on('click', () => {
    closePanel(shareRoot());
    setTimeout(() => {
      openPanel(linksRoot(), shareAnchor());
    }, PANEL_SWAP_MS);
  });

  $('input[name="shareDuration"]').on('change', renderExpiryPreview);

  $('#shareCreateBtn').on('click', () => {
    void createOrUpdate();
  });

  $('#shareActiveCopy').on('click', () => {
    const record = activeShareRecord();
    if (record) {
      void copyLinkText(shareUrlFor(record.token), 'Link copied to clipboard.');
    }
  });

  $('#shareActiveCancel').on('click', (event) => {
    const record = activeShareRecord();
    if (record) {
      onCancelClick(record, event.currentTarget as HTMLElement);
    }
  });

  // The links scope: this note only, or every link the account owns.
  $('input[name="shareScope"]').on('change', renderLinks);

  $('#shareModal').on('panel:show', () => {
    // A stale armed button from the previous visit must not survive the
    // reopen — the confirm state belongs to this visit's list only.
    disarmCancel();
    renderShareState();
    renderExpiryPreview();
    void refreshShares();
  });

  $('#shareLinksPanel').on('panel:show', () => {
    disarmCancel();
    renderLinks();
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

// ---- the note being shared ---------------------------------------------------

function activeNote(): {
  id: string;
  title: string;
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
  // The note's TRUE content: html notes read the live editor, every other
  // kind reads the model (its editor shows a placeholder card).
  const captured = getActiveNoteContent();
  const content = captured?.content ?? '';
  const noteType = captured?.noteType ?? null;

  // The link names what will actually be shared. A freshly typed first
  // line has not reached the saved model yet — the title derives from the
  // LIVE capture, not the stale one, or the link carries "Untitled" over
  // a note that visibly has words.
  const liveTitle = active.name?.trim() ? title : deriveTabTitle({ ...active, content });

  return {
    id: active.id,
    title: liveTitle,
    content,
    noteType,
    empty: noteContentIsEmpty(content, noteType),
  };
}

/** The active link that belongs to the note in the editor, if any. */
function activeShareRecord(): ShareRecord | null {
  const note = activeNote();
  if (!note) {
    return null;
  }
  return (
    shares.find(
      (record) => record.note_id === note.id && !record.revoked && isLinkActive(record),
    ) ?? null
  );
}

function isLinkActive(record: ShareRecord): boolean {
  return !record.revoked && new Date(record.expires_at).getTime() > Date.now();
}

/**
 * The signed-in pane's whole state, from two facts: does the note have an
 * active link, and does the note have words. Link + words → the card shows
 * and the button says Update. No link + words → the button says Create.
 * No words → the button goes dark and one quiet line says why — the note
 * strip is gone; the refusal is the only thing left to say.
 */
function renderShareState(): void {
  const note = activeNote();
  const record = activeShareRecord();

  const $card = $('#shareActiveCard');
  if (record) {
    $('#shareActiveUrl').text(shortUrl(record.token));
    $('#shareActiveMeta').text(`${relativeExpiry(record)} · ${createdAgo(record)}`);
    $('#shareActiveCancel').attr('data-token', record.token);
    $card.removeAttr('hidden');
  } else {
    $card.attr('hidden', 'hidden');
  }

  // The button's label follows the state; the busy variant tracks it too.
  $('.share-create-label').text(record ? 'Update link' : 'Create link');

  // An empty note cannot be shared (or updated — a link to nothing stays
  // live with its old words, but there is nothing new to refresh toward).
  const shareable = !!note && !note.empty;
  $('#shareCreateBtn').prop('disabled', !shareable);
  $('#shareCreateBtn').removeAttr('title');
  $('#shareEmptyLine').attr('hidden', shareable ? 'hidden' : null);
}

/**
 * The create button's busy state. Re-enabling must respect the empty-note
 * refusal: the links refresh runs AFTER renderShareState disabled the
 * button, and a blind `disabled = false` used to resurrect it mid-panel
 * for a note with nothing to share.
 */
function renderLinksBusy(busy: boolean): void {
  const record = activeShareRecord();
  $('.share-create-label').text(
    busy ? (record ? 'Updating…' : 'Creating…') : record ? 'Update link' : 'Create link',
  );
  if (busy) {
    $('#shareCreateBtn').prop('disabled', true);
    return;
  }
  const note = activeNote();
  const shareable = !!note && !note.empty;
  $('#shareCreateBtn').prop('disabled', !shareable);
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
  renderShareState();
  renderLinks();
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
  // The popup has room for the whole typical link; the cap only tames
  // pathological hosts. The row's own ellipsis handles the rest.
  if (url.length <= 64) {
    return url;
  }
  return `${url.slice(0, 60)}…`;
}

/**
 * The popup's rows — ACTIVE links only. A cancelled or expired link is
 * not a dimmed memory here; it is gone. The scope narrows the list to
 * this note or spans the account (rows say which note they point at
 * when the list does).
 */
function renderLinks(): void {
  const $list = $('#shareLinksList');
  const note = activeNote();
  const showAll = $('#shareScopeAll').is(':checked');

  const visible = shares
    .filter((record) => isLinkActive(record))
    .filter((record) => (showAll ? true : note ? record.note_id === note.id : true))
    .sort((a, b) => b.created_at - a.created_at);

  renderCount(visible.length);

  // No change, no churn: the list re-renders on every panel:show AND on
  // every refresh — and the open path fires both within milliseconds.
  // A rebuild that lands while a cancel button is armed would replace
  // the armed button with a quiet clone mid-gesture (the confirm state
  // IS the button; a clone is a disarm the user never asked for). When
  // the data behind the rows has not moved, keep the DOM — and the
  // armed state — exactly as it is.
  const signature = JSON.stringify([
    showAll,
    visible.map((record) => [record.token, record.revoked, record.expires_at, record.title]),
  ]);
  if (signature === lastLinksSignature) {
    return;
  }
  lastLinksSignature = signature;

  $list.empty();
  disarmCancel();

  if (visible.length === 0) {
    const message = showAll
      ? 'No active links. Create one from any note — anyone with it sees a read-only copy.'
      : 'No active link for this note. Create one in the Share panel.';
    $list.append($('<p class="share-links-empty"></p>').text(message));
    return;
  }

  visible.forEach((record) => {
    const row = $('<div class="share-link-row"></div>');

    const top = $('<div class="share-link-top"></div>');
    top.append($('<span class="share-link-url"></span>').text(shortUrl(record.token)));
    top.append('<span class="share-badge active">Active</span>');

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
      void copyLinkText(shareUrlFor(record.token), 'Link copied to clipboard.');
    });
    actions.append(copy);

    const cancel = $('<button type="button" class="share-chip-btn danger"></button>').text(
      'Cancel link',
    );
    cancel.attr('data-token', record.token);
    cancel.on('click', (event) => {
      onCancelClick(record, event.currentTarget as HTMLElement);
    });
    actions.append(cancel);

    row.append(top);
    row.append(meta);
    row.append(actions);
    $list.append(row);
  });
}

/**
 * The two count chips: the share panel's "All links" row counts every
 * active link the account owns (the row opens the whole list), the popup
 * head counts what the list actually shows (the scope may narrow it).
 * Quiet at zero, honest otherwise.
 */
function renderCount(visibleCount: number): void {
  const activeTotal = shares.filter((record) => isLinkActive(record)).length;
  const $total = $('#shareLinkCount');
  const $popup = $('#sharePopupCount');
  if (activeTotal === 0) {
    $total.attr('hidden', 'hidden');
  } else {
    $total.text(String(activeTotal)).removeAttr('hidden');
  }
  if (visibleCount === 0) {
    $popup.attr('hidden', 'hidden');
    return;
  }
  $popup.text(String(visibleCount)).removeAttr('hidden');
}

// ---- the two-step cancel -------------------------------------------------------

/**
 * The confirm state IS the button: the first click arms it (the label
 * asks the question), the second commits. Auto-disarms after a few
 * seconds; a click anywhere else disarms it; only one button is armed
 * at a time. The twin of the History sheet's armed deletes.
 *
 * The button that arms is the button that was CLICKED — the same token
 * can be rendered twice (the share panel's card and the popup's row),
 * and a document-wide lookup would arm the hidden copy while the user
 * watches the visible one stay quiet.
 */
function onCancelClick(record: ShareRecord, clicked?: HTMLElement): void {
  const button = clicked?.classList.contains('danger') ? clicked : undefined;
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

  // Flag the record the CURRENT array holds — the closure's object may be
  // from an earlier fetch (the popup refreshes on open, replacing every
  // record object while the signature guard keeps the rendered rows, so
  // the row's handler can legitimately hold yesterday's object). Mutating
  // the stale twin would flip nothing the render reads.
  const current = shares.find((entry) => entry.token === record.token);
  if (current) {
    current.revoked = true;
  }
  showToast('Link cancelled — it no longer works for anyone.');
  // The active-only surfaces drop the row everywhere: the card collapses
  // (the button says Create again), the popup list loses the row.
  renderShareState();
  renderLinks();
}

// ---- actions -----------------------------------------------------------------

/**
 * The one primary action, deduped: a note without an active link creates
 * one; a note with one updates the link it already has (the freshly
 * picked window replaces the old expiry — the URL never changes, so a
 * link already in someone's hands keeps working, now for longer).
 */
async function createOrUpdate(): Promise<void> {
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

  const existing = activeShareRecord();

  if (existing) {
    renderLinksBusy(true);
    const result = await updateShareExpiry(existing.token, selectedDays());
    renderLinksBusy(false);

    if (!result.ok) {
      showToast(result.message ?? 'Could not update the link.');
      // The list may have gone stale (the link was cancelled elsewhere).
      await refreshShares();
      return;
    }

    if (typeof result.expiresAt === 'number') {
      existing.expires_at = result.expiresAt;
      showToast(`Link updated — it now works until ${formatDate(existing.expires_at)}.`);
      renderShareState();
      renderLinks();
    } else {
      // An older server answered ok without the row — refetch so the
      // card's countdown tells the truth.
      showToast('Link updated.');
      await refreshShares();
    }
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
  // (the card offers Copy for later use).
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
    showToast(ok ? message : 'Link created — copy it from the card above.');
  }
}
