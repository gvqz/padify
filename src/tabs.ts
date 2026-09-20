/**
 * Padify note tabs — multiple notes in one editor.
 *
 * Tabs live on the main page alongside the rich text formatting (merged in
 * from the old standalone Tabbypad tool, which no longer ships as a separate
 * page). Every tab is an independent note with its own rich content that is
 * autosaved to localStorage:
 *
 *   padifyTabs      → JSON array of { id, name, html, createdAt, updatedAt }
 *   padifyActiveTab → id of the tab shown in the editor
 *
 * The legacy single-note `note` key (plain text, optionally with markdown
 * style **bold** / *italic* / __underline__ / ~~strikethrough__ wrappers) is
 * migrated into the first tab on first run, converting the markers into real
 * formatting tags so the text renders the way it was written.
 *
 * Content is stored as a small HTML subset (b/strong/i/em/u/s/strike/del/br/
 * div/span + text). Everything that goes into the editor from storage passes
 * through sanitizeNoteHtml, which strips unknown tags and attributes, so the
 * editor surface only ever contains the formatting the app itself produces.
 */

import $ from 'jquery';
import Swal from 'sweetalert2';
import { showToast } from './utils';

export interface NoteTab {
  id: string;
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  html: string;
  createdAt: number;
  updatedAt: number;
}

const TABS_KEY = 'padifyTabs';
const ACTIVE_KEY = 'padifyActiveTab';
const LEGACY_NOTE_KEY = 'note';

/**
 * Tabs closed on this device whose deletion has not been confirmed by the
 * cloud yet. Persisted so closing a tab offline still deletes it remotely
 * after the next sync.
 */
export interface TabTombstone {
  id: string;
  updatedAt: number;
}

const TOMBSTONES_KEY = 'padifyTabTombstones';

/** Everything the cloud sync layer needs after the model changed. */
export interface TabsSyncPayload {
  /** Current tab list (already persisted to localStorage). */
  tabs: NoteTab[];
  /** Tab ids whose content/name changed since the last persist. */
  dirty: string[];
  /** Full tombstone list (pending deletions, some possibly old news). */
  tombstones: TabTombstone[];
}

const MAX_TITLE_LENGTH = 42;

/** Welcome note shown for brand-new installs (rich HTML). */
export const WELCOME_HTML = [
  'Welcome! Padify is an offline-capable notepad which is a Progressive Web App.',
  '',
  'The app serves the following features:',
  '',
  '- Your notes are saved in real-time as you type.',
  '- Multiple notes via tabs — plus bold, italic, underline and strikethrough',
  '  formatting that renders right inside the editor (right-click to try it).',
  '- Optional cloud sync: click the cloud icon in the top bar to back up',
  '  your notes and pick them up on any other device.',
  '- Installable on supported browsers for offline usage.',
  '- "Add To Home Screen" feature on Android-supported devices to launch the app from the home screen.',
  '- Dark mode.',
  '- Privacy-focused - Never collects your precious data.',
  '- Light-weight - Loads almost instantly.',
  '- Writing sessions with a pick-a-duration timer.',
  '- View Note Statistics.',
  '- Snapshots.',
  '- Ability to mimic typewriter sound when typing.',
  '- Optional break reminders after long writing sessions.',
  '- Keyboard shortcuts for common actions.',
  '- Focus mode to leave you with a barebones and pristine editor.',
  '- Full-screen mode for a distraction-free writing experience.',
  '- Floating window (in supported browsers) to effectively take notes across other apps.',
  '- Download notes as plain text, PDF, HTML, and DOCX file.',
  '- Ability to play generative ambient music and mix 25 ambience sounds to help you focus.',
  '',
  'CAUTION: Since the app uses the browser\'s localStorage to store your notes,',
  'it\'s recommended that you take a backup of your notes more often using the',
  '"Download Notes" button or by pressing the "ctrl/command + s" keys.',
  '',
  '<b>Delete this text and start writing your notes</b>'
].join('\n');

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Escapes a plain-text string so it can be embedded as HTML text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Converts the legacy plain-text note (with markdown-style formatting
 * wrappers) into the rich HTML subset the editor stores. Newlines stay as
 * literal \n characters — the editor renders with white-space: pre-wrap.
 */
export function legacyTextToHtml(text: string): string {
  const escaped = escapeHtml(text);

  const unwrap = (pattern: RegExp, tag: string): string =>
    escaped.replace(pattern, (_match, inner: string) => `<${tag}>${inner}</${tag}>`);

  // Order matters: the longer asterisk run (bold) before the single-star
  // italic, underline's `__` before nothing else that clashes.
  return unwrap(/\*\*([^*\n]+?)\*\*/g, 'b')
    .replace(/__([^_\n]+?)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
}

const ALLOWED_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'BR', 'DIV', 'SPAN', 'P'
]);

