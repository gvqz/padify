/**
 * Padify share links — user interface.
 *
 * The share panel is the ACT of sharing one note, built around the
 * link itself. A note keeps ONE active link: with a link already out,
 * the panel shows it as a FIELD — the URL, selectable, with a copy
 * button that flips to a check — and the primary button refreshes its
 * expiry instead of minting a twin (duplication is not a thing the
 * user can do by accident, and the server refuses it even when a
 * stale client tries). Open previews the page a reader sees; Share
 * via… hands the URL to the OS share sheet when the browser has one;
 * cancelling a link arms its own button (the confirm state IS the
 * button), the same two-step contract the History sheet's deletes
 * follow. The INVENTORY lives in Settings → Cloud sync: the "Shared
 * links" card lists every ACTIVE link across the account, newest
 * first. Signed-out visitors get a sign-in gate — sharing is a
 * cloud-account feature.
 *
 * Nothing here opens a second dialog.
 */

import { $ } from '../lib/q';
import { closePanel, openPanel } from '../ui/behavior/panel';
import { showToast } from '../ui/toast';
import { deriveTabTitle, getActiveNoteContent, getTabManager } from '../tabs';
import {
  NOTE_TYPE_ICONS,
  noteTypeLabel,
  type KnownNoteType,
  type NoteType,
} from '../editor/note-types';
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
/** How long the field's copy button shows its green check. */
const COPY_FEEDBACK_MS = 1_600;
/** The panel-to-modal handoff — matches the modal's own transition. */
const PANEL_SWAP_MS = 200;

let shares: ShareRecord[] = [];

/**
 * What the links list was last built from (the visible records'
 * identity — token, revoked, expiry, title). A render whose signature
 * matches keeps the DOM untouched, so a rebuild racing a just-armed
 * cancel button can never clone over the confirm state.
 */
let lastLinksSignature: string | null = null;

/** The two-step cancel: the armed row's token, and its auto-disarm timer. */
let armedToken: string | null = null;
let armedTimer: number | null = null;

/** The copy button's check-mark reset timer (one flash at a time). */
let copyResetTimer: number | null = null;

