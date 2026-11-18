/**
 * Typing substitutions — the as-you-type text rewrites. The em-dash pair
 * (the owner's `--` → `—` setting) was the first tenant; the catalog now
 * carries the family the owner green-lit in docs/TEXT-SETTINGS-IDEAS.md:
 * the ellipsis, the ASCII arrows and Word's symbol shorthand. Smart
 * quotes and fractions were dropped by owner decision; `<-` stays out of
 * the arrows because under a closing-character trigger it would swallow
 * `<->` and it is the R assignment operator — the highest false-positive
 * cost of the set.
 *
 * One catalog, two apply paths, one veto vocabulary:
 *
 *  - the ENGINE path (plain and rich notes): the model engine's
 *    replaceBeforeCaret splices the canonical model — one history group
 *    of its own, so undo #1 hands the raw characters back;
 *  - the FIELD path (the markdown source textarea, the task composer's
 *    fields): the raw field splice through source-edit's applyEdit,
 *    which keeps the browser's native undo alive.
 *
 * Every rule carries a line-prefix predicate — the boundary veto that
 * keeps the rewrite away from the structures it would damage (the
 * markdown horizontal rule, the table separator, the front-matter
 * fence) — and, when context beyond the line matters, a document
 * predicate: the code-fence veto that keeps fenced code raw. The engine
 * adds the one structural check only it can see — a caret inside a
 * `<pre>` block never converts, in any rule.
 *
 * The catalog is the growth point: a future rule is an entry here plus
 * a settings row, no new machinery. The one rule that protects all of
 * them: a refusal must never disturb the typing burst, and a conversion
 * is its own undo group — the raw characters always come back first.
 */

import { applyEdit } from './markdown/source-edit';
import { getEditorPort } from './port';

export interface TextSubstitution {
  /** Stable id — the preference, the docs and the specs key off it. */
  id: string;
  /** The characters that must end exactly at the caret. */
  find: string;
  /** What they become. */
  replacement: string;
  /**
   * The boundary veto. `linePrefix` is everything the CURRENT LINE holds
   * before the pair (for the engine path, the caret's block is the line).
   * False refuses the rewrite — the pair is structure, not prose.
   */
  appliesAfterPrefix(linePrefix: string): boolean;
  /**
   * The document veto — the code-fence check. Receives everything the
   * document holds before the pair; false refuses the rewrite when the
   * caret sits inside a fenced code block. The field path scans the raw
   * textarea value, the engine path the canonical text stream.
   */
  appliesInDocument?(textBeforePair: string): boolean;
}

/**
 * The glue characters the veto refuses to rewrite behind — a pair glued
 * to one of these is almost certainly markdown/CLI syntax, not prose:
 * `---` runs (the pair after another hyphen), the table separator
 * (`|---|`), emphasis fences (`**--`), blockquote markers glued to the
 * pair (`> --`), setext underlines, inline code ticks, and the `<!` of
 * an HTML comment opener (`<!--` must not become `<!—`).
 */
const SYNTAX_GLUE_TAIL = /(?:[-|=<>#*_~+`.]+|<!)$/;

/**
 * The fence scan — true when `text` holds no unclosed fenced code block:
 * ``` or ~~~ at a line's edge, up to three spaces of indent (the
 * CommonMark shapes; a four-space indent is an indented code block, not
 * a fence, and stays out of the count). Deliberately conservative: an
 * unclosed fence vetoes everything after it.
 */
export function notInsideCodeFence(text: string): boolean {
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
      inside = !inside;
    }
  }
  return !inside;
}

/**
 * The dash's boundary rule, shared with the arrows: the pair must ride
 * prose. A line that opens with the pair (after any indent) is markdown
 * structure — the horizontal rule, the front-matter fence, an indented
 * divider; a pair glued to the syntax characters is a table separator,
 * an emphasis run, an HTML comment, an inline-code tick. Never.
 */
function ridesProse(linePrefix: string): boolean {
  const prose = linePrefix.replace(/[ \t\u00a0]+$/, '');
  if (prose === '') {
    return false;
  }
  return !SYNTAX_GLUE_TAIL.test(prose);
}

/**
 * The symbols' boundary — Word's own rule: the opening parenthesis must
 * follow whitespace or open the line. `foo(c)` is a function call,
 * `2(c)` a footnote style; `(c)` after a space is a copyright line.
 */
function opensLikeASymbol(linePrefix: string): boolean {
  return linePrefix === '' || /[\s\u00a0]$/.test(linePrefix);
}

