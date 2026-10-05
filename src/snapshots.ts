// Snapshots Manager
import { $ } from './lib/q';
import { openModal, closeModal } from './ui/behavior/modal';
import Swal from 'sweetalert2';
import {
  getActiveNoteContent,
  getEditorText,
  getTabManager,
  htmlToText,
  setEditorHtml,
} from './tabs';
import { isHtmlContent, noteTypeLabel, type NoteType } from './editor/note-types';
import { showToast } from './ui/toast';
import { updateWordCountPill } from './word-count-pill';

interface Snapshot {
  id?: number;
  title: string;
  content: string;
  /** The note's type at capture time; absent = html (the classic note). */
  noteType?: string;
  preview: string;
  timestamp: number;
  formattedDate: string;
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

export class SnapshotsManager {
  dbName: string;
  storeName: string;
  db: IDBDatabase | null;

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
    const request = indexedDB.open(this.dbName, 1);

    request.onerror = (event) => {
      console.error('Error opening database', event);
      this.rejectReady(event);
    };

    request.onsuccess = (event) => {
      this.db = (event.target as IDBRequest).result;
      this.updateSnapshotsCount();
      this.loadSnapshots();
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
      this.loadSnapshots();
    });

    // Create snapshot button
    document.getElementById('createSnapshotBtn')?.addEventListener('click', () => {
      this.createSnapshot();
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

    // Search snapshots
    document.getElementById('searchSnapshots')?.addEventListener('input', (e) => {
      this.searchSnapshots((e.target as HTMLInputElement).value);
    });

    // Keyboard shortcut: Ctrl/Cmd + U to create snapshot
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyU') {
        e.preventDefault();
        this.createSnapshot();
      }
    });
  }

  // Create a new snapshot.
  // Async because the IDB connection may not be open yet — callers that
  // invoke this from a user action (Ctrl+Shift+Delete safety snapshot, the
  // Create Snapshot button) get a Promise they can await; the wait is
  // typically 0 ms after the first paint.
  async createSnapshot(title?: string): Promise<void> {
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

    // Capture from the note itself, not the editor DOM: a non-html note's
    // editor shows a placeholder card — its real content lives in the model.
    const captured = getActiveNoteContent();
    if (!captured) {
      return;
    }
    const noteContent = captured.content;
    const noteType = captured.noteType;
    if (!getEditorText().trim()) {
      showToast('Note is empty. Nothing to save as snapshot.');
      return;
    }

    // Generate a title from the first line of the note if not provided
    const noteTitle = title || this.generateSnapshotTitle(noteContent, noteType);

    const timestamp = Date.now();
    const snapshot: Snapshot = {
      title: noteTitle,
      content: noteContent,
      ...(noteType ? { noteType } : {}),
      preview: this.generatePreview(noteContent, noteType),
      timestamp: timestamp,
      formattedDate: this.formatDate(timestamp),
    };

    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    // The prune call below needs a stable reference after this callback
    // returns — `this.db` narrowing does not survive into event callbacks.
    const database = this.db;

    const request = store.add(snapshot);

    request.onsuccess = () => {
      showToast('Snapshot created successfully!', 'success');

      // A store that only ever grows is a slow leak: retire the oldest
      // snapshots beyond the cap so safety copies stay bounded.
      pruneSnapshots(database, this.storeName)
        .then((pruned) => {
          if (pruned > 0) {
            this.loadSnapshots();
            this.updateSnapshotsCount();
          }
        })
        .catch((error) => {
          console.warn('[snapshots] prune failed — the cap will retry on the next snapshot', error);
        });

      this.loadSnapshots();
      this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error creating snapshot', event);
      this.showToast('Error creating snapshot');
    };
  }

  // Load all snapshots
  loadSnapshots(searchTerm: string = ''): void {
    if (!this.db) return;

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    const request = store.index('timestamp').openCursor(null, 'prev');
    const snapshotsList = document.getElementById('snapshotsList');
    const noSnapshots = document.getElementById('noSnapshots');

    if (!snapshotsList) return;

    snapshotsList.innerHTML = '';
    let hasSnapshots = false;
    const searchLower = searchTerm.toLowerCase();

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;

      if (cursor) {
        const snapshot = cursor.value as Snapshot;

        // Filter by search term if provided
        if (
          !searchTerm ||
          snapshot.title.toLowerCase().includes(searchLower) ||
          snapshot.content.toLowerCase().includes(searchLower)
        ) {
          hasSnapshots = true;
          const snapshotElement = this.createSnapshotElement(snapshot);
          snapshotsList.appendChild(snapshotElement);
        }

        cursor.continue();
      } else {
        // No more snapshots
        snapshotsList.style.display = hasSnapshots ? 'block' : 'none';
        noSnapshots!.style.display = hasSnapshots ? 'none' : 'flex';
      }
    };

    request.onerror = (event) => {
      console.error('Error loading snapshots', event);
    };
  }

  // Create a snapshot element for the UI
  createSnapshotElement(snapshot: Snapshot): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'snapshot-item';

    li.innerHTML = `
            <div class="snapshot-info">
                <h4 class="snapshot-title" title="${this.escapeHtml(snapshot.title)}">${this.escapeHtml(snapshot.title)}</h4>
                <p class="snapshot-preview" title="${this.escapeHtml(snapshot.preview)}">${this.escapeHtml(snapshot.preview)}</p>
                <div class="snapshot-meta">
                <span class="snapshot-date">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 7V3M16 7V3M7 11H17M5 21H19C20.1046 21 21 20.1046 21 19V7C21 5.89543 20.1046 5 19 5H5C3.89543 5 3 5.89543 3 7V19C3 20.1046 3.89543 21 5 21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    ${snapshot.formattedDate}
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

        // Restore the content. Html snapshots ride the editor path (old
        // snapshots hold plain text — the editor renders it faithfully,
        // newlines and all); every other kind is written to the model
        // through the manager, because no editor surface exists for it.
        if (snapshot.noteType && !isHtmlContent(snapshot.noteType as NoteType)) {
          getTabManager()?.applySnapshotToActive(snapshot.content, snapshot.noteType as NoteType);
        } else {
          setEditorHtml(snapshot.content);
        }
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
      this.showToast('Error restoring snapshot');
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
      this.showToast('Error copying snapshot');
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
          this.loadSnapshots();
          this.updateSnapshotsCount();
        };

        request.onerror = (event) => {
          console.error('Error deleting snapshot', event);
          this.showToast('Error deleting snapshot');
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
      this.loadSnapshots();
      this.updateSnapshotsCount();
    };

    request.onerror = (event) => {
      console.error('Error deleting all snapshots', event);
      this.showToast('Error deleting snapshots');
    };
  }

  // Search snapshots by title or content
  searchSnapshots(searchTerm: string): void {
    this.loadSnapshots(searchTerm);
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

  // Generate a title from note content
  generateSnapshotTitle(content: string, noteType?: string): string {
    // Html content derives the title from its plain text. Raw formats
    // title from their type — never from a guessed reading of the content
    // (the first line of an unknown format could be anything).
    const firstLine = isHtmlContent(noteType)
      ? htmlToText(content)
          .split('\n')
          .find((line) => line.trim() !== '')
      : noteType
        ? noteTypeLabel(noteType as NoteType)
        : undefined;
    let title = firstLine || 'Untitled Snapshot';

    // Limit title length
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title;
  }

  // Generate a preview of the note content
  generatePreview(content: string, noteType?: string): string {
    // Html content previews as its rendered text; raw formats preview as
    // their raw bytes — an honest window into what the snapshot holds.
    let preview = (
      isHtmlContent(noteType) ? htmlToText(content).replace(/\s+\n/g, '\n') : content
    ).trim();

    // Get first 100 characters
    if (preview.length > 100) {
      preview = preview.substring(0, 97) + '...';
    }

    return preview || 'No content';
  }

  // Format timestamp to readable date
  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Show toast message
  showToast(message: string): void {
    showToast(message);
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
