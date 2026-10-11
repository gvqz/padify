/**
 * Snapshots — safety copies of notes, one store, deduplicated per note.
 *
 * The rebuild (see tasks.txt, "Complex") fixed four things the old menu
 * got wrong across note types:
 *
 *  • DUPLICATES — every Ctrl+U and every safety capture (tab close,
 *    delete) appended a row even when nothing changed. A snapshot now
 *    records the note it came from, and an identical (content + type)
 *    capture against that note's LATEST snapshot is declined instead of
 *    stored — no point keeping two copies of the same bytes.
 *  • EMPTINESS — the old check read the plain-text projection, so an
 *    image-only rich note (text projection empty, content an <img>)
 *    could not be snapshotted at all. Emptiness is now judged per
 *    content kind (see snapshotHasContent).
 *  • SEARCH — matched the raw stored string, so searching "div" hit
 *    every html snapshot's markup. Search now runs over what the row
 *    shows (title, preview, type label) plus the raw source of the
 *    text kinds, whose bytes ARE their text.
 *  • DATES — were formatted once at capture and frozen; a locale change
 *    left old rows in the old language. Rows format at render time from
 *    the timestamp (every record, legacy included, has one). The stored
 *    formattedDate field is still WRITTEN so an older build reading a
 *    newer store keeps a date — it is never read here.
 */
import { $ } from './lib/q';
import { openModal, closeModal } from './ui/behavior/modal';
import Swal from 'sweetalert2';
import { getActiveNoteContent, getEditorText, getTabManager, htmlToText } from './tabs';
import { isHtmlContent, noteTypeLabel, type NoteType } from './editor/note-types';
import { showToast } from './ui/toast';
import { updateWordCountPill } from './word-count-pill';

interface Snapshot {
  id?: number;
  /** The source note's tab id — scopes duplicate detection. Absent on
   *  records written before the rebuild; those never match a note. */
  noteId?: string;
  title: string;
  content: string;
  /** The note's type at capture time; absent = html (the classic note). */
  noteType?: string;
  /** The theme the content's ink colors were written under; absent on
   *  records written before this field existed (treated as current). */
  colorTheme?: 'light' | 'dark';
  preview: string;
  timestamp: number;
  /** Legacy: written for older builds that still read it. Never read. */
  formattedDate: string;
}

/** The shape compared for duplicate detection. */
interface SnapshotState {
  content: string;
  noteType?: string;
}

/**
 * Snapshots are safety copies, not an archive: every Ctrl+U, every
 * delete-safety capture adds one, and an unbounded store grows forever on
 * a long-lived install. The cap keeps the oldest history — the newest
 * MAX_SNAPSHOTS entries stay, older ones go (the timestamp index's
 * ascending order is the deletion order).
 */
export const MAX_SNAPSHOTS = 200;

/**
 * Deletes the oldest snapshots beyond the cap. Resolves with the number
 * pruned once the transaction commits; 0 when under the cap. Exported so
 * the cap is testable against a raw database without the manager's DOM
 * dependencies.
 */
export function pruneSnapshots(
  db: IDBDatabase,
  storeName: string,
  cap: number = MAX_SNAPSHOTS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let excess = 0;
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      excess = Math.max(0, countRequest.result - cap);
      if (excess === 0) {
        return; // under the cap — nothing to delete in this transaction
      }
      // Oldest first: ascending timestamp order is exactly the eviction
      // order a capped history wants.
      const cursorRequest = store.index('timestamp').openCursor();
      let deleted = 0;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= excess) {
          return;
        }
        cursor.delete();
        deleted += 1;
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    };
    countRequest.onerror = () => reject(countRequest.error);
    transaction.oncomplete = () => resolve(excess);
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

// ---------------------------------------------------------------------------
// Pure helpers — the decision layer, exported so tests pin it without the
// manager's DOM wiring.
// ---------------------------------------------------------------------------

/**
 * Whether a note's content is worth a snapshot, judged by its kind.
 * Html notes read their TEXT PROJECTION — the storage subset holds
 * words and formatting only (images are rendered as chips, never stored
 * as <img> — see editor/markdown/nodes.ts), so an html note without
 * words is empty, full stop. Text/json/opaque kinds are their raw bytes.
 */
