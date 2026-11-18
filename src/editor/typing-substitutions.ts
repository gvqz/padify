/**
 * Typing substitutions — the as-you-type text rewrites. The em-dash pair
 * (the owner's `--` → `—` setting) is the first tenant.
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
 * markdown horizontal rule, the table separator, the front-matter fence).
 * The catalog is the growth point: a future rule is an entry here plus a
 * settings row, no new machinery (see docs/TEXT-SETTINGS-IDEAS.md).
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
}

/**
 * The glue characters the veto refuses to rewrite behind — a pair glued
 * to one of these is almost certainly markdown/CLI syntax, not a dash:
 * `---` runs (the pair after another hyphen), the table separator
 * (`|---|`), emphasis fences (`**--`), blockquote arrows (`> --`),
 * setext underlines, inline code ticks.
 */
const SYNTAX_GLUE_TAIL = /[-|=<>#*_~+`.]+$/;

/** The owner's `--` → `—` rule. Fires on the freshly typed second hyphen. */
export const EM_DASH_SUBSTITUTION: TextSubstitution = {
  id: 'em-dash',
  find: '--',
  replacement: '\u2014',
  appliesAfterPrefix(linePrefix) {
    // A whitespace-only (or empty) prefix means the pair opens the line:
    // the markdown horizontal rule, the front-matter fence, an indented
    // divider. Never.
    const prose = linePrefix.replace(/[ \t\u00a0]+$/, '');
    if (prose === '') {
      return false;
    }
    if (SYNTAX_GLUE_TAIL.test(prose)) {
      return false;
    }
    return true;
  },
};

/** The catalog, in the order the rules were added. */
export const TEXT_SUBSTITUTIONS: readonly TextSubstitution[] = [EM_DASH_SUBSTITUTION];

// ---------------------------------------------------------------------------
// The listener — one hook for every note kind.
// ---------------------------------------------------------------------------

let substitutionsEnabled = false;

/** The master switch — wired to the setting's change notification. */
export function setTypingSubstitutionsEnabled(enabled: boolean): void {
  substitutionsEnabled = enabled;
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
 * Only a freshly typed hyphen can complete a pair: `inputType` must be
 * 'insertText' with `data === '-'`. The plain `input` Events the engine
 * announces with (every command's announce) and the programmatic field
 * dispatches carry no inputType — they fall out here, which is also what
 * keeps the splice from re-entering itself. Paste, drop, IME composition
 * and dictation are not typing a pair; they never fire this.
 */
export function initTypingSubstitutions(ctx: TypingSubstitutionsContext): void {
  ctx.host.addEventListener('input', (event: Event) => {
    if (!substitutionsEnabled) {
      return;
    }
    const e = event as InputEvent;
    if (e.inputType !== 'insertText' || e.data !== '-') {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      spliceTypedPairInField(
        target as HTMLTextAreaElement | HTMLInputElement,
        EM_DASH_SUBSTITUTION,
      );
      return;
    }
    // The engine path: a plain or rich note's contenteditable. No pair can
    // end here unless a hyphen sits right before the caret — asking first
    // (the port's read-only charBeforeCaret) keeps the common lone hyphen
    // ("well-known", "e-mail") from even knocking on the engine.
    const port = getEditorPort();
    if (!port || port.charBeforeCaret() !== '-') {
      return;
    }
    // A veto (no pair, boundary, parked engine) leaves the typed
    // characters — and the typing burst around them — exactly as they
    // stood.
    port.replaceBeforeCaret(
      EM_DASH_SUBSTITUTION.find,
      EM_DASH_SUBSTITUTION.replacement,
      EM_DASH_SUBSTITUTION.appliesAfterPrefix,
    );
  });
}

/**
 * The field path: the markdown source textarea, the task composer's
 * fields. The splice lands through source-edit's applyEdit — the one
 * canonical field edit — so the browser's native undo covers the
 * substitution exactly as it covers typing: one undo hands the raw pair
 * back. Returns false when nothing matched (the typed hyphen stands).
 */
function spliceTypedPairInField(
  field: HTMLTextAreaElement | HTMLInputElement,
  sub: TextSubstitution,
): boolean {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === null || end === null || start !== end) {
    return false; // the substitution is a typing-time gesture — collapsed caret only
  }
  const value = field.value;
  const pairStart = end - sub.find.length;
  if (pairStart < 0 || value.slice(pairStart, end) !== sub.find) {
    return false;
  }
  const lineStart = value.lastIndexOf('\n', pairStart - 1) + 1;
  if (!sub.appliesAfterPrefix(value.slice(lineStart, pairStart))) {
    return false;
  }
  applyEdit(field, pairStart, end, sub.replacement, pairStart + sub.replacement.length);
  return true;
}
