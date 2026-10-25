/**
 * Modal behavior controller — the owned replacement for Bootstrap 3's
 * modal plugin (the last piece of the jQuery/bootstrap-JS exit).
 *
 * Replicates the subset of bootstrap@3.4.1 modal.js this app uses, driven
 * by native events:
 *   - delegated openers:  [data-toggle="modal"] + data-target/href
 *   - delegated dismissers: [data-dismiss="modal"]
 *   - Escape closes shown modals; backdrop click closes (honours
 *     data-backdrop="static", data-keyboard="false")
 *   - body gets `modal-open` while a modal is shown, with the same
 *     scrollbar-width padding compensation bootstrap applied
 *   - the same CSS classes the vendored bootstrap stylesheet expects:
 *     .modal display block + .in, .modal-backdrop.fade.in
 *   - the same lifecycle events, as native CustomEvents with bootstrap's
 *     names (show/shown/hide/hidden.bs.modal; show/hide cancelable) so
 *     the existing listeners keep working untouched
 *
 * Timing matches bootstrap: with the .fade class, `shown` fires after the
 * 300ms dialog transition and `hidden` after it, `shown`/`hidden` land at
 * the transition boundary rather than instantly.
 */

import type { ElementOrDocument } from '../../lib/q';
import { closeAllPanels } from './panel';

const MODAL_TRANSITION_MS = 300;
const BACKDROP_TRANSITION_MS = 150;

interface ModalState {
  isShown: boolean;
  backdrop: HTMLElement | null;
  opener: HTMLElement | null;
}

const states = new WeakMap<Element, ModalState>();
const shownModals = new Set<HTMLElement>();

function stateOf(el: HTMLElement): ModalState {
  let state = states.get(el);
  if (!state) {
    state = { isShown: false, backdrop: null, opener: null };
    states.set(el, state);
  }
  return state;
}

/** Fires a bootstrap-named lifecycle event; returns false when canceled. */
function fire(el: HTMLElement, type: string, cancelable = false): boolean {
  return el.dispatchEvent(new CustomEvent(type, { bubbles: false, cancelable }));
}

function fadeDelay(el: HTMLElement): number {
  return el.classList.contains('fade') ? MODAL_TRANSITION_MS : 0;
}

// ---- scrollbar compensation (bootstrap parity) -------------------------------

let scrollbarWidth: number | undefined;

function measureScrollbar(): number {
  if (scrollbarWidth !== undefined) return scrollbarWidth;
  const probe = document.createElement('div');
  probe.className = 'modal-scrollbar-measure';
  probe.style.cssText = 'position:absolute;top:-9999px;width:50px;height:50px;overflow:scroll;';
  document.body.appendChild(probe);
  scrollbarWidth = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return scrollbarWidth;
}

function adjustScrollbar(): void {
  const bodyPad = parseInt(window.getComputedStyle(document.body).paddingRight || '0', 10);
  if (document.body.clientWidth < window.innerWidth) {
    document.body.style.paddingRight = `${bodyPad + measureScrollbar()}px`;
  }
}

function resetScrollbar(): void {
  document.body.style.paddingRight = '';
}

// ---- show / hide --------------------------------------------------------------

export function openModal(
  target: ElementOrDocument | null | undefined,
  opener?: HTMLElement,
): void {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return;

  const state = stateOf(el);
  if (state.isShown || el.classList.contains('in')) return;

  if (!fire(el, 'show.bs.modal', true)) return;

  // A modal owns the screen — any topbar panel standing goes down first.
  closeAllPanels('modal');

  state.isShown = true;
  state.opener = opener ?? null;
  shownModals.add(el);

  document.body.classList.add('modal-open');
  adjustScrollbar();

  // Backdrop — created lazily per show, like bootstrap does.
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop fade';
  document.body.appendChild(backdrop);
  void backdrop.offsetWidth; // force reflow so the fade transition runs
  backdrop.classList.add('in');
  state.backdrop = backdrop;

  // The vendored stylesheet hides .modal with display:none; bootstrap shows
  // it inline, then flips .in after a reflow to run the dialog transition.
  el.style.display = 'block';
  el.removeAttribute('aria-hidden');
  void el.offsetWidth; // reflow
  el.classList.add('in');

  window.setTimeout(() => {
    el.focus();
    fire(el, 'shown.bs.modal');
  }, fadeDelay(el));
}

export function closeModal(target: ElementOrDocument | null | undefined): void {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return;

  const state = stateOf(el);
  if (!state.isShown) return;

  if (!fire(el, 'hide.bs.modal', true)) return;

  state.isShown = false;
  shownModals.delete(el);
  el.classList.remove('in');

  window.setTimeout(() => {
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');

    if (state.backdrop) {
      state.backdrop.classList.remove('in');
      const backdrop = state.backdrop;
      window.setTimeout(() => backdrop.remove(), BACKDROP_TRANSITION_MS);
      state.backdrop = null;
    }

    if (shownModals.size === 0) {
      document.body.classList.remove('modal-open');
      resetScrollbar();
    }

    fire(el, 'hidden.bs.modal');

    // Bootstrap 3.4 restores focus to the element that opened the modal.
    state.opener?.focus();
    state.opener = null;
  }, fadeDelay(el));
}

export function closeAllModals(): void {
  Array.from(shownModals).forEach((el) => closeModal(el));
}

// ---- delegated wiring -----------------------------------------------------------

function modalTargetFromTrigger(trigger: HTMLElement): Element | null {
  const selector = trigger.getAttribute('data-target') ?? trigger.getAttribute('href');
  if (!selector || selector === '#') return null;
  return document.querySelector(selector);
}

export function initModalBehavior(): void {
  // Openers (anchors/buttons with data-target="#id" or href="#id").
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<HTMLElement>('[data-toggle="modal"]');
    if (!trigger) return;
    event.preventDefault();
    openModal(modalTargetFromTrigger(trigger), trigger);
  });

  // Dismissers (× buttons, Cancel, footer buttons — 17 in the markup).
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dismiss = target.closest<HTMLElement>('[data-dismiss="modal"]');
    if (!dismiss) return;
    const modal = dismiss.closest('.modal');
    if (modal) closeModal(modal);
  });

  // Click on the backdrop area itself (the .modal element, not the dialog).
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains('modal')) return;
    const state = states.get(target);
    if (!state?.isShown) return;
    if (target.getAttribute('data-backdrop') === 'static') return;
    closeModal(target);
  });

  // Escape closes shown modals unless data-keyboard="false".
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    Array.from(shownModals).forEach((el) => {
      if (el.getAttribute('data-keyboard') !== 'false') closeModal(el);
    });
  });
}