export function snapshotHasContent(content: string, noteType?: string): boolean {
  if (isHtmlContent(noteType)) {
    return htmlToText(content).trim() !== '';
  }
  return content.trim() !== '';
}

/** Two captures are the same snapshot when bytes and note type match. */
export function isSameSnapshotState(a: SnapshotState, b: SnapshotState): boolean {
  return a.content === b.content && a.noteType === b.noteType;
}

/**
 * The newest snapshot that came from the given note. Input order does
 * not matter — the newest timestamp with a matching id wins. Legacy
 * records (no noteId) match only an unattributed query, which in
 * practice never happens — every note has a tab id.
 */
export function findLatestForNote(
  snapshots: Snapshot[],
  noteId: string | undefined,
): Snapshot | undefined {
  let latest: Snapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.noteId !== noteId) {
      continue;
    }
    if (!latest || snapshot.timestamp > latest.timestamp) {
      latest = snapshot;
    }
  }
  return latest;
}

/**
 * What a row is searched by: the copy it shows, plus the FULL text of
 * the note — for html kinds its text projection (searching raw markup
 * would answer every query about tags, not about the note), for text
 * kinds their raw source, whose bytes ARE their text. Computed once per
 * load and cached on the row, so each keystroke filters strings.
 */
export function snapshotSearchText(snapshot: Snapshot): string {
  const label = snapshot.noteType ? snapshotTypeBadgeLabel(snapshot.noteType) : '';
  const text = isHtmlContent(snapshot.noteType) ? htmlToText(snapshot.content) : snapshot.content;
  return `${snapshot.title}\n${snapshot.preview}\n${label}\n${text}`.toLowerCase();
}

/**
 * The short chip a row shows — 'Markdown', 'Rich Text' — matching the
 * shortcuts reference's badges. Unknown future types fall back to the
 * registry's full label; the chip matters when restoring switches the
 * note's type.
 */
export function snapshotTypeBadgeLabel(noteType: string): string {
  if (noteType === 'markdown') {
    return 'Markdown';
  }
  if (noteType === 'rich') {
    return 'Rich Text';
  }
  return noteTypeLabel(noteType as NoteType);
}

/** Render-time date — the row always speaks the user's current locale. */
export function formatSnapshotTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** First meaningful line (html) or the type's label, capped at 50 chars. */
export function deriveSnapshotTitle(content: string, noteType?: string): string {
  const firstLine = isHtmlContent(noteType)
    ? htmlToText(content)
        .split('\n')
        .find((line) => line.trim() !== '')
    : noteType
      ? noteTypeLabel(noteType as NoteType)
      : undefined;
  const title = firstLine || 'Untitled Snapshot';
  return title.length > 50 ? `${title.substring(0, 47)}...` : title;
}

/** 100 characters of what the row should show of the note. */
export function deriveSnapshotPreview(content: string, noteType?: string): string {
  const preview = (
    isHtmlContent(noteType) ? htmlToText(content).replace(/\s+\n/g, '\n') : content
  ).trim();
  if (preview.length > 100) {
    return `${preview.substring(0, 97)}...`;
  }
  return preview || 'No content';
}

export class SnapshotsManager {
  dbName: string;
  storeName: string;
  db: IDBDatabase | null;

  /** The last read, with each row's search text precomputed — keystrokes
   *  filter this array instead of re-reading IndexedDB. */
  private cache: { snapshot: Snapshot; searchText: string }[] = [];