const shareRoot = () => $('#shareModal').get(0);
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

  $('#shareCreateBtn').on('click', () => {
    void createOrUpdate();
  });

  $('#shareActiveCopy').on('click', () => {
    const record = activeShareRecord();
    if (record) {
      void copyLinkText(shareUrlFor(record.token), 'Link copied to clipboard.').then((copied) => {
        if (copied) {
          flashCopied();
        }
      });
    }
  });

  // See it the way a reader will: the viewer page, in a new tab.
  $('#shareActiveOpen').on('click', () => {
    const record = activeShareRecord();
    if (record) {
      window.open(shareUrlFor(record.token), '_blank', 'noopener');
    }
  });

  // The OS share sheet, when the platform has one — the natural end of
  // a share menu. Hidden by default; revealed here only when the API
  // exists, so desktop Firefox never shows a dead button.
  if (typeof navigator.share === 'function') {
    $('#shareActiveNative').removeAttr('hidden');
  }
  $('#shareActiveNative').on('click', () => {
    void nativeShare();
  });

  // The expiry hint follows the picked window immediately — the date
  // updates while the segments move, before any button is pressed.
  $('input[name="shareDuration"]').on('change', renderDurHint);

  $('#shareActiveCancel').on('click', (event) => {
    const record = activeShareRecord();
    if (record) {
      onCancelClick(record, event.currentTarget as HTMLElement);
    }
  });

  $('#shareModal').on('panel:show', () => {
    // A stale armed button or a stale green check from the previous
    // visit must not survive the reopen — the confirm state belongs to
    // this visit's list only.
    disarmCancel();
    resetCopyFlash();
    renderShareState();
    void refreshShares();
  });

  // The settings card: the list refreshes whenever Settings opens —
  // and re-renders from the cache instantly, before the fetch lands.
  $('#preferencesModal').on('show.bs.modal', () => {
    disarmCancel();
    resetCopyFlash();
    renderPanes();
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
  // The settings card is inventory — it only means something once the
  // user can own links.
  $('#shareLinksCard').attr('hidden', signedIn ? null : 'hidden');
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
 * active link, and does the note have words. Link + words → the field
 * shows and the button says Update. No link + words → the button says
 * Create. No words → the button goes dark and one quiet line says why.
 * Either way the note strip names the subject and the expiry hint names
 * the date the current pick produces.
 */
function renderShareState(): void {
  const note = activeNote();
  const record = activeShareRecord();

  renderNoteStrip(note);

  const $card = $('#shareActiveCard');
  if (record) {
    // The field shows the link itself — the whole URL, selectable, with
    // the full text on the title for the clamped tail. Copy carries it
    // verbatim; seeing it is trusting it.
    const url = shareUrlFor(record.token);
    $('#shareActiveUrl').text(url).attr('title', url);
    $('#shareActiveMeta').text(`${relativeExpiry(record)} · ${createdAgo(record)}`);
    $('#shareActiveCancel').attr('data-token', record.token);
    $card.removeAttr('hidden');
  } else {
    $card.attr('hidden', 'hidden');
  }

  // The button's label follows the state; the busy variant tracks it too.
  // "Update expiration" — the URL never changes, only the window does;
  // naming the movement keeps the one-link promise legible.
  $('.share-create-label').text(record ? 'Update expiration' : 'Create link');

  // An empty note cannot be shared (or updated — a link to nothing stays
  // live with its old words, but there is nothing new to refresh toward).
  const shareable = !!note && !note.empty;
  $('#shareCreateBtn').prop('disabled', !shareable);
  $('#shareCreateBtn').removeAttr('title');
  $('#shareEmptyLine').attr('hidden', shareable ? 'hidden' : null);

  // The hint's wording depends on the create/update split, so it
  // re-renders with the state as well as with the pick itself.
  renderDurHint();
}

/**
 * The note strip: the type glyph (the registry the rail badges draw
 * from) plus the note's live title. This is WHAT the panel shares —
 * it renders on every state pass so a tab switch while open re-names
 * the subject instead of lying about it.
 */
function renderNoteStrip(note: ReturnType<typeof activeNote>): void {
  const $glyph = $('#shareNoteGlyph');
  if (!note) {
    $('#shareNoteName').text('No note open');
    $glyph.empty().removeAttr('title');
    return;
  }

  $('#shareNoteName').text(note.title || 'Untitled');
  const typeId = (note.noteType ?? 'standard') as KnownNoteType;
  const icon = NOTE_TYPE_ICONS[typeId];
  if (icon) {
    $glyph.html(icon(13)).attr('title', noteTypeLabel(typeId));
  } else {
    // A type this build does not know yet still names itself — the
    // registry's plain-text mark, exactly like the rail's badge.
    $glyph
      .html(
        `<span class="share-note-glyph-fallback">${noteTypeLabel(typeId).charAt(0).toLowerCase()}</span>`,
      )
      .attr('title', noteTypeLabel(typeId));
  }
}

/**
 * The expiry pick, translated into a date: the one thing a duration
 * number never says. With a link out, the same pick EXTENDS that
 * link — the hint says so and keeps the URL constancy front and
 * center; without one, it previews the window a create would open.
 */
function renderDurHint(): void {
  const until = formatDate(Date.now() + selectedDays() * DAY_MS);
  const record = activeShareRecord();
  $('#shareDurHint').text(
    record ? `Same URL — this link now works until ${until}` : `Readers keep access until ${until}`,
  );
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
    busy ? (record ? 'Updating…' : 'Creating…') : record ? 'Update expiration' : 'Create link',
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
  // The card no longer prints the URL (Copy carries it), so this only
  // feeds the settings card's rows — enough to recognise a link, not a
  // wall of monospace. The row's own ellipsis handles the rest.
  if (url.length <= 48) {
    return url;
  }
  return `${url.slice(0, 46)}…`;
}

/**
 * The settings card's rows — ACTIVE links only, newest first, the whole
 * account. A cancelled or expired link is not a dimmed memory here; it
 * is gone. Rows say which note they point at — the list is exactly the
 * account's inventory, not one note's view of it.
 */
function renderLinks(): void {
  const $list = $('#shareLinksList');

  const visible = shares
    .filter((record) => isLinkActive(record))
    .sort((a, b) => b.created_at - a.created_at);

  renderCount(visible.length);

  // No change, no churn: the list re-renders when Settings opens AND on
  // every refresh — the open path fires both within milliseconds.
  // A rebuild that lands while a cancel button is armed would replace
  // the armed button with a quiet clone mid-gesture (the confirm state
  // IS the button; a clone is a disarm the user never asked for). When
  // the data behind the rows has not moved, keep the DOM — and the
  // armed state — exactly as it is.
  const signature = JSON.stringify(
    visible.map((record) => [record.token, record.revoked, record.expires_at, record.title]),
  );
  if (signature === lastLinksSignature) {
    return;
  }
  lastLinksSignature = signature;

  $list.empty();
  disarmCancel();

  if (visible.length === 0) {
    $list.append(
      $('<p class="share-links-empty"></p>').text('No active links. Create one from any note.'),
    );
    return;
  }

  visible.forEach((record) => {
    const row = $('<div class="share-link-row"></div>');

    const top = $('<div class="share-link-top"></div>');
    top.append($('<span class="share-link-url"></span>').text(shortUrl(record.token)));
    top.append('<span class="share-badge active">Active</span>');

    const meta = $('<div class="share-link-meta"></div>');
    const title = record.title && record.title.trim() ? record.title : 'Untitled';
    const parts = [relativeExpiry(record), createdAgo(record), `\u201C${title}\u201D`];
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
 * The settings card's count chip: the number of ACTIVE links the
 * account owns. Quiet at zero, honest otherwise.
 */
function renderCount(visibleCount: number): void {
  const $total = $('#shareLinkCount');
  if (visibleCount === 0) {
    $total.attr('hidden', 'hidden');
    return;
  }
  $total.text(String(visibleCount)).removeAttr('hidden');
}

// ---- the two-step cancel -------------------------------------------------------

/**
 * The confirm state IS the button: the first click arms it (the label
 * asks the question), the second commits. Auto-disarms after a few
 * seconds; a click anywhere else disarms it; only one button is armed
 * at a time. The twin of the History sheet's armed deletes.
 *
 * The button that arms is the button that was CLICKED — the same token
 * can be rendered twice (the share panel's card and the settings row),
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
  // from an earlier fetch (the settings list refreshes on open, replacing every
  // record object while the signature guard keeps the rendered rows, so
  // the row's handler can legitimately hold yesterday's object). Mutating
  // the stale twin would flip nothing the render reads.
  const current = shares.find((entry) => entry.token === record.token);
  if (current) {
    current.revoked = true;
  }
  showToast('Link cancelled — it no longer works for anyone.');
  // The active-only surfaces drop the row everywhere: the card collapses
  // (the button says Create again), the settings list loses the row.
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
      // A server without the expiry branch answered ok without the row —
      // and the legacy handler it ran may have REVOKED the link instead
      // of updating it. Refetch and tell the truth about what is out
      // there now; "Link updated." over a vanished link is a lie.
      await refreshShares();
      const stillOut = shares.some(
        (record) => record.token === existing.token && isLinkActive(record),
      );
      showToast(
        stillOut
          ? 'Link updated.'
          : 'The server could not update this link — create it again from this panel.',
      );
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
  // (the card offers Copy for later use). The server can answer with
  // the note's EXISTING link (the one-active-link backstop) — then the
  // honest toast says so, nothing was minted.
  if (result.token) {
    void copyLinkText(
      shareUrlFor(result.token),
      result.existed
        ? 'This note already has an active link — copied it.'
        : 'Link created and copied.',
    ).then((copied) => {
      // The field's own receipt — same gesture, same flash a manual
      // copy gets, so the card answers the moment it appears.
      if (copied) {
        flashCopied();
      }
    });
  } else {
    showToast(result.existed ? 'This note already has an active link.' : 'Link created.');
  }
  await refreshShares();
}

/**
 * Writes a URL to the clipboard and reports the outcome as a toast.
 * Returns whether the copy actually landed, so a caller that shows its
 * own receipt (the field's green check) can stay honest — a failed
 * copy never flashes success.
 */
async function copyLinkText(url: string, message: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    showToast(message);
    return true;
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
    showToast(ok ? message : 'Could not copy — select the link text and copy by hand.');
    return ok;
  }
}

// ---- the field's copy receipt -------------------------------------------------

/** The copy button's receipt: a green check for a beat, then back to idle. */
function flashCopied(): void {
  const button = $('#shareActiveCopy').get(0) as HTMLElement | undefined;
  if (!button) {
    return;
  }
  button.classList.add('is-copied');
  if (copyResetTimer !== null) {
    window.clearTimeout(copyResetTimer);
  }
  copyResetTimer = window.setTimeout(() => {
    copyResetTimer = null;
    button.classList.remove('is-copied');
  }, COPY_FEEDBACK_MS);
}

/** Clears any standing flash — a fresh surface never opens mid-check. */
function resetCopyFlash(): void {
  if (copyResetTimer !== null) {
    window.clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
  ($('#shareActiveCopy').get(0) as HTMLElement | undefined)?.classList.remove('is-copied');
}

// ---- the OS share sheet ---------------------------------------------------------

/**
 * Hands the link to the platform's share sheet — the natural end of a
 * share menu on phones. A dismissed sheet is silence, not an error;
 * any other failure falls back to the clipboard, which always works.
 */
async function nativeShare(): Promise<void> {
  const record = activeShareRecord();
  if (!record) {
    return;
  }
  const url = shareUrlFor(record.token);
  const note = activeNote();
  try {
    await navigator.share({ title: note?.title || 'A shared note', url });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return; // the user closed the sheet — nothing to say
    }
    await copyLinkText(url, 'Sharing unavailable — the link was copied instead.');
  }
}
