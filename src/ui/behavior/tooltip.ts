/**
 * Tooltip behavior controller — the owned replacement for Bootstrap 3's
 * tooltip plugin.
 *
 * Same visuals, same data contract: elements carry data-toggle="tooltip",
 * (optionally data-placement="top|bottom|left|right") and a title. The
 * controller swaps the native title for data-original-title (so the
 * browser tooltip never double-shows) and renders the vendored
 * bootstrap markup (.tooltip.fade.[placement] with .tooltip-arrow and
 * .tooltip-inner), fading in with .in — pixel-identical to the plugin.
 *
 * Listeners are delegated on the document, so markup added at any time
 * (the timer modal mounts after boot step 1, for instance) is covered.
 */

const FADE_MS = 150;

type Placement = 'top' | 'bottom' | 'left' | 'right';

let currentTip: HTMLElement | null = null;
let currentOwner: HTMLElement | null = null;

function placementOf(el: HTMLElement): Placement {
  const value = el.getAttribute('data-placement');
  return value === 'bottom' || value === 'left' || value === 'right' ? value : 'top';
}

function titleOf(el: HTMLElement): string {
  return el.getAttribute('data-original-title') ?? el.getAttribute('title') ?? '';
}

/** jQuery/bootstrap semantics: reading the title moves it out of the DOM. */
function stripTitle(el: HTMLElement): void {
  const title = el.getAttribute('title');
  if (title !== null && title !== '') {
    el.setAttribute('data-original-title', title);
  }
  el.removeAttribute('title');
}

function positionTip(tip: HTMLElement, owner: HTMLElement, placement: Placement): void {
  const rect = owner.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  let left: number;
  let top: number;

  switch (placement) {
    case 'bottom':
      left = rect.left + rect.width / 2 - tipRect.width / 2;
      top = rect.bottom + scrollY;
      break;
    case 'left':
      left = rect.left + scrollX - tipRect.width;
      top = rect.top + rect.height / 2 - tipRect.height / 2 + scrollY;
      break;
    case 'right':
      left = rect.right + scrollX;
      top = rect.top + rect.height / 2 - tipRect.height / 2 + scrollY;
      break;
    case 'top':
    default:
      left = rect.left + rect.width / 2 - tipRect.width / 2;
      top = rect.top + scrollY - tipRect.height;
      break;
  }

  // Bootstrap's within-viewport pass: flip to the opposite side when the
  // primary placement would push the tooltip off screen.
  if (placement === 'top' && top < 0) {
    top = rect.bottom + scrollY;
  } else if (placement === 'bottom' && top + tipRect.height > window.innerHeight) {
    top = rect.top + scrollY - tipRect.height;
  }

  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${top}px`;
}

function showFor(owner: HTMLElement): void {
  const title = titleOf(owner);
  if (!title) return;
  stripTitle(owner);

  if (currentTip && currentOwner === owner) return;
  hide();

  const placement = placementOf(owner);
  const tip = document.createElement('div');
  tip.className = `tooltip fade ${placement}`;
  tip.setAttribute('role', 'tooltip');
  tip.innerHTML = '<div class="tooltip-arrow"></div><div class="tooltip-inner"></div>';
  const inner = tip.querySelector('.tooltip-inner') as HTMLElement;
  inner.textContent = title;
  document.body.appendChild(tip);

  positionTip(tip, owner, placement);
  void tip.offsetWidth; // reflow so the fade transition runs
  tip.classList.add('in');

  currentTip = tip;
  currentOwner = owner;
}

function hide(): void {
  const tip = currentTip;
  if (!tip) return;
  currentTip = null;
  currentOwner = null;
  tip.classList.remove('in');
  window.setTimeout(() => tip.remove(), FADE_MS);
}

export function initTooltips(): void {
  // Existing markup loses its native titles up front (bootstrap did this
  // at init time too); the delegated listeners below pick up any element
  // added later, lazily stripping its title on first hover.
  document.querySelectorAll<HTMLElement>('[data-toggle="tooltip"]').forEach(stripTitle);

  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const owner = target.closest<HTMLElement>('[data-toggle="tooltip"]');
    if (!owner) return;
    showFor(owner);
  });

  document.addEventListener('mouseout', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const owner = target.closest<HTMLElement>('[data-toggle="tooltip"]');
    if (!owner || owner !== currentOwner) return;
    // Moving between the owner's own children must not flicker the tip.
    if (event.relatedTarget instanceof Node && owner.contains(event.relatedTarget)) return;
    hide();
  });

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target instanceof Element) {
      const owner = target.closest<HTMLElement>('[data-toggle="tooltip"]');
      if (owner) showFor(owner);
    }
  });

  document.addEventListener('focusout', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-toggle="tooltip"]')) {
      hide();
    }
  });

  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
