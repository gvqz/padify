/**
 * Trash — the Recently Deleted sheet.
 *
 * The trash itself is MODEL state (TabManager.trashed, synced as deleted
 * rows with kept content — see tabs.ts); this module is only the sheet:
 * the rail button, the day-anchored timeline, Restore, Delete forever and
 * Empty trash. Every row reuses the History sheet's snap-* vocabulary so
 * the two right-side sheets read as siblings.
 *
 * The structural contract:
 *
 *  • RENDER — a fresh read on every open and after every action; the rows
 *    carry no listeners of their own (one delegated pair on the list root
 *    covers every row a render can produce).
 *  • VISIBILITY — entries with neither words nor a name (an empty note
 *    trashed, a pre-trash tombstone migrated) are hidden: they have nothing
 *    to restore and nothing to show, and Delete-forever chores for them
 *    would be exactly the clutter the trash exists to remove.
 *  • RESTORE — one click, no dialog: the note returns to the END of the
 *    strip under its own id (share links survive) and the sheet stays
 *    open — closing is the user's move.
 *  • DELETES — one row or all: a two-step INLINE confirm (arm, then
 *    confirm) on the button itself; nothing stacks a dialog over the
 *    sheet.
 *  • THE CLOCK — every row shows how long it still waits ("27 days"),
 *    tinted for the last three; after TRASH_RETENTION_MS the boot sweeps
 *    retire the entry everywhere and no dialog is ever involved.
 */

import { openModal } from './ui/behavior/modal';
import { getTabManager } from './tabs';
import { deriveTabTitle, escapeHtml, htmlToText, type TitledNote } from './editor/note-content';
import { normalizeNoteType } from './editor/note-types';
import { TRASH_RETENTION_MS } from '../shared/wire';
import type { TrashedNote } from './storage';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A trash row worth showing: words or a name. Tombstone-shaped entries
 *  (migrated pre-trash deletes with no content) are invisible. */
function isRestorable(grave: TrashedNote): boolean {
  return !!(grave.name && grave.name.trim()) || htmlToText(grave.content).trim() !== '';
}

function asTitled(grave: TrashedNote): TitledNote {
  return {
    name: grave.name,
    content: grave.content,
    noteType: normalizeNoteType(grave.noteType),
  };
}

function trashTitle(grave: TrashedNote): string {
  return deriveTabTitle(asTitled(grave));
}

function trashPreview(grave: TrashedNote): string {
  const text = htmlToText(grave.content).trim();
  if (!text) {
    return '';
  }
  // The title derives from the note's first line (unless the note was
  // explicitly named) — a preview that echoed that same line read as
  // duplication, so the preview starts past it. Named notes keep their
  // whole text: the name is not the body's first line. A single-line
  // note yields no preview at all — the title line already says it,
  // the same once-only rule the History sheet's rows follow.
  const named = !!(grave.name && grave.name.trim());
  let body = text;
  if (!named) {
    const firstBreak = text.indexOf('\n');
    body = firstBreak === -1 ? '' : text.slice(firstBreak + 1).trim();
  }
  // Truncate on a word boundary with an explicit ellipsis — a hard
  // slice feeding the CSS ellipsis read as a mid-word cut.
  const flat = body.replace(/\s+/g, ' ');
  const shown = flat.length > 120 ? `${flat.slice(0, 119).replace(/\s+\S*$/, '')}…` : flat;
  return escapeHtml(shown);
}

