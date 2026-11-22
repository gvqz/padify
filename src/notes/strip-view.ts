/**
 * The tab strip view — the DOM half of the note model, extracted from the
 * TabManager (S2). Everything the strip LOOKS like lives here: building
 * the tab elements (badges, titles, close affordances), the delegated
 * event wiring (click/auxclick/dblclick), the inline rename editor, the
 * active-tab highlighting, the rail's count badge and the document title.
 * Everything the strip DOES is a command back to its host — the manager
 * (tabs.ts), which owns the model, the editor and the persistence. The
 * view holds no state of its own beyond the strip element: it renders
 * from the host's model on demand and stays otherwise inert.
 *
 * The listener-lifecycle rules hold here as they did in the manager: the
 * strip's single delegated listener set is bound once (bind), child nodes
 * are rebuilt by clearing the parent (render), and the rename editor's
 * commit settles exactly once (Enter fires it; the blur that follows the
 * input's replacement must not fire it again).
 */

import { $, type Q } from '../lib/q';
import { noteStripBadge } from '../editor/note-projections';
import { deriveTabTitle } from '../editor/note-content';
import { hasVoiceRecording } from '../../shared/att-refs';
import {
  DEFAULT_NOTE_TYPE,
  NOTE_TYPE_ICONS,
  noteTypeLabel,
  type KnownNoteType,
} from '../editor/note-types';
import { getSetting, onChangeSetting } from '../state/settings';
import { isInstalledDisplayMode } from '../install-pwa';
import { showToast } from '../ui/toast';
import type { NoteTab } from './domain';

/** Notifies the rail's count badge (and any other listener) about tab count. */
const RAIL_COUNT_ID = 'tabRailCount';

/**
 * Whether the identification badges beside each note's name are wanted —
 * the "Note badges" preference (the voice mic, the type icons, the list
 * dot). Absent = the default = shown, so existing installs keep their
 * badges with no migration. The conflict badge is NOT governed by this:
 * it is an actionable alert (its click opens the review sheet), not
 * identification, and hiding an alert would strand the user in a
 * conflict they can no longer see.
 */
function noteBadgesWanted(): boolean {
  return getSetting('userChosenNoteBadges') !== 'No';
}

/**
 * The commands and reads the strip needs from its host — the manager.
 * Narrow on purpose: the view cannot reach the model's internals, only
 * ask the questions a strip is allowed to ask.
 */
export interface TabStripHost {
  /** The live model, in strip order. */
  modelTabs(): readonly NoteTab[];
  /** The active tab id. */
  activeTabId(): string | null;
  /** Whether a note carries a parked version conflict (the ledger's read). */
  isConflicted(tabId: string): boolean;
  /** The review sheet's gesture — the conflict badge's click. */
  onConflictReview(tabId: string): void;
  switchTo(tabId: string): void;
  requestCloseTab(tabId: string): void;
  addTab(): void;
  focusEditor(): void;
  /**
   * The rename commit: the model half (trim, guard, stamp, mark dirty,
   * persist) plus the label refresh. Returns whether the name moved —
   * the view owns the toast.
   */
  commitRename(tabId: string, name: string): boolean;
}

export class TabStripView {
  private readonly strip: Q;

  constructor(
    strip: Q,
    private readonly host: TabStripHost,
  ) {
    this.strip = strip;
    // The strip redraws itself when the Note-badges preference moves: the
    // view is the thing that paints the badges, so the re-render belongs
    // here — a pure view concern, no manager round-trip.
    onChangeSetting('userChosenNoteBadges', () => this.render());
  }

  /** Rebuilds the strip from the host's model — the render after any
   *  model-level change (load, merge, reorder, close). */
  render(): void {
    const stripElement = this.strip.get(0) as HTMLElement | undefined;
    if (!stripElement) {
      return;
    }

    // Rebuild by clearing the node directly so event handlers die with the
    // children (no retained listeners on surviving parents).
    stripElement.textContent = '';

    this.host.modelTabs().forEach((tab) => {
      stripElement.appendChild(this.buildTabElement(tab));
    });

    this.renderRailCount();
  }

