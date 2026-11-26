/**
 * The island's error boundary — the crash that stops being a white
 * screen.
 *
 * THE OWNER'S REPORT this answers: "if you click on the hamburger menu in
 * excalidraw the whole thing literally crashes." A render-time error
 * inside the vendor tree (a stale-build page whose menu row references a
 * module the deploy renamed; any vendor edge case) unwinds React's whole
 * component stack — with no boundary on the island, createRoot unmounts
 * everything and the app is a white screen. This boundary wraps the
 * vendor component ONCE (canvas.ts) and turns that class of failure into
 * the app's own error card — the same card the chunk-load failure shows,
 * with the same Retry action (reloadWithFreshShell — the deterministic
 * hard refresh; see its docstring for why an in-tab retry cannot fetch a
 * chunk name the deploy renamed).
 *
 * THE E2E CRASH SEAM (IslandCrashProbe): deterministic reproduction needs
 * a render-time throw INSIDE the boundary, and no e2e can make the real
 * vendor tree throw on demand. The probe renders null, always — except
 * when `window.__padifyCrashDrawingIsland` is set, when it throws. The
 * e2e suite sets the flag, forces an island re-render (a theme event),
 * and asserts the card (never a white screen) and the Retry press. One
 * tiny, clearly-labeled seam — the alternative (route-blocking a vendor
 * chunk to make a lazy import fail) depends on which internals happen to
 * be lazy in any given vendor build, and would flake with them.
 *
 * This module imports React only — never the vendor — so a unit-level
 * import of the boundary never drags the 1–2 MB island. It is consumed
 * exclusively by canvas.ts (the one React module of the app).
 */

import { Component, createElement, type ReactNode } from 'react';

/** The card's words and Retry action, owned by the host (canvas.ts). */
export interface IslandErrorCardSpec {
  title: string;
  body: string;
  retryLabel: string;
}

/** Reads the e2e crash flag — see the module docstring's seam story. */
function crashFlagSet(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as { __padifyCrashDrawingIsland?: boolean }).__padifyCrashDrawingIsland === true
  );
}

/** The e2e seam — throws inside the boundary's render when flagged. */
function IslandCrashProbe(): null {
  if (crashFlagSet()) {
    throw new Error('padify: the drawing island test crash (the e2e seam fired)');
  }
  return null;
}

interface BoundaryProps {
  card: IslandErrorCardSpec;
  /** The Retry press — the deterministic fresh-shell reload. */
  onRetry: () => void;
  /** The vendor island — arrives as createElement's children argument. */
  children?: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

/**
 * The boundary: `failed` flips on a caught render error and the fallback
 * card replaces the vendor tree. The vendor island dies, the app lives —
 * the mount div, the app shell, every other note stay on screen, exactly
 * like the chunk-load failure's card.
 */
export class IslandErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // A warn, not an error — visible in any console without the red
    // noise of a crash the card already owns (the SW registration's
    // logging pattern).
    console.warn('[padify] the drawing island errored (render caught):', error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      // The app's own error-card classes (surface.ts's buildCard look —
      // the CSS is global), spoken as React elements.
      return createElement(
        'div',
        { className: 'unsupported-note', 'data-note-type': 'drawing' },
        createElement('p', { className: 'unsupported-note-title' }, this.props.card.title),
        createElement(
          'p',
          { className: 'unsupported-note-body' },
          createElement('span', null, this.props.card.body),
        ),
        createElement(
          'div',
          { className: 'unsupported-note-actions' },
          createElement(
            'button',
            { type: 'button', className: 'unsupported-note-action', onClick: this.props.onRetry },
            this.props.card.retryLabel,
          ),
        ),
      );
    }
    return createElement(
      'span',
      { className: 'padify-island-boundary', style: { display: 'contents' } },
      createElement(IslandCrashProbe),
      this.props.children,
    );
  }
}