function dayKey(timestamp: number, now: number = Date.now()): string {
  const startOfDay = (ts: number): number => ts - (ts % DAY_MS);
  const days = Math.floor((startOfDay(now) - startOfDay(timestamp)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "27 days" / "3 days" — the retention countdown, tinted near the end. */
function retentionChip(deletedAt: number, now: number = Date.now()): string {
  const daysLeft = Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / DAY_MS));
  const last = daysLeft <= 3 ? ' is-last-days' : '';
  if (daysLeft <= 0) {
    return '<span class="trash-chip is-last-days">last day</span>';
  }
  const unit = daysLeft === 1 ? 'day' : 'days';
  return `<span class="trash-chip${last}">${daysLeft} ${unit}</span>`;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One row of the timeline. No per-node listeners — the list delegates. */
function buildRow(grave: TrashedNote, now: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'snap-item trash-item';
  li.dataset.trashId = grave.id;
  const preview = trashPreview(grave);
  const title = escapeHtml(trashTitle(grave));
  // The EXACT skeleton the History sheet's rows use:
  // [when][rail][what] — three grid children, because .snap-row's grid
  // has three columns. A missing rail spacer parks the content in the
  // 20px rail column and the row collapses (name crushed to zero,
  // chips and actions spilling out unclipped).
  //
  // Inside .snap-what, two lines: the title line (name + retention
  // chip — the name takes every spare pixel) and the body line
  // (preview + the row's actions at its right end). The History sheet
  // keeps its actions in an expandable detail; the trash row has no
  // detail, so the actions live on the body line where they never
  // compete with the title for width.
  li.innerHTML = `
    <div class="snap-row" role="group" aria-label="${title}">
      <span class="snap-when">${clock(grave.deletedAt)}</span>
      <span class="snap-rail" aria-hidden="true"></span>
      <span class="snap-what">
        <span class="snap-line">
          <span class="snap-name">${title}</span>
          ${retentionChip(grave.deletedAt, now)}
        </span>
        <span class="trash-body">
          ${preview ? `<span class="snap-preview">${preview}</span>` : ''}
          <span class="trash-row-actions">
            <button type="button" class="snap-act ghost" data-trash-action="restore">Restore</button>
            <button type="button" class="trash-purge" data-trash-action="purge" title="Delete forever" aria-label="Delete ${title} forever">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </span>
        </span>
      </span>
    </div>`;
  return li;
}

/** The armed purge row — first click arms (the button turns "Delete
 *  forever?"), the second commits, a click elsewhere disarms. Auto-disarms
 *  after a few seconds. */
let armedPurgeId: string | null = null;
let armedPurgeTimer: ReturnType<typeof setTimeout> | null = null;

const PURGE_GLYPH =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function disarmPurge(): void {
  armedPurgeId = null;
  if (armedPurgeTimer) {
    clearTimeout(armedPurgeTimer);
    armedPurgeTimer = null;
  }
  document.querySelectorAll('.trash-purge.is-armed').forEach((node) => {
    const button = node as HTMLButtonElement;
    button.classList.remove('is-armed');
    button.title = 'Delete forever';
    button.innerHTML = PURGE_GLYPH;
  });
}

function armPurge(id: string, button: HTMLButtonElement): void {
  disarmPurge();
  armedPurgeId = id;
  button.classList.add('is-armed');
  button.textContent = 'Delete forever?';
  armedPurgeTimer = setTimeout(disarmPurge, 4000);
}

let emptyTrashArmed = false;
let emptyTrashTimer: ReturnType<typeof setTimeout> | null = null;

function disarmEmptyTrash(): void {
  emptyTrashArmed = false;
  if (emptyTrashTimer) {
    clearTimeout(emptyTrashTimer);
    emptyTrashTimer = null;
  }
  const button = document.getElementById('emptyTrashBtn') as HTMLButtonElement | null;
  if (button) {
    const label = button.querySelector('.snap-delete-all-label');
    if (label) {
      label.textContent = 'Empty trash';
    }
    button.classList.remove('is-armed');
  }
}

/** Renders the whole sheet from the model. Safe to call at any cadence. */
function renderTrashSheet(): void {
  const manager = getTabManager();
  const list = document.getElementById('trashList');
  const empty = document.getElementById('noTrashedNotes');
  const count = document.getElementById('trashCount');
  const emptyBtn = document.getElementById('emptyTrashBtn') as HTMLButtonElement | null;
  if (!manager || !list || !empty || !count || !emptyBtn) {
    return;
  }

  disarmPurge();
  disarmEmptyTrash();

  const now = Date.now();
  const all = manager.getTrashed();
  const graves = all.filter(isRestorable);

  list.textContent = '';
  empty.style.display = graves.length > 0 ? 'none' : 'flex';

  // Day runs — the same anchoring the History sheet uses (Today /
  // Yesterday / the date), newest day first because getTrashed sorts
  // newest-first already. The group-start/group-end trims ride along
  // for the same reason they exist on History: the rail's line breaks
  // at day boundaries instead of dangling past the last dot.
  let currentKey = '';
  let runRows: HTMLLIElement[] = [];
  const closeRun = (): void => {
    if (runRows.length === 0) {
      return;
    }
    runRows[0].classList.add('group-start');
    runRows[runRows.length - 1].classList.add('group-end');
    runRows = [];
  };
  for (const grave of graves) {
    const key = dayKey(grave.deletedAt, now);
    if (key !== currentKey) {
      closeRun();
      currentKey = key;
      const day = document.createElement('li');
      day.className = 'snap-day';
      day.textContent = key;
      list.appendChild(day);
    }
    const row = buildRow(grave, now);
    runRows.push(row);
    list.appendChild(row);
  }
  closeRun();

  count.textContent = graves.length === 1 ? '1 note' : `${graves.length} notes`;
  emptyBtn.disabled = graves.length === 0;
}

/** The toast, loaded lazily so this module stays import-light for tests. */
function showTrashToast(message: string): void {
  void import('./ui/toast')
    .then(({ showToast }) => {
      showToast(message);
    })
    .catch(() => {
      /* a lost toast is cosmetic */
    });
}

export function initTrash(): void {
  // The rail button opens the sheet — a fresh render every time, because
  // the model may have moved under a stale one.
  document.getElementById('tabRailTrash')?.addEventListener('click', () => {
    openModal(document.getElementById('trashModal'));
    renderTrashSheet();
  });

  // Delegated row actions: restore on the first click, purge on the
  // second (arm in between).
  document.getElementById('trashList')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-trash-action]');
    if (!action) {
      disarmPurge();
      return;
    }
    const manager = getTabManager();
    const row = action.closest<HTMLElement>('.trash-item');
    if (!manager || !row) {
      return;
    }
    const id = row.dataset.trashId ?? '';
    const kind = action.dataset.trashAction;

    if (kind === 'restore') {
      if (manager.restoreNote(id)) {
        const title = row.querySelector('.snap-name')?.textContent ?? 'The note';
        showTrashToast(`"${title}" is back in the notes list.`);
        renderTrashSheet();
      }
      return;
    }

    if (kind === 'purge') {
      if (armedPurgeId === id) {
        if (manager.purgeNote(id)) {
          disarmPurge();
          showTrashToast('Deleted for good.');
          renderTrashSheet();
        }
      } else {
        armPurge(id, action as HTMLButtonElement);
      }
    }
  });

  // Empty trash — the same two-step inline confirm, on the footer button.
  document.getElementById('emptyTrashBtn')?.addEventListener('click', () => {
    const manager = getTabManager();
    if (!manager) {
      return;
    }
    if (emptyTrashArmed) {
      const purged = manager.emptyTrash();
      disarmEmptyTrash();
      showTrashToast(
        purged === 1 ? 'Deleted 1 note for good.' : `Deleted ${purged} notes for good.`,
      );
      renderTrashSheet();
      return;
    }
    emptyTrashArmed = true;
    const button = document.getElementById('emptyTrashBtn');
    button?.classList.add('is-armed');
    const label = button?.querySelector('.snap-delete-all-label');
    if (label) {
      label.textContent = 'Really empty it?';
    }
    emptyTrashTimer = setTimeout(disarmEmptyTrash, 4000);
  });
}