  /** Refreshes one tab's label in place — the typing path's cheap update
   *  (a full strip rebuild per keystroke would drop the rename input and
   *  the hover states). */
  refreshLabel(tabId: string): void {
    const tab = this.host.modelTabs().find((entry) => entry.id === tabId);
    const element = this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`);
    if (!tab || element.length === 0) {
      return;
    }

    element.find('.tab-strip-title').text(deriveTabTitle(tab));
    // A task list's strip badge is its color — the same save that lands
    // the new color in the note repaints the circle (the rail's dot
    // follows the aggregate; the strip needed its own refresh).
    const listDot = element.find('.tab-strip-list-dot');
    if (listDot.length > 0) {
      const badge = noteStripBadge(tab.content, tab.noteType);
      if (badge) {
        listDot.attr('data-color', badge.color);
      }
    }
    if (tab.id === this.host.activeTabId()) {
      this.syncDocumentTitle();
    }
  }

  /** The count badge on the rail. */
  renderRailCount(): void {
    const count = document.getElementById(RAIL_COUNT_ID);
    if (count) {
      count.textContent = String(this.host.modelTabs().length);
    }
  }

  /** Appends one newly added tab without rebuilding the strip. */
  append(tab: NoteTab): void {
    const stripElement = this.strip.get(0);
    if (!stripElement) {
      return;
    }
    stripElement.appendChild(this.buildTabElement(tab));
    this.setActiveClass();
    this.renderRailCount();
  }

  /** Re-points the active classes after a switch (no rebuild). */
  setActiveClass(): void {
    this.strip.find('.tab-strip-tab').each((_index, element) => {
      const $element = $(element);
      const isActive = $element.data('tab-id') === this.host.activeTabId();
      $element.toggleClass('active', isActive);
      $element.attr('aria-selected', String(isActive));
    });
  }

  scrollTabIntoView(tabId: string): void {
    (
      this.strip.find(`.tab-strip-tab[data-tab-id="${tabId}"]`).get(0) as HTMLElement | undefined
    )?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * The browser tab mirrors the note's name so a row of pinned tabs
   * says which note each holds. Follows every path the tab strip label
   * follows (typing, rename, switch), through the same deriveTabTitle,
   * so the two never disagree. Two naming rules from the task list: the
   * separator is a plain hyphen-minus " - " (nothing that can read as
   * part of the note's own name — emdash and pipe both did), and an
   * INSTALLED app gets the bare note name — the standalone window's
   * chrome already says "Padify", and "Padify - Padify" is what a
   * suffix produced there.
   */
  syncDocumentTitle(): void {
    const active = this.host.modelTabs().find((entry) => entry.id === this.host.activeTabId());
    if (!active) {
      document.title = 'Padify';
      return;
    }
    document.title = isInstalledDisplayMode()
      ? deriveTabTitle(active)
      : `${deriveTabTitle(active)} - Padify`;
  }

  /** Binds the strip's delegated events — once, at init. */
  bind(): void {
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

      if (target.closest('.tab-strip-conflict')) {
        // The review badge is its own gesture — opening the review sheet
        // must not also switch notes under it.
        event.stopPropagation();
        this.host.onConflictReview(tabId);
        return;
      }

      if (target.closest('.tab-strip-close')) {
        event.stopPropagation();
        this.host.requestCloseTab(tabId);
        return;
      }

      if (tabId !== this.host.activeTabId()) {
        this.host.switchTo(tabId);
      } else {
        this.host.focusEditor();
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
        this.host.requestCloseTab(tabElement.dataset.tabId!);
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
      this.host.addTab();
    });
  }

  /** Builds one tab element — badges, title, close affordance. */
  private buildTabElement(tab: NoteTab): HTMLElement {
    const button = document.createElement('div');
    button.className = 'tab-strip-tab' + (tab.id === this.host.activeTabId() ? ' active' : '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === this.host.activeTabId()));
    button.dataset.tabId = tab.id;
    button.title = tab.name ? tab.name : 'Double-click to rename';

    // A parked version conflict gets the review badge. Its click is
    // DELEGATED through the strip (the single listener bind() owns), per
    // the listener-lifecycle rules — nothing per-node.
    if (this.host.isConflicted(tab.id)) {
      const conflictBadge = document.createElement('span');
      conflictBadge.className = 'tab-strip-type tab-strip-conflict';
      conflictBadge.title = 'Changed on two devices — review the versions';
      conflictBadge.setAttribute('role', 'button');
      conflictBadge.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="12" r="2.6"/><path d="M8.2 7.4 15.5 11M8.2 16.6 15.5 13"/></svg>';
      button.appendChild(conflictBadge);
    }

    // The identification badges (list dot, voice mic, type icon) answer to
    // the Note-badges preference — off means the tab is just its name and
    // its close button. The conflict badge above is NOT part of that deal
    // (see noteBadgesWanted).
    if (noteBadgesWanted()) {
      const stripBadge = noteStripBadge(tab.content, tab.noteType);
      if (stripBadge) {
        // A task list's badge is its own colored circle — the rail shows
        // the note AS a list (the projection seam reads the model).
        const listDot = document.createElement('span');
        listDot.className = 'tab-strip-type tab-strip-list-dot';
        listDot.title = 'Task list';
        listDot.setAttribute('aria-hidden', 'true');
        listDot.dataset.color = stripBadge.color;
        button.appendChild(listDot);
      } else if (hasVoiceRecording(tab.content)) {
        // A voice note outranks its type badge: what the note CARRIES is
        // the louder fact about it (the type badge reads the same for every
        // rich note; the mic says which one holds a recording).
        const voiceBadge = document.createElement('span');
        voiceBadge.className = 'tab-strip-type';
        voiceBadge.title = 'Voice note';
        voiceBadge.setAttribute('aria-hidden', 'true');
        voiceBadge.innerHTML =
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="11.5" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18.5V21" /></svg>';
        button.appendChild(voiceBadge);
      } else if (tab.noteType && tab.noteType !== DEFAULT_NOTE_TYPE) {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'tab-strip-type';
        typeBadge.title = `${noteTypeLabel(tab.noteType)} — created via the type menu`;
        typeBadge.setAttribute('aria-hidden', 'true');
        // Icons exist for known types; a future type still badges, with the
        // registry's plain-text mark standing in until this build learns it.
        const icon = NOTE_TYPE_ICONS[tab.noteType as KnownNoteType];
        typeBadge.innerHTML = icon
          ? icon(10)
          : `<span style="font-size:9px;font-weight:700;line-height:1">${noteTypeLabel(tab.noteType).charAt(0).toLowerCase()}</span>`;
        button.appendChild(typeBadge);
      }
    }

    const title = document.createElement('span');
    title.className = 'tab-strip-title';
    title.textContent = deriveTabTitle(tab);
    button.appendChild(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-strip-close';
    close.setAttribute('aria-label', `Move ${deriveTabTitle(tab)} to trash`);
    close.title = 'Move to trash';
    close.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    button.appendChild(close);

    return button;
  }

  /** The inline rename editor — double-click a tab to rename it. */
  beginRename(tabId: string): void {
    const tab = this.host.modelTabs().find((entry) => entry.id === tabId);
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

    // The commit settles ONCE: Enter fires it, and the blur that follows
    // (the input is replaced, focus moves) would fire it again — a double
    // persist, a double "renamed" toast, and two DOM swaps racing the
    // browser's own blur fixup (Chromium's replaceWith can throw
    // NotFoundError when the node's focus bookkeeping moves mid-swap —
    // its error text says as much). The second and later calls no-op.
    let settled = false;
    const commit = (keep: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = String(input.val() ?? '').trim();
      if (keep && raw && raw !== currentName) {
        if (this.host.commitRename(tabId, raw)) {
          showToast('Tab renamed.');
        }
      }
      // Presentation-only swap: the name is already in the model. A sync
      // merge may have rebuilt the strip while the input was open (the
      // input then sits in a detached subtree), and the swap itself can
      // lose the browser's blur race — either way the LIVE strip gets its
      // label from the model and the user never sees the difference.
      if (input.get(0)?.isConnected) {
        try {
          element
            .find('.tab-strip-rename')
            .replaceWith($('<span class="tab-strip-title"></span>').text(deriveTabTitle(tab)));
        } catch {
          this.refreshLabel(tabId);
        }
        element.attr('title', tab.name ? tab.name : 'Double-click to rename');
      } else {
        this.refreshLabel(tabId);
      }
    };

    input.on('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(true);
        this.host.focusEditor();
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
}
