/**
 * The notes model — the note LIST as state, extracted from the TabManager
 * (S2, tranche two). Who is open, which one is active, in what order: the
 * answers live here and nowhere else. The manager (tabs.ts) remains the
 * composition root and orchestrates AROUND the model — persistence, the
 * editor, focus, the strip, the toasts — while every list mutation flows
 * through these methods, so the two invariants that used to be
 * re-implemented by hand at every mutation site (init's fallback block,
 * the merge's active repair, the close paths' neighbour pick, the
 * switch guard) hold by construction instead:
 *
 *   I1  the active id always names a note that is in the list. A mutation
 *       that invalidates it repairs it in the same breath: a remove picks
 *       the left neighbour (clamped to the new first), a replace-all
 *       falls to the surviving first row, an unknown setActive is refused.
 *   I2  after the first seed the list is never empty — closing the last
 *       note mints a fresh tab, and so does a merge that empties the
 *       world. The mint CONTENT is the caller's policy, passed per call:
 *       a blank page on boot and merge (the welcome prose left — fresh
 *       installs start on an empty note), an empty tab on close (the
 *       user just deleted their last note on purpose; the toast already
 *       says "a fresh tab is ready").
 *
 * The record itself (NoteTab) is a domain object and in-place field writes
 * on a record the model handed out are the domain's business, exactly as
 * they were before. What the model owns is the LIST and the ACTIVE
 * POINTER — plus the active-note event registry, whose TIMING stays the
 * manager's: listeners read surfaces, and a surface reflects the new note
 * only once the orchestrator painted it, so the manager fires the event
 * after the switch is done, not when the pointer moved.
 *
 * Pure by construction: no DOM, no storage writes, no sync, no editor.
 * The layering test pins this — see architecture.test.ts's notes-model
 * block.
 */

import { type NoteTab } from './domain';
import { isHtmlContent, normalizeNoteType } from '../editor/note-types';
import { sanitizeNoteHtml } from '../editor/storage-subset';
import type { StoredNoteTab } from '../storage';

/** What a list mutation reports back to its orchestrator — the facts the
 *  manager needs to decide what to repaint, persist and announce. */
export interface ListMutationOutcome {
  /** The note that left the list (remove only). */
  removed: NoteTab | null;
  /** The note the mint policy created because the list would have
   *  emptied — null when the list never got there. */
  minted: NoteTab | null;
  /** Whether the ACTIVE pointer moved — the repaint-and-announce signal. */
  activeChanged: boolean;
}

export class NotesModel {
  private tabs: NoteTab[] = [];
  private currentActiveId: string | null = null;
  private readonly activeListeners = new Set<(tab: NoteTab) => void>();

  /** @param mintFallback mints the tab that keeps invariant I2 — the
   *      boot and merge paths' blank page. Close passes its own (empty)
   *      mint per call; this is the default. */
  constructor(private readonly mintFallback: () => NoteTab) {}

  // ---- reads ----------------------------------------------------------------

  /** Every open note, in strip order. */
  all(): readonly NoteTab[] {
    return this.tabs;
  }

  /** The active note, when one is. */
  activeTab(): NoteTab | null {
    return this.tabs.find((tab) => tab.id === this.currentActiveId) ?? null;
  }

  /** The active note's id — null only before the first seed. */
  activeTabId(): string | null {
    return this.currentActiveId;
  }

  /** A note by id, when open. */
  tabOf(id: string): NoteTab | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  /** Whether the id names an open note. */
  has(id: string): boolean {
    return this.tabs.some((tab) => tab.id === id);
  }

  /** Strip-order position of a note (-1 when not open). */
  indexOf(id: string): number {
    return this.tabs.findIndex((tab) => tab.id === id);
  }

  // ---- seed & swap ------------------------------------------------------------

  /**
   * The boot seed: the hydrated (or legacy-migrated) rows become the
   * list, and the active id is the stored preference when it survives,
   * else the first row, else the mint keeps the list from starting
   * empty. Returns whether a fallback tab had to be minted — the caller
   * persists exactly then (a normal boot writes nothing).
   */
  seed(rows: NoteTab[], preferredActiveId: string | null): { minted: NoteTab | null } {
    this.tabs = rows;
    this.currentActiveId = this.has(preferredActiveId ?? '')
      ? preferredActiveId
      : (rows[0]?.id ?? null);
    if (this.currentActiveId === null) {
      const fresh = this.mintFallback();
      this.tabs.push(fresh);
      this.currentActiveId = fresh.id;
      return { minted: fresh };
    }
    return { minted: null };
  }

