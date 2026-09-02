/**
 * Padify custom right-click menu for the editor.
 *
 * Replaces the browser's default context menu on the notes textarea with a
 * Vercel-styled menu carrying the important editing actions:
 *
 *   Undo · Redo · Cut · Copy · Paste · Delete · Select All
 *   Case Converter (12 transformations, in a submenu — no more separate tab)
 *   Remove Tabs (the "clear formatting" action)
 *
 * Edits are applied through document.execCommand('insertText') so the native
 * Ctrl/Cmd + Z undo stack keeps working; a setRangeText fallback covers
 * browsers where execCommand is unavailable.
 */

import { showToast } from './utils';

interface CaseDef {
    id: string;
    label: string;
    hint?: string;
    convert: (text: string) => string;
}

const SMALL_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'of', 'at', 'by',
    'for', 'nor', 'so', 'yet', 'to', 'up', 'off', 'out'
]);

function splitWords(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[\s_\-.]+/)
        .filter(Boolean);
}

const CASES: CaseDef[] = [
    {
        id: 'upper',
        label: 'UPPERCASE',
        convert: text => text.toUpperCase()
    },
    {
        id: 'lower',
        label: 'lowercase',
        convert: text => text.toLowerCase()
    },
    {
        id: 'sentence',
        label: 'Sentence case',
        convert: text =>
            text
                .split(/\n{2,}/)
                .map(paragraph =>
                    paragraph
                        .split(/([.!?]\s+)/)
                        .map(chunk =>
                            chunk.startsWith(' ') || chunk.startsWith('\n')
                                ? chunk
                                : chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase()
                        )
                        .join('')
                )
                .join('\n\n')
    },
    {
        id: 'title',
        label: 'Title Case',
        convert: text =>
            text
                .split('\n')
                .map(line => {
                    const words = line.split(' ');
                    const last = words.length - 1;
                    return words
                        .map((word, index) => {
                            const lower = word.toLowerCase();
                            if (
                                index > 0 &&
                                index < last &&
                                SMALL_WORDS.has(lower.replace(/[^a-z]/g, ''))
                            ) {
                                return lower;
                            }
                            return lower.charAt(0).toUpperCase() + lower.slice(1);
                        })
                        .join(' ');
                })
                .join('\n')
    },
    {
        id: 'capitalized',
        label: 'Capitalize Each Word',
        convert: text =>
            text
                .toLowerCase()
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ')
    },
    {
        id: 'camel',
        label: 'camelCase',
        convert: text =>
            splitWords(text)
                .map((word, index) =>
                    index === 0
                        ? word.toLowerCase()
                        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
                )
                .join('')
    },
    {
        id: 'pascal',
        label: 'PascalCase',
        convert: text =>
            splitWords(text)
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join('')
    },
    {
        id: 'snake',
        label: 'snake_case',
        convert: text => splitWords(text).map(word => word.toLowerCase()).join('_')
    },
    {
        id: 'kebab',
        label: 'kebab-case',
        convert: text => splitWords(text).map(word => word.toLowerCase()).join('-')
    },
    {
        id: 'constant',
        label: 'CONSTANT_CASE',
        convert: text => splitWords(text).map(word => word.toUpperCase()).join('_')
    },
    {
        id: 'alternating',
        label: 'aLtErNaTiNg',
        convert: text =>
            text
                .split('')
                .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char.toLowerCase()))
                .join('')
    },
    {
        id: 'inverse',
        label: 'tOGGLE cASE',
        convert: text =>
            text
                .split('')
                .map(char => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
                .join('')
    }
];

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 15): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
    undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    cut: icon('<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M20 4 8.1 15.9"/><path d="M14.5 14.5 20 20"/><path d="M8.1 8.1 12 12"/>'),
    copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    paste: icon('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
    delete: icon('<path d="M21 4H8l-5 8 5 8h13a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/><path d="m18 9-6 6M12 9l6 6"/>'),
    selectAll: icon('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M8 8h8v8H8z" fill="currentColor" stroke="none" opacity="0.25"/><path d="M8 8h8v8H8z"/>'),
    case: icon('<path d="M4 18 9 6l5 12"/><path d="M5.6 14h6.8"/><path d="M19 10.5a3 3 0 1 0 0 5"/><path d="M19 10.5V18"/>'),
    chevron: '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M5.25 3 9 6.75 5.25 10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tabs: icon('<path d="M3 7h5v5"/><path d="M3 12h5v5"/>') // custom simple
};

