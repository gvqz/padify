/**
 * The note domain record — S2's first extraction from the TabManager.
 *
 * The model's core TYPE gets a home of its own so the modules that only
 * need "what a note is" (the strip view, the trash store, the features
 * reading `allTabs`) stop importing the manager itself — the review's
 * "every feature must reach through it" problem starts right there. The
 * manager (tabs.ts) remains the composition root and re-exports this type
 * for its existing importers; new code imports it here.
 *
 * Everything in this module is pure: no DOM, no storage, no sync — the
 * record, the stamps' discipline, and the two picks that keep sync state
 * out of the domain half (the ledger owns it; see sync/ledger.ts).
 */

import { DEFAULT_NOTE_TYPE, type NoteType } from '../editor/note-types';
import type { StoredNoteTab, TrashedNote } from '../storage';

/** One note — see the manager's NoteTab docs (re-exported from here). */
export interface NoteTab {
  id: string;
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  /**
   * The note's content, in the format its type owns (see
   * editor/note-types.ts — contentKindFor). For the classic types that is
   * the sanitized HTML subset; for every other type it is that type's
   * format — Markdown source, JSON, an unknown build's bytes — verbatim,
   * and the sanitizer never touches it.
   */
  content: string;
  createdAt: number;
  updatedAt: number;
  /** The note kind — absent means the default (standard). */
  noteType?: NoteType;
  /** The theme the note's inline colors were last written under — rich
   *  text notes only (editor/theme-colors.ts). */
  colorTheme?: 'light' | 'dark';
  /** Conflicted-copy lineage (LEGACY — pre-review builds minted twin notes
   *  and marked them; nothing writes it anymore, values ride unread). */
  copyOf?: string;
}

export function createTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The next edit timestamp for a tab: strictly greater than the current
 * one, even when two changes land inside the same millisecond (double
 * restores, programmatic edits, automation). The storage diff and the
 * cloud merge both treat `updatedAt` as the change signal — a same-ms
 * second change would otherwise read as "nothing changed" and never
 * persist.
 */
export function nextUpdatedAt(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

export function createTab(
  content: string = '',
  name: string | null = null,
  noteType: NoteType = DEFAULT_NOTE_TYPE,
): NoteTab {
  const now = Date.now();
  const tab: NoteTab = { id: createTabId(), name, content, createdAt: now, updatedAt: now };
  if (noteType !== DEFAULT_NOTE_TYPE) {
    tab.noteType = noteType;
  }
  return tab;
}

/**
 * The domain half of a stored row — the pick that keeps the model honest:
 * a field only enters the model by being named here, so sync state can
 * never silently ride a domain object again. Verbatim values (the merge
 * already normalized what needed normalizing); html content was sanitized
 * by the caller before this runs.
 */
export function domainTabOf(row: StoredNoteTab): NoteTab {
  const tab: NoteTab = {
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.noteType !== undefined) {
    tab.noteType = row.noteType;
  }
  if (row.colorTheme !== undefined) {
    tab.colorTheme = row.colorTheme;
  }
  if (row.copyOf !== undefined) {
    tab.copyOf = row.copyOf;
  }
  return tab;
}

/**
 * The domain half of a grave: the tab pick plus the trash stamps. The
 * grave's sync state stays in the ledger (same id); nothing to copy.
 */
export function domainGraveOf(grave: TrashedNote): TrashedNote {
  const out: TrashedNote = {
    ...domainTabOf(grave),
    deletedAt: grave.deletedAt,
  };
  if (grave.purged) {
    out.purged = true;
  }
  return out;
}
