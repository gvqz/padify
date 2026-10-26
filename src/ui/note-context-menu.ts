/**
 * The note rail's right-click menu.
 *
 * Right-clicking a note in the rail opens this menu instead of the
 * browser's: the actions a note row can take, in one place — open,
 * rename, duplicate, change type, snapshot, share, copy, statistics,
 * close. It rides the editor context menu's `.padify-ctx` vocabulary
 * (same items, separators, submenu mechanics, fonts), so the two menus
 * read as siblings of one design system rather than two features.
 *
 * The menu targets the note UNDER THE CURSOR, not the active note —
 * background notes get the same treatment. Items that only make sense
 * for what is open (Share, Statistics) switch to the note first; items
 * that read content (Take snapshot, Copy note text) work from the model
 * directly, like the close flow does.
 *
 * Desktop: opens at the cursor (viewport-clamped), hover opens the type
 * submenu, Escape/outside click/scroll closes. Keyboard: arrows rove,
 * Enter activates, Escape closes. Touch long-press fires contextmenu and
 * works through the same path.
 */
import { $ } from '../lib/q';
import { showToast } from './toast';
import { registerLayer } from './behavior/layers';
import { openModal } from './behavior/modal';
import { getTabManager, type TabManager } from '../tabs';
import {
  DEFAULT_NOTE_TYPE,
  NOTE_TYPES,
  NOTE_TYPE_ICONS,
  type KnownNoteType,
  type NoteType,
} from '../editor/note-types';
import { deriveTabTitle, htmlToText } from '../editor/note-content';

/** Menu glyphs — 14px stroke icons on the items' leading edge. */
const ICONS = {
  open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>',
  rename:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  duplicate:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  type: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>',
  snapshot:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="14" r="3.5"/></svg>',
  share:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  stats:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/></svg>',
  close:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chevron:
    '<svg class="padify-ctx-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  check:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11"/></svg>',
};

/** The note the menu acts on — captured at open, cleared at close. */
let targetTabId: string | null = null;

function menu(): HTMLElement | null {
  return document.getElementById('noteCtxMenu');
}

function submenu(): HTMLElement | null {
  return document.querySelector('.note-ctx-submenu');
}

/**
 * Builds the static menu once — the rows never change, only which note
 * they act on and which type row shows the check.
 */
function buildMenuMarkup(): string {
  const typeRows = NOTE_TYPES.map(
    (def) => `
      <button type="button" class="padify-ctx-item note-ctx-type" role="menuitem"
        data-action="set-type" data-type="${def.id}">
        <span class="note-ctx-type-icon" aria-hidden="true">${
          NOTE_TYPE_ICONS[def.id as KnownNoteType]
            ? NOTE_TYPE_ICONS[def.id as KnownNoteType]!(13)
            : ''
        }</span>
        <span>${def.label}</span>
        <span class="note-ctx-check" data-type-check="${def.id}" hidden>${ICONS.check}</span>
      </button>`,
  ).join('');

  return `
  <div class="padify-ctx note-ctx" id="noteCtxMenu" role="menu" aria-label="Note actions" hidden>
    <div class="padify-ctx-scroll">
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="open">
        ${ICONS.open}<span>Open</span>
      </button>
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="rename">
        ${ICONS.rename}<span>Rename</span>
      </button>
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="duplicate">
        ${ICONS.duplicate}<span>Duplicate</span>
      </button>
      <div class="padify-ctx-item padify-ctx-parent note-ctx-parent" data-action="type-menu">
        <button type="button" class="padify-ctx-trigger" role="menuitem"
          aria-haspopup="true" aria-expanded="false">
          ${ICONS.type}<span>Change type</span>${ICONS.chevron}
        </button>
        <div class="padify-ctx-submenu note-ctx-submenu" role="menu" aria-label="Note type" hidden>
          ${typeRows}
        </div>
      </div>
      <div class="padify-ctx-sep" role="separator"></div>
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="snapshot">
        ${ICONS.snapshot}<span>Take snapshot</span>
      </button>
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="share">
        ${ICONS.share}<span>Share note</span>
      </button>
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="copy-text">
        ${ICONS.copy}<span>Copy note text</span>
      </button>
      <div class="padify-ctx-sep" role="separator"></div>
      <button type="button" class="padify-ctx-item" role="menuitem" data-action="stats">
        ${ICONS.stats}<span>Statistics</span>
      </button>
      <div class="padify-ctx-sep" role="separator"></div>
      <button type="button" class="padify-ctx-item padify-ctx-danger" role="menuitem" data-action="close">
        ${ICONS.close}<span>Close tab</span>
      </button>
    </div>
  </div>`;
}

