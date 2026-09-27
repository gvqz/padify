/**
 * The note-type menu — the chevron beside "New note" in the rail foot.
 *
 * The main button keeps creating the default (standard) note in one click;
 * this menu is the "other kinds of notes" door. Items are built from the
 * NOTE_TYPES registry, so adding a future type needs no markup change here.
 *
 * Owns only the menu mechanics: open/close (trigger toggle, outside click,
 * Escape with focus restore, aria-expanded sync), the one-time render and
 * the create dispatch. Everything after the choice (persisting, focusing
 * the editor, toasts) belongs to the TabManager via onCreate.
 */
import { isNoteType, NOTE_TYPES, NOTE_TYPE_ICONS, type NoteType } from '../editor/note-types';

export function initNoteTypeMenu(onCreate: (type: NoteType) => void): void {
  const trigger = document.getElementById('addTabTypeMenu');
  const popover = document.getElementById('addTabTypeMenuPopover');
  if (!trigger || !popover) {
    return;
  }

  const isOpen = (): boolean => !popover.hidden;
  const setOpen = (open: boolean): void => {
    popover.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(!isOpen());
    if (isOpen()) {
      renderTypeMenuItems(popover);
    }
  });

  // Outside click closes (the trigger's own click already stopped here).
  document.addEventListener('click', (event) => {
    if (!isOpen()) {
      return;
    }
    const target = event.target as Node;
    if (!popover.contains(target) && !trigger.contains(target)) {
      setOpen(false);
    }
  });

  // Menu keys, per the menu role this markup declares: arrows rove focus
  // (wrapping), Home/End jump, Tab closes while letting focus move on, and
  // Escape closes with focus back on the trigger. Enter/Space activate —
  // native button behavior.
  const menuItems = (): HTMLElement[] =>
    Array.from(popover.querySelectorAll<HTMLElement>('[data-note-type]'));
  const focusItemAt = (items: HTMLElement[], index: number): void => {
    if (items.length > 0) {
      items[(index + items.length) % items.length].focus();
    }
  };

  document.addEventListener('keydown', (event) => {
    if (!isOpen()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.focus();
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false); // focus keeps moving on; the menu just follows suit
      return;
    }

    const items = menuItems();
    if (items.length === 0) {
      return;
    }
    const current = items.findIndex((item) => item === document.activeElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItemAt(items, current < 0 ? 0 : current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItemAt(items, current < 0 ? items.length - 1 : current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItemAt(items, 0);
        break;
      case 'End':
        event.preventDefault();
        focusItemAt(items, items.length - 1);
        break;
    }
  });

  popover.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-note-type]');
    if (!item) {
      return;
    }
    const type = item.dataset.noteType;
    if (!type || !isNoteType(type)) {
      return;
    }
    event.stopPropagation();
    setOpen(false);
    onCreate(type);
  });
}

function renderTypeMenuItems(popover: HTMLElement): void {
  if (popover.childElementCount > 0) {
    return; // built once from the registry; the page is single-session
  }

  NOTE_TYPES.forEach((def) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tab-type-menu-item';
    item.setAttribute('role', 'menuitem');
    item.dataset.noteType = def.id;

    const icon = document.createElement('span');
    icon.className = 'tab-type-menu-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = NOTE_TYPE_ICONS[def.id](15);
    item.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'tab-type-menu-text';
    const label = document.createElement('span');
    label.className = 'tab-type-menu-label';
    label.textContent = def.label;
    const description = document.createElement('span');
    description.className = 'tab-type-menu-desc';
    description.textContent = def.description;
    text.appendChild(label);
    text.appendChild(description);
    item.appendChild(text);

    popover.appendChild(item);
  });
}