/** The owner's `--` → `—` rule. Fires on the freshly typed second hyphen. */
export const EM_DASH_SUBSTITUTION: TextSubstitution = {
  id: 'em-dash',
  find: '--',
  replacement: '\u2014',
  appliesAfterPrefix: ridesProse,
  appliesInDocument: notInsideCodeFence,
};

/** The ellipsis — `...` → `…`. Fires on the freshly typed third dot. */
export const ELLIPSIS_SUBSTITUTION: TextSubstitution = {
  id: 'ellipsis',
  find: '...',
  replacement: '\u2026',
  appliesAfterPrefix(linePrefix) {
    // A leading-dot line is still prose (the ideas doc's read) — no
    // line-start veto here. What refuses: a pair glued to a preceding
    // dot (a restored trio the burst kept — `a.` + `...` must not become
    // `a.…`) and to an inline-code tick.
    return !/[.`]$/.test(linePrefix);
  },
  appliesInDocument: notInsideCodeFence,
};

/**
 * The ASCII arrows — `->` → `→`, `=>` → `⇒`, `<->` → `↔`. Each fires on
 * the freshly typed closing angle and rides the dash's own boundary
 * rule (no line starts, no syntax glue) plus the fence veto.
 */
export const RIGHT_ARROW_SUBSTITUTION: TextSubstitution = {
  id: 'arrow',
  find: '->',
  replacement: '\u2192',
  appliesAfterPrefix: ridesProse,
  appliesInDocument: notInsideCodeFence,
};

export const DOUBLE_ARROW_SUBSTITUTION: TextSubstitution = {
  id: 'arrow',
  find: '=>',
  replacement: '\u21d2',
  appliesAfterPrefix: ridesProse,
  appliesInDocument: notInsideCodeFence,
};

export const LEFT_RIGHT_ARROW_SUBSTITUTION: TextSubstitution = {
  id: 'arrow',
  find: '<->',
  replacement: '\u2194',
  appliesAfterPrefix: ridesProse,
  appliesInDocument: notInsideCodeFence,
};

/**
 * Word's symbol shorthand — `(c)` → ©, `(r)` → ®, `(tm)` → ™. Fires on
 * the freshly typed closing parenthesis, after whitespace or a line
 * start only (the call `foo(c)` stays a call), fenced code skipped.
 */
export const COPYRIGHT_SUBSTITUTION: TextSubstitution = {
  id: 'symbol',
  find: '(c)',
  replacement: '\u00a9',
  appliesAfterPrefix: opensLikeASymbol,
  appliesInDocument: notInsideCodeFence,
};

export const REGISTERED_SUBSTITUTION: TextSubstitution = {
  id: 'symbol',
  find: '(r)',
  replacement: '\u00ae',
  appliesAfterPrefix: opensLikeASymbol,
  appliesInDocument: notInsideCodeFence,
};

export const TRADEMARK_SUBSTITUTION: TextSubstitution = {
  id: 'symbol',
  find: '(tm)',
  replacement: '\u2122',
  appliesAfterPrefix: opensLikeASymbol,
  appliesInDocument: notInsideCodeFence,
};

/** The catalog, in the order the rules were added. */
export const TEXT_SUBSTITUTIONS: readonly TextSubstitution[] = [
  EM_DASH_SUBSTITUTION,
  ELLIPSIS_SUBSTITUTION,
  LEFT_RIGHT_ARROW_SUBSTITUTION,
  RIGHT_ARROW_SUBSTITUTION,
  DOUBLE_ARROW_SUBSTITUTION,
  TRADEMARK_SUBSTITUTION,
  COPYRIGHT_SUBSTITUTION,
  REGISTERED_SUBSTITUTION,
];

/**
 * The trigger table — the freshly typed character that can complete each
 * rule's pair. Candidates sit longest-first: on `>` the three-char `<->`
 * gets its turn before the two-char arrows, on `)` the `(tm)` before the
 * three-char symbols. The first armed match wins and its veto has the
 * final word — a refusal is the rule saying "this context is not
 * prose", never an invitation to try a shorter pair behind its back.
 */
const SUBSTITUTION_TRIGGERS: Readonly<Record<string, readonly TextSubstitution[]>> = {
  '-': [EM_DASH_SUBSTITUTION],
  '.': [ELLIPSIS_SUBSTITUTION],
  '>': [LEFT_RIGHT_ARROW_SUBSTITUTION, RIGHT_ARROW_SUBSTITUTION, DOUBLE_ARROW_SUBSTITUTION],
  ')': [TRADEMARK_SUBSTITUTION, COPYRIGHT_SUBSTITUTION, REGISTERED_SUBSTITUTION],
};

// ---------------------------------------------------------------------------
// The listener — one hook for every note kind.
// ---------------------------------------------------------------------------

/** The armed rules — each settings row flips exactly its own id. */
const enabledRules = new Set<string>();

/** Arms/disarms ONE substitution family — the wiring app.ts keeps. */
export function setSubstitutionEnabled(id: string, enabled: boolean): void {
  if (enabled) {
    enabledRules.add(id);
  } else {
    enabledRules.delete(id);
  }
}

/**
 * The master switch — every rule at once. The specs arm the family this
 * way; the app arms per family through the settings rows.
 */
export function setTypingSubstitutionsEnabled(enabled: boolean): void {
  for (const rule of TEXT_SUBSTITUTIONS) {
    setSubstitutionEnabled(rule.id, enabled);
  }
}

export interface TypingSubstitutionsContext {
  /**
   * The editor host. Every note kind's surface mounts inside it, so every
   * typing input event bubbles here from all of them — one listener
   * covers plain, rich, markdown and task notes alike.
   */
  host: HTMLElement;
}

/**
 * Attaches the substitution listener to the editor host.
 *
 * Only a freshly typed trigger character can complete a pair:
 * `inputType` must be 'insertText' with `data` in the trigger table.
 * The plain `input` Events the engine announces with (every command's
 * announce) and the programmatic field dispatches carry no inputType —
 * they fall out here, which is also what keeps the splice from
 * re-entering itself. Paste, drop, IME composition and dictation are
 * not typing a pair; they never fire this.
 */
export function initTypingSubstitutions(ctx: TypingSubstitutionsContext): void {
  ctx.host.addEventListener('input', (event: Event) => {
    const e = event as InputEvent;
    if (e.inputType !== 'insertText' || !e.data) {
      return;
    }
    const candidates = SUBSTITUTION_TRIGGERS[e.data];
    if (!candidates) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      spliceTypedPairInField(target as HTMLTextAreaElement | HTMLInputElement, candidates);
      return;
    }
    // The engine path: a plain or rich note's contenteditable. The live
    // text before the caret picks the rule — the longest armed pair that
    // ends here (so `<->` outruns `->`) — and the engine re-checks the
    // match atomically before anything moves. No armed pair can end
    // here → no knock on the engine, the burst stays whole.
    const port = getEditorPort();
    if (!port) {
      return;
    }
    const armed = candidates.filter((rule) => enabledRules.has(rule.id));
    const longest = Math.max(...armed.map((rule) => rule.find.length), 0);
    if (longest === 0) {
      return;
    }
    const before = port.textBeforeCaret(longest);
    const rule = armed.find((candidate) => before.endsWith(candidate.find));
    if (!rule) {
      return;
    }
    // A veto (no pair, boundary, fence, pre block, parked engine) leaves
    // the typed characters — and the typing burst around them — exactly
    // as they stood.
    port.replaceBeforeCaret(
      rule.find,
      rule.replacement,
      rule.appliesAfterPrefix,
      rule.appliesInDocument,
    );
  });
}

/**
 * The field path: the markdown source textarea, the task composer's
 * fields. The splice lands through source-edit's applyEdit — the one
 * canonical field edit — so the browser's native undo covers the
 * substitution exactly as it covers typing: one undo hands the raw pair
 * back. Returns false when nothing matched (the typed characters stand).
 */
function spliceTypedPairInField(
  field: HTMLTextAreaElement | HTMLInputElement,
  candidates: readonly TextSubstitution[],
): boolean {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === null || end === null || start !== end) {
    return false; // the substitution is a typing-time gesture — collapsed caret only
  }
  const value = field.value;
  const armed = candidates.filter((rule) => enabledRules.has(rule.id));
  const rule = armed.find(
    (candidate) =>
      end >= candidate.find.length &&
      value.slice(end - candidate.find.length, end) === candidate.find,
  );
  if (!rule) {
    return false;
  }
  const pairStart = end - rule.find.length;
  const lineStart = value.lastIndexOf('\n', pairStart - 1) + 1;
  if (!rule.appliesAfterPrefix(value.slice(lineStart, pairStart))) {
    return false;
  }
  if (rule.appliesInDocument && !rule.appliesInDocument(value.slice(0, pairStart))) {
    return false;
  }
  applyEdit(field, pairStart, end, rule.replacement, pairStart + rule.replacement.length);
  return true;
}
