/**
 * Topbar panels — anchored, non-modal popover surfaces.
 *
 * The cloud sync menu and the share menu are topbar SERVICES, not
 * documents: they open from their own icon, hover over the page without a
 * backdrop, and close on outside click or Escape. That shape is deliberately
 * NOT the History sheet's: a sheet is a room you visit (snapshots, long
 * lists, in-place edits); a panel is a tool you grab (sign in, copy a link,
 * see the sync state) and put back down.
 *
 * Contracts:
 *  - one panel open at a time (opening one closes the other);
 *  - opening a MODAL closes any panel (the modal owns the screen);
 *  - Escape closes the open panel — unless a modal is shown, the modal
 *    owns Escape;
 *  - outside pointerdown closes; a click on the anchor toggles;
 *  - desktop: the panel hangs from its anchor (below, left-aligned,
 *    flipped above / nudged when the viewport pushes back), and
 *    repositions on scroll + resize + its own content growth;
 *  - narrow viewports (<640px): the panel becomes a bottom sheet —
 *    full width, slides up, body scroll locked while open;
 *  - focus moves into the panel on open (data-panel-autofocus wins) and
 *    returns to the anchor on close; the anchor gets aria-expanded.
 */

import type { ElementOrDocument } from '../../lib/q';

export type PanelCloseReason = 'outside' | 'escape' | 'anchor' | 'modal' | 'programmatic';

interface PanelState {
  root: HTMLElement;
  anchor: HTMLElement | null;
  onClose?: (reason: PanelCloseReason) => void;
  shown: boolean;
}

const SHEET_QUERY = '(max-width: 640px)';
/** The panel's open transition — keep in sync with 19-panels.css. */
const PANEL_TRANSITION_MS = 150;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 8;

const stateOf = (root: HTMLElement): PanelState | undefined => PANELS.get(root);

const PANELS = new WeakMap<HTMLElement, PanelState>();
/** At most one panel is ever open; this is it (or null). */
let openPanelRoot: HTMLElement | null = null;
let hideTimer: number | null = null;

function fire(root: HTMLElement, type: string): void {
  root.dispatchEvent(new CustomEvent(type, { bubbles: false }));
}

function sheetMode(): boolean {
  return window.matchMedia(SHEET_QUERY).matches;
}

// ---- positioning -----------------------------------------------------------

/** Repositions the open panel under its anchor; desktop mode only. */
function positionPanel(root: HTMLElement, anchor: HTMLElement): void {
  if (sheetMode()) {
    return; // the sheet is CSS-positioned (fixed to the bottom edge)
  }

  const panelRect = root.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Horizontal: left edges meet; if the panel would spill off the right
  // edge, hang it off the anchor's right edge instead; clamp as a last
  // resort so a tiny viewport can never clip it.
  let left = anchorRect.left;
  if (left + panelRect.width > vw - VIEWPORT_MARGIN) {
    left = anchorRect.right - panelRect.width;
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - panelRect.width - VIEWPORT_MARGIN));

  // Vertical: below the anchor; flip above when the panel would spill
  // past the bottom; clamp when even the flipped side cannot hold it.
  let top = anchorRect.bottom + ANCHOR_GAP;
  const originY = 'top';
  if (top + panelRect.height > vh - VIEWPORT_MARGIN) {
    const above = anchorRect.top - ANCHOR_GAP - panelRect.height;
    if (above >= VIEWPORT_MARGIN) {
      top = above;
    }
  }
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - panelRect.height - VIEWPORT_MARGIN));

  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  root.style.transformOrigin =
    originY === 'top'
      ? `${Math.round(anchorRect.left - left + anchorRect.width / 2)}px 0`
      : 'center bottom';
}

/** Re-positions while open (scroll / resize / content growth). */
function reposition(): void {
  if (!openPanelRoot) return;
  const state = PANELS.get(openPanelRoot);
  if (!state?.shown || !state.anchor || sheetMode()) return;
  positionPanel(state.root, state.anchor);
}

let rafQueued = false;

/** rAF-throttled wrapper so a scroll storm costs one layout pass. */
function repositionSoon(): void {
  if (rafQueued || !openPanelRoot) return;
  rafQueued = true;
  window.requestAnimationFrame(() => {
    rafQueued = false;
    reposition();
  });
}

let resizeObserver: ResizeObserver | null = null;

function watchPanel(root: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => repositionSoon());
  resizeObserver.observe(root);
}

function unwatchPanel(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
}

// ---- show / hide -------------------------------------------------------------

