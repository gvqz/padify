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

const COLLAPSE_TRANSITION_MS = 350;

const transitioning = new WeakSet<HTMLElement>();

function fire(el: HTMLElement, type: string, cancelable = false): boolean {
  return el.dispatchEvent(new CustomEvent(type, { bubbles: false, cancelable }));
}

function afterTransition(el: HTMLElement, fn: () => void): void {
  window.setTimeout(fn, COLLAPSE_TRANSITION_MS);
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
      collapse(el);
    } else {
      if (!fire(el, 'show.bs.collapse', true)) return;
      expand(el);
    }
  });
}
