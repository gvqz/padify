/**
 * Version review — the conflict sheet.
 *
 * When a note changed on two devices at once and the three-way merge could
 * not reconcile the overlap, cloud/sync.ts parks the losing words on the
 * note itself (NoteTab.conflict) and badges it in the strip. This module
 * is the sheet that resolves it:
 *
 *  • THE VIEW is one document in tracked-changes style — the note's
 *    current (winning) version with the other side's words marked — not a
 *    two-column code diff. Prose reads as prose; the review asks one
 *    question ("which words survive?"), and marked-up text answers it at
 *    a glance.
 *  • THE MARKS are word-level (the same token diff the merge runs):
 *    struck-through for this device's parked words that the current
 *    version does not carry, underlined for the other device's words this
 *    device never had. Formatting-only differences (tags that moved with
 *    no text change) get a note instead of markup soup.
 *  • THE RESOLUTIONS are three, one click each, no stacked dialog:
 *    restore my version (re-apply the parked words, re-push), keep the
 *    current version (clear the record — nothing moves), or keep both
 *    (restore mine AND keep theirs as an explicit copy, the old
 *    "conflicted copy" behavior as a decision instead of an accident).
 */

import { closeModal, openModal } from './ui/behavior/modal';
import { getTabManager, type NoteConflict } from './tabs';
import { escapeHtml } from './editor/note-content';
import { contentKindFor, type NoteType } from './editor/note-types';
import { diffSequences } from './merge/myers';
import { tokenizeHtml, tokenizeText } from './merge/tokens';
import { sanitizeNoteHtml } from './editor/storage-subset';

/** The note under review — cleared when the sheet closes. */
let reviewingTabId: string | null = null;

// ---------------------------------------------------------------------------
// The tracked-changes rendering
// ---------------------------------------------------------------------------

/** Word-diffs mine against theirs, rendering ONE marked-up document.
 *  Exported for the sheet's tests — pure markup from a record. */
export function renderTrackedDiff(conflict: NoteConflict, noteType?: NoteType): string {
  const kind = contentKindFor(noteType);
  const tokenize = kind === 'html' ? tokenizeHtml : tokenizeText;

  // The view reads as "the current version, with my lost words marked":
  // diff mine→theirs and walk the ops over THEIRS, marking mine-only
  // words as struck-through and theirs-only words as underlined.
  const mine = sanitizeForPreview(conflict.mine.content, kind);
  const theirs = sanitizeForPreview(conflict.theirs.content, kind);
  const mineTokens = tokenize(mine);
  const theirTokens = tokenize(theirs);
  const ops = diffSequences(mineTokens, theirTokens, (a, b) => a.value === b.value);

  if (ops === null) {
    // Too far apart to diff — the two-paragraph summary instead of a wall.
    return (
      previewParagraph('Your version', mine, kind) +
      previewParagraph('The current version', theirs, kind)
    );
  }

  let sawDelete = false;
  let sawInsert = false;
  let sawTagChange = false;
  let html = '';

  for (const op of ops) {
    if (op.op === 'equal') {
      html += op.items
        .map((token) => (token.kind === 'tag' ? '' : escapeHtml(token.value)))
        .join('');
    } else if (op.op === 'delete') {
      // In mine, not in theirs — the parked words the current version lost.
      sawDelete = true;
      const text = op.items
        .filter((token) => token.kind !== 'tag')
        .map((token) => token.value)
        .join('');
      if (text.trim()) {
        html += `<del class="conflict-del">${escapeHtml(text)}</del>`;
      } else {
        sawTagChange = true;
      }
    } else {
      // In theirs, not in mine — the words this device never had.
      sawInsert = true;
      const text = op.items
        .filter((token) => token.kind !== 'tag')
        .map((token) => token.value)
        .join('');
      if (text.trim()) {
        html += `<ins class="conflict-ins">${escapeHtml(text)}</ins>`;
      } else {
        sawTagChange = true;
      }
    }
  }

  const notes: string[] = [];
  if (!sawDelete && !sawInsert) {
    notes.push('The two versions carry the same words — only the formatting differs.');
  } else if (sawTagChange) {
    notes.push('Formatting also differs between the versions.');
  }
  if (conflict.mine.name !== conflict.theirs.name) {
    notes.push(
      `The name differs too: “${conflict.mine.name ?? 'untitled'}” here, “${conflict.theirs.name ?? 'untitled'}” there.`,
    );
  }

  const body = html.trim() || '<span class="conflict-empty">(no text)</span>';
  return (
    `<p class="conflict-text">${body}</p>` +
    notes.map((note) => `<p class="conflict-note">${escapeHtml(note)}</p>`).join('')
  );
}

/** Html notes preview through the sanitizer; text kinds pass verbatim. */
function sanitizeForPreview(content: string, kind: string): string {
  return kind === 'html' ? sanitizeNoteHtml(content) : content;
}

/** The fallback for undiffable versions: both sides, labeled. */
function previewParagraph(label: string, content: string, kind: string): string {
  const text = kind === 'html' ? stripTags(content) : content;
  return `<p class="conflict-note">${escapeHtml(label)}</p><p class="conflict-text">${escapeHtml(
    text.slice(0, 2000),
  )}</p>`;
}

function stripTags(content: string): string {
  const scratch = document.createElement('div');
  scratch.innerHTML = content;
  return scratch.textContent ?? '';
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function renderConflictSheet(tabId: string): void {
  const manager = getTabManager();
  const diffHost = document.getElementById('conflictDiff');
  const meta = document.getElementById('conflictMeta');
  const subtitle = document.getElementById('conflictSubtitle');
  if (!manager || !diffHost || !meta || !subtitle) {
    return;
  }
  const tab = manager.getConflictedNote(tabId);
  if (!tab || !tab.conflict) {
    return;
  }
  reviewingTabId = tabId;

  const when = new Date(tab.conflict.theirs.updatedAt || tab.conflict.detectedAt);
  subtitle.textContent = 'It changed on another device while this one had unsynced edits.';
  meta.textContent = `Their edit landed ${when.toLocaleString()}.`;
  diffHost.innerHTML = renderTrackedDiff(tab.conflict, tab.noteType);
}

/** Opens the sheet for a note (the strip badge and the note menu's path). */
export function openConflictReview(tabId: string): void {
  const manager = getTabManager();
  if (!manager || !manager.getConflictedNote(tabId)) {
    return;
  }
  openModal(document.getElementById('conflictModal'));
  renderConflictSheet(tabId);
}

export function initConflictReview(): void {
  // The manager's hook — the strip's delegated badge click lands here.
  // Wired from app.ts (the manager exists by then); safe to call twice.
  const manager = getTabManager();
  if (manager) {
    manager.onConflictReview = openConflictReview;
  }

  // One delegated listener for all three resolutions.
  document.getElementById('conflictModal')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-conflict-resolution]');
    if (!button || !reviewingTabId) {
      return;
    }
    const currentManager = getTabManager();
    const resolution = button.dataset.conflictResolution as 'mine' | 'theirs' | 'both';
    if (currentManager?.resolveConflict(reviewingTabId, resolution)) {
      reviewingTabId = null;
      closeModal(document.getElementById('conflictModal'));
    }
  });
}