// ---------------------------------------------------------------------------
// Menu markup
// ---------------------------------------------------------------------------

const menuMarkup = `
<div class="padify-ctx" id="padifyCtxMenu" role="menu" aria-label="Text actions" hidden>
    <div class="padify-ctx-scroll">
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="undo">
            ${ICONS.undo}<span>Undo</span><kbd>Ctrl+Z</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="redo">
            ${ICONS.redo}<span>Redo</span><kbd>Ctrl+Y</kbd>
        </button>
        <div class="padify-ctx-sep" role="separator"></div>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="cut">
            ${ICONS.cut}<span>Cut</span><kbd>Ctrl+X</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="copy">
            ${ICONS.copy}<span>Copy</span><kbd>Ctrl+C</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="paste">
            ${ICONS.paste}<span>Paste</span><kbd>Ctrl+V</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="delete">
            ${ICONS.delete}<span>Delete</span><kbd>Del</kbd>
        </button>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="select-all">
            ${ICONS.selectAll}<span>Select all</span><kbd>Ctrl+A</kbd>
        </button>
        <div class="padify-ctx-sep" role="separator"></div>
        <div class="padify-ctx-item padify-ctx-parent" data-action="case-menu">
            <button type="button" class="padify-ctx-trigger" role="menuitem" aria-haspopup="true" aria-expanded="false">
                ${ICONS.case}<span>Case converter</span>${ICONS.chevron}
            </button>
            <div class="padify-ctx-submenu" role="menu" aria-label="Case conversions" hidden>
                ${CASES.map(
                    caseDef => `
                <button type="button" class="padify-ctx-item" role="menuitem" data-action="case" data-case="${caseDef.id}">
                    <span>${caseDef.label}</span>
                </button>`
                ).join('')}
            </div>
        </div>
        <button type="button" class="padify-ctx-item" role="menuitem" data-action="remove-tabs">
            ${ICONS.tabs}<span>Remove tabs</span>
        </button>
    </div>
</div>`;

