/**
 * Math equations for rich text notes — the KaTeX integration.
 *
 * Storage model: a note stores an EMPTY shell —
 *   `<span class="padify-math" data-latex="…"></span>`
 * — and the rendered KaTeX markup lives only in the editing DOM:
 *   - `renderMathIn` fills every shell that has no rendered content yet;
 *   - `getHtml` empties the shells again before sanitize/storage, so notes
 *     stay small and the sanitizer never sees KaTeX's hundreds of spans.
 *
 * The shell is `contenteditable="false"` — Chrome's undo stack skips DOM
 * mutations inside non-editable children (probed live: one Ctrl+Z removes
 * the whole equation, exactly like Docs), which is what makes the
 * insert-then-render sequence behave as a single undoable step.
 *
 * KaTeX renders with `throwOnError: false`: invalid LaTeX shows as red
 * source instead of exploding, and the editor never crashes on math.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

export const MATH_CLASS = 'padify-math';

/** Stored LaTeX is capped — an editor needs ~10, a crafted payload less. */
export const MATH_LATEX_PATTERN = /^[\s\S]{1,2000}$/;

/** Escapes a string for safe use inside an HTML attribute (insertHTML). */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The stored shell for a LaTeX equation (empty — rendered in the DOM). */
export function buildMathShell(latex: string): string {
  return `<span class="${MATH_CLASS}" data-latex="${escapeHtmlAttr(latex)}" contenteditable="false"></span>`;
}

/**
 * Renders every math shell inside root that isn't rendered yet. Cheap on
 * notes without math (one querySelectorAll) and idempotent everywhere else
 * — already-rendered spans carry data-rendered and are skipped.
 *
 * Renders through renderToString + innerHTML, NOT katex.render: the app's
 * index.html predates a doctype (quirks mode) and katex.render refuses to
 * run in quirks mode, while renderToString never touches the document.
 */
export function renderMathIn(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLElement>(`.${MATH_CLASS}:not([data-rendered])`)
    .forEach((span) => {
      span.setAttribute('contenteditable', 'false');
      span.innerHTML = '';
      const latex = span.getAttribute('data-latex') ?? '';
      try {
        span.innerHTML = katex.renderToString(latex, { throwOnError: false });
      } catch {
        // katex with throwOnError:false shouldn't throw, but never let a
        // rendering quirk take the editor down: show the source instead.
        span.textContent = latex;
      }
      span.setAttribute('data-rendered', '1');
    });
}

/** Live-renders LaTeX into a preview element (throws never). */
export function renderMathPreview(target: HTMLElement, latex: string): void {
  target.innerHTML = '';
  try {
    target.innerHTML = katex.renderToString(latex, { throwOnError: false });
  } catch {
    target.textContent = latex;
  }
}