/**
 * Strips the stored HTML down to the formatting subset the editor produces:
 * known inline tags survive without attributes, everything else is unwrapped
 * to its text. Guards the innerHTML round-trip against stray markup.
 */
export function sanitizeNoteHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

  const walk = (node: Node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      return [node];
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return [];
    }

    const element = node as HTMLElement;
    const children: Node[] = [];
    element.childNodes.forEach((child) => {
      children.push(...walk(child));
    });

    if (!ALLOWED_TAGS.has(element.tagName)) {
      return children;
    }

    const clone = document.createElement(element.tagName);
    children.forEach((child) => clone.appendChild(child));
    return [clone];
  };

  const container = parsed.body;
  const out: Node[] = [];
  container.childNodes.forEach((child) => out.push(...walk(child)));

  const fragment = document.createElement('div');
  out.forEach((node) => fragment.appendChild(node));
  return fragment.innerHTML;
}

/** Plain text of a stored HTML snippet (newlines preserved). */
export function htmlToText(html: string): string {
  const probe = document.createElement('div');
  probe.innerHTML = html;

  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    if (element.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    if (element.tagName === 'DIV' || element.tagName === 'P') {
      // Block boundaries read as newlines, like innerText would report them.
      if ((element.textContent ?? '') === '') {
        parts.push('\n');
        return;
      }
      if (parts.length > 0) {
        parts.push('\n');
      }
      element.childNodes.forEach(walk);
      return;
    }
    element.childNodes.forEach(walk);
  };

  probe.childNodes.forEach(walk);
  return parts.join('');
}

/** Derives the tab label: user name, else the first non-empty line. */
export function deriveTabTitle(tab: NoteTab): string {
  if (tab.name && tab.name.trim()) {
    return tab.name.trim();
  }

  const firstLine = htmlToText(tab.html)
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);

  if (!firstLine) {
    return 'Untitled';
  }

  return firstLine.length > MAX_TITLE_LENGTH
    ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

function createTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTab(html: string = '', name: string | null = null): NoteTab {
  const now = Date.now();
  return { id: createTabId(), name, html, createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class TabManager {
  private tabs: NoteTab[] = [];
  private activeId: string | null = null;
  private readonly editor: JQuery;
  private readonly strip: JQuery;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tombstones: TabTombstone[] = [];
  private dirtyIds: Set<string> = new Set();

  constructor(editor: JQuery) {
    this.editor = editor;
    this.strip = $('#tabStripTabs');
  }

  /** Loads (or bootstraps) the model and paints the strip + editor. */
  init(): void {
    this.tabs = this.load();
    this.tombstones = this.loadTombstones();
    this.migrateLegacyNote();

    const savedActive = localStorage.getItem(ACTIVE_KEY);
    this.activeId = this.tabs.some(tab => tab.id === savedActive)
      ? savedActive
      : this.tabs[0]?.id ?? null;

    if (!this.activeId || !this.getActive()) {
      if (this.tabs.length === 0) {
        this.tabs.push(createTab(WELCOME_HTML));
        this.persist();
      }
      this.activeId = this.tabs[0].id;
      this.persist();
    }

    this.renderStrip();
    this.loadActiveIntoEditor();
    this.bindStripEvents();
  }

  // ---- model ---------------------------------------------------------------

  private load(): NoteTab[] {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string')
        .map(entry => ({
          id: entry.id as string,
          name: typeof entry.name === 'string' ? entry.name : null,
          html: typeof entry.html === 'string' ? sanitizeNoteHtml(entry.html) : '',
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now()
        }));
    } catch {
      return [];
    }
  }

  /**
   * One-time migration from the legacy single-note `note` key. Runs after
   * load() so an existing tab list wins over the old note.
   */
  private migrateLegacyNote(): void {
    const legacy = localStorage.getItem(LEGACY_NOTE_KEY);

    if (legacy === null) {
      return;
    }

    localStorage.removeItem(LEGACY_NOTE_KEY);

    if (this.tabs.length > 0 || legacy.trim() === '') {
      return;
    }

    this.tabs.unshift(createTab(legacyTextToHtml(legacy)));
    this.persist();
  }

  private persist(): void {
    localStorage.setItem(TABS_KEY, JSON.stringify(this.tabs));
    if (this.activeId) {
      localStorage.setItem(ACTIVE_KEY, this.activeId);
    }

    if (this.onPersist) {
      this.onPersist(this.exportForSync());
    }
  }

  // ---- sync support ---------------------------------------------------------

  private loadTombstones(): TabTombstone[] {
    try {
      const raw = localStorage.getItem(TOMBSTONES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        entry => entry && typeof entry.id === 'string' && typeof entry.updatedAt === 'number'
      );
    } catch {
      return [];
    }
  }

  private persistTombstones(): void {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(this.tombstones));
  }

  /** Records a tab deletion so the cloud can mirror it (tombstone). */
  private recordTombstone(tabId: string): void {
    if (this.tombstones.some(entry => entry.id === tabId)) {
      return;
    }
    this.tombstones.push({ id: tabId, updatedAt: Date.now() });
    this.persistTombstones();
  }

  /** Snapshot of the model for the cloud sync layer. */
  exportForSync(): TabsSyncPayload {
    return {
      tabs: this.tabs.map(tab => ({ ...tab })),
      dirty: [...this.dirtyIds],
      tombstones: this.tombstones.map(entry => ({ ...entry }))
    };
  }

  /**
   * Called by the cloud sync layer after a pull confirmed a tombstone is
   * stored remotely — the local record is no longer needed.
   */
  confirmTombstones(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const confirmed = new Set(ids);
    this.tombstones = this.tombstones.filter(entry => !confirmed.has(entry.id));
    this.persistTombstones();
  }

  /**
   * Replaces the model with a merged tab list coming from the sync layer.
   * The editor only reloads when the user is not actively typing in it, so a
   * background pull can never swallow keystrokes.
   */
  applyExternalMerge(nextTabs: NoteTab[]): void {
    const activeBefore = this.getActive();

    this.tabs = nextTabs.map(tab => ({
      ...tab,
      html: sanitizeNoteHtml(tab.html)
    }));

    if (!this.tabs.some(tab => tab.id === this.activeId)) {
      this.activeId = this.tabs[0]?.id ?? null;
      if (!this.activeId) {
        const fresh = createTab(WELCOME_HTML);
        this.tabs.push(fresh);
        this.activeId = fresh.id;
      }
    }

    this.persist();
    this.renderStrip();

    const active = this.getActive();
    if (active) {
      const editorFocused = document.activeElement === this.editor.get(0);
      const contentChanged = !activeBefore || activeBefore.id !== active.id
        ? true
        : activeBefore.html !== active.html || activeBefore.name !== active.name;

      if (contentChanged && !editorFocused) {
        this.loadActiveIntoEditor();
      }
      this.notifyActiveChanged();
    }
  }

  /** Debounced persistence for editor input — keeps typing smooth. */
  schedulePersist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 400);
  }

  getActive(): NoteTab | null {
    return this.tabs.find(tab => tab.id === this.activeId) ?? null;
  }

  /** Saves the editor's current HTML into the active tab. */
  saveActiveFromEditor(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }

    const html = this.editor.html() ?? '';
    if (html === active.html) {
      return;
    }

    active.html = html;
    active.updatedAt = Date.now();
    this.dirtyIds.add(active.id);
    this.schedulePersist();
    this.refreshTabLabel(active.id);
  }

  /** Persists the editor content immediately (snapshot restore, clear, …). */
  syncAfterExternalEdit(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }

    active.html = this.editor.html() ?? '';
    active.updatedAt = Date.now();
    this.dirtyIds.add(active.id);
    this.persist();
    this.refreshTabLabel(active.id);
  }

  // ---- editor sync -----------------------------------------------------------

  private loadActiveIntoEditor(): void {
    const active = this.getActive();
    this.editor.html(active ? active.html : '');
    this.editor.scrollTop(0);
  }

  getActiveText(): string {
    const element = this.editor.get(0) as HTMLElement | undefined;
    if (!element) {
      return '';
    }
    return element.innerText.replace(/\u00a0/g, ' ');
  }

  clearActiveTab(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }

    this.editor.html('');
    active.html = '';
    active.updatedAt = Date.now();
    this.dirtyIds.add(active.id);
    this.persist();
    this.refreshTabLabel(active.id);
    this.editor.trigger('focus');
  }

  // ---- strip rendering --------------------------------------------------------

  private renderStrip(): void {
    const stripElement = this.strip.get(0);
    if (!stripElement) {
      return;
    }

    // Rebuild without jQuery empty() so event handlers die with the nodes.
    stripElement.textContent = '';

    this.tabs.forEach((tab) => {
      stripElement.appendChild(this.buildTabElement(tab));
    });
  }

  private buildTabElement(tab: NoteTab): HTMLElement {
    const button = document.createElement('div');
    button.className = 'tab-strip-tab' + (tab.id === this.activeId ? ' active' : '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === this.activeId));
    button.dataset.tabId = tab.id;
    button.title = tab.name ? tab.name : 'Double-click to rename';

    const title = document.createElement('span');
    title.className = 'tab-strip-title';
    title.textContent = deriveTabTitle(tab);
    button.appendChild(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-strip-close';
    close.setAttribute('aria-label', `Close tab ${deriveTabTitle(tab)}`);
    close.title = 'Close tab';
    close.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    button.appendChild(close);

    return button;
  }

  private refreshTabLabel(tabId: string): void {
    const tab = this.tabs.find(entry => entry.id === tabId);
    const element = this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`);
    if (!tab || element.length === 0) {
      return;
    }

    element.find('.tab-strip-title').text(deriveTabTitle(tab));
  }

  private bindStripEvents(): void {
    const stripElement = this.strip.get(0);
    if (!stripElement) {
      return;
    }

    // Delegated: switch on click, close on ×, rename on double-click.
    stripElement.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const tabElement = target.closest<HTMLElement>('.tab-strip-tab');
      if (!tabElement) {
        return;
      }

      const tabId = tabElement.dataset.tabId!;

      if (target.closest('.tab-strip-close')) {
        event.stopPropagation();
        this.requestCloseTab(tabId);
        return;
      }

      if (tabId !== this.activeId) {
        this.switchTo(tabId);
      } else {
        (this.editor.get(0) as HTMLElement).focus();
      }
    });

    stripElement.addEventListener('auxclick', (event) => {
      // Middle-click closes, like browser tabs.
      if ((event as MouseEvent).button !== 1) {
        return;
      }
      const tabElement = (event.target as HTMLElement).closest<HTMLElement>('.tab-strip-tab');
      if (tabElement) {
        event.preventDefault();
        this.requestCloseTab(tabElement.dataset.tabId!);
      }
    });

    stripElement.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement;
      const tabElement = target.closest<HTMLElement>('.tab-strip-tab');
      if (tabElement && !target.closest('.tab-strip-close')) {
        event.preventDefault();
        this.beginRename(tabElement.dataset.tabId!);
      }
    });

    $('#addTab').on('click', () => {
      this.addTab();
    });
  }

  // ---- actions -----------------------------------------------------------------

  switchTo(tabId: string, focusEditor = true): void {
    if (tabId === this.activeId) {
      return;
    }

    this.saveActiveFromEditor();
    this.activeId = tabId;
    this.persist();
    this.renderStrip();
    this.loadActiveIntoEditor();

    if (focusEditor) {
      (this.editor.get(0) as HTMLElement).focus();
    }

    this.notifyActiveChanged();
  }

  addTab(focusEditor = true): void {
    this.saveActiveFromEditor();

    const tab = createTab('');
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.dirtyIds.add(tab.id);
    this.persist();

    this.strip.get(0)!.appendChild(this.buildTabElement(tab));
    this.setActiveClass();
    this.loadActiveIntoEditor();
    this.scrollTabIntoView(tab.id);

    if (focusEditor) {
      (this.editor.get(0) as HTMLElement).focus();
    }

    this.notifyActiveChanged();
    showToast('New tab created.');
  }

  private requestCloseTab(tabId: string): void {
    const tab = this.tabs.find(entry => entry.id === tabId);
    if (!tab) {
      return;
    }

    const isActive = tabId === this.activeId;
    const text = isActive ? this.getActiveText() : htmlToText(tab.html);

    const closeNow = (): void => {
      // Keep a safety snapshot behind the user's back, like delete-notes does.
      if (text.trim() && window.snapshotsManager) {
        try {
          window.snapshotsManager.createSnapshot(`Before closing "${deriveTabTitle(tab)}"`);
        } catch {
          /* snapshots unavailable — the close still proceeds */
        }
      }

      const index = this.tabs.findIndex(entry => entry.id === tabId);
      this.tabs = this.tabs.filter(entry => entry.id !== tabId);
      this.dirtyIds.delete(tabId);
      this.recordTombstone(tabId);

      if (this.tabs.length === 0) {
        const fresh = createTab('');
        this.tabs.push(fresh);
        this.activeId = fresh.id;
        this.persist();
        this.renderStrip();
        this.loadActiveIntoEditor();
        (this.editor.get(0) as HTMLElement).focus();
        this.notifyActiveChanged();
        showToast('Tab closed. A fresh tab is ready.');
        return;
      }

      if (isActive) {
        const neighbour = this.tabs[Math.max(0, index - 1)] ?? this.tabs[0];
        this.activeId = neighbour.id;
        this.persist();
        this.renderStrip();
        this.loadActiveIntoEditor();
        (this.editor.get(0) as HTMLElement).focus();
        this.notifyActiveChanged();
      } else {
        this.persist();
        this.renderStrip();
      }

      showToast('Tab closed.');
    };

    if (!text.trim()) {
      closeNow();
      return;
    }

    Swal.fire({
      title: 'Close this tab?',
      text: `"${deriveTabTitle(tab)}" has content. A snapshot is saved before it closes.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Close tab',
      cancelButtonText: 'Keep it'
    }).then((result) => {
      if (result.isConfirmed) {
        closeNow();
      }
    });
  }

  private beginRename(tabId: string): void {
    const tab = this.tabs.find(entry => entry.id === tabId);
    const element = this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`);
    if (!tab || element.length === 0 || element.find('.tab-strip-rename').length > 0) {
      return;
    }

    const titleElement = element.find('.tab-strip-title');
    const currentName = tab.name ?? deriveTabTitle(tab);

    const input = $('<input type="text" class="tab-strip-rename" maxlength="60" aria-label="Tab name">')
      .val(currentName);
    titleElement.replaceWith(input);
    input.trigger('focus');

    const commit = (keep: boolean): void => {
      const raw = String(input.val() ?? '').trim();
      if (keep && raw && raw !== currentName) {
        tab.name = raw;
        tab.updatedAt = Date.now();
        this.dirtyIds.add(tab.id);
        this.persist();
        showToast('Tab renamed.');
      }
      element.find('.tab-strip-rename').replaceWith(
        $('<span class="tab-strip-title"></span>').text(deriveTabTitle(tab))
      );
      element.attr('title', tab.name ? tab.name : 'Double-click to rename');
    };

    input.on('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(true);
        (this.editor.get(0) as HTMLElement).focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        commit(false);
      }
    });
    input.on('blur', () => commit(true));
    input.on('click', (event) => event.stopPropagation());
    input.on('dblclick', (event) => event.stopPropagation());
  }

  /** Ctrl/Cmd + Alt + ←/→ moves between tabs. */
  cycle(delta: number): void {
    if (this.tabs.length < 2) {
      return;
    }

    const index = this.tabs.findIndex(entry => entry.id === this.activeId);
    const next = this.tabs[(index + delta + this.tabs.length) % this.tabs.length];
    this.switchTo(next.id);
  }

  private scrollTabIntoView(tabId: string): void {
    this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`).get(0)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private setActiveClass(): void {
    this.strip.find('.tab-strip-tab').each((_index, element) => {
      const $element = $(element);
      const isActive = $element.data('tab-id') === this.activeId;
      $element.toggleClass('active', isActive);
      $element.attr('aria-selected', String(isActive));
    });
  }

  /** Hook for app.ts to refresh the word-count pill on tab switches. */
  onActiveChanged: ((tab: NoteTab) => void) | null = null;

  /** Hook for the cloud sync layer — fires after every model persist. */
  onPersist: ((payload: TabsSyncPayload) => void) | null = null;

  private notifyActiveChanged(): void {
    if (this.onActiveChanged) {
      const active = this.getActive();
      if (active) {
        this.onActiveChanged(active);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor — app.ts wires it up, other modules (utils, snapshots,
// unicode picker) read it through here.
// ---------------------------------------------------------------------------

let tabManagerInstance: TabManager | null = null;

export function setTabManager(manager: TabManager): void {
  tabManagerInstance = manager;
}

export function getTabManager(): TabManager | null {
  return tabManagerInstance;
}

/** Plain text of the note currently shown in the editor. */
export function getEditorText(): string {
  return tabManagerInstance?.getActiveText() ?? '';
}

/** HTML of the note currently shown in the editor. */
export function getEditorHtml(): string {
  const element = document.getElementById('note') as HTMLElement | null;
  return element ? element.innerHTML : '';
}

/** Replaces the editor content (already-sanitised on entry) and persists. */
export function setEditorHtml(html: string): void {
  const element = document.getElementById('note') as HTMLElement | null;
  if (!element) {
    return;
  }

  element.innerHTML = sanitizeNoteHtml(html);
  tabManagerInstance?.syncAfterExternalEdit();
}
