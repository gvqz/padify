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

/**
 * Session-stable handle for a rendered equation shell — the id the
 * EditorPort's math API speaks (queryMathAtCaret / updateMath / the
 * padify:math-click event). Deliberately NOT part of the stored format:
 * getHtml strips it with the rendered markup, so ids are per-render
 * handles, exactly like the KaTeX output itself. Engines that keep a
 * document model answer with their own node ids — the contract is “a
 * string that updateMath understands”, never a DOM element.
 */
export const MATH_ID_ATTR = 'data-math-id';

let mathIdCounter = 0;

/** The shell's handle — assigned on first ask, stable for this render. */
export function ensureMathId(shell: HTMLElement): string {
  const existing = shell.getAttribute(MATH_ID_ATTR);
  if (existing) {
    return existing;
  }
  const id = `m${(mathIdCounter += 1)}`;
  shell.setAttribute(MATH_ID_ATTR, id);
  return id;
}

/** Stored LaTeX is capped — an editor needs ~10, a crafted payload less. */
export const MATH_LATEX_PATTERN = /^[\s\S]{1,2000}$/;

/**
 * KaTeX macros that can produce clickable links, embed external resources, or
 * smuggle HTML. `\href{url}{text}` renders as `<a href="url">text</a>` — a
 * `javascript:` URL there is a self-XSS in the math preview element (which
 * lives outside the editor's link-click interceptor in contenteditable-port.ts).
 * `\url{}` is the same surface. `\includegraphics`, `\htmlData`, `\htmlClass`,
 * `\htmlStyle`, and `\mathchoice` round out the dangerous set. We refuse to
 * render LaTeX containing these macros and fall back to showing the source —
 * the math popover is a learning tool where users experiment with \href
 * legitimately, but the editor surface itself is the only place those should
 * ever execute.
 */
const MATH_FORBIDDEN_MACROS = /\\(href|url|htmlData|htmlStyle|htmlClass|includegraphics|mathchoice)\b/;

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
 * Renders through renderToString + innerHTML, NOT katex.render:
 * renderToString never touches the document, so it works in any rendering
 * mode (the app's index.html lived without a doctype for years, where
 * katex.render's quirks-mode check refused to run) and in every context
 * the shell could land in. The doctype has since been added, but
 * renderToString stays — same output, fewer moving parts.
 */
export function renderMathIn(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(`.${MATH_CLASS}:not([data-rendered])`).forEach((span) => {
    span.setAttribute('contenteditable', 'false');
    span.innerHTML = '';
    const latex = span.getAttribute('data-latex') ?? '';
    if (MATH_FORBIDDEN_MACROS.test(latex)) {
      // Refuse to render LaTeX containing dangerous macros. Falls back to
      // the source text so the user still sees what they typed — and so a
      // malicious note can't smuggle a `javascript:` link through \href.
      span.textContent = latex;
      span.setAttribute('data-rendered', '1');
      return;
    }
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
  if (MATH_FORBIDDEN_MACROS.test(latex)) {
    target.textContent = latex;
    return;
  }
  try {
    target.innerHTML = katex.renderToString(latex, { throwOnError: false });
  } catch {
    target.textContent = latex;
  }
}