  /**
   * Resolves once the IndexedDB open completes (or rejects if it errors).
   * Callers that need a snapshot before boot finishes — like the Ctrl+Shift+
   * Delete safety snapshot in utils.deleteNotes — can `await` this so the
   * snapshot isn't silently dropped when the IDB open hasn't completed yet.
   */
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: unknown) => void;

  constructor() {
    this.dbName = 'NotepadSnapshotsDB';
    this.storeName = 'snapshots';
    this.db = null;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.initializeDB();
    this.setupEventListeners();
  }

  /** Resolves once the IndexedDB connection is open. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  // Initialize IndexedDB
  initializeDB(): void {
    // Same hardening the main storage layer uses (storage/idb.ts
    // openDatabase): in environments where `indexedDB` is undefined or
    // throws synchronously (Firefox with dom.indexedDB.enabled=false,
    // hardened WebViews), the constructor must not throw — it runs inside
    // bootPadify BEFORE initApp, and an uncaught throw there kills the
    // whole boot into a dead shell. Rejecting ready() is the tolerated
    // failure: every caller catches and the app boots without snapshots.
    if (typeof indexedDB === 'undefined') {
      this.rejectReady(new Error('IndexedDB unavailable in this environment'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(this.dbName, 1);
    } catch (error) {
      this.rejectReady(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    request.onerror = (event) => {
      console.error('Error opening database', event);
      this.rejectReady(event);
    };

    request.onsuccess = (event) => {
      this.db = (event.target as IDBRequest).result;
      this.updateSnapshotsCount();
      void this.loadSnapshots();
      this.resolveReady();
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBRequest).result as IDBDatabase;
      if (!db.objectStoreNames.contains(this.storeName)) {
        const store = db.createObjectStore(this.storeName, {
          keyPath: 'id',
          autoIncrement: true,
        });

        // Create indexes for efficient querying
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
    };
  }

  // Setup event listeners
  setupEventListeners(): void {
    // Open snapshots modal
    document.getElementById('snapshotsButton')?.addEventListener('click', () => {
      openModal($('#snapshotsModal').get(0));
      // Honor the search field's leftover text — reopening used to show the
      // unfiltered list under a stale query.
      const query = (document.getElementById('searchSnapshots') as HTMLInputElement | null)?.value;
      void this.loadSnapshots(query ?? '');
    });

    // Create snapshot button
    document.getElementById('createSnapshotBtn')?.addEventListener('click', () => {
      void this.createSnapshot();
    });

    // Delete all snapshots button
    document.getElementById('deleteAllSnapshotsBtn')?.addEventListener('click', () => {
      Swal.fire({
        title: 'Want to delete all snapshots?',
        text: "You won't be able to revert this!",
        icon: 'warning',
        showCancelButton: true,
        customClass: {
          confirmButton: 'swal-btn-danger',
        },
        confirmButtonText: 'Yes, Delete!',
        cancelButtonText: 'No, keep it.',
      }).then((result) => {
        if (result.value) {
          this.deleteAllSnapshots();
        }
      });
    });

    // Search snapshots — filters the cached rows; no store read per keystroke.
    document.getElementById('searchSnapshots')?.addEventListener('input', (e) => {
      this.renderRows((e.target as HTMLInputElement).value);
    });

    // Keyboard shortcut: the platform's primary modifier + U
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyU') {
        e.preventDefault();
        void this.createSnapshot();
      }
    });
  }

  // Create a new snapshot of the ACTIVE note — or decline politely when
  // it adds nothing.
  async createSnapshot(title?: string): Promise<void> {
    // Capture from the note itself, not the editor DOM: a non-html note's
    // editor shows a placeholder card — its real content lives in the model.
    const captured = getActiveNoteContent();
    if (!captured) {
      return;
    }
    await this.createSnapshotFromCapture(
      captured.content,
      captured.noteType,
      getTabManager()?.getActive()?.id,
      title,
      { emptyToast: true, duplicateToast: true },
      getTabManager()?.getActive()?.colorTheme,
    );
  }

  /**
   * Safety snapshot of a note that is NOT (or no longer) the active one —
   * the close-tab path. Content comes from the tab's model (the note is
   * not mounted in the editor), and declines stay silent: the caller
   * promised "a snapshot is saved before it closes", which an identical
   * existing snapshot already satisfies.
   */
  async createSnapshotFromNote(
    content: string,
    noteType: NoteType | undefined,
    noteId: string,
    title: string,
    colorTheme?: 'light' | 'dark',
  ): Promise<void> {
    await this.createSnapshotFromCapture(
      content,
      noteType,
      noteId,
      title,
      {
        emptyToast: false,
        duplicateToast: false,
        // Silent by contract — the caller already owns the confirmation
        // toast ("Tab closed", "Notes deleted"), and a background "Snapshot
        // created!" landing after it would replace the user-facing message.
        successToast: false,
      },
      colorTheme,
    );
  }

  // The one writer — every path funnels here.
  private async createSnapshotFromCapture(
    noteContent: string,
    noteType: NoteType | undefined,
    noteId: string | undefined,
    title: string | undefined,
    options: {
      emptyToast: boolean;
      duplicateToast: boolean;
      /** Success toast — silent safety copies opt out (default: show). */
      successToast?: boolean;
    },
    colorTheme?: 'light' | 'dark',
  ): Promise<void> {
    if (!this.db) {
      // Wait for the IDB open to finish instead of silently dropping the
      // snapshot. Previously the safety snapshot in utils.deleteNotes was
      // lost if the user hit Ctrl+Shift+Delete within the first ~50 ms of
      // boot — the note was deleted without a backup.
      try {
        await this.ready();
      } catch {
        console.error('Snapshots database unavailable — cannot create snapshot.');
        return;
      }
    }
    if (!this.db) {
      // ready() resolved but the DB is still null (defensive — should not happen).
      console.error('Snapshots database not initialized after ready().');
      return;
    }

    if (!snapshotHasContent(noteContent, noteType)) {
      if (options.emptyToast) {
        showToast('Note is empty. Nothing to save as snapshot.');
      }
      return;
    }

    // The same bytes as this note's newest snapshot add nothing — decline.
    const existing = await this.readAllSnapshots();
    const latest = findLatestForNote(existing, noteId);
    if (latest && isSameSnapshotState(latest, { content: noteContent, noteType })) {
      if (options.duplicateToast) {
        showToast('No changes since the last snapshot.');
      }
      return;
    }

    // Generate a title from the first line of the note if not provided
    const noteTitle = title || deriveSnapshotTitle(noteContent, noteType);

    const timestamp = Date.now();
    const snapshot: Snapshot = {
      ...(noteId ? { noteId } : {}),
      title: noteTitle,
      content: noteContent,
      ...(noteType ? { noteType } : {}),
      ...(colorTheme ? { colorTheme } : {}),
      preview: deriveSnapshotPreview(noteContent, noteType),
      timestamp: timestamp,
      // Written for older builds' sake; this module renders from timestamp.
      formattedDate: formatSnapshotTimestamp(timestamp),
    };

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    // The prune call below needs a stable reference after this callback
    // returns — `this.db` narrowing does not survive into event callbacks.
    const database = this.db;
    const showCreatedToast = options.successToast !== false;

    // The function is async and callers await it to ORDER effects (the
    // restore path's "Snapshot restored!" must not be clobbered by this
    // write's own toast landing a microtask later) — so the promise must
    // settle when the WRITE settles, not when the handlers are attached.
    // Resolves on error too: a failed safety write must not wedge the
    // caller's flow (the restore/close already has the user's consent).
    await new Promise<void>((resolve) => {
      const request = store.add(snapshot);

      request.onsuccess = () => {
        if (showCreatedToast) {
          showToast('Snapshot created!', 'success');
        }

        // A store that only ever grows is a slow leak: retire the oldest
        // snapshots beyond the cap so safety copies stay bounded.
        pruneSnapshots(database, this.storeName)
          .then((pruned) => {
            if (pruned > 0) {
              void this.loadSnapshots();
              this.updateSnapshotsCount();
            }
          })
          .catch((error) => {
            console.warn(
              '[snapshots] prune failed — the cap will retry on the next snapshot',
              error,
            );
          });

        void this.loadSnapshots();
        this.updateSnapshotsCount();
        resolve();
      };

      request.onerror = (event) => {
        console.error('Error creating snapshot', event);
        showToast('Error creating snapshot');
        resolve();
      };
    });
  }

  /** Every snapshot, newest first (the read order the UI wants). */
  private readAllSnapshots(): Promise<Snapshot[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve([]);
        return;
      }
      const request = this.db
        .transaction([this.storeName], 'readonly')
        .objectStore(this.storeName)
        .getAll();
      request.onsuccess = () => {
        const rows = (request.result as Snapshot[]).slice();
        // getAll returns key order (insertion); the UI wants time order.
        rows.sort((a, b) => b.timestamp - a.timestamp);
        resolve(rows);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Load all snapshots into the list, filtered by the search term. One
  // store read per load; keystrokes re-filter the cached rows.
  async loadSnapshots(searchTerm: string = ''): Promise<void> {
    const snapshots = await this.readAllSnapshots();
    this.cache = snapshots.map((snapshot) => ({
      snapshot,
      searchText: snapshotSearchText(snapshot),
    }));
    this.renderRows(searchTerm);
  }

  // Render the cached rows through the current search term.
  private renderRows(searchTerm: string = ''): void {
    const snapshotsList = document.getElementById('snapshotsList');
    const noSnapshots = document.getElementById('noSnapshots');
    if (!snapshotsList || !noSnapshots) {
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    const rows: Snapshot[] = term
      ? this.cache.filter((row) => row.searchText.includes(term)).map((row) => row.snapshot)
      : this.cache.map((row) => row.snapshot);

    snapshotsList.innerHTML = '';
    for (const snapshot of rows) {
      snapshotsList.appendChild(this.createSnapshotElement(snapshot));
    }

    // The empty state has two faces: nothing stored yet, or nothing that
    // matched the search. They share the icon; the copy must not lie.
    const hasAny = this.cache.length > 0;
    const hasRows = rows.length > 0;
    snapshotsList.style.display = hasRows ? 'block' : 'none';
    noSnapshots.style.display = hasRows ? 'none' : 'flex';
    const showMiss = hasAny && !hasRows;
    document.getElementById('noSnapshotsEmpty')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsHint')?.toggleAttribute('hidden', showMiss);
    document.getElementById('noSnapshotsMiss')?.toggleAttribute('hidden', !showMiss);
  }

  // Create a snapshot element for the UI
  createSnapshotElement(snapshot: Snapshot): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'snapshot-item';

    // The type badge — shown for non-default types only, matching the tab
    // rail's convention: a badge matters when restoring would SWITCH the
    // note's type, which plain notes never do.
    const badge =
      snapshot.noteType && snapshot.noteType !== 'standard'
        ? `<span class="snapshot-type-badge">${this.escapeHtml(snapshotTypeBadgeLabel(snapshot.noteType))}</span>`
        : '';

    li.innerHTML = `
            <div class="snapshot-info">
                <h4 class="snapshot-title" title="${this.escapeHtml(snapshot.title)}">${this.escapeHtml(snapshot.title)}</h4>
                <p class="snapshot-preview" title="${this.escapeHtml(snapshot.preview)}">${this.escapeHtml(snapshot.preview)}</p>
                <div class="snapshot-meta">
                ${badge}
                <span class="snapshot-date">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M8 7V3M16 7V3M7 11H17M5 21H19C20.1046 21 21 20.1046 21 19V7C21 5.89543 20.1046 5 19 5H5C3.89543 5 3 5.89543 3 7V19C3 20.1046 3.89543 21 5 21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    ${this.escapeHtml(formatSnapshotTimestamp(snapshot.timestamp))}
                </span>
                </div>
            </div>
            <div class="snapshot-actions">
                <button class="snapshot-btn restore" title="Restore this snapshot">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="0.45600000000000007"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M4.52185 7H7C7.55229 7 8 7.44772 8 8C8 8.55229 7.55228 9 7 9H3C1.89543 9 1 8.10457 1 7V3C1 2.44772 1.44772 2 2 2C2.55228 2 3 2.44772 3 3V5.6754C4.26953 3.8688 6.06062 2.47676 8.14852 1.69631C10.6633 0.756291 13.435 0.768419 15.9415 1.73041C18.448 2.69239 20.5161 4.53782 21.7562 6.91897C22.9963 9.30013 23.3228 12.0526 22.6741 14.6578C22.0254 17.263 20.4464 19.541 18.2345 21.0626C16.0226 22.5842 13.3306 23.2444 10.6657 22.9188C8.00083 22.5931 5.54702 21.3041 3.76664 19.2946C2.20818 17.5356 1.25993 15.3309 1.04625 13.0078C0.995657 12.4579 1.45216 12.0088 2.00445 12.0084C2.55673 12.0079 3.00351 12.4566 3.06526 13.0055C3.27138 14.8374 4.03712 16.5706 5.27027 17.9625C6.7255 19.605 8.73118 20.6586 10.9094 20.9247C13.0876 21.1909 15.288 20.6513 17.0959 19.4075C18.9039 18.1638 20.1945 16.3018 20.7247 14.1724C21.2549 12.043 20.9881 9.79319 19.9745 7.8469C18.9608 5.90061 17.2704 4.3922 15.2217 3.6059C13.173 2.8196 10.9074 2.80968 8.8519 3.57803C7.11008 4.22911 5.62099 5.40094 4.57993 6.92229C4.56156 6.94914 4.54217 6.97505 4.52185 7Z" fill="currentColor"></path> </g></svg>
                </button>
                <button class="snapshot-btn copy" title="Copy snapshot content">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect> <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path> </g></svg>
                </button>
                <button class="snapshot-btn delete" title="Delete this snapshot">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M10 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M14 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M4 7H20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M6 7H12H18V18C18 19.6569 16.6569 21 15 21H9C7.34315 21 6 19.6569 6 18V7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V7H9V5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>
                </button>
            </div>
        `;

    // Add event listeners
    const restoreBtn = li.querySelector('.restore')!;
    const copyBtn = li.querySelector('.copy')!;
    const deleteBtn = li.querySelector('.delete')!;

    restoreBtn.addEventListener('click', () => this.restoreSnapshot(snapshot.id));
    copyBtn.addEventListener('click', () => this.copySnapshot(snapshot.id, copyBtn));
    deleteBtn.addEventListener('click', () => this.deleteSnapshot(snapshot.id));

    return li;
  }

  // Restore a snapshot
  restoreSnapshot(snapshotId: number | undefined): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const request = store.get(snapshotId!);

    request.onsuccess = async (event) => {
      const snapshot = (event.target as IDBRequest).result as Snapshot | undefined;
      if (snapshot) {
        // Ask for confirmation if there's existing content
        const noteContent = getEditorText();

        let result: { value?: unknown } = {
          value: true,
        };

        if (noteContent.trim() != '') {
          result = await Swal.fire({
            title: 'Restore this snapshot?',
            text: 'This will replace your current note. Are you sure?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Yes, Restore!',
            cancelButtonText: 'No, leave it.',
          });
        }

        if (!result.value) {
          return;
        }

        // Safety copy FIRST: restoring is the only destructive path whose
        // confirm dialog was the sole protection — undo history resets on
        // the wholesale replace, so a wrong-row restore would otherwise be
        // unrecoverable. Every other destructive flow (tab close, note
        // delete) keeps a behind-the-scenes snapshot; this matches them.
        // Declines (empty / identical) are silent — an identical existing
        // snapshot already satisfies the promise.
        const preRestore = getActiveNoteContent();
        if (preRestore && snapshotHasContent(preRestore.content, preRestore.noteType)) {
          try {
            await this.createSnapshotFromCapture(
              preRestore.content,
              preRestore.noteType,
              getTabManager()?.getActive()?.id,
              `Before restoring "${snapshot.title}"`,
              // Silent: the "Snapshot restored!" toast below is the
              // user-facing message for this action — the safety copy
              // is a background detail and must not replace it.
              { emptyToast: false, duplicateToast: false, successToast: false },
              getTabManager()?.getActive()?.colorTheme,
            );
          } catch {
            /* the restore still proceeds — the confirm already happened */
          }
        }

        // Restore the content through the ONE restore path: it moves the
        // note's type with the content and re-announces the active note so
        // the chrome (toolbar, editor port, tab badge) follows the
        // restored kind. Old snapshots hold plain text on the html path —
        // the editor renders it faithfully, newlines and all.
        getTabManager()?.applySnapshotToActive(
          snapshot.content,
          snapshot.noteType as NoteType | undefined,
          snapshot.colorTheme,
        );
        updateWordCountPill(getEditorText());

        showToast('Snapshot restored!', 'success');

        // Close the modal after a short delay
        setTimeout(() => {
          closeModal($('#snapshotsModal').get(0));
        }, 150);
      }
    };

    request.onerror = (event) => {
      console.error('Error restoring snapshot', event);
      showToast('Error restoring snapshot');
    };
  }

  // Copy a snapshot content to clipboard
  copySnapshot(snapshotId: number | undefined, buttonElement: Element): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const request = store.get(snapshotId!);

    request.onsuccess = (event) => {
      const snapshot = (event.target as IDBRequest).result as Snapshot | undefined;
      if (snapshot) {
        // Use the Clipboard API
        navigator.clipboard
          .writeText(snapshot.content)
          .then(() => {
            this.showCopySuccess(buttonElement);
          })
          .catch((err) => {
            console.error('Failed to copy text: ', err);
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = snapshot.content;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);

            this.showCopySuccess(buttonElement);
          });
      }
    };

    request.onerror = (event) => {
      console.error('Error copying snapshot', event);
      showToast('Error copying snapshot');
    };
  }

  // Show copy success feedback
  showCopySuccess(button: Element): void {
    const originalHTML = button.innerHTML;
    button.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <polyline points="20 6 9 17 4 12"></polyline> </g></svg>';

    setTimeout(() => {
      button.innerHTML = originalHTML;
    }, 700);
  }

  // Delete a snapshot
  deleteSnapshot(snapshotId: number | undefined): void {
    Swal.fire({
      title: 'Want to delete this snapshot?',
      text: "You won't be able to revert this!",
      icon: 'warning',
      showCancelButton: true,
      customClass: {
        confirmButton: 'swal-btn-danger',
      },
      confirmButtonText: 'Yes, Delete!',
      cancelButtonText: 'No, keep it.',
    }).then((result) => {
      if (result.value) {
        if (!this.db) return;
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(snapshotId!);

        request.onsuccess = () => {
          void this.loadSnapshots();
          this.updateSnapshotsCount();
        };

        request.onerror = (event) => {
          console.error('Error deleting snapshot', event);
          showToast('Error deleting snapshot');
        };
      }
    });
  }

  // Delete all snapshots
  deleteAllSnapshots(): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const request = store.clear();

    request.onsuccess = () => {
      void this.loadSnapshots();
      this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error deleting all snapshots', event);
      showToast('Error deleting snapshots');
    };
  }

  // Search snapshots by title or content
  searchSnapshots(searchTerm: string): void {
    this.renderRows(searchTerm);
  }

  // Update the snapshots count in the UI
  updateSnapshotsCount(): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const countRequest = store.count();

    countRequest.onsuccess = () => {
      const countElement = document.getElementById('snapshotsCount');
      const deleteAllBtn = document.getElementById(
        'deleteAllSnapshotsBtn',
      ) as HTMLButtonElement | null;

      if (countElement) {
        countElement.textContent = String(countRequest.result);
      }

      if (deleteAllBtn) {
        deleteAllBtn.disabled = countRequest.result === 0;
      }
    };
  }

  // Helper to escape HTML
  escapeHtml(unsafe: string | null | undefined): string {
    if (!unsafe) return '';
    return unsafe
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

/**
 * Wires the snapshots feature: constructs the manager when the snapshots
 * button exists and exposes the window.createSnapshot hook. Called by
 * boot.ts; used to register itself on DOMContentLoaded.
 */
export function initSnapshots(): void {
  // Only initialize if the snapshots button exists
  if (document.getElementById('snapshotsButton')) {
    window.snapshotsManager = new SnapshotsManager();
  }
}

// Add a global function to create a snapshot (can be called from other parts of the app)
window.createSnapshot = function (title?: string): Promise<void> {
  if (window.snapshotsManager) {
    return window.snapshotsManager.createSnapshot(title);
  }
  console.warn('Snapshots manager not initialized');
  return Promise.resolve();
};
