/**
 * Padify custom right-click menu for the editor.
 *
 * Replaces the browser's default context menu on the notes editor (the
 * contenteditable #note surface) with a Vercel-styled menu carrying the
 * important editing actions:
 *
 *   Undo · Redo · Cut · Copy · Paste · Delete · Select All
 *   Bold · Italic · Underline · Strikethrough (one-row format group)
 *   Clear Formatting (clears formatting inside the selection, Ctrl+\\)
 *   Insert Link (hands over to the link bubble; Remove link when on one)
 *   Insert Equation (rich + markdown notes — the bubble's own kinds)
 *   Case Converter (12 transformations, in a submenu — no more separate tab)
 *   Table operations (only while the caret sits inside a table)
 *
 * The format group serves EVERY html note — the classic/plain note is
 * the same contenteditable surface the rich note is (the note type only
 * decides the Docs toolbar's presence), so Bold and friends run through
 * the same EditorPort commands on both.
 *
 * The editor renders rich text, so formatting runs through the classic
 * editing commands (document.execCommand bold/italic/underline/strikeThrough)
 * and actually displays as bold/italic/underlined/struck text. Applying a
 * format to formatted text toggles it off; the format buttons reflect the
 * state at the caret through aria-checked.
 *
 * Edits are applied through execCommand so the native Ctrl/Cmd + Z undo
 * stack keeps working.
 *
 * Shortcuts: Ctrl/Cmd + B, Ctrl/Cmd + I, Ctrl/Cmd + U and
 * Ctrl/Cmd + Shift + X while typing in the note.
 */

import Swal from 'sweetalert2';
import { showToast } from './ui/toast';
import { registerLayer } from './ui/behavior/layers';
import { CASES } from './case-conversions';
import { getEditorPort, type EditorCommand, type FormatCommand } from './editor/port';
import { getTabManager } from './tabs';
import { isHtmlContent, isMarkdownNote, isRichNote } from './editor/note-types';
import { isApplePlatform, shortcutLabel } from './lib/platform';
import {
  mdClearFormatting,
  mdCopy,
  mdCut,
  mdDeleteSelection,
  mdFocus,
  mdMenuFormat,
  mdPaste,
  mdRedo,
  mdRemoveLink,
  mdReplaceSelection,
  mdSelectAll,
  mdSelectionText,
  mdState,
  mdTableOp,
  mdUndo,
  markdownMenuTarget,
  markdownViewMode,
} from './editor/markdown/menu-actions';

// --- Note-level actions -----------------------------------------------
// "Copy the note" and "Delete the note" are menu/keyboard actions, so
// they live with the menu wiring that triggers them (the download menu
// item, Alt+C, Ctrl+Shift+Del). They used to sit in the shared utils
// grab-bag — whose import of getTabManager was half of the repo's only
// import cycle.

export function copyNotesToClipboard(note: string): void {
  // The app's one toast (see ui/toast.ts) — the SweetAlert2 bottom-toast
  // this used to fire was a second notification system with its own
  // position, animation and off-palette icon.
  navigator.clipboard.writeText(note).then(
    function () {
      showToast('Notes copied to clipboard.', 'success');
    },
    function () {
      showToast('Fail to copy. Check permissions for clipboard.', 'error');
    },
  );
}

export function deleteNotes(): void {
  Swal.fire({
    title: 'Want to delete notes?',
    text: "You won't be able to revert this!",
    icon: 'warning',
    showCancelButton: true,
    customClass: {
      confirmButton: 'swal-btn-danger',
    },
    confirmButtonText: 'Yes, Delete!',
    cancelButtonText: 'No, keep it.',
  }).then(async (result) => {
    if (result.value) {
      // Save a safety snapshot before deleting — await so the snapshot
      // actually lands before the note is wiped. Previously the call was
      // fire-and-forget and could lose the snapshot if the IDB open hadn't
      // completed yet, or if the page navigated away mid-write.
      try {
        await window.snapshotsManager!.createSnapshot();
      } catch {
        /* snapshots unavailable — the delete still proceeds */
      }

      // Clear the active tab (delete-notes only ever deleted the note
      // that was on screen, so it stays per-tab now that tabs exist).
      getTabManager()?.clearActiveTab();

      Swal.fire('Deleted!', 'Your notes has been deleted.', 'success');
    }
  });
}

interface FormatDef {
  id: 'bold' | 'italic' | 'underline' | 'strike';
  label: string;
  /** The editor command that toggles this format. */
  command: FormatCommand;
  /** The document.queryCommandState name that reports it. */
  stateCommand: FormatCommand;
  glyph: string;
}

const FORMATS: FormatDef[] = [
  { id: 'bold', label: 'Bold', command: 'bold', stateCommand: 'bold', glyph: 'B' },
  { id: 'italic', label: 'Italic', command: 'italic', stateCommand: 'italic', glyph: 'I' },
  {
    id: 'underline',
    label: 'Underline',
    command: 'underline',
    stateCommand: 'underline',
    glyph: 'U',
  },
  {
    id: 'strike',
    label: 'Strikethrough',
    command: 'strikeThrough',
    stateCommand: 'strikeThrough',
    glyph: 'S',
  },
];

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 15): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

/** queryCommand-style probes can throw in odd selection states — never crash. */
function safeQueryPort<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