export function openPanel(
  target: ElementOrDocument | null | undefined,
  anchor: ElementOrDocument | null | undefined,
  opts: { onClose?: (reason: PanelCloseReason) => void } = {},
): void {
  const root = target instanceof HTMLElement ? target : null;
  if (!root) return;

  if (openPanelRoot === root) {
    closePanel(root, 'anchor');
    return;
  }
  if (openPanelRoot) {
    closePanel(openPanelRoot, 'programmatic');
  }
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  const state: PanelState = {
    root,
    anchor: anchor instanceof HTMLElement ? anchor : null,
    onClose: opts.onClose,
    shown: true,
  };
  PANELS.set(root, state);
  openPanelRoot = root;

  fire(root, 'panel:show');

  root.removeAttribute('hidden');
  root.style.display = 'block';
  void root.offsetWidth; // reflow — the transition needs a starting frame

  if (sheetMode()) {
    root.classList.add('at-sheet');
    document.body.classList.add('panel-sheet-open');
  } else {
    root.classList.remove('at-sheet');
    if (state.anchor) positionPanel(root, state.anchor);
  }

  root.classList.add('in');
  if (state.anchor) state.anchor.setAttribute('aria-expanded', 'true');

  window.setTimeout(() => {
    // Focus lands on the panel's own autofocus target (the auth form's
    // email field, say) or the panel itself.
    const focusTarget =
      root.querySelector<HTMLElement>('[data-panel-autofocus]') ?? (root as HTMLElement);
    focusTarget.focus({ preventScroll: true });
    fire(root, 'panel:shown');
  }, PANEL_TRANSITION_MS);

  watchPanel(root);
}

export function closePanel(
  target: ElementOrDocument | null | undefined,
  reason: PanelCloseReason = 'programmatic',
): void {
  const root = target instanceof HTMLElement ? target : null;
  const state = root ? stateOf(root) : undefined;
  if (!root || !state || !state.shown) return;

  state.shown = false;
  if (openPanelRoot === root) openPanelRoot = null;

  fire(root, 'panel:hide');
  root.classList.remove('in');
  state.anchor?.setAttribute('aria-expanded', 'false');

  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    root.style.display = 'none';
    root.setAttribute('hidden', 'hidden');
    document.body.classList.remove('panel-sheet-open');
    unwatchPanel();
    fire(root, 'panel:hidden');
    // Focus goes home to the anchor — the panel opened from it. The
    // anchor may be a plain wrapper (the cloud nav's span): fall back to
    // its own focusable trigger.
    if (reason !== 'anchor' && state.anchor?.isConnected) {
      const anchor = state.anchor;
      anchor.focus({ preventScroll: true });
      if (document.activeElement !== anchor) {
        anchor.querySelector<HTMLElement>('a, button, [tabindex]')?.focus({ preventScroll: true });
      }
    }
    state.onClose?.(reason);
  }, PANEL_TRANSITION_MS);
}

export function closeAllPanels(reason: PanelCloseReason = 'programmatic'): void {
  if (!openPanelRoot) return;
  closePanel(openPanelRoot, reason);
}

export function isPanelOpen(target?: ElementOrDocument | null): boolean {
  if (target instanceof HTMLElement) return openPanelRoot === target;
  return openPanelRoot !== null;
}

// ---- delegated wiring ----------------------------------------------------------

let wired = false;

export function initPanelBehavior(): void {
  if (wired) return;
  wired = true;

  // data-dismiss="panel" — the panel's own × buttons.
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const dismiss = target?.closest?.('[data-dismiss="panel"]');
    if (!dismiss) return;
    const panel = dismiss.closest('.topbar-panel');
    if (panel instanceof HTMLElement) closePanel(panel, 'programmatic');
  });

  // Outside pointerdown closes — the panel is a tool, not a room; there
  // is no backdrop to click, the page itself is the dismiss gesture.
  document.addEventListener('pointerdown', (event) => {
    if (!openPanelRoot) return;
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest('.topbar-panel')) return;
    const state = PANELS.get(openPanelRoot);
    if (state?.anchor && state.anchor.contains(target)) {
      return; // the anchor's own click handler toggles
    }
    closePanel(openPanelRoot, 'outside');
  });

  // Escape closes the panel — unless a modal is showing, the modal owns
  // Escape. Capture phase so the panel answers before page-level shortcuts.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !openPanelRoot) return;
      if (document.querySelector('.modal.in')) return;
      event.stopPropagation();
      closePanel(openPanelRoot, 'escape');
    },
    true,
  );

  // Keep the panel under its anchor while the world moves.
  window.addEventListener('scroll', repositionSoon, true);
  window.addEventListener('resize', () => {
    if (!openPanelRoot) return;
    const state = PANELS.get(openPanelRoot);
    if (!state?.shown) return;
    // Crossing the sheet breakpoint swaps the positioning mode in place.
    if (sheetMode()) {
      state.root.classList.add('at-sheet');
      document.body.classList.add('panel-sheet-open');
      state.root.style.left = '';
      state.root.style.top = '';
    } else {
      state.root.classList.remove('at-sheet');
      document.body.classList.remove('panel-sheet-open');
      if (state.anchor) positionPanel(state.root, state.anchor);
    }
  });
}
