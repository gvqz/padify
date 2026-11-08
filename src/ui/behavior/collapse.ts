/**
 * Collapse behavior controller — the owned replacement for Bootstrap 3's
 * collapse plugin, covering the one real consumer: the navbar hamburger
 * (`data-toggle="collapse" data-target="#navbar"`).
 *
 * Same class choreography the vendored bootstrap stylesheet expects:
 *   show: .collapse → .collapsing (height 0 → scrollHeight) → .collapse.in
 *   hide: .collapse.in → .collapsing (height → 0) → .collapse
 * with the bootstrap-named show/shown/hide/hidden.bs.collapse events
 * dispatched as native CustomEvents. The 350ms height transition comes
 * from the stylesheet's .collapsing rule.
 */

import type { ElementOrDocument } from '../../lib/q';

const COLLAPSE_TRANSITION_MS = 350;

const transitioning = new WeakSet<HTMLElement>();

/** The pending completion of the transition an element is running —
 *  tracked so an interrupting fold can cancel it (an expand's timer
 *  landing after a fold would re-open the menu the fold just closed). */
const pendingCompletion = new WeakMap<HTMLElement, number>();

function fire(el: HTMLElement, type: string, cancelable = false): boolean {
  return el.dispatchEvent(new CustomEvent(type, { bubbles: false, cancelable }));
}

function afterTransition(el: HTMLElement, fn: () => void): void {
  pendingCompletion.set(
    el,
    window.setTimeout(() => {
      pendingCompletion.delete(el);
      fn();
    }, COLLAPSE_TRANSITION_MS),
  );
}

/** Cancels the transition an element is mid-way through — the caller
 *  owns the element's next state, and the old completion must not land
 *  after it. */
function cancelPendingCompletion(el: HTMLElement): void {
  const timer = pendingCompletion.get(el);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pendingCompletion.delete(el);
    transitioning.delete(el);
  }
}

function expand(el: HTMLElement): void {
  transitioning.add(el);
  el.classList.remove('collapse');
  el.classList.add('collapsing');
  el.style.height = '0px';
  void el.offsetHeight; // reflow so the height transition starts from 0
  el.style.height = `${el.scrollHeight}px`;

  afterTransition(el, () => {
    el.classList.remove('collapsing');
    el.classList.add('collapse', 'in');
    el.style.height = '';
    transitioning.delete(el);
    fire(el, 'shown.bs.collapse');
  });
}

function collapse(el: HTMLElement): void {
  transitioning.add(el);
  el.style.height = `${el.getBoundingClientRect().height}px`;
  void el.offsetHeight; // reflow so the transition has a start height
  el.classList.remove('collapse', 'in');
  el.classList.add('collapsing');
  el.style.height = '0px';

  afterTransition(el, () => {
    el.classList.remove('collapsing');
    el.classList.add('collapse');
    el.style.height = '';
    transitioning.delete(el);
    fire(el, 'hidden.bs.collapse');
  });
}

/** The trigger that opens a collapse, found the way the delegated
 *  handler finds it: the data-target (or href) that names the element. */
function triggerFor(el: HTMLElement): HTMLElement | null {
  if (!el.id) return null;
  return document.querySelector<HTMLElement>(`[data-target="#${el.id}"], a[href="#${el.id}"]`);
}

export function initCollapseBehavior(): void {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<HTMLElement>('[data-toggle="collapse"]');
    if (!trigger) return;

    const selector = trigger.getAttribute('data-target') ?? trigger.getAttribute('href');
    if (!selector || selector === '#') return;
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el || transitioning.has(el)) return;

    event.preventDefault();
    if (el.classList.contains('in')) {
      if (!fire(el, 'hide.bs.collapse', true)) return;
      trigger.setAttribute('aria-expanded', 'false');
      collapse(el);
    } else {
      if (!fire(el, 'show.bs.collapse', true)) return;
      trigger.setAttribute('aria-expanded', 'true');
      expand(el);
    }
  });
}

/** Folds a collapse that a navigation is about to cover — the navbar
 *  hamburger staying open underneath a full-screen History sheet reads
 *  as a waypoint nobody dismissed. A fold that lands while an expand is
 *  still animating CANCELS the expand's pending completion first: the
 *  timer would fire after the fold finished and re-open the menu under
 *  the sheet (CI caught exactly that race). No-op when already folded
 *  and idle; the trigger's aria-expanded follows. */
export function closeCollapse(target: ElementOrDocument | null | undefined): void {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return;
  const busy = transitioning.has(el);
  if (!busy && !el.classList.contains('in')) return;
  if (!fire(el, 'hide.bs.collapse', true)) return;
  triggerFor(el)?.setAttribute('aria-expanded', 'false');
  if (busy) {
    // An interrupted expand leaves a partial height behind — the fold
    // animates from wherever the menu actually is.
    cancelPendingCompletion(el);
  }
  collapse(el);
}
