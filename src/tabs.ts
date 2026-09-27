/**
 * Padify note tabs — multiple notes in one editor.
 *
 * Tabs live on the main page alongside the rich text formatting (merged in
 * from the old standalone Tabbypad tool, which no longer ships as a separate
 * page). Every tab is an independent note with its own rich content,
 * autosaved per-record into the padify IndexedDB store (see src/storage/):
 *
 *   notes store    → one row per note: { id, name, html, createdAt,
 *                    updatedAt, position } — deletions are rows with
 *                    deleted=true (tombstones), exactly like the cloud
 *                    schema; a save writes only the changed rows
 *   kv store       → padifyActiveTab holds the id of the tab in the editor
 *
 * A legacy blob mirror keeps the old `padifyTabs` localStorage key fresh for
 * service-worker-cached pre-storage app versions (bounded cadence — see
 * storage/notes.ts), and IndexedDB-unavailable browsers fall back to the
 * blob format entirely.
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

import { $, type Q } from './lib/q';
import Swal from 'sweetalert2';
import { showToast } from './utils';
import {
  ACTIVE_TAB_KEY,
  loadNotes,
  saveNotes,
  stateGet,
  stateRemove,
  type StoredNoteTab,
} from './storage';
import { getEditorPort } from './editor/port';
import {
  DEFAULT_NOTE_TYPE,
  normalizeNoteType,
  NOTE_TYPE_ICONS,
  noteTypeLabel,
  type NoteType,
} from './editor/note-types';

export type { NoteType } from './editor/note-types';

export interface NoteTab {
  id: string;
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  html: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The note kind — absent means the default (standard). See
   * editor/note-types.ts; kept optional so existing rows need no migration.
   */
  noteType?: NoteType;
}

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

/** Notifies the rail's count badge (and any other listener) about tab count. */
const RAIL_COUNT_ID = 'tabRailCount';

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
  '- Multiple notes live in the sidebar on the left — plus bold, italic,',
  '  underline and strikethrough formatting that renders right inside the',
  '  editor (right-click to try it).',
  '- Note types: use the arrow beside "New note" to create rich text',
  '  notes with headings, lists, quotes, code blocks and links.',
  '- Voice typing: click the mic in the top bar (or press alt/option + v)',
  '  and just talk.',
  '- Optional cloud sync: click the cloud icon in the top bar to back up',
  '  your notes and pick them up on any other device.',
  '- Signed in? Share any note with a read-only link that expires on its',
  '  own and can be cancelled any time (share icon in the top bar).',
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
  '- Full-screen mode for a distraction-free writing experience.',
  '- Floating window (in supported browsers) to effectively take notes across other apps.',
  '- Download notes as plain text, PDF, HTML, and DOCX file.',
  '- Play music while you write — free song search with no account, or connect your Spotify — and mix 12 ambience sounds to help you focus.',
  '',
  "CAUTION: Since the app stores your notes on your own device, it's",
  'recommended that you take a backup of your notes more often using the',
  '"Download Notes" button or by pressing the "ctrl/command + s" keys.',
  '',
  '<b>Delete this text and start writing your notes</b>',
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

/**
 * The tags a note may contain. Inline tags are the classic formatting
 * subset; the block + link tags are the rich text note vocabulary, and
 * sup/sub/hr join for the Docs-style controls (scripts, rules). Everything
 * else is unwrapped to its text on load.
 */
const ALLOWED_TAGS = new Set([
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'S',
  'STRIKE',
  'DEL',
  'BR',
  'DIV',
  'SPAN',
  'P',
  'H1',
  'H2',
  'H3',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'SUP',
  'SUB',
  'HR',
  'A',
]);

/**
 * Attributes a surviving tag may keep. Everything else is stripped — the
 * editor only ever produces these itself. `a[href]` is gated to safe
 * schemes below; `style` is gated to the property allowlist beneath it;
 * the checklist data attributes are gated to their fixed vocabularies.
 */
const ALLOWED_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['A', new Set(['href'])],
  ['SPAN', new Set(['style'])],
  ['DIV', new Set(['style'])],
  ['P', new Set(['style'])],
  ['H1', new Set(['style'])],
  ['H2', new Set(['style'])],
  ['H3', new Set(['style'])],
  ['UL', new Set(['data-rich-checklist'])],
  ['LI', new Set(['style', 'data-checked'])],
  ['BLOCKQUOTE', new Set(['style'])],
  ['PRE', new Set(['style'])],
]);

/**
 * Data-attribute values that may survive, by attribute. The checklist mark
 * is a boolean flag and the item state a boolean pair — anything else is a
 * crafted payload, not editor output.
 */
const ALLOWED_DATA_ATTR_VALUES: ReadonlyMap<string, RegExp> = new Map([
  ['data-rich-checklist', /^true$/],
  ['data-checked', /^(true|false)$/],
]);