document.body.insertAdjacentHTML('beforeend', menuMarkup);

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class ContextMenu {
    private menu: HTMLElement;
    private submenu: HTMLElement;
    private textarea: HTMLTextAreaElement | null = null;
    private reopenGesture = false;

    constructor() {
        this.menu = document.getElementById('padifyCtxMenu') as HTMLElement;
        this.submenu = this.menu.querySelector('.padify-ctx-submenu') as HTMLElement;

        document.addEventListener(
            'contextmenu',
            event => this.handleContextMenu(event),
            true
        );
        this.menu.addEventListener('click', event => this.handleMenuClick(event));
        this.menu.addEventListener(
            'keydown',
            event => this.handleMenuKeydown(event as KeyboardEvent)
        );
        document.addEventListener('click', event => {
            if (
                !this.menu.hidden &&
                !(event.target as HTMLElement).closest('.padify-ctx')
            ) {
                this.close();
            }
        });
        window.addEventListener('blur', () => this.close());
        window.addEventListener('resize', () => this.close());
        document.addEventListener('scroll', () => this.close(), true);
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

        event.preventDefault();
        this.textarea = document.getElementById('note') as HTMLTextAreaElement;
        this.open(Math.round(event.clientX), Math.round(event.clientY));
    }

    private open(x: number, y: number): void {
        this.refreshEnabledState();
        this.submenu.hidden = true;
        this.menu.hidden = false;

        // Measure and flip when overflowing the viewport.
        const rect = this.menu.getBoundingClientRect();
        const width = rect.width || 232;
        const height = rect.height || 386;
        const margin = 8;
        let left = x + 2;
        let top = y + 2;
        if (left + width > window.innerWidth - margin) left = x - width - 2;
        if (top + height > window.innerHeight - margin) top = y - height - 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
        top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

        this.menu.style.left = `${Math.round(left)}px`;
        this.menu.style.top = `${Math.round(top)}px`;

        const firstItem = this.menu.querySelector<HTMLElement>('.padify-ctx-item:not([disabled])');
        firstItem?.focus();
    }

    private close(): void {
        this.menu.hidden = true;
        this.submenu.hidden = true;
        this.menu.querySelectorAll('.padify-ctx-trigger').forEach(trigger => {
            trigger.setAttribute('aria-expanded', 'false');
        });
    }

    // ---- state ---------------------------------------------------------------

    private get selection(): string {
        const note = this.textarea;
        if (!note) return '';
        return note.value.slice(note.selectionStart, note.selectionEnd);
    }

    private refreshEnabledState(): void {
        const hasSelection = this.selection.length > 0;
        const actions = ['cut', 'copy', 'delete'];
        for (const action of actions) {
            const item = this.menu.querySelector<HTMLButtonElement>(
                `.padify-ctx-item[data-action="${action}"]`
            );
            if (item) {
                item.disabled = !hasSelection;
                item.setAttribute('aria-disabled', String(!hasSelection));
            }
        }
    }

    // ---- interactions -----------------------------------------------------------

    private handleMenuClick(event: Event): void {
        const target = event.target as HTMLElement;

        const trigger = target.closest('.padify-ctx-trigger') as HTMLButtonElement | null;
        if (trigger) {
            event.stopPropagation();
            this.toggleSubmenu();
            return;
        }

        const parent = target.closest('.padify-ctx-parent') as HTMLElement | null;
        if (parent && !target.closest('.padify-ctx-submenu')) {
            // Clicking the parent row (outside the trigger button) opens the submenu too.
            event.stopPropagation();
            this.toggleSubmenu();
            return;
        }

        const item = target.closest('.padify-ctx-item') as HTMLButtonElement | null;
        if (!item || item.disabled) return;
        const action = item.dataset.action;
        const caseId = item.dataset.case;
        if (!action) return;

        // Prevent the global click handler from closing before the action runs.
        event.stopPropagation();
        this.runAction(action, caseId);
    }

    private handleMenuKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!this.submenu.hidden) {
                this.submenu.hidden = true;
                const trigger = this.menu.querySelector<HTMLElement>('.padify-ctx-trigger');
                trigger?.focus();
            } else {
                this.close();
                this.textarea?.focus();
            }
            return;
        }

        const items = Array.from(
            this.menu.querySelectorAll<HTMLElement>(
                '.padify-ctx-scroll > .padify-ctx-item, .padify-ctx-submenu[hidden="false"] .padify-ctx-item, .padify-ctx-submenu:not([hidden]) .padify-ctx-item'
            )
        ).filter(el => !(el as HTMLButtonElement).disabled);
        const active = document.activeElement as HTMLElement;
        const index = items.indexOf(active);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            const next = items[(index + delta + items.length) % items.length];
            next?.focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
            if (active instanceof HTMLButtonElement && !active.disabled) {
                event.preventDefault();
                active.click();
            }
        }
    }

    private toggleSubmenu(): void {
        const willOpen = this.submenu.hidden;
        this.submenu.hidden = !willOpen;
        const trigger = this.menu.querySelector<HTMLElement>('.padify-ctx-trigger');
        trigger?.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
            // Reset any previous shift, then flip horizontally if needed.
            this.submenu.style.top = '';
            this.submenu.classList.remove('is-flipped');
            const menuRect = this.menu.getBoundingClientRect();
            const subRect = this.submenu.getBoundingClientRect();
            if (menuRect.right + subRect.width > window.innerWidth - 8) {
                this.submenu.classList.add('is-flipped');
            }
            // Shift the flyout up when it would run past the viewport bottom.
            const overflow = subRect.bottom - (window.innerHeight - 8);
            if (overflow > 0) {
                const currentCssTop = parseFloat(getComputedStyle(this.submenu).top) || 0;
                this.submenu.style.top = `${Math.round(currentCssTop - overflow)}px`;
            }
            const first = this.submenu.querySelector<HTMLElement>('.padify-ctx-item');
            first?.focus();
        } else {
            const triggerBtn = this.menu.querySelector<HTMLElement>('.padify-ctx-trigger');
            triggerBtn?.focus();
        }
    }

    // ---- actions ------------------------------------------------------------------

    private runAction(action: string, caseId?: string): void {
        switch (action) {
            case 'undo':
                this.execCommand('undo');
                this.close();
                this.restoreFocus();
                break;
            case 'redo':
                this.execCommand('redo');
                this.close();
                this.restoreFocus();
                break;
            case 'cut':
                void this.cutSelection();
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
            case 'case':
                if (caseId) this.convertCase(caseId);
                break;
            case 'remove-tabs':
                this.removeTabs();
                break;
            default:
                this.close();
        }
    }

    private restoreFocus(): void {
        // Re-focus the textarea so subsequent typing and Ctrl+Z work naturally.
        if (this.textarea) {
            this.reopenGesture = true;
            this.textarea.focus({ preventScroll: true });
            requestAnimationFrame(() => {
                this.reopenGesture = false;
            });
        }
    }

    private execCommand(command: string, value?: string): boolean {
        try {
            return document.execCommand(command, false, value);
        } catch {
            return false;
        }
    }

    /** Replaces the current selection, keeping the native undo stack intact. */
    private replaceSelection(replacement: string): void {
        const note = this.textarea;
        if (!note) return;
        this.close();
        note.focus({ preventScroll: true });

        const ok = this.execCommand('insertText', replacement);
        if (!ok) {
            const start = note.selectionStart;
            const end = note.selectionEnd;
            note.setRangeText(replacement, start, end, 'end');
            note.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    private async copySelection(): Promise<void> {
        const text = this.selection;
        if (!text) {
            this.close();
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            showToast('Copied to clipboard.');
        } catch {
            this.fallbackCopy(text);
        }
        this.close();
        this.restoreFocus();
    }

    private fallbackCopy(text: string): void {
        const note = this.textarea;
        if (!note) return;
        // execCommand('copy') needs an active selection — borrow the textarea.
        note.focus({ preventScroll: true });
        const start = note.selectionStart;
        const end = note.selectionEnd;
        note.select();
        const ok = this.execCommand('copy');
        note.setSelectionRange(start, end);
        if (ok) {
            showToast('Copied to clipboard.');
        } else {
            showToast('Copy blocked — press Ctrl/Cmd + C.');
        }
    }

    private async cutSelection(): Promise<void> {
        const text = this.selection;
        if (!text) {
            this.close();
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            /* cut still proceeds; worst case the clipboard keeps old content */
        }
        this.replaceSelection('');
        showToast('Cut to clipboard.');
    }

    private async pasteFromClipboard(): Promise<void> {
        const note = this.textarea;
        if (!note) return;
        this.close();
        note.focus({ preventScroll: true });
        try {
            const text = await navigator.clipboard.readText();
            if (!text) {
                showToast('Clipboard is empty.');
                return;
            }
            this.replaceSelection(text);
        } catch {
            showToast('Clipboard blocked by the browser — press Ctrl/Cmd + V instead.');
            this.restoreFocus();
        }
    }

    private deleteSelection(): void {
        if (!this.selection) {
            this.close();
            return;
        }
        this.replaceSelection('');
    }

    private selectAll(): void {
        const note = this.textarea;
        this.close();
        if (!note) return;
        note.focus({ preventScroll: true });
        note.select();
    }

    private convertCase(caseId: string): void {
        const caseDef = CASES.find(entry => entry.id === caseId);
        const note = this.textarea;
        if (!caseDef || !note) {
            this.close();
            return;
        }

        const start = note.selectionStart;
        const end = note.selectionEnd;
        if (start === end) {
            this.close();
            showToast('Select some text first, then convert its case.');
            this.restoreFocus();
            return;
        }

        const selected = note.value.slice(start, end);
        const converted = caseDef.convert(selected);
        if (converted === selected) {
            this.close();
            this.restoreFocus();
            return;
        }

        this.replaceSelection(converted);
        // Keep the converted text selected so another case can be applied.
        note.setSelectionRange(start, start + converted.length);
        showToast(`Converted to ${caseDef.label}.`);
    }

    private removeTabs(): void {
        const note = this.textarea;
        if (!note) {
            this.close();
            return;
        }
        const start = note.selectionStart;
        const end = note.selectionEnd;
        const hasSelection = start !== end;
        const target = hasSelection
            ? note.value.slice(start, end)
            : note.value;
        const tabCount = (target.match(/\t/g) || []).length;

        if (tabCount === 0) {
            this.close();
            showToast('No tab indentation to remove.');
            this.restoreFocus();
            return;
        }

        const cleaned = target.replace(/\t/g, '');
        if (hasSelection) {
            this.replaceSelection(cleaned);
            note.setSelectionRange(start, start + cleaned.length);
        } else {
            // Whole-note replacement: select everything so undo + execCommand stay coherent.
            this.close();
            note.focus({ preventScroll: true });
            note.select();
            const ok = this.execCommand('insertText', cleaned);
            if (!ok) {
                note.setRangeText(cleaned, 0, note.value.length, 'end');
                note.dispatchEvent(new Event('input', { bubbles: true }));
            }
            note.setSelectionRange(0, cleaned.length);
        }
        showToast(`Removed ${tabCount} tab${tabCount === 1 ? '' : 's'}.`);
    }
}

new ContextMenu();

// E2E probe.
interface CtxDebugWindow {
    __padifyContextMenu?: { cases: string[] };
}
(window as unknown as CtxDebugWindow).__padifyContextMenu = {
    cases: CASES.map(entry => entry.id)
};
