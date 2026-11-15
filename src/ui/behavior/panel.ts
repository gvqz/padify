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
 *  - focus moves into the panel on open (data-panel-autofocus wins — but
 *    never over focus that already entered the panel: a user typing into
 *    the auth form inside the transition window keeps their caret) and
 *    returns to the anchor on close (again, only when focus has not
 *    already moved on); the anchor gets aria-expanded.
 */

import type { ElementOrDocument } from '../../lib/q';

export type PanelCloseReason = 'outside' | 'escape' | 'anchor' | 'modal' | 'programmatic';

interface PanelState {
  root: HTMLElement;
  anchor: HTMLElement | null;
  onClose?: (reason: PanelCloseReason) => void;
  shown: boolean;
  /** This panel's pending fade-out cleanup (null: none pending). Owned
   *  PER PANEL, not module-global: the global timer meant opening B
   *  while A faded CANCELLED A's cleanup outright — no display:none, no
   *  hidden attribute, no panel:hidden, no onClose — and two overlapping
   *  fades overwrote each other's handle. */
  hideTimer: number | null;
  /** This panel's pending open-transition focus (null: none pending).
   *  Cleared by closePanel: a panel that closed inside its own transition
   *  must not receive a delayed focus() from its dead opening — and the
   * timer must never outlive the state that scheduled it. */
  showTimer: number | null;
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
  // Reopening THIS panel cancels its own pending fade-out — the reopen
  // wins. Another panel's pending cleanup is deliberately left alone so
  // it still lands (see PanelState.hideTimer). A stale show-timer cannot
  // exist here (closePanel clears it), but clearing defensively keeps
  // the state machine honest against future edits.
  const pending = stateOf(root);
  if (pending && pending.hideTimer !== null) {
    window.clearTimeout(pending.hideTimer);
    pending.hideTimer = null;
  }
  if (pending && pending.showTimer !== null) {
    window.clearTimeout(pending.showTimer);
    pending.showTimer = null;
  }

  const state: PanelState = {
    root,
    anchor: anchor instanceof HTMLElement ? anchor : null,
    onClose: opts.onClose,
    shown: true,
    hideTimer: null,
    showTimer: null,
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

  state.showTimer = window.setTimeout(() => {
    state.showTimer = null;
    // Focus lands on the panel's own autofocus target (the auth form's
    // email field, say) or the panel itself — but ONLY when nothing
    // inside the panel already owns it. The unconditional steal raced
    // everyone who reached the panel inside the transition window: a
    // driver's fill() mid-keystroke had its text re-targeted to the
    // autofocus field (the CI auth flake — the password landed in the
    // email box), and a fast human typist lost their caret the same way.
    if (!root.contains(document.activeElement)) {
      const focusTarget = root.querySelector<HTMLElement>('[data-panel-autofocus]') ?? root;
      focusTarget.focus({ preventScroll: true });
    }
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

  // The dead opening must not deliver a delayed focus after the close.
  if (state.showTimer !== null) {
    window.clearTimeout(state.showTimer);
    state.showTimer = null;
  }

  fire(root, 'panel:hide');
  root.classList.remove('in');
  state.anchor?.setAttribute('aria-expanded', 'false');

  state.hideTimer = window.setTimeout(() => {
    state.hideTimer = null;
    root.style.display = 'none';
    root.setAttribute('hidden', 'hidden');
    // Another panel may have taken the stage while this one faded: its
    // open re-added the sheet lock and pointed the watcher at itself.
    // Only the LAST panel standing may take those back.
    if (!openPanelRoot) {
      document.body.classList.remove('panel-sheet-open');
      unwatchPanel();
    }
    fire(root, 'panel:hidden');
    // Focus goes home to the anchor — the panel opened from it — but
    // only when focus is still orphaned on <body>: hiding the panel
    // drops a caret that lived inside it, and THAT deserves a ride home.
    // If focus sits anywhere real, the user (or a driver) put it there
    // during the fade — yanking it to the anchor would steal their next
    // keystroke (and Space/Enter on the anchor would reopen the panel).
    const orphaned = document.activeElement === document.body || document.activeElement === null;
    if (reason !== 'anchor' && orphaned && state.anchor?.isConnected) {
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