/**
 * CSS a stored note may keep, split by tag class. The editor only ever
 * produces these declarations itself (the Docs-style controls), but notes
 * also come back from storage and cloud sync — the allowlist is the wall
 * that keeps a crafted payload from carrying url()/expression() or layout
 * hijacks into the surface.
 */
const COLOR_VALUE_PATTERN =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*(0?\.\d+|1)\s*)?\)|[a-z]+)$/i;
const FONT_FAMILY_VALUE_PATTERN = /^[-a-z0-9\s,'’]{1,120}$/i;

const INLINE_STYLE_PROPS: ReadonlyMap<string, RegExp> = new Map([
  ['color', COLOR_VALUE_PATTERN],
  ['background-color', COLOR_VALUE_PATTERN],
  ['font-size', /^\d+(\.\d+)?(px|pt)$/],
  ['font-family', FONT_FAMILY_VALUE_PATTERN],
]);

const BLOCK_STYLE_PROPS: ReadonlyMap<string, RegExp> = new Map([
  ['text-align', /^(left|center|right|justify)$/i],
  ['margin-left', /^\d+(\.\d+)?px$/],
]);

function sanitizeStyle(raw: string, inline: boolean): string | null {
  const allowed = inline ? INLINE_STYLE_PROPS : BLOCK_STYLE_PROPS;
  const kept: string[] = [];
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const pattern = allowed.get(prop);
    if (pattern && pattern.test(value)) {
      kept.push(`${prop}: ${value}`);
    }
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * Link schemes a stored href may use. javascript:/data:/vbscript: and
 * friends are dropped (the anchor keeps its text, just without a target).
 */
const SAFE_HREF_PATTERN = /^(https?:|mailto:|#|\/)/i;

function sanitizeHref(raw: string): string | null {
  const href = raw.trim();
  return href.length > 0 && SAFE_HREF_PATTERN.test(href) ? href : null;
}

/**
 * Strips the stored HTML down to the formatting subset the editor produces:
 * known inline/block tags survive (with their one allowed attribute where
 * declared), everything else is unwrapped to its text. Guards the innerHTML
 * round-trip against stray markup.
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

    const allowedAttrs = ALLOWED_ATTRS.get(element.tagName);
    if (allowedAttrs) {
      allowedAttrs.forEach((attr) => {
        const value = element.getAttribute(attr);
        if (value === null) {
          return;
        }
        if (attr === 'href') {
          const safe = sanitizeHref(value);
          if (safe !== null) {
            clone.setAttribute(attr, safe);
          }
          return;
        }
        if (attr === 'style') {
          const safe = sanitizeStyle(value, element.tagName === 'SPAN');
          if (safe !== null) {
            clone.setAttribute(attr, safe);
          }
          return;
        }
        const dataPattern = ALLOWED_DATA_ATTR_VALUES.get(attr);
        if (dataPattern) {
          if (dataPattern.test(value)) {
            clone.setAttribute(attr, value);
          }
          return;
        }
        clone.setAttribute(attr, value);
      });
    }

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

  /** Block tags read as line boundaries, like innerText would report them. */
  const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'LI', 'HR']);

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
    // Checklist items read with their box state — the plain-text twin of
    // the rendered checkbox.
    if (element.tagName === 'LI') {
      const list = element.parentElement;
      if (list instanceof HTMLElement && list.hasAttribute('data-rich-checklist')) {
        if (parts.length > 0) {
          parts.push('\n');
        }
        parts.push(element.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ');
        element.childNodes.forEach(walk);
        return;
      }
    }
    if (BLOCK_TAGS.has(element.tagName)) {
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
    .map((line) => line.trim())
    .find((line) => line.length > 0);

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

function createTab(
  html: string = '',
  name: string | null = null,
  noteType: NoteType = DEFAULT_NOTE_TYPE,
): NoteTab {
  const now = Date.now();
  const tab: NoteTab = { id: createTabId(), name, html, createdAt: now, updatedAt: now };
  if (noteType !== DEFAULT_NOTE_TYPE) {
    tab.noteType = noteType;
  }
  return tab;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class TabManager {
  private tabs: NoteTab[] = [];
  private activeId: string | null = null;
  private readonly editor: Q;
  private readonly strip: Q;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tombstones: TabTombstone[] = [];
  private dirtyIds: Set<string> = new Set();
  private persistListeners: Set<(payload: TabsSyncPayload) => void> = new Set();
  private activeListeners: Set<(tab: NoteTab) => void> = new Set();

  constructor(editor: Q) {
    this.editor = editor;
    this.strip = $('#tabStripTabs');
  }

  /**
   * Loads (or bootstraps) the model and paints the strip + editor. Awaited
   * by app.ts after the storage layer hydrated (see storage/index.ts).
   */
  async init(): Promise<void> {
    const snapshot = await loadNotes();
    this.tabs = this.loadModel(snapshot.tabs);
    this.tombstones = snapshot.tombstones.filter(
      (entry) => entry && typeof entry.id === 'string' && typeof entry.updatedAt === 'number',
    );
    this.migrateLegacyNote();

    const savedActive = stateGet(ACTIVE_TAB_KEY);
    this.activeId = this.tabs.some((tab) => tab.id === savedActive)
      ? savedActive
      : (this.tabs[0]?.id ?? null);

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

  /** Validates + sanitises a stored row into the editor-safe model shape. */
  private loadModel(entries: StoredNoteTab[]): NoteTab[] {
    return entries
      .filter((entry) => entry && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : null,
        html: typeof entry.html === 'string' ? sanitizeNoteHtml(entry.html) : '',
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
        noteType: normalizeNoteType(entry.noteType),
      }));
  }

  /**
   * One-time migration from the legacy single-note `note` key. Runs after
   * the snapshot load so an existing tab list wins over the old note.
   */
  private migrateLegacyNote(): void {
    const legacy = stateGet(LEGACY_NOTE_KEY);

    if (legacy === null) {
      return;
    }

    stateRemove(LEGACY_NOTE_KEY);

    if (this.tabs.length > 0 || legacy.trim() === '') {
      return;
    }

    this.tabs.unshift(createTab(legacyTextToHtml(legacy)));
    this.persist();
  }

  /**
   * Persists the model (write-behind — see storage/notes.ts) and notifies
   * the sync layer + persist listeners. `immediate=false` marks the typing
   * path: the IndexedDB diff still runs, the legacy blob mirror is
   * throttled.
   */
  private persist(immediate = true): void {
    saveNotes({ tabs: this.tabs, tombstones: this.tombstones }, this.activeId, { immediate });

    const payload = this.exportForSync();
    if (this.onPersist) {
      this.onPersist(payload);
    }
    this.persistListeners.forEach((listener) => listener(payload));
  }

  /**
   * Extra persist listeners (save indicator, share-link freshness, …). The
   * cloud sync layer keeps using the onPersist slot; everyone else registers
   * here so features can coexist without chaining over each other.
   */
  addPersistListener(listener: (payload: TabsSyncPayload) => void): () => void {
    this.persistListeners.add(listener);
    return () => {
      this.persistListeners.delete(listener);
    };
  }

  /**
   * Fires whenever the active note changed (switch, create, external merge).
   * Used by type-aware editor chrome (e.g. the rich text toolbar) that must
   * follow the note without each feature grabbing the single onActiveChanged
   * slot.
   */
  addActiveListener(listener: (tab: NoteTab) => void): () => void {
    this.activeListeners.add(listener);
    return () => {
      this.activeListeners.delete(listener);
    };
  }

  // ---- sync support ---------------------------------------------------------

  /**
   * Persists the tombstone list (they live as deleted rows in the notes
   * store — see storage/notes.ts).
   */
  private persistTombstones(): void {
    saveNotes({ tabs: this.tabs, tombstones: this.tombstones }, this.activeId, { immediate: true });
  }

  /** Records a tab deletion so the cloud can mirror it (tombstone). */
  private recordTombstone(tabId: string): void {
    if (this.tombstones.some((entry) => entry.id === tabId)) {
      return;
    }
    this.tombstones.push({ id: tabId, updatedAt: Date.now() });
    this.persistTombstones();
  }

  /** Snapshot of the model for the cloud sync layer. */
  exportForSync(): TabsSyncPayload {
    return {
      tabs: this.tabs.map((tab) => ({ ...tab })),
      dirty: [...this.dirtyIds],
      tombstones: this.tombstones.map((entry) => ({ ...entry })),
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
    this.tombstones = this.tombstones.filter((entry) => !confirmed.has(entry.id));
    this.persistTombstones();
  }

  /**
   * Replaces the model with a merged tab list coming from the sync layer.
   * The editor only reloads when the user is not actively typing in it, so a
   * background pull can never swallow keystrokes.
   */
  applyExternalMerge(nextTabs: NoteTab[]): void {
    const activeBefore = this.getActive();

    this.tabs = nextTabs.map((tab) => ({
      ...tab,
      html: sanitizeNoteHtml(tab.html),
    }));

    if (!this.tabs.some((tab) => tab.id === this.activeId)) {
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
      const contentChanged =
        !activeBefore || activeBefore.id !== active.id
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
      this.persist(false);
    }, 400);
  }

  getActive(): NoteTab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  /** Saves the editor's current HTML into the active tab. */
  saveActiveFromEditor(): void {
    const active = this.getActive();
    if (!active) {
      return;
    }

    const html = this.editor.html();
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

    active.html = this.editor.html();
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
    const stripElement = this.strip.get(0) as HTMLElement | undefined;
    if (!stripElement) {
      return;
    }

    // Rebuild by clearing the node directly so event handlers die with the
    // children (no retained listeners on surviving parents).
    stripElement.textContent = '';

    this.tabs.forEach((tab) => {
      stripElement.appendChild(this.buildTabElement(tab));
    });

    this.renderRailCount();
  }

  private renderRailCount(): void {
    const count = document.getElementById(RAIL_COUNT_ID);
    if (count) {
      count.textContent = String(this.tabs.length);
    }
  }

  private buildTabElement(tab: NoteTab): HTMLElement {
    const button = document.createElement('div');
    button.className = 'tab-strip-tab' + (tab.id === this.activeId ? ' active' : '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === this.activeId));
    button.dataset.tabId = tab.id;
    button.title = tab.name ? tab.name : 'Double-click to rename';

    if (tab.noteType && tab.noteType !== DEFAULT_NOTE_TYPE) {
      const typeBadge = document.createElement('span');
      typeBadge.className = 'tab-strip-type';
      typeBadge.title = `${noteTypeLabel(tab.noteType)} — created via the type menu`;
      typeBadge.setAttribute('aria-hidden', 'true');
      typeBadge.innerHTML = NOTE_TYPE_ICONS[tab.noteType](10);
      button.appendChild(typeBadge);
    }

    const title = document.createElement('span');
    title.className = 'tab-strip-title';
    title.textContent = deriveTabTitle(tab);
    button.appendChild(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-strip-close';
    close.setAttribute('aria-label', `Close tab ${deriveTabTitle(tab)}`);
    close.title = 'Close tab';
    close.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    button.appendChild(close);

    return button;
  }

  private refreshTabLabel(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
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

  addTab(focusEditor = true, noteType: NoteType = DEFAULT_NOTE_TYPE): void {
    this.saveActiveFromEditor();

    const tab = createTab('', null, noteType);
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.dirtyIds.add(tab.id);
    this.persist();

    this.strip.get(0)!.appendChild(this.buildTabElement(tab));
    this.setActiveClass();
    this.renderRailCount();
    this.loadActiveIntoEditor();
    this.scrollTabIntoView(tab.id);

    if (focusEditor) {
      (this.editor.get(0) as HTMLElement).focus();
    }

    this.notifyActiveChanged();
    showToast(
      noteType === DEFAULT_NOTE_TYPE
        ? 'New note created.'
        : `New ${noteTypeLabel(noteType).toLowerCase()} created.`,
    );
  }

  private requestCloseTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
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

      const index = this.tabs.findIndex((entry) => entry.id === tabId);
      this.tabs = this.tabs.filter((entry) => entry.id !== tabId);
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
      cancelButtonText: 'Keep it',
    }).then((result) => {
      if (result.isConfirmed) {
        closeNow();
      }
    });
  }

  private beginRename(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    const element = this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`);
    if (!tab || element.length === 0 || element.find('.tab-strip-rename').length > 0) {
      return;
    }

    const titleElement = element.find('.tab-strip-title');
    const currentName = tab.name ?? deriveTabTitle(tab);

    const input = $(
      '<input type="text" class="tab-strip-rename" maxlength="60" aria-label="Tab name">',
    ).val(currentName);
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
      element
        .find('.tab-strip-rename')
        .replaceWith($('<span class="tab-strip-title"></span>').text(deriveTabTitle(tab)));
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

    const index = this.tabs.findIndex((entry) => entry.id === this.activeId);
    const next = this.tabs[(index + delta + this.tabs.length) % this.tabs.length];
    this.switchTo(next.id);
  }

  private scrollTabIntoView(tabId: string): void {
    (
      this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`).get(0) as HTMLElement | undefined
    )?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    const active = this.getActive();
    if (!active) {
      return;
    }
    if (this.onActiveChanged) {
      this.onActiveChanged(active);
    }
    this.activeListeners.forEach((listener) => listener(active));
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

/**
 * HTML of the note currently shown in the editor. Routed through the
 * EditorPort (see editor/port.ts) with a bare-DOM fallback for the rare
 * paths that run before the composition root installed the port.
 */
export function getEditorHtml(): string {
  const port = getEditorPort();
  if (port) {
    return port.getHtml();
  }
  const element = document.getElementById('note') as HTMLElement | null;
  return element ? element.innerHTML : '';
}

/** Replaces the editor content (sanitized in the port) and persists. */
export function setEditorHtml(html: string): void {
  const port = getEditorPort();
  if (port) {
    port.setHtml(html);
    return;
  }

  const element = document.getElementById('note') as HTMLElement | null;
  if (!element) {
    return;
  }

  element.innerHTML = sanitizeNoteHtml(html);
  tabManagerInstance?.syncAfterExternalEdit();
}
