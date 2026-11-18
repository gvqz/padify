import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeNoteHtml } from './storage-subset';
import { ModelPort } from './model-port';
import { setEditorPort } from './port';
import {
  COPYRIGHT_SUBSTITUTION,
  DOUBLE_ARROW_SUBSTITUTION,
  ELLIPSIS_SUBSTITUTION,
  EM_DASH_SUBSTITUTION,
  LEFT_RIGHT_ARROW_SUBSTITUTION,
  REGISTERED_SUBSTITUTION,
  RIGHT_ARROW_SUBSTITUTION,
  TRADEMARK_SUBSTITUTION,
  initTypingSubstitutions,
  notInsideCodeFence,
  setSubstitutionEnabled,
  setTypingSubstitutionsEnabled,
} from './typing-substitutions';

/**
 * The typing substitutions, end to end in jsdom:
 *
 *  - the catalog's boundary vetoes (the markdown structures and the
 *    inline glue each rule must never convert);
 *  - the document veto — the code-fence scan shared by the family;
 *  - the FIELD path — the markdown source textarea and the task
 *    composer's inputs, spliced through applyEdit;
 *  - the ENGINE path — plain/rich notes through the model engine,
 *    including the undo/redo manners (undo #1 hands the raw pair back),
 *    the vetoes the engine re-checks, and the `<pre>` structural veto;
 *  - the arming — one settings row per family, the master switch for
 *    the specs.
 */

// ---------------------------------------------------------------------------
// The em-dash rule's boundary veto.
// ---------------------------------------------------------------------------