  /**
   * The merge swap: the merged rows replace the list wholesale. When the
   * active note did not survive the merge, the first surviving row takes
   * the stage (the editor's old DOM belonged to a note that no longer
   * exists — the caller repaints on `activeChanged`); an emptied world
   * mints a blank page back.
   */
  replaceAll(rows: NoteTab[]): ListMutationOutcome {
    const previousActiveId = this.currentActiveId;
    this.tabs = rows;
    // Asked against the NEW list, after the swap — the question is
    // whether the merge kept the note the pointer names, not whether the
    // old list held it (it trivially did).
    const survived = previousActiveId !== null && this.has(previousActiveId);
    let minted: NoteTab | null = null;
    if (!survived) {
      if (this.tabs.length === 0) {
        minted = this.mintFallback();
        this.tabs.push(minted);
      }
      this.currentActiveId = this.tabs[0]!.id;
    }
    return { removed: null, minted, activeChanged: !survived };
  }

  // ---- mutations ----------------------------------------------------------------

  /**
   * Adds a note at the end of the strip — a new tab (activated), a
   * background note or a restore (not activated: the editor never
   * notices until the note is opened).
   */
  append(tab: NoteTab, opts: { activate?: boolean } = {}): void {
    this.tabs.push(tab);
    if (opts.activate) {
      this.currentActiveId = tab.id;
    }
  }

  /**
   * Adds a note directly after another — the duplicate and the
   * conflict-resolution copy both land beside their source, where the
   * gesture reads as "here is its twin". An unknown anchor falls back to
   * the end (defensive: both callers hold validated ids).
   */
  insertAfter(afterId: string, tab: NoteTab): void {
    const index = this.indexOf(afterId);
    if (index === -1) {
      this.tabs.push(tab);
    } else {
      this.tabs.splice(index + 1, 0, tab);
    }
  }

  /**
   * Removes a note from the list — the trash flow's list half. The
   * neighbour policy (invariant I1): the tab LEFT of the closed one
   * becomes active, clamped to the new first when the closed one led the
   * strip. A non-active close does not move the pointer. Emptying the
   * list mints `mintWhenEmpty` and activates it (invariant I2). Returns
   * null when the id was not open.
   */
  remove(id: string, mintWhenEmpty: () => NoteTab = this.mintFallback): ListMutationOutcome | null {
    const index = this.indexOf(id);
    if (index === -1) {
      return null;
    }
    const removed = this.tabs[index]!;
    const wasActive = removed.id === this.currentActiveId;
    this.tabs = this.tabs.filter((tab) => tab.id !== id);
    let minted: NoteTab | null = null;
    if (this.tabs.length === 0) {
      minted = mintWhenEmpty();
      this.tabs.push(minted);
      this.currentActiveId = minted.id;
    } else if (wasActive) {
      const neighbour = this.tabs[Math.max(0, index - 1)] ?? this.tabs[0]!;
      this.currentActiveId = neighbour.id;
    }
    return { removed, minted, activeChanged: wasActive || minted !== null };
  }

  /**
   * Moves the active pointer — a switch's state half. Refuses an id that
   * is not open (the old code poisoned the pointer and let it self-heal
   * on the next boot; every real caller holds a live id, so the refusal
   * is unreachable hardening) and a no-op re-switch. Returns whether the
   * pointer moved.
   */
  setActive(id: string): boolean {
    if (id === this.currentActiveId || !this.has(id)) {
      return false;
    }
    this.currentActiveId = id;
    return true;
  }

  // ---- events ----------------------------------------------------------------

  /** The active-note event — see addActiveListener. */
  addActiveListener(listener: (tab: NoteTab) => void): () => void {
    this.activeListeners.add(listener);
    return () => {
      this.activeListeners.delete(listener);
    };
  }

  /**
   * Fires the active event with the CURRENT active tab. The manager
   * calls this when a switch is DONE — after the editor painted the new
   * note — because listeners read surfaces (the word pill counts the
   * painted words, the toolbars query the painted kind). Firing on the
   * pointer move alone would announce a note the DOM has not met yet.
   */
  emitActiveChanged(): void {
    const active = this.activeTab();
    if (!active) {
      return;
    }
    this.activeListeners.forEach((listener) => listener(active));
  }
}

/**
 * Validates one stored row into the editor-safe domain shape — the
 * seed-side map from the persisted spelling to the record. Every field is
 * coerced, never trusted: a row written by an older or newer build (or a
 * corrupted store) degrades to sane defaults instead of crashing the
 * boot. The sanitizer belongs to html notes ONLY — any other format
 * passing through it would have its angle brackets rewritten and its
 * data corrupted in place. The row's sync state is NOT this function's
 * business: the manager adopts it into the ledger beside this call (see
 * sync/ledger.ts's adoptStoredRow).
 */
export function validatedTabFromRow(entry: StoredNoteTab): NoteTab {
  const noteType = normalizeNoteType(entry.noteType);
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : null,
    content:
      typeof entry.content === 'string' && isHtmlContent(noteType)
        ? sanitizeNoteHtml(entry.content)
        : typeof entry.content === 'string'
          ? entry.content
          : '',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    noteType,
    colorTheme:
      entry.colorTheme === 'light' || entry.colorTheme === 'dark' ? entry.colorTheme : undefined,
    copyOf: typeof entry.copyOf === 'string' && entry.copyOf ? entry.copyOf : undefined,
  };
}
