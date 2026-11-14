/**
 * The topbar panel lifecycle — the fade-out's bookkeeping.
 *
 * The hide transition makes panel lifecycles OVERLAP: opening B while A
 * fades out is the everyday switch (share-ui does exactly this —
 * closePanel(shareRoot()); openPanel(cloudModal, …)). These tests pin
 * the two invariants that overlap breaks first:
 *
 *  • THE REPLACED PANEL STILL HIDES — its fade-out cleanup (display:none,
 *    the hidden attribute, panel:hidden, onClose) must land even though
 *    another panel opened during the 150 ms window. The hide timer used
 *    to be module-global and openPanel cancelled it unconditionally, so
 *    every switch left the replaced panel a ghost: pointer-transparent,
 *    but never hidden, its close callback never fired.
 *  • THE FAST TOGGLE REOPEN WINS — close and immediately reopen the SAME
 *    panel and the pending cleanup must cancel (that is what the cancel
 *    exists for), or the stale timer would hide the freshly opened panel
 *    and fire its onClose a beat later.
 *
 * Both stage-wide resources (the sheet-mode body lock, the resize
 * watcher) belong to whoever is open when the last fade settles — a
 * replaced panel's cleanup must not take them while its successor runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePanel, initPanelBehavior, openPanel } from './panel';

// jsdom does not implement matchMedia; the panel reads it for the sheet
// breakpoint. These tests pin desktop mode (matches: false).
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const TRANSITION = 150;

function makePanel(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'topbar-panel';
  document.body.append(el);
  return el;
}

function makeAnchor(): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  document.body.append(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  initPanelBehavior();
});

afterEach(() => {
  closeAllPanelsNow();
  vi.advanceTimersByTime(TRANSITION + 1);
  vi.useRealTimers();
});

function closeAllPanelsNow(): void {
  // Best effort: close whatever is open so a leaking test does not bleed
  // into the next one through the module-level openPanelRoot.
  const open = document.querySelector('.topbar-panel:not([hidden])');
  if (open instanceof HTMLElement) {
    closePanel(open, 'programmatic');
  }
}

describe('the topbar panel lifecycle', () => {
  it('opens, fades out on close, and reports the full sequence', () => {
    const panel = makePanel('panelA');
    const anchor = makeAnchor();
    const events: string[] = [];
    panel.addEventListener('panel:show', () => events.push('show'));
    panel.addEventListener('panel:hidden', () => events.push('hidden'));

    openPanel(panel, anchor);
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('true');

    closePanel(panel, 'programmatic');
    vi.advanceTimersByTime(TRANSITION + 1);
    expect(events).toEqual(['show', 'hidden']);
    expect(panel.style.display).toBe('none');
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('switching panels: the replaced panel still hides and fires onClose', () => {
    const a = makePanel('panelA');
    const b = makePanel('panelB');
    const anchorA = makeAnchor();
    const aHidden: string[] = [];
    const aClosed: string[] = [];
    a.addEventListener('panel:hidden', () => aHidden.push('hidden'));

    openPanel(a, anchorA, { onClose: (reason) => aClosed.push(reason) });
    expect(a.hasAttribute('hidden')).toBe(false);

    // The everyday switch (share panel → cloud panel): B opens while A is
    // still showing. A's fade-out must still complete.
    openPanel(b, null);
    vi.advanceTimersByTime(TRANSITION + 1);

    expect(b.hasAttribute('hidden')).toBe(false);
    expect(b.classList.contains('in')).toBe(true);
    // A is gone for real — not a pointer-transparent ghost.
    expect(a.style.display).toBe('none');
    expect(a.hasAttribute('hidden')).toBe(true);
    expect(a.classList.contains('in')).toBe(false);
    expect(aHidden).toEqual(['hidden']);
    expect(aClosed).toEqual(['programmatic']);
  });

  it('switching twice: both replaced panels hide, the last one stays', () => {
    const a = makePanel('panelA');
    const b = makePanel('panelB');
    const c = makePanel('panelC');

    openPanel(a, null);
    openPanel(b, null);
    openPanel(c, null);
    vi.advanceTimersByTime(TRANSITION + 1);

    expect(a.style.display).toBe('none');
    expect(b.style.display).toBe('none');
    expect(c.hasAttribute('hidden')).toBe(false);
    expect(c.classList.contains('in')).toBe(true);
  });

  it('a fast toggle reopens the same panel without the stale close clobbering it', () => {
    const panel = makePanel('panelA');
    const anchor = makeAnchor();
    const closed: string[] = [];

    openPanel(panel, anchor, { onClose: (reason) => closed.push(reason) });
    closePanel(panel, 'anchor');
    // Reopen inside the fade window — the reopen must win.
    openPanel(panel, anchor);
    vi.advanceTimersByTime(TRANSITION + 1);

    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(panel.classList.contains('in')).toBe(true);
    expect(closed).toEqual([]);
  });

  it('close → switch → reopen: the first panel reopens clean', () => {
    const a = makePanel('panelA');
    const b = makePanel('panelB');

    openPanel(a, null);
    closePanel(a, 'programmatic');
    openPanel(b, null);
    // A's fade is pending; reopening A cancels its own cleanup only.
    openPanel(a, null);
    vi.advanceTimersByTime(TRANSITION + 1);

    expect(a.hasAttribute('hidden')).toBe(false);
    expect(a.classList.contains('in')).toBe(true);
    expect(b.style.display).toBe('none');
    expect(b.hasAttribute('hidden')).toBe(true);
  });

  it('the anchor click while another panel fades does not lose that cleanup', () => {
    const a = makePanel('panelA');
    const anchorB = makeAnchor();
    const b = makePanel('panelB');

    openPanel(a, null);
    // The outside-pointerdown path: A closes, then B's anchor opens B in
    // the same gesture — both inside A's fade window.
    closePanel(a, 'outside');
    openPanel(b, anchorB);
    vi.advanceTimersByTime(TRANSITION + 1);

    expect(a.style.display).toBe('none');
    expect(a.hasAttribute('hidden')).toBe(true);
    expect(b.hasAttribute('hidden')).toBe(false);
  });
});