export function initNoteContextMenu(): void {
  if (document.getElementById('noteCtxMenu')) {
    return;
  }
  document.body.insertAdjacentHTML('beforeend', buildMenuMarkup());
  const root = menu()!;
  const sub = submenu()!;
  const trigger = root.querySelector('.padify-ctx-trigger') as HTMLElement;

  const isOpen = () => !root.hidden;

  const closeSubmenu = (): void => {
    sub.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const close = (): void => {
    if (!isOpen()) {
      return;
    }
    root.hidden = true;
    closeSubmenu();
    targetTabId = null;
  };

  // Outside-click dismissal rides the dismissable-layer registry: the
  // capture-phase pointerdown sweep closes this menu when a click lands
  // elsewhere or another layer (a panel, a modal, the editor's own
  // context menu) opens.
  registerLayer({
    elements: [root],
    isOpen,
    setOpen: (open) => {
      if (!open) {
        close();
      }
    },
  });

  const openSubmenu = (): void => {
    markCurrentType();
    sub.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  };

  /** The type rows check the note's CURRENT kind; a foreign kind (sync)
   *  keeps every row unchecked. */
  function markCurrentType(): void {
    const tabs = getTabManager();
    const tab = tabs?.getTabs().find((entry) => entry.id === targetTabId);
    const current = (tab?.noteType ?? DEFAULT_NOTE_TYPE) as string;
    sub.querySelectorAll<HTMLElement>('[data-type-check]').forEach((chip) => {
      chip.hidden = chip.getAttribute('data-type-check') !== current;
    });
  }

  /** Fresh content for the note: the ACTIVE note's editor may hold words
   *  the model has not seen — the close flow's rule, reused here. For
   *  html kinds the readable text is what gets copied, not the markup;
   *  text kinds (markdown, a task list's json) copy as stored. */
  function noteText(tabs: TabManager, tabId: string): string {
    const tab = tabs.getTabs().find((entry) => entry.id === tabId);
    if (!tab) {
      return '';
    }
    if (tab.id === tabs.getActive()?.id) {
      tabs.saveActiveFromEditor();
    }
    return htmlToText(tab.content);
  }

  /** Clipboard with the share module's seatbelt: the async API rejects
   *  on http origins and permission-denied headless contexts, and the
   *  note text is exactly the thing a user cannot re-type — fall back
   *  to the hidden-textarea execCommand path before admitting defeat. */
  async function copyNoteText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Note text copied.');
      return;
    } catch {
      /* the legacy path below owns it */
    }
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.left = '-9999px';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    showToast(ok ? 'Note text copied.' : 'Could not copy the note text.');
  }

  function act(action: string, payload?: string): void {
    const tabs = getTabManager();
    const tabId = targetTabId;
    close();
    if (!tabs || !tabId) {
      return;
    }

    switch (action) {
      case 'open':
        tabs.switchTo(tabId);
        break;
      case 'rename':
        tabs.beginRename(tabId);
        break;
      case 'duplicate':
        tabs.duplicateNote(tabId);
        break;
      case 'set-type':
        tabs.changeNoteType(tabId, payload as NoteType);
        break;
      case 'snapshot': {
        const tab = tabs.getTabs().find((entry) => entry.id === tabId);
        if (!tab) {
          return;
        }
        if (tab.id === tabs.getActive()?.id) {
          tabs.saveActiveFromEditor();
        }
        const manager = window.snapshotsManager;
        if (!manager) {
          showToast('Snapshots are not available right now.');
          return;
        }
        void manager
          .createSnapshotFromNote(
            tab.content,
            tab.noteType,
            tab.id,
            `From the note menu — "${deriveTabTitle(tab)}"`,
            tab.colorTheme,
            tab.name ?? undefined,
          )
          .then(() => showToast('Snapshot taken.'))
          .catch(() => showToast('Could not take the snapshot.'));
        break;
      }
      case 'share':
        // The share panel reads the ACTIVE note — open the note, then
        // its panel, through the same trigger the topbar uses.
        tabs.switchTo(tabId);
        $('#shareNotes').trigger('click');
        break;
      case 'copy-text': {
        const text = noteText(tabs, tabId);
        if (!text.trim()) {
          showToast('This note is empty — nothing to copy.');
          return;
        }
        void copyNoteText(text);
        break;
      }
      case 'stats':
        tabs.switchTo(tabId);
        openModal($('#statisticsModal').get(0));
        break;
      case 'close':
        tabs.requestCloseTab(tabId);
        break;
      default:
        break;
    }
  }

  // ---- opening ------------------------------------------------------------

  const openAt = (x: number, y: number): void => {
    // The width/height come from layout offsets — getBoundingClientRect
    // would read the vz-menu-in animation's transformed box and skew the
    // flip math (the editor menu's lesson, kept).
    root.hidden = false;
    closeSubmenu();
    const width = root.offsetWidth || 232;
    const height = root.offsetHeight || 360;
    const margin = 8;
    let left = x + 2;
    let top = y + 2;
    if (left + width > window.innerWidth - margin) left = x - width - 2;
    if (top + height > window.innerHeight - margin) top = y - height - 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;

    const first = root.querySelector<HTMLElement>('.padify-ctx-item:not([disabled])');
    first?.focus();
  };

  // The rail delegates: one listener on the strip covers every row the
  // strip ever renders, drawer and desktop alike.
  const strip = document.getElementById('tabStripTabs');
  strip?.addEventListener('contextmenu', (event) => {
    const mouse = event as MouseEvent;
    const row = (mouse.target as HTMLElement).closest<HTMLElement>('.tab-strip-tab');
    if (!row) {
      return;
    }
    event.preventDefault();
    // The editor menu's capture handler closed itself for this gesture;
    // it never sees the rail. Selecting the note would change the active
    // tab as a SIDE EFFECT of right-clicking — menus target what they
    // opened on, so no switch happens here.
    const tabs = getTabManager();
    const tabId = row.dataset.tabId ?? null;
    if (!tabs || !tabId || !tabs.getTabs().some((entry) => entry.id === tabId)) {
      return;
    }
    targetTabId = tabId;
    openAt(Math.round(mouse.clientX), Math.round(mouse.clientY));
  });

  // ---- activation ---------------------------------------------------------

  root.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('.padify-ctx-item');
    if (!item || item.classList.contains('padify-ctx-parent')) {
      return;
    }
    const action = item.dataset.action ?? '';
    act(action, item.dataset.type);
  });

  // Hover opens the type flyout on pointer devices; leaving either the
  // row or the flyout closes it (the editor menu's timers, simplified —
  // one close delay shared by both edges).
  let subTimer: ReturnType<typeof setTimeout> | null = null;
  const parentRow = root.querySelector('.note-ctx-parent') as HTMLElement;
  parentRow.addEventListener('mouseenter', () => {
    if (subTimer) {
      clearTimeout(subTimer);
      subTimer = null;
    }
    if (!sub.hidden) {
      return;
    }
    subTimer = setTimeout(openSubmenu, 120);
  });
  parentRow.addEventListener('mouseleave', () => {
    if (subTimer) {
      clearTimeout(subTimer);
    }
    subTimer = setTimeout(() => {
      subTimer = null;
      if (!sub.contains(document.activeElement)) {
        closeSubmenu();
      }
    }, 200);
  });
  sub.addEventListener('mouseenter', () => {
    if (subTimer) {
      clearTimeout(subTimer);
      subTimer = null;
    }
  });

  // ---- keyboard -----------------------------------------------------------

  const rove = (items: HTMLElement[], index: number): void => {
    if (items.length > 0) {
      items[(index + items.length) % items.length].focus();
    }
  };
  const visibleItems = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('.padify-ctx-item')).filter(
      (item) => item.closest('[hidden]') === null,
    );

  root.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    const items = visibleItems();
    const index = items.indexOf(document.activeElement as HTMLElement);

    if (key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      rove(items, index + (key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      rove(items, key === 'Home' ? 0 : items.length - 1);
      return;
    }
    // ArrowRight on the parent row opens the flyout and focuses it.
    if (key === 'ArrowRight' && document.activeElement === trigger) {
      event.preventDefault();
      openSubmenu();
      (sub.querySelector('.padify-ctx-item') as HTMLElement | null)?.focus();
      return;
    }
    // Tab leaves the menu — close first, let the focus move on.
    if (key === 'Tab') {
      close();
    }
  });

  sub.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    const items = Array.from(sub.querySelectorAll<HTMLElement>('.padify-ctx-item')).filter(
      (item) => !item.closest('[hidden]'),
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      rove(items, index + (key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (key === 'ArrowLeft' || key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSubmenu();
      trigger.focus();
    }
  });

  // Scroll or leaving the window dismisses — the menu is anchored to a
  // viewport position, and a moved page invalidates it.
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener(
    'scroll',
    (event) => {
      if (event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      if (isOpen()) {
        close();
      }
    },
    true,
  );
}