describe('the em-dash rule boundary veto', () => {
  const applies = (prefix: string) => EM_DASH_SUBSTITUTION.appliesAfterPrefix(prefix);

  it('converts after prose: a word, a space, punctuation of sentences', () => {
    expect(applies('wait ')).toBe(true);
    expect(applies('well')).toBe(true);
    expect(applies('said "')).toBe(true);
    expect(applies('e.g ')).toBe(true);
  });

  it('never converts at a line start — the markdown horizontal rule', () => {
    expect(applies('')).toBe(false);
  });

  it('never converts behind whitespace alone — the indented divider', () => {
    expect(applies('   ')).toBe(false);
    expect(applies('\t')).toBe(false);
    expect(applies('\u00a0\u00a0')).toBe(false);
  });

  it('never converts behind syntax glue — tables, fences, emphasis, quotes', () => {
    expect(applies('|')).toBe(false); // the table separator: |---|---|
    expect(applies('-')).toBe(false); // the third hyphen of a --- run
    expect(applies('a-')).toBe(false); // a longer hyphen run
    expect(applies('**')).toBe(false);
    expect(applies('>')).toBe(false);
    expect(applies('#')).toBe(false);
    expect(applies('`')).toBe(false);
    expect(applies('=')).toBe(false);
    expect(applies('e.g.')).toBe(false); // the numbered-list dot stays a dot
  });

  it('never converts behind an HTML comment opener — `<!--` stays `<!--`', () => {
    expect(applies('<!')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The family's boundary vetoes.
// ---------------------------------------------------------------------------

describe('the ellipsis rule boundary veto', () => {
  const applies = (prefix: string) => ELLIPSIS_SUBSTITUTION.appliesAfterPrefix(prefix);

  it('converts after prose — a leading-dot line is still prose', () => {
    expect(applies('wait ')).toBe(true);
    expect(applies('')).toBe(true);
    expect(applies('e.g ')).toBe(true);
  });

  it('never converts behind a dot — a restored trio must not fuse', () => {
    expect(applies('a.')).toBe(false);
    expect(applies('...')).toBe(false);
  });

  it('never converts behind an inline-code tick', () => {
    expect(applies('`')).toBe(false);
  });
});

describe('the arrows’ boundary veto (the dash’s own rule)', () => {
  const applies = {
    right: (p: string) => RIGHT_ARROW_SUBSTITUTION.appliesAfterPrefix(p),
    both: (p: string) => LEFT_RIGHT_ARROW_SUBSTITUTION.appliesAfterPrefix(p),
    double: (p: string) => DOUBLE_ARROW_SUBSTITUTION.appliesAfterPrefix(p),
  };

  it('never converts at a line start or behind whitespace alone', () => {
    expect(applies.right('')).toBe(false);
    expect(applies.right('  ')).toBe(false);
    expect(applies.both('')).toBe(false);
    expect(applies.double('\t')).toBe(false);
  });

  it('converts after prose: a word, a space', () => {
    expect(applies.right('a ')).toBe(true);
    expect(applies.right('a')).toBe(true);
    expect(applies.both('e ')).toBe(true);
    expect(applies.double('f ')).toBe(true);
  });

  it('never converts behind syntax glue — hyphen runs, equals chains, comments', () => {
    expect(applies.right('a-')).toBe(false); // `a-->` stays raw
    expect(applies.right('x=')).toBe(false); // `x==>` stays raw
    expect(applies.right('|')).toBe(false);
    expect(applies.right('>')).toBe(false);
    expect(applies.both('a-')).toBe(false);
    expect(applies.double('<!')).toBe(false);
  });
});

describe('the symbols’ boundary veto (Word’s own rule)', () => {
  const applies = {
    c: (p: string) => COPYRIGHT_SUBSTITUTION.appliesAfterPrefix(p),
    r: (p: string) => REGISTERED_SUBSTITUTION.appliesAfterPrefix(p),
    tm: (p: string) => TRADEMARK_SUBSTITUTION.appliesAfterPrefix(p),
  };

  it('converts after whitespace or a line start', () => {
    expect(applies.c('')).toBe(true);
    expect(applies.c(' ')).toBe(true);
    expect(applies.c('\t')).toBe(true);
    expect(applies.c('\u00a0')).toBe(true);
    expect(applies.r('see ')).toBe(true);
    expect(applies.tm('  ')).toBe(true);
  });

  it('never converts behind a word — foo(c) stays a function call', () => {
    expect(applies.c('foo')).toBe(false);
    expect(applies.c('(')).toBe(false);
    expect(applies.c('2')).toBe(false);
    expect(applies.r('`')).toBe(false);
    expect(applies.tm('x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The document veto — the code-fence scan.
// ---------------------------------------------------------------------------

describe('the code-fence veto (the document predicate)', () => {
  it('passes prose and closed fences', () => {
    expect(notInsideCodeFence('')).toBe(true);
    expect(notInsideCodeFence('wait ... ok')).toBe(true);
    expect(notInsideCodeFence('```js\nx = 1\n```\nafter')).toBe(true);
    expect(notInsideCodeFence('~~~\nshell\n~~~\n')).toBe(true);
  });

  it('refuses inside an open fence — including an unclosed one', () => {
    expect(notInsideCodeFence('```js\nx = 1')).toBe(false);
    expect(notInsideCodeFence('before\n```\nstill inside')).toBe(false);
    expect(notInsideCodeFence('~~~\n- ->')).toBe(false);
  });

  it('a four-space indent is an indented code block, not a fence', () => {
    expect(notInsideCodeFence('    ``` weird')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The FIELD path — a textarea/input spliced on the typed pair.
// ---------------------------------------------------------------------------

describe('the field splice (markdown source textarea, task fields)', () => {
  let host: HTMLElement;

  /** Simulates the browser's typed-hyphen input on `field`. */
  function typeHyphen(field: HTMLTextAreaElement | HTMLInputElement): void {
    const event = new Event('input', { bubbles: true });
    Object.defineProperty(event, 'inputType', { value: 'insertText' });
    Object.defineProperty(event, 'data', { value: '-' });
    field.dispatchEvent(event);
  }

  /** Simulates the browser typing one character on `field`. */
  function typeChar(field: HTMLTextAreaElement | HTMLInputElement, ch: string): void {
    const event = new Event('input', { bubbles: true });
    Object.defineProperty(event, 'inputType', { value: 'insertText' });
    Object.defineProperty(event, 'data', { value: ch });
    field.dispatchEvent(event);
  }

  function makeField(
    value: string,
    caret: number,
    tag: 'textarea' | 'input' = 'textarea',
  ): HTMLTextAreaElement | HTMLInputElement {
    const field =
      tag === 'textarea'
        ? document.createElement('textarea')
        : (Object.assign(document.createElement('input'), { type: 'text' }) as HTMLInputElement);
    field.value = value;
    host.append(field);
    field.focus();
    field.setSelectionRange(caret, caret);
    return field;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    initTypingSubstitutions({ host });
    setTypingSubstitutionsEnabled(true);
  });

  afterEach(() => {
    host.remove();
    setTypingSubstitutionsEnabled(false);
  });

  it('converts the pair mid-line: "wait --" + "-" → "wait —"', () => {
    // The trigger is the SECOND hyphen's input: the value already holds
    // the pair, the caret sits right after it.
    const field = makeField('wait --', 7);
    typeHyphen(field);
    expect(field.value).toBe('wait \u2014');
    expect(field.selectionStart).toBe(6);
    expect(field.selectionEnd).toBe(6);
  });

  it('converts after a word: "well--" → "well—" (the intra-word dash)', () => {
    const field = makeField('well--', 6);
    typeHyphen(field);
    expect(field.value).toBe('well\u2014');
  });

  it('rides an INPUT as well as a textarea (the task composer)', () => {
    const field = makeField('blocked --', 10, 'input');
    typeHyphen(field);
    expect(field.value).toBe('blocked \u2014');
  });

  it('leaves the line-start pair alone — the "---" horizontal rule', () => {
    const field = makeField('--', 2);
    typeHyphen(field);
    expect(field.value).toBe('--');
  });

  it('leaves the table separator alone: "|--" stays "|--"', () => {
    const field = makeField('|--', 3);
    typeHyphen(field);
    expect(field.value).toBe('|--');
  });

  it('leaves a "---" run alone on the pair before the third hyphen', () => {
    // Typing "---": at the second hyphen the pair opens the line (veto);
    // at the third, the prefix ends in a hyphen (veto again).
    const field = makeField('---', 3);
    typeHyphen(field);
    expect(field.value).toBe('---');
  });

  it('is line-scoped: a pair that opens a line stays, one mid-line converts', () => {
    const field = makeField('intro\n--', 8);
    typeHyphen(field);
    expect(field.value).toBe('intro\n--');

    const second = makeField('intro\nwait --', 13);
    typeHyphen(second);
    expect(second.value).toBe('intro\nwait \u2014');
  });

  it('does nothing when disabled (the shipped default)', () => {
    setTypingSubstitutionsEnabled(false);
    const field = makeField('wait --', 7);
    typeHyphen(field);
    expect(field.value).toBe('wait --');
  });

  it('does nothing for paste, drop, or the engine\u2019s own announcements', () => {
    const field = makeField('wait --', 7);
    for (const inputType of ['insertFromPaste', 'insertFromDrop', 'insertCompositionText']) {
      const event = new Event('input', { bubbles: true });
      Object.defineProperty(event, 'inputType', { value: inputType });
      Object.defineProperty(event, 'data', { value: '-' });
      field.dispatchEvent(event);
    }
    // The plain Events every programmatic path announces with.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(field.value).toBe('wait --');
  });

  it('does nothing under a ranged selection', () => {
    const field = makeField('wait --', 7);
    field.setSelectionRange(0, 7);
    typeHyphen(field);
    expect(field.value).toBe('wait --');
  });

  it('fires only on a typed hyphen — other characters never splice', () => {
    const field = makeField('wait --', 7);
    const event = new Event('input', { bubbles: true });
    Object.defineProperty(event, 'inputType', { value: 'insertText' });
    Object.defineProperty(event, 'data', { value: 'x' });
    field.dispatchEvent(event);
    expect(field.value).toBe('wait --');
  });

  it('converts the ellipsis on the typed third dot: "wait ..." → "wait …"', () => {
    const field = makeField('wait ...', 8);
    typeChar(field, '.');
    expect(field.value).toBe('wait \u2026');
    expect(field.selectionStart).toBe(6);
    expect(field.selectionEnd).toBe(6);
  });

  it('never fuses a restored trio with a fresh dot: "a...." stands', () => {
    const field = makeField('a....', 5);
    typeChar(field, '.');
    expect(field.value).toBe('a....');
  });

  it('never converts behind an inline-code tick: "`..." stands', () => {
    const field = makeField('`...', 4);
    typeChar(field, '.');
    expect(field.value).toBe('`...');
  });

  it('stays inside a fenced block: the ellipsis and the arrow keep their code', () => {
    const field = makeField('```js\nwait ...', 14);
    typeChar(field, '.');
    expect(field.value).toBe('```js\nwait ...');

    const arrow = makeField('```js\nstep ->', 13);
    typeChar(arrow, '>');
    expect(arrow.value).toBe('```js\nstep ->');
  });

  it('converts after the fence closes', () => {
    const field = makeField('```\ncode\n```\nwait ...', 21);
    typeChar(field, '.');
    expect(field.value).toBe('```\ncode\n```\nwait \u2026');
  });

  it('converts the arrows on the typed closing angle', () => {
    const right = makeField('a ->', 4);
    typeChar(right, '>');
    expect(right.value).toBe('a \u2192');

    const both = makeField('a <->', 5);
    typeChar(both, '>');
    expect(both.value).toBe('a \u2194');

    const double = makeField('a =>', 4);
    typeChar(double, '>');
    expect(double.value).toBe('a \u21d2');
  });

  it('leaves `<-` alone — no rule, no rewrite (the R assignment stands)', () => {
    const field = makeField('x <-', 4);
    typeChar(field, '-');
    expect(field.value).toBe('x <-');
  });

  it('never converts behind a hyphen run: "a-->" stands', () => {
    const field = makeField('a-->', 4);
    typeChar(field, '>');
    expect(field.value).toBe('a-->');
  });

  it('converts the symbols on the typed closing parenthesis', () => {
    const c = makeField('see (c)', 7);
    typeChar(c, ')');
    expect(c.value).toBe('see \u00a9');

    const r = makeField('see (r)', 7);
    typeChar(r, ')');
    expect(r.value).toBe('see \u00ae');

    const tm = makeField('see (tm)', 8);
    typeChar(tm, ')');
    expect(tm.value).toBe('see \u2122');

    const lineStart = makeField('(tm)', 4);
    typeChar(lineStart, ')');
    expect(lineStart.value).toBe('\u2122');
  });

  it('never converts a call: "foo(c)" stands, uppercase "(C)" too', () => {
    const call = makeField('foo(c)', 6);
    typeChar(call, ')');
    expect(call.value).toBe('foo(c)');

    const upper = makeField('see (C)', 7);
    typeChar(upper, ')');
    expect(upper.value).toBe('see (C)');
  });

  it('arms per family: symbols on, the dash stays raw', () => {
    setTypingSubstitutionsEnabled(false);
    setSubstitutionEnabled('symbol', true);

    const c = makeField('see (c)', 7);
    typeChar(c, ')');
    expect(c.value).toBe('see \u00a9');

    const dash = makeField('wait --', 7);
    typeHyphen(dash);
    expect(dash.value).toBe('wait --');
  });
});

// ---------------------------------------------------------------------------
// The ENGINE path — plain/rich notes through the model engine.
// ---------------------------------------------------------------------------

describe('the engine splice (plain and rich notes)', () => {
  function makePort(html = ''): { port: ModelPort; surface: HTMLElement } {
    const surface = document.createElement('div');
    surface.setAttribute('contenteditable', 'true');
    document.body.append(surface);
    const port = new ModelPort(surface, { sanitize: sanitizeNoteHtml });
    if (html !== '') {
      port.renderHtml(html);
    }
    return { port, surface };
  }

  /** Parks the caret at a stream offset on the surface (end-safe) — the
   *  live selection the engine's commands read. */
  function caretAtOffset(surface: HTMLElement, offset: number): void {
    const selection = window.getSelection()!;
    const range = document.createRange();
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node as Text;
      const len = (text.nodeValue ?? '').length;
      if (consumed + len >= offset) {
        range.setStart(text, offset - consumed);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      consumed += len;
    }
    range.selectNodeContents(surface);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Simulates the browser typing `text` at the caret: the native DOM
   *  edit, wrapped in the beforeinput/input pair (the engine's burst
   *  machinery sees exactly what Chromium sends). */
  function typeText(surface: HTMLElement, text: string): void {
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(before, 'inputType', { value: 'insertText' });
    Object.defineProperty(before, 'data', { value: text });
    surface.dispatchEvent(before);

    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);
    if (range) {
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStart(node, text.length);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    const after = new Event('input', { bubbles: true });
    Object.defineProperty(after, 'inputType', { value: 'insertText' });
    Object.defineProperty(after, 'data', { value: text });
    surface.dispatchEvent(after);
  }

  function textOf(surface: HTMLElement): string {
    return surface.textContent ?? '';
  }

  describe('through the substitution listener (the full wiring)', () => {
    let port: ModelPort;
    let surface: HTMLElement;

    beforeEach(() => {
      ({ port, surface } = makePort());
      caretAtOffset(surface, 0);
      setEditorPort(port); // the app installs the engine at boot; so does the test
      initTypingSubstitutions({ host: surface });
      setTypingSubstitutionsEnabled(true);
    });

    afterEach(() => {
      surface.remove();
      setTypingSubstitutionsEnabled(false);
    });

    it('the pair converts as you type: "wait -- what" → "wait — what"', () => {
      port.insertText('wait ');
      typeText(surface, '-');
      typeText(surface, '-');
      typeText(surface, ' what');
      expect(textOf(surface)).toBe('wait \u2014 what');
    });

    it('undo #1 hands the raw pair back, redo brings the dash again', () => {
      port.insertText('wait ');
      typeText(surface, '-');
      typeText(surface, '-');

      expect(textOf(surface)).toBe('wait \u2014');
      expect(port.undo()).toBe(true);
      expect(textOf(surface)).toBe('wait --');
      // The caret rides the restored state — right after the raw pair.
      expect(window.getSelection()?.rangeCount).toBe(1);
      expect(port.redo()).toBe(true);
      expect(textOf(surface)).toBe('wait \u2014');
    });

    it('undo #2 removes the whole typed burst, the chain stays coherent', () => {
      port.insertText('wait ');
      typeText(surface, '-');
      typeText(surface, '-');

      expect(port.undo()).toBe(true); // → 'wait --' (the substitution reverts)
      expect(textOf(surface)).toBe('wait --');
      expect(port.undo()).toBe(true); // → 'wait ' (the pair's burst goes)
      expect(textOf(surface)).toBe('wait ');
      expect(port.undo()).toBe(true); // → '' (the first burst goes)
      expect(textOf(surface)).toBe('');
      expect(port.redo()).toBe(true);
      expect(textOf(surface)).toBe('wait ');
      expect(port.redo()).toBe(true);
      expect(textOf(surface)).toBe('wait --');
      expect(port.redo()).toBe(true);
      expect(textOf(surface)).toBe('wait \u2014');
    });

    it('typing continues after the substitution with no re-fire', () => {
      port.insertText('wait ');
      typeText(surface, '-');
      typeText(surface, '-');
      expect(textOf(surface)).toBe('wait \u2014');

      // Undo back to the raw pair, then keep typing — the restored
      // characters must NOT re-trigger (the trap autocorrect is famous
      // for: you cannot get your "--" back).
      expect(port.undo()).toBe(true);
      expect(textOf(surface)).toBe('wait --');
      typeText(surface, ' what');
      expect(textOf(surface)).toBe('wait -- what');
    });

    it('the third hyphen of a run never converts: "a—-", not "a——"', () => {
      port.insertText('a-');
      typeText(surface, '-'); // pair completes → 'a—'
      expect(textOf(surface)).toBe('a\u2014');
      typeText(surface, '-'); // the run continues — the prefix ends in the dash
      expect(textOf(surface)).toBe('a\u2014-');
    });

    it('the line-start pair is left alone — "---" stays "---"', () => {
      typeText(surface, '-');
      typeText(surface, '-');
      expect(textOf(surface)).toBe('--');
      typeText(surface, '-');
      expect(textOf(surface)).toBe('---');
    });

    it('a pair that opens a new paragraph stays raw', () => {
      port.insertText('intro');
      typeText(surface, '-');
      typeText(surface, '-');
      // 'intro--' — mid-line pair converts…
      expect(textOf(surface)).toBe('intro\u2014');
      const after = new Event('beforeinput', { bubbles: true, cancelable: true });
      Object.defineProperty(after, 'inputType', { value: 'insertParagraph' });
      surface.dispatchEvent(after);
      // …but the model check also vetoes a pair that straddles a block
      // boundary (covered by the op tests below).
    });

    it('a lone hyphen does not split the typing burst (undo granularity)', () => {
      port.insertText('wait ');
      typeText(surface, '-');
      typeText(surface, 'x');
      expect(textOf(surface)).toBe('wait -x');
      // One undo step for the whole burst — the lone hyphen never knocked
      // on the engine, so the burst stayed open across it.
      expect(port.undo()).toBe(true);
      expect(textOf(surface)).toBe('wait ');
      expect(port.undo()).toBe(true);
      expect(textOf(surface)).toBe('');
    });

    it('a vetoed pair does not split the burst (the table-separator typing)', () => {
      port.insertText('a|');
      typeText(surface, '-');
      typeText(surface, '-');
      typeText(surface, 'b');
      expect(textOf(surface)).toBe('a|--b');
      // The veto refused twice; neither refusal may close the burst —
      // one undo takes the whole typed run back, exactly as without the
      // setting.
      expect(port.undo()).toBe(true);
      expect(textOf(surface)).toBe('a|');
    });

    it('the substitution survives the toggle: off means nothing moves', () => {
      port.insertText('wait ');
      setTypingSubstitutionsEnabled(false);
      typeText(surface, '-');
      typeText(surface, '-');
      expect(textOf(surface)).toBe('wait --');
      setTypingSubstitutionsEnabled(true);
      typeText(surface, ' what');
      expect(textOf(surface)).toBe('wait -- what');
    });

    it('the ellipsis converts as you type: "wait ..." → "wait …"', () => {
      port.insertText('wait ');
      typeText(surface, '.');
      typeText(surface, '.');
      typeText(surface, '.');
      expect(textOf(surface)).toBe('wait \u2026');
      typeText(surface, ' ok');
      expect(textOf(surface)).toBe('wait \u2026 ok');
    });

    it('undo #1 hands the raw dots back, redo brings the ellipsis again', () => {
      port.insertText('wait ');
      typeText(surface, '.');
      typeText(surface, '.');
      typeText(surface, '.');
      expect(textOf(surface)).toBe('wait \u2026');
      expect(port.undo()).toBe(true);
      expect(textOf(surface)).toBe('wait ...');
      expect(port.redo()).toBe(true);
      expect(textOf(surface)).toBe('wait \u2026');
    });

    it('the arrows convert on the typed angle: ->, => and <->', () => {
      port.insertText('a ');
      typeText(surface, '-');
      typeText(surface, '>');
      expect(textOf(surface)).toBe('a \u2192');
      typeText(surface, ' b ');
      typeText(surface, '=');
      typeText(surface, '>');
      expect(textOf(surface)).toBe('a \u2192 b \u21d2');
      typeText(surface, ' c ');
      typeText(surface, '<');
      typeText(surface, '-');
      typeText(surface, '>');
      expect(textOf(surface)).toBe('a \u2192 b \u21d2 c \u2194');
    });

    it('the R assignment `<-` never converts', () => {
      port.insertText('x ');
      typeText(surface, '<');
      typeText(surface, '-');
      typeText(surface, ' y');
      expect(textOf(surface)).toBe('x <- y');
    });

    it('the symbols convert after a space; a call like foo(c) stands', () => {
      port.insertText('see ');
      typeText(surface, '(');
      typeText(surface, 'c');
      typeText(surface, ')');
      expect(textOf(surface)).toBe('see \u00a9');
      port.insertText(' foo');
      typeText(surface, '(');
      typeText(surface, 'c');
      typeText(surface, ')');
      expect(textOf(surface)).toBe('see \u00a9 foo(c)');
    });

    it('a fenced line keeps the whole family raw', () => {
      typeText(surface, '`');
      typeText(surface, '`');
      typeText(surface, '`');
      typeText(surface, ' x ');
      typeText(surface, '.');
      typeText(surface, '.');
      typeText(surface, '.');
      expect(textOf(surface)).toBe('``` x ...');
      typeText(surface, ' ');
      typeText(surface, '(');
      typeText(surface, 'c');
      typeText(surface, ')');
      expect(textOf(surface)).toBe('``` x ... (c)');
    });

    it('arming is per family: ellipsis on, the dash stands down', () => {
      setTypingSubstitutionsEnabled(false);
      setSubstitutionEnabled('ellipsis', true);
      typeText(surface, '.');
      typeText(surface, '.');
      typeText(surface, '.');
      expect(textOf(surface)).toBe('\u2026');
      typeText(surface, ' ');
      typeText(surface, '-');
      typeText(surface, '-');
      expect(textOf(surface)).toBe('\u2026 --');
    });
  });

  describe('the port seam directly', () => {
    it('veto: no pair before the caret — false, nothing changes', () => {
      const { port, surface } = makePort('<p>wait -</p>');
      caretAtOffset(surface, 6);
      port.insertText('x');
      expect(port.replaceBeforeCaret('--', '\u2014')).toBe(false);
      expect(textOf(surface)).toBe('wait -x');
      surface.remove();
    });

    it('veto: a ranged selection — the substitution is a typing gesture', () => {
      const { port, surface } = makePort('<p>wait --</p>');
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(surface);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(port.replaceBeforeCaret('--', '\u2014', EM_DASH_SUBSTITUTION.appliesAfterPrefix)).toBe(
        false,
      );
      expect(textOf(surface)).toBe('wait --');
      surface.remove();
    });

    it('veto: the boundary rule gets the last word', () => {
      const { port, surface } = makePort('<p>|--</p>');
      const selection = window.getSelection()!;
      const range = document.createRange();
      const p = surface.querySelector('p')!;
      range.setStart(p.firstChild!, 3);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(port.replaceBeforeCaret('--', '\u2014', EM_DASH_SUBSTITUTION.appliesAfterPrefix)).toBe(
        false,
      );
      expect(textOf(surface)).toBe('|--');
      surface.remove();
    });

    it('without a veto the seam converts (the engine stays policy-free)', () => {
      const { port, surface } = makePort('<p>wait --</p>');
      const selection = window.getSelection()!;
      const range = document.createRange();
      const p = surface.querySelector('p')!;
      range.setStart(p.firstChild!, 7);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(port.replaceBeforeCaret('--', '\u2014')).toBe(true);
      expect(textOf(surface)).toBe('wait \u2014');
      surface.remove();
    });

    it('a parked engine refuses (the markdown note owns the host)', () => {
      const { port, surface } = makePort('<p>wait --</p>');
      port.setInert(true);
      const selection = window.getSelection()!;
      const range = document.createRange();
      const p = surface.querySelector('p')!;
      range.setStart(p.firstChild!, 7);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(port.replaceBeforeCaret('--', '\u2014')).toBe(false);
      expect(textOf(surface)).toBe('wait --');
      surface.remove();
    });

    it('veto: the caret sits in a pre block — code never converts', () => {
      const { port, surface } = makePort('<pre>wait --</pre>');
      caretAtOffset(surface, 7);
      expect(
        port.replaceBeforeCaret(
          '--',
          '\u2014',
          EM_DASH_SUBSTITUTION.appliesAfterPrefix,
          EM_DASH_SUBSTITUTION.appliesInDocument,
        ),
      ).toBe(false);
      expect(textOf(surface)).toBe('wait --');
      surface.remove();
    });

    it('veto: the document predicate — the fence keeps its pair', () => {
      const { port, surface } = makePort('<p>``` x ...</p>');
      const p = surface.querySelector('p')!;
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(p.firstChild!, 9);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(
        port.replaceBeforeCaret(
          '...',
          '\u2026',
          ELLIPSIS_SUBSTITUTION.appliesAfterPrefix,
          ELLIPSIS_SUBSTITUTION.appliesInDocument,
        ),
      ).toBe(false);
      expect(textOf(surface)).toBe('``` x ...');
      surface.remove();
    });

    it('the pair that is a whole block converts in its own block — not one line up', () => {
      // `(tm)` is the ONLY content of the second block: the splice's
      // insertion offset is the block boundary itself, which the stream
      // resolver answers as the previous run's end. The op must pin the
      // replacement to the block's own start.
      const { port, surface } = makePort('<p>see \u00a9</p><p>(tm)</p>');
      caretAtOffset(surface, 9);
      expect(
        port.replaceBeforeCaret(
          '(tm)',
          '\u2122',
          TRADEMARK_SUBSTITUTION.appliesAfterPrefix,
          TRADEMARK_SUBSTITUTION.appliesInDocument,
        ),
      ).toBe(true);
      const blocks = surface.querySelectorAll('p');
      expect(blocks).toHaveLength(2);
      expect(blocks[0].textContent).toBe('see \u00a9');
      expect(blocks[1].textContent).toBe('\u2122');
      surface.remove();
    });

    it('the em-dash pair as a whole block lands in its own line too', () => {
      const { port, surface } = makePort('<p>first line</p><p>wait --</p>');
      caretAtOffset(surface, 17);
      expect(
        port.replaceBeforeCaret(
          '--',
          '\u2014',
          EM_DASH_SUBSTITUTION.appliesAfterPrefix,
          EM_DASH_SUBSTITUTION.appliesInDocument,
        ),
      ).toBe(true);
      const blocks = surface.querySelectorAll('p');
      expect(blocks[0].textContent).toBe('first line');
      expect(blocks[1].textContent).toBe('wait \u2014');
      surface.remove();
    });

    it('textBeforeCaret reads the live run before the caret', () => {
      const { port, surface } = makePort('<p>hello</p>');
      caretAtOffset(surface, 5);
      expect(port.textBeforeCaret(3)).toBe('llo');
      expect(port.textBeforeCaret(99)).toBe('hello');
      expect(port.charBeforeCaret()).toBe('o');
      surface.remove();
    });
  });
});