const ICONS = {
  undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  cut: icon(
    '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M20 4 8.1 15.9"/><path d="M14.5 14.5 20 20"/><path d="M8.1 8.1 12 12"/>',
  ),
  copy: icon(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  ),
  paste: icon(
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  ),
  delete: icon(
    '<path d="M21 4H8l-5 8 5 8h13a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/><path d="m18 9-6 6M12 9l6 6"/>',
  ),
  selectAll: icon(
    '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M8 8h8v8H8z" fill="currentColor" stroke="none" opacity="0.25"/><path d="M8 8h8v8H8z"/>',
  ),
  case: icon(
    '<path d="M4 18 9 6l5 12"/><path d="M5.6 14h6.8"/><path d="M19 10.5a3 3 0 1 0 0 5"/><path d="M19 10.5V18"/>',
  ),
  chevron:
    '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M5.25 3 9 6.75 5.25 10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  erase: icon(
    '<path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  ),
  link: icon(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  unlink: icon(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><path d="M3 3l18 18" opacity="0"/><path d="m4 4 3.5 3.5"/><path d="m16.5 16.5 3.5 3.5"/><path d="M4.6 9.5 2.5 10.2"/><path d="M21.5 13.8l-2.1.7"/><path d="M9.5 4.6 10.2 2.5"/><path d="M13.8 21.5l.7-2.1"/>',
  ),
  table: icon(
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M9.75 9.5v10M15.75 9.5v10"/>',
  ),
  math: icon('<path d="m3 12 3.5 5L11 4h10"/>'),
};

// ---------------------------------------------------------------------------
// Menu markup
// ---------------------------------------------------------------------------

/** macOS uses ⌘/⌥ symbols and ⇧⌘Z for redo; everything else shows Ctrl. */
const IS_APPLE = isApplePlatform();
const MOD = IS_APPLE ? '⌘' : 'Ctrl+';
const REDO_HINT = IS_APPLE ? '⇧⌘Z' : 'Ctrl+Y';
const STRIKE_HINT = IS_APPLE ? '⌘⇧X' : 'Ctrl+⇧X';
const CLEAR_HINT = IS_APPLE ? '⌘\\' : 'Ctrl+\\';
/** The clipboard-blocked toasts tell the user which key to press instead. */
const COPY_BLOCKED_HINT = `Copy blocked — press ${shortcutLabel('mod+c')}.`;
const PASTE_BLOCKED_HINT = `Clipboard blocked by the browser — press ${shortcutLabel('mod+v')} instead.`;

const FORMAT_META: Record<FormatDef['id'], { hint: string }> = {
  bold: { hint: `${MOD}B` },
  italic: { hint: `${MOD}I` },
  underline: { hint: `${MOD}U` },
  strike: { hint: STRIKE_HINT },
};

/** The Markdown format row — the same gestures, markdown's grammar. */
const MD_FORMATS: { id: string; label: string; glyph: string }[] = [
  { id: 'bold', label: 'Bold', glyph: 'B' },
  { id: 'italic', label: 'Italic', glyph: 'I' },
  { id: 'strike', label: 'Strikethrough', glyph: 'S' },
  { id: 'code', label: 'Inline code', glyph: '</>' },
];

const menuMarkup = `
<div class="padify-ctx" id="padifyCtxMenu" role="menu" aria-label="Text actions" hidden>
    <div class="padify-ctx-scroll">
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="undo">
            ${ICONS.undo}<span>Undo</span><kbd>${MOD}Z</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="redo">
            ${ICONS.redo}<span>Redo</span><kbd>${REDO_HINT}</kbd>
        </button>
        <div class="padify-ctx-sep" role="separator"></div>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="cut">
            ${ICONS.cut}<span>Cut</span><kbd>${MOD}X</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="copy">
            ${ICONS.copy}<span>Copy</span><kbd>${MOD}C</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="paste">
            ${ICONS.paste}<span>Paste</span><kbd>${MOD}V</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="delete">
            ${ICONS.delete}<span>Delete</span><kbd>Del</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="select-all">
            ${ICONS.selectAll}<span>Select all</span><kbd>${MOD}A</kbd>
        </button>
        <div class="padify-ctx-sep padify-ctx-rich" role="separator"></div>
        <div class="padify-ctx-formats padify-ctx-rich" role="group" aria-label="Text formatting">
            ${FORMATS.map(
              (def) => `
            <button type="button" class="padify-ctx-item padify-ctx-fmt padify-fmt-${def.id}" role="menuitemcheckbox" aria-checked="false" data-action="format" data-format="${def.id}" aria-label="${def.label}" title="${def.label} (${FORMAT_META[def.id].hint})"><span aria-hidden="true">${def.glyph}</span></button>`,
            ).join('')}
        </div>
        <div class="padify-ctx-sep padify-ctx-md" role="separator"></div>
        <div class="padify-ctx-formats padify-ctx-md" role="group" aria-label="Markdown formatting">
            ${MD_FORMATS.map(
              (def) => `
            <button type="button" class="padify-ctx-item padify-ctx-fmt padify-fmt-${def.id}" role="menuitemcheckbox" aria-checked="false" data-action="md-format" data-format="${def.id}" aria-label="${def.label}" title="${def.label}"><span aria-hidden="true">${def.glyph}</span></button>`,
            ).join('')}
        </div>
        <button type="button" class="padify-ctx-item padify-ctx-clear" role="menuitem" data-action="clear-formatting">
            ${ICONS.erase}<span>Clear formatting</span><kbd>${CLEAR_HINT}</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="insert-link">
            ${ICONS.link}<span>Insert link</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-equation" role="menuitem" data-action="insert-equation">
            ${ICONS.math}<span>Insert equation</span>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="remove-link" hidden>
            ${ICONS.unlink}<span>Remove link</span>
        </button>
        <div class="padify-ctx-sep" role="separator"></div>
        <div class="padify-ctx-item padify-ctx-parent" data-action="case-menu">
            <button type="button" class="padify-ctx-trigger" role="menuitem" aria-haspopup="true" aria-expanded="false">
                ${ICONS.case}<span>Case converter</span>${ICONS.chevron}
            </button>
            <div class="padify-ctx-submenu" role="menu" aria-label="Case conversions" hidden>
                ${CASES.map(
                  (caseDef) => `
                <button type="button" class="padify-ctx-item" role="menuitem" data-action="case" data-case="${caseDef.id}">
                    <span>${caseDef.label}</span>
                </button>`,
                ).join('')}
            </div>
        </div>
        <button type="button" class="padify-ctx-item padify-ctx-table" role="menuitem" data-action="table-op" data-op="row-above" hidden>
            ${ICONS.table}<span>Insert row above</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-table" role="menuitem" data-action="table-op" data-op="row-below" hidden>
            ${ICONS.table}<span>Insert row below</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-table" role="menuitem" data-action="table-op" data-op="col-left" hidden>
            ${ICONS.table}<span>Insert column left</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-table" role="menuitem" data-action="table-op" data-op="col-right" hidden>
            ${ICONS.table}<span>Insert column right</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-table padify-ctx-danger" role="menuitem" data-action="table-op" data-op="row-delete" hidden>
            ${ICONS.table}<span>Delete row</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-table padify-ctx-danger" role="menuitem" data-action="table-op" data-op="col-delete" hidden>
            ${ICONS.table}<span>Delete column</span>
        </button>
        <button type="button" class="padify-ctx-item padify-ctx-table padify-ctx-danger" role="menuitem" data-action="table-op" data-op="table-delete" hidden>
            ${ICONS.table}<span>Delete table</span>
        </button>
    </div>
</div>`;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class ContextMenu {
  private menu: HTMLElement;
  private submenu: HTMLElement;
  private trigger: HTMLElement;
  private editor: HTMLElement | null = null;
  private reopenGesture = false;
  private submenuHoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.menu = document.getElementById('padifyCtxMenu') as HTMLElement;
    this.submenu = this.menu.querySelector('.padify-ctx-submenu') as HTMLElement;
    this.trigger = this.menu.querySelector('.padify-ctx-trigger') as HTMLElement;

    document.addEventListener('contextmenu', (event) => this.handleContextMenu(event), true);
    this.menu.addEventListener('click', (event) => this.handleMenuClick(event));
    this.menu.addEventListener('keydown', (event) =>
      this.handleMenuKeydown(event as KeyboardEvent),
    );
    // Outside-click dismissal rides the dismissable-layer registry (see
    // ui/behavior/layers.ts): the capture-phase pointerdown sweep closes
    // this menu when another layer opens or a click lands elsewhere —
    // including clicks on openers that stopPropagation, which the old
    // private document click listener below never saw.
    registerLayer({
      elements: [this.menu],
      isOpen: () => !this.menu.hidden,
      setOpen: (open) => {
        if (!open) {
          this.close();
        }
      },
    });
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
    // Close when anything behind the menu scrolls, but let the submenu's
    // own list scroll freely (it overflows its max-height).
    document.addEventListener(
      'scroll',
      (event) => {
        if (event.target instanceof Node && this.menu.contains(event.target)) {
          return;
        }
        this.close();
      },
      true,
    );

    this.registerSubmenuHover();
    this.registerShortcuts();
  }

  /** Desktop menus open the flyout while hovering the parent row. */
  private registerSubmenuHover(): void {
    const parentRow = this.menu.querySelector('.padify-ctx-parent') as HTMLElement;
    if (!parentRow) return;

    parentRow.addEventListener('mouseenter', () => {
      this.cancelSubmenuHoverTimer();
      if (!this.menu.hidden && this.submenu.hidden) {
        this.submenuHoverTimer = setTimeout(() => this.openSubmenu(false), 120);
      }
    });
    parentRow.addEventListener('mouseleave', () => {
      this.scheduleSubmenuClose();
    });
    this.submenu.addEventListener('mouseenter', () => this.cancelSubmenuHoverTimer());
    this.submenu.addEventListener('mouseleave', () => this.scheduleSubmenuClose());

    // Hovering any other row dismisses an open flyout (native menu feel).
    this.menu
      .querySelectorAll<HTMLElement>(
        '.padify-ctx-scroll > .padify-ctx-item:not(.padify-ctx-parent), .padify-ctx-scroll > .padify-ctx-formats',
      )
      .forEach((item) => {
        item.addEventListener('mouseenter', () => {
          this.cancelSubmenuHoverTimer();
          if (!this.submenu.hidden) this.closeSubmenu();
        });
      });
  }

  private cancelSubmenuHoverTimer(): void {
    if (this.submenuHoverTimer !== null) {
      clearTimeout(this.submenuHoverTimer);
      this.submenuHoverTimer = null;
    }
  }

  private scheduleSubmenuClose(): void {
    this.cancelSubmenuHoverTimer();
    this.submenuHoverTimer = setTimeout(() => {
      this.submenuHoverTimer = null;
      if (!this.submenu.hidden) this.closeSubmenu();
    }, 200);
  }

  // ---- open/close ---------------------------------------------------------

  private handleContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const inEditor = target.closest('#note') !== null;
    if (!inEditor || this.reopenGesture) {
      if (!this.reopenGesture) this.close();
      this.reopenGesture = false;
      return;
    }

    // The menu's vocabulary serves the EDITING surfaces: the html rows
    // through the EditorPort, the markdown rows through the surface's
    // own action layer (menu-actions.ts). Non-editing kinds keep the
    // browser's native menu.
    const activeNote = getTabManager()?.getActive();
    if (!isHtmlContent(activeNote?.noteType) && !isMarkdownNote(activeNote)) {
      return;
    }

    event.preventDefault();
    this.editor = document.getElementById('note');
    this.open(Math.round(event.clientX), Math.round(event.clientY));
  }

  private open(x: number, y: number): void {
    this.refreshEnabledState();
    this.submenu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.menu.hidden = false;

    // Measure with layout offsets — getBoundingClientRect would report the
    // vz-menu-in animation's scaled/translated box and skew the flip math.
    const width = this.menu.offsetWidth || 232;
    const height = this.menu.offsetHeight || 386;
    const margin = 8;
    let left = x + 2;
    let top = y + 2;
    if (left + width > window.innerWidth - margin) left = x - width - 2;
    if (top + height > window.innerHeight - margin) top = y - height - 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;

    // Focus lands on the first VISIBLE row — hidden groups (rich-only rows
    // on a plain note) are skipped, their children can't take focus.
    const firstItem = Array.from(
      this.menu.querySelectorAll<HTMLElement>('.padify-ctx-item:not([disabled])'),
    ).find((item) => item.closest('[hidden]') === null);
    firstItem?.focus();
  }

  private close(): void {
    this.cancelSubmenuHoverTimer();
    this.menu.hidden = true;
    this.submenu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
  }

  // ---- state ---------------------------------------------------------------

  private get selection(): string {
    const editor = this.editor;
    if (!editor) return '';

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return '';

    return selection.toString();
  }

  /** Is the given format active at the current selection/caret? */
  private isFormatActive(def: FormatDef): boolean {
    const editor = this.editor;
    if (!editor) return false;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    if (!editor.contains(selection.getRangeAt(0).commonAncestorContainer)) return false;

    try {
      const port = getEditorPort();
      if (port) {
        return port.queryFormat(def.command);
      }
      return document.queryCommandState(def.stateCommand);
    } catch {
      return false;
    }
  }

  private refreshEnabledState(): void {
    const hasSelection = this.selection.length > 0;
    const isMd = markdownMenuTarget();
    for (const action of ['cut', 'copy', 'delete', 'clear-formatting']) {
      const item = this.menu.querySelector<HTMLButtonElement>(
        `.padify-ctx-item[data-action="${action}"]`,
      );
      if (item) {
        item.disabled = !hasSelection;
        item.setAttribute('aria-disabled', String(!hasSelection));
      }
    }

    // Formatting belongs to the EDITING notes — and that is EVERY html
    // note: the classic/plain note is the same contenteditable surface
    // the rich note is (the type only decides the DOCS toolbar's
    // presence), so its rows run through the same EditorPort commands.
    // Markdown notes answer through the surface's own state; the two
    // vocabularies share the equation row's handoff event. The separator
    // leading each group hides with it, so no doubled rule.
    const isHtml = isHtmlContent(getTabManager()?.getActive()?.noteType);
    this.menu.querySelectorAll<HTMLElement>('.padify-ctx-rich').forEach((item) => {
      item.hidden = !isHtml;
    });
    this.menu.querySelectorAll<HTMLElement>('.padify-ctx-md').forEach((item) => {
      item.hidden = !isMd;
    });
    const editing = isHtml || isMd;
    const isRich = isRichNote(getTabManager()?.getActive());
    // The equation row is shared by the notes whose TOOLBAR owns the
    // bubble (rich + markdown); a standard note has no bubble to open.
    this.menu.querySelectorAll<HTMLElement>('.padify-ctx-equation').forEach((item) => {
      item.hidden = !(isRich || isMd);
    });
    // Clear formatting is a plain EditorPort command — every html note
    // can honestly run it, and markdown has its own surface pass.
    this.menu.querySelectorAll<HTMLElement>('.padify-ctx-clear').forEach((item) => {
      item.hidden = !editing;
    });

    // The link rows follow the caret's context, the way the toolbar's
    // table menu does — no link under the caret, no Remove link; not in
    // a table, no table operations. On markdown the surface's own state
    // answers; on html the port does. Remove link is a port command
    // (every html note); Insert link needs the toolbar's popover, which
    // only the rich and markdown kinds show.
    const port = getEditorPort();
    const mdCaret = isMd ? mdState() : null;
    const inLink = isMd ? !!mdCaret?.link : !!safeQueryPort(() => port?.queryLinkHref());
    const removeLinkItem = this.menu.querySelector<HTMLButtonElement>(
      '.padify-ctx-item[data-action="remove-link"]',
    );
    if (removeLinkItem) {
      removeLinkItem.hidden = !editing || !inLink;
    }
    const insertLinkItem = this.menu.querySelector<HTMLButtonElement>(
      '.padify-ctx-item[data-action="insert-link"]',
    );
    if (insertLinkItem) {
      insertLinkItem.hidden = !(isRich || isMd) || inLink;
    }
    // Table ops only run in the WYSIWYG (runMarkdownTableAction declines
    // while the source pane is live) — in source/split the rows would render
    // for any pipe-led line and silently do nothing.
    const inTable = isMd
      ? !!mdCaret?.inTable && markdownViewMode() === 'edit'
      : !!safeQueryPort(() => port?.queryTableContext());
    this.menu.querySelectorAll<HTMLElement>('.padify-ctx-table').forEach((item) => {
      item.hidden = !inTable;
    });

    // Reflect which formats are active at the caret, so screen readers and
    // the title tooltips tell the truth when the menu opens.
    for (const def of FORMATS) {
      const button = this.menu.querySelector<HTMLButtonElement>(
        `.padify-ctx-rich.padify-ctx-fmt[data-format="${def.id}"], .padify-ctx-formats.padify-ctx-rich .padify-ctx-fmt[data-format="${def.id}"]`,
      );
      if (!button) continue;
      button.setAttribute('aria-checked', String(this.isFormatActive(def)));
    }
    if (mdCaret) {
      const mdActive: Record<string, boolean> = {
        bold: mdCaret.bold,
        italic: mdCaret.italic,
        strike: mdCaret.strikethrough,
        code: mdCaret.code,
      };
      for (const def of MD_FORMATS) {
        const button = this.menu.querySelector<HTMLButtonElement>(
          `.padify-ctx-md.padify-ctx-fmt[data-format="${def.id}"], .padify-ctx-formats.padify-ctx-md .padify-ctx-fmt[data-format="${def.id}"]`,
        );
        if (!button) continue;
        button.setAttribute('aria-checked', String(mdActive[def.id] ?? false));
      }
    }
  }

  // ---- interactions -----------------------------------------------------------

  private handleMenuClick(event: Event): void {
    const target = event.target as HTMLElement;

    const trigger = target.closest('.padify-ctx-trigger') as HTMLButtonElement | null;
    if (trigger) {
      event.stopPropagation();
      this.cancelSubmenuHoverTimer();
      if (this.submenu.hidden) {
        this.openSubmenu(true);
      } else {
        this.closeSubmenu(true);
      }
      return;
    }

    const parent = target.closest('.padify-ctx-parent') as HTMLElement | null;
    if (parent && !target.closest('.padify-ctx-submenu')) {
      // Clicking the parent row (outside the trigger button) opens the submenu too.
      event.stopPropagation();
      this.cancelSubmenuHoverTimer();
      if (this.submenu.hidden) {
        this.openSubmenu(true);
      } else {
        this.closeSubmenu(true);
      }
      return;
    }

    const item = target.closest('.padify-ctx-item') as HTMLButtonElement | null;
    if (!item || item.disabled) return;
    const action = item.dataset.action;
    const caseId = item.dataset.case;
    const formatId = item.dataset.format as FormatDef['id'] | undefined;
    if (!action) return;

    // Prevent the global click handler from closing before the action runs.
    event.stopPropagation();
    this.runAction(action, caseId, formatId, item.dataset.op);
  }

  private handleMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!this.submenu.hidden) {
        this.closeSubmenu(true);
      } else {
        this.close();
        this.editor?.focus();
      }
      return;
    }

    // Tab leaves the menu entirely instead of landing in a random focus sink.
    if (event.key === 'Tab') {
      event.preventDefault();
      this.close();
      this.editor?.focus();
      return;
    }

    const active = document.activeElement as HTMLElement;

    // Left/right arrows drive the flyout from the trigger row.
    if (event.key === 'ArrowRight') {
      if (active === this.trigger && this.submenu.hidden) {
        event.preventDefault();
        this.openSubmenu(true);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (!this.submenu.hidden && this.submenu.contains(active)) {
        event.preventDefault();
        this.closeSubmenu(true);
      }
      return;
    }

    // Walk the visible items: top-level rows plus, when the flyout is
    // open, the trigger button and its items. The trigger (a real button)
    // is included so keyboard users can reach the Case converter row.
    const items = Array.from(
      this.menu.querySelectorAll<HTMLElement>(
        '.padify-ctx-scroll > .padify-ctx-item:not(.padify-ctx-parent), .padify-ctx-scroll > .padify-ctx-formats .padify-ctx-item, .padify-ctx-scroll > .padify-ctx-parent > .padify-ctx-trigger, .padify-ctx-submenu:not([hidden]) .padify-ctx-item',
      ),
    ).filter(
      // Skip disabled rows and anything hidden with its group (the
      // rich-only rows on a plain note render none of their children).
      (el) => !(el as HTMLButtonElement).disabled && el.closest('[hidden]') === null,
    );
    const index = items.indexOf(active);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = items[(index + delta + items.length) % items.length];
      next?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (active instanceof HTMLButtonElement && !active.disabled) {
        event.preventDefault();
        active.click();
      }
    }
  }

  private openSubmenu(focusFirstItem: boolean): void {
    if (!this.submenu.hidden) return;
    this.submenu.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');

    // Reset any previous flip/shift, then recompute using layout offsets
    // (immune to the open animation's transform, unlike getBoundingClientRect).
    this.submenu.style.top = '';
    this.submenu.style.maxHeight = '';
    this.submenu.classList.remove('is-flipped');

    const menuLeft = this.menu.offsetLeft;
    const menuTop = this.menu.offsetTop;
    const menuWidth = this.menu.offsetWidth;
    const subWidth = this.submenu.offsetWidth;
    const subHeight = this.submenu.offsetHeight;

    // Flip to the left edge when the flyout would leave the viewport and
    // there is actually room on the left (never on narrow/mobile screens).
    const opensRightEdge = menuLeft + menuWidth + 4 + subWidth;
    if (opensRightEdge > window.innerWidth - 8 && menuLeft - 4 - subWidth >= 8) {
      this.submenu.classList.add('is-flipped');
    }

    // Viewport Y of the flyout: menu top + the parent row's offset + CSS top.
    const parentRow = this.trigger.parentElement as HTMLElement;
    const rowTop = parentRow.offsetTop;
    const cssTop = parseFloat(getComputedStyle(this.submenu).top) || 0;
    const subTop = menuTop + rowTop + cssTop;

    // Shift the flyout up when it would run past the viewport bottom.
    const overflow = subTop + subHeight - (window.innerHeight - 8);
    if (overflow > 0) {
      this.submenu.style.top = `${Math.round(cssTop - overflow)}px`;
      // Extremely short viewports: cap the flyout so it stays reachable.
      if (subTop - overflow < 8) {
        this.submenu.style.maxHeight = `${Math.max(160, window.innerHeight - 16)}px`;
      }
    }

    if (focusFirstItem) {
      const first = this.submenu.querySelector<HTMLElement>('.padify-ctx-item');
      first?.focus();
    }
  }

  private closeSubmenu(refocusTrigger = false): void {
    if (this.submenu.hidden) return;
    const focusWasInside = this.submenu.contains(document.activeElement);
    this.submenu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (refocusTrigger || focusWasInside) {
      this.trigger.focus();
    }
  }

  // ---- actions ------------------------------------------------------------------

  private runAction(
    action: string,
    caseId?: string,
    formatId?: FormatDef['id'],
    tableOp?: string,
  ): void {
    // Markdown notes take their own action layer — every mutation
    // through the surface, never the EditorPort (which is parked).
    if (markdownMenuTarget()) {
      this.runMarkdownAction(action, caseId, formatId, tableOp);
      return;
    }
    switch (action) {
      case 'undo':
        this.editorUndo();
        this.close();
        this.restoreFocus();
        break;
      case 'redo':
        this.editorRedo();
        this.close();
        this.restoreFocus();
        break;
      case 'cut':
        this.cutSelection();
        break;
      case 'copy':
        void this.copySelection();
        break;
      case 'paste':
        void this.pasteFromClipboard();
        break;
      case 'delete':
        this.deleteSelection();
        break;
      case 'select-all':
        this.selectAll();
        break;
      case 'format': {
        const def = FORMATS.find((entry) => entry.id === formatId);
        if (def) this.applyFormat(def);
        break;
      }
      case 'clear-formatting':
        this.removeFormatting();
        break;
      case 'insert-link':
        this.openLinkBubble();
        break;
      case 'insert-equation':
        this.openEquationBubble();
        break;
      case 'remove-link':
        this.removeLinkAtCaret();
        break;
      case 'table-op': {
        if (tableOp) this.runTableOp(tableOp);
        break;
      }
      case 'case':
        if (caseId) this.convertCase(caseId);
        break;
      default:
        this.close();
    }
  }

  private restoreFocus(): void {
    // Markdown notes focus their own editor (the host is not editable).
    if (markdownMenuTarget()) {
      mdFocus();
      return;
    }
    // Re-focus the editor so subsequent typing and Ctrl+Z work naturally.
    if (this.editor) {
      this.reopenGesture = true;
      this.editor.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        this.reopenGesture = false;
      });
    }
  }

  /** The markdown edition of runAction — the same rows, the surface's answers. */
  private runMarkdownAction(
    action: string,
    caseId?: string,
    formatId?: FormatDef['id'],
    tableOp?: string,
  ): void {
    switch (action) {
      case 'undo':
        mdUndo();
        this.close();
        mdFocus();
        break;
      case 'redo':
        mdRedo();
        this.close();
        mdFocus();
        break;
      case 'cut': {
        this.close();
        mdFocus();
        const cut = mdCut();
        showToast(cut ? 'Cut to clipboard.' : 'Cut. Clipboard unavailable in this browser.');
        break;
      }
      case 'copy': {
        this.close();
        void mdCopy().then((copied) => {
          showToast(copied ? 'Copied to clipboard.' : COPY_BLOCKED_HINT);
        });
        mdFocus();
        break;
      }
      case 'paste': {
        this.close();
        mdFocus();
        void mdPaste().then((result) => {
          if (result === 'empty') {
            showToast('Clipboard is empty.');
          } else if (result === 'blocked') {
            showToast(PASTE_BLOCKED_HINT);
          }
        });
        break;
      }
      case 'delete':
        this.close();
        mdDeleteSelection();
        break;
      case 'select-all':
        this.close();
        mdSelectAll();
        break;
      case 'md-format': {
        const def = MD_FORMATS.find((entry) => entry.id === formatId);
        if (!def) {
          this.close();
          break;
        }
        this.close();
        mdFocus();
        const ok = mdMenuFormat(def.id);
        const active =
          mdState()?.[
            def.id === 'bold'
              ? 'bold'
              : def.id === 'italic'
                ? 'italic'
                : def.id === 'strike'
                  ? 'strikethrough'
                  : 'code'
          ];
        showToast(ok ? `${def.label} ${active ? 'on' : 'off'}.` : `${def.label} unavailable.`);
        break;
      }
      case 'clear-formatting': {
        this.close();
        mdFocus();
        const ok = mdClearFormatting();
        showToast(ok ? 'Formatting removed.' : 'Could not remove formatting.');
        break;
      }
      case 'insert-link':
        this.close();
        mdFocus();
        document.dispatchEvent(new CustomEvent('padify:open-link'));
        break;
      case 'insert-equation':
        this.close();
        mdFocus();
        document.dispatchEvent(new CustomEvent('padify:open-equation'));
        break;
      case 'remove-link': {
        this.close();
        const removed = mdRemoveLink();
        if (removed) {
          showToast('Link removed.');
        }
        mdFocus();
        break;
      }
      case 'table-op': {
        this.close();
        if (tableOp) {
          mdTableOp(tableOp);
        }
        mdFocus();
        break;
      }
      case 'case':
        if (caseId) {
          this.convertCaseMarkdown(caseId);
        }
        break;
      default:
        this.close();
    }
  }

  /**
   * Ctrl/Cmd + B / I / U and Ctrl/Cmd + Shift + X while typing in the note.
   * Bound in the capture phase so Ctrl + U never reaches the browser's
   * view-source binding, and only when the note itself has focus — the open
   * menu handles its own keys through handleMenuKeydown.
   */
  private registerShortcuts(): void {
    document.addEventListener(
      'keydown',
      (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const target = event.target as HTMLElement | null;
        if (!target || (target.id !== 'note' && target.closest('#note') === null)) return;
        // These are the html surface's format commands; a Markdown note's
        // Mod-B/Mod-I belong to its own keymap — swallowing them here would
        // park the keystroke on an inert port.
        if (!isHtmlContent(getTabManager()?.getActive()?.noteType)) return;

        let formatId: FormatDef['id'] | null = null;
        if (event.shiftKey && event.code === 'KeyX') {
          formatId = 'strike';
        } else if (!event.shiftKey) {
          if (event.code === 'KeyB') formatId = 'bold';
          else if (event.code === 'KeyI') formatId = 'italic';
          else if (event.code === 'KeyU') formatId = 'underline';
        }
        if (!formatId) return;

        const def = FORMATS.find((entry) => entry.id === formatId);
        if (!def) return;
        event.preventDefault();
        this.editor = target.closest('#note');
        this.applyFormat(def);
      },
      true,
    );
  }

  /**
   * Toggles one formatting layer with the real rendering commands. With a
   * selection the format is applied to (or removed from) the selection;
   * with a collapsed caret it toggles the typing style, like Word does.
   */
  private applyFormat(def: FormatDef): void {
    if (!this.editor) {
      this.close();
      return;
    }

    this.close();
    this.editor.focus({ preventScroll: true });

    // The command runs through the EditorPort (or execCommand until the
    // port is installed) — it keeps the native undo stack intact and fires
    // an input event, which the app uses to autosave the note.
    const ok = this.applyEditorCommand(def.command);
    showToast(
      ok
        ? this.isFormatActive(def)
          ? `${def.label} on.`
          : `${def.label} off.`
        : `${def.label} unavailable in this browser.`,
    );
  }

  private removeFormatting(): void {
    const selection = window.getSelection();
    if (!this.editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.close();
      showToast('Select some text first, then remove its formatting.');
      this.restoreFocus();
      return;
    }

    this.close();
    this.editor.focus({ preventScroll: true });

    const ok = this.applyEditorCommand('removeFormat');
    showToast(ok ? 'Formatting removed.' : 'Could not remove formatting in this browser.');
  }

  /**
   * The link bubble (toolbar) handles insert/edit/copy; the menu item just
   * hands over after restoring the caret so the bubble parks the selection.
   */
  private openLinkBubble(): void {
    this.close();
    this.restoreFocus();
    document.dispatchEvent(new CustomEvent('padify:open-link'));
  }

  /** The equation bubble (toolbar) owns LaTeX editing; hands over the same way. */
  private openEquationBubble(): void {
    this.close();
    this.restoreFocus();
    document.dispatchEvent(new CustomEvent('padify:open-equation'));
  }

  private removeLinkAtCaret(): void {
    this.close();
    const port = getEditorPort();
    if (!port || !safeQueryPort(() => port.queryLinkHref())) {
      this.restoreFocus();
      return;
    }
    this.editor?.focus({ preventScroll: true });
    port.removeLink();
    showToast('Link removed.');
  }

  /** Table operations reuse the toolbar's vocabulary (port.runTableAction). */
  private runTableOp(op: string): void {
    this.close();
    const port = getEditorPort();
    if (!port || !safeQueryPort(() => port.queryTableContext())) {
      this.restoreFocus();
      return;
    }
    this.editor?.focus({ preventScroll: true });
    port.runTableAction(op);
  }

  private execCommand(command: string, value?: string): boolean {
    try {
      return document.execCommand(command, false, value);
    } catch {
      return false;
    }
  }

  /**
   * Format + undo/redo mutations go through the EditorPort so the same
   * actions keep working when the document-model editor replaces the
   * contenteditable. Clipboard commands (copy/cut/paste) are browser-level
   * and stay on execCommand/the async API.
   */
  private applyEditorCommand(command: EditorCommand): boolean {
    const port = getEditorPort();
    if (port) {
      return port.applyFormat(command);
    }
    return this.execCommand(command);
  }

  private editorUndo(): boolean {
    const port = getEditorPort();
    return port ? port.undo() : this.execCommand('undo');
  }

  private editorRedo(): boolean {
    const port = getEditorPort();
    return port ? port.redo() : this.execCommand('redo');
  }

  /** Replaces the current selection, keeping the native undo stack intact. */
  private replaceSelection(replacement: string): void {
    const editor = this.editor;
    if (!editor) return;
    this.close();
    editor.focus({ preventScroll: true });

    const port = getEditorPort();
    const ok = port ? port.insertText(replacement) : this.execCommand('insertText', replacement);
    if (!ok) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(replacement);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  private async copySelection(): Promise<void> {
    const text = this.selection;
    if (!text) {
      this.close();
      return;
    }
    // execCommand('copy') carries the rich rendering when the note is
    // pasted elsewhere; the async API is the fallback.
    let copied = false;
    try {
      copied = this.execCommand('copy');
    } catch {
      // execCommand threw — copied stays false and the async API is tried.
    }
    if (!copied) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }
    showToast(copied ? 'Copied to clipboard.' : COPY_BLOCKED_HINT);
    this.close();
    this.restoreFocus();
  }

  private cutSelection(): void {
    const text = this.selection;
    const editor = this.editor;
    if (!text || !editor) {
      this.close();
      return;
    }
    // Every action closes the menu like a native one does — cut used to
    // leave it hanging open on screen after the deletion.
    this.close();
    editor.focus({ preventScroll: true });
    // Never block the cut on the async Clipboard API: in several browsers
    // (no permission, unfocused document, Firefox/Safari quirks) writeText
    // either rejects or hangs forever. Copy synchronously through
    // execCommand first, fall back to the async API in the background,
    // and always delete the selection like a native cut would.
    let copied = false;
    try {
      copied = this.execCommand('copy');
    } catch {
      // execCommand threw — copied stays false and the async API is tried.
    }
    if (!copied) {
      void navigator.clipboard?.writeText(text).catch(() => {
        /* clipboard unavailable — the cut still proceeds */
      });
    }
    this.replaceSelection('');
    showToast(copied ? 'Cut to clipboard.' : 'Cut. Clipboard unavailable in this browser.');
  }

  private async pasteFromClipboard(): Promise<void> {
    const editor = this.editor;
    if (!editor) return;
    this.close();
    editor.focus({ preventScroll: true });
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showToast('Clipboard is empty.');
        return;
      }
      this.replaceSelection(text);
    } catch {
      showToast(PASTE_BLOCKED_HINT);
      this.restoreFocus();
    }
  }

  private deleteSelection(): void {
    if (!this.selection) {
      this.close();
      return;
    }
    // Closes like every other action — delete used to leave the menu
    // hanging open over the text it had just removed.
    this.close();
    this.replaceSelection('');
  }

  private selectAll(): void {
    const editor = this.editor;
    this.close();
    if (!editor) return;

    editor.focus({ preventScroll: true });

    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private convertCase(caseId: string): void {
    const caseDef = CASES.find((entry) => entry.id === caseId);
    const editor = this.editor;
    if (!caseDef || !editor) {
      this.close();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      this.close();
      showToast('Select some text first, then convert its case.');
      this.restoreFocus();
      return;
    }

    const selected = this.selection;
    if (!selected) {
      this.close();
      showToast('Select some text first, then convert its case.');
      this.restoreFocus();
      return;
    }

    const converted = caseDef.convert(selected);
    if (converted === selected) {
      this.close();
      this.restoreFocus();
      return;
    }

    // execCommand mutations don't reliably preserve live Ranges, so
    // remember the selection as absolute text offsets inside the note
    // (text before the selection is untouched by insertText, so the
    // replacement always lands at the same start offset).
    const liveRange = selection.getRangeAt(0);
    const absStart = this.absoluteTextOffset(
      editor,
      liveRange.startContainer,
      liveRange.startOffset,
    );

    this.replaceSelection(converted);

    // Re-select exactly the converted text so another case (or format)
    // can be applied right away.
    try {
      const restored = document.createRange();
      this.setTextOffset(editor, restored, 'start', absStart);
      this.setTextOffset(editor, restored, 'end', absStart + converted.length);
      selection.removeAllRanges();
      selection.addRange(restored);
    } catch {
      /* selection restore is best-effort */
    }

    showToast(`Converted to ${caseDef.label}.`);
  }

  /** The markdown edition — the selection is the surface's, not the DOM's. */
  private convertCaseMarkdown(caseId: string): void {
    const caseDef = CASES.find((entry) => entry.id === caseId);
    if (!caseDef) {
      this.close();
      return;
    }

    const selected = mdSelectionText();
    if (!selected) {
      this.close();
      showToast('Select some text first, then convert its case.');
      mdFocus();
      return;
    }

    const converted = caseDef.convert(selected);
    this.close();
    if (converted !== selected) {
      mdReplaceSelection(converted);
    }
    mdFocus();
    if (converted !== selected) {
      showToast(`Converted to ${caseDef.label}.`);
    }
  }

  /** Text offset of (node, offset) measured across the editor's text. */
  private absoluteTextOffset(editor: HTMLElement, node: Node, offset: number): number {
    if (node === editor) {
      // Offset counts child nodes; sum the text they contain.
      let total = 0;
      const limit = Math.min(offset, editor.childNodes.length);
      for (let i = 0; i < limit; i += 1) {
        const child = editor.childNodes[i];
        total +=
          child.nodeType === Node.TEXT_NODE
            ? (child.nodeValue?.length ?? 0)
            : (child.textContent?.length ?? 0);
      }
      return total;
    }

    let total = 0;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const current = walker.currentNode as Text;
      if (current === node) {
        return total + Math.min(offset, current.nodeValue?.length ?? 0);
      }
      total += current.nodeValue?.length ?? 0;
    }
    return total;
  }

  /** Moves one boundary of `range` to the given absolute text offset. */
  private setTextOffset(
    editor: HTMLElement,
    range: Range,
    boundary: 'start' | 'end',
    target: number,
  ): void {
    let remaining = target;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let lastNode: Text | null = null;

    while (walker.nextNode()) {
      const current = walker.currentNode as Text;
      const length = current.nodeValue?.length ?? 0;
      lastNode = current;

      if (remaining <= length) {
        if (boundary === 'start') {
          range.setStart(current, remaining);
        } else {
          range.setEnd(current, remaining);
        }
        return;
      }
      remaining -= length;
    }

    // Offset beyond the text (e.g. trailing newline quirks): clamp.
    if (lastNode) {
      const end = lastNode.nodeValue?.length ?? 0;
      if (boundary === 'start') {
        range.setStart(lastNode, end);
      } else {
        range.setEnd(lastNode, end);
      }
    } else {
      range.selectNodeContents(editor);
      range.collapse(boundary === 'start');
    }
  }
}

// E2E probe.
interface CtxDebugWindow {
  __padifyContextMenu?: { cases: string[]; formats: string[] };
}
(window as unknown as CtxDebugWindow).__padifyContextMenu = {
  cases: CASES.map((entry) => entry.id),
  formats: FORMATS.map((entry) => entry.id),
};

/**
 * Mounts the context menu markup and constructs it. Called by boot.ts; the
 * two statements used to run at module evaluation.
 */
export function initContextMenu(): void {
  document.body.insertAdjacentHTML('beforeend', menuMarkup);
  new ContextMenu();
}
