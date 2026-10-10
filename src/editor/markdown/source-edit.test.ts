/**
 * The source editor's editing primitives — pure text-transform tests over
 * a real textarea (jsdom): every toolbar gesture the raw-markdown pane
 * can make, pinned the way GitHub's source editor behaves.
 *
 * applyEdit()'s execCommand path is unavailable in jsdom — the suite
 * exercises the setRangeText fallback, which is the same text math with
 * a hand-dispatched input event (the browser suite pins the execCommand
 * half end-to-end).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyLink,
  applyEdit,
  clearFormatting,
  continueListOnEnter,
  indentLines,
  insertBlock,
  linkAroundCaret,
  listShapeOfLine,
  removeLink,
  setHeadingLevel,
  sourceSelectionState,
  tableTemplate,
  toggleLinePrefix,
  toggleOrderedList,
  toggleWrap,
  wrapCodeBlock,
} from './source-edit';

let ta: HTMLTextAreaElement;

function mount(value: string, selectionStart = value.length, selectionEnd = selectionStart): void {
  ta = document.createElement('textarea');
  ta.value = value;
  document.body.appendChild(ta);
  ta.setSelectionRange(selectionStart, selectionEnd);
}

function state(): { value: string; from: number; to: number } {
  return { value: ta.value, from: ta.selectionStart, to: ta.selectionEnd };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('applyEdit', () => {
  it('replaces the range, sets the selection, and announces via input', () => {
    mount('hello world');
    const heard: Event[] = [];
    ta.addEventListener('input', (event) => heard.push(event));
    applyEdit(ta, 0, 5, 'HELLO', 0, 5);
    expect(ta.value).toBe('HELLO world');
    expect(ta.selectionStart).toBe(0);
    expect(ta.selectionEnd).toBe(5);
    expect(heard).toHaveLength(1);
    expect(heard[0].bubbles).toBe(true);
  });
});

describe('toggleWrap', () => {
  it('wraps a selection and selects the content between the markers', () => {
    mount('say bold now', 4, 8);
    toggleWrap(ta, '**');
    expect(state()).toEqual({ value: 'say **bold** now', from: 6, to: 10 });
  });

  it('unwraps when the markers hug the selection (the toggle off ramp)', () => {
    mount('say **bold** now', 6, 10);
    toggleWrap(ta, '**');
    expect(state()).toEqual({ value: 'say bold now', from: 4, to: 8 });
  });

  it('unwraps when the selection carries its own markers', () => {
    mount('say **bold** now', 4, 12);
    toggleWrap(ta, '**');
    expect(state()).toEqual({ value: 'say bold now', from: 4, to: 8 });
  });

  it('an empty selection plants an empty wrap with the caret between', () => {
    mount('say  now', 4, 4);
    toggleWrap(ta, '**');
    expect(state()).toEqual({ value: 'say **** now', from: 6, to: 6 });
  });

  it('toggling bold inside bold+italic keeps the italic (***x*** → *x*)', () => {
    // *** is bold+italic; the ** hug the caret's selection, so the toggle
    // removes BOLD and leaves the single-asterisk italic standing.
    mount('***x***', 3, 4);
    toggleWrap(ta, '**');
    expect(ta.value).toBe('*x*');
  });
});

describe('toggleLinePrefix', () => {
  it('prefixes the caret line with a quote', () => {
    mount('a line', 2);
    toggleLinePrefix(ta, '> ');
    expect(ta.value).toBe('> a line');
  });

  it('strips the quote when every selected line carries it', () => {
    mount('> one\n> two', 0, 12);
    toggleLinePrefix(ta, '> ');
    expect(ta.value).toBe('one\ntwo');
  });

  it('a quote replaces a bullet prefix (one grammar at a time)', () => {
    mount('- one', 1);
    toggleLinePrefix(ta, '> ');
    expect(ta.value).toBe('> one');
  });

  it('task prefix replaces bullet prefix', () => {
    mount('- one', 1);
    toggleLinePrefix(ta, '- [ ] ');
    expect(ta.value).toBe('- [ ] one');
  });

  it('null strips every known prefix', () => {
    mount('### heading', 2);
    toggleLinePrefix(ta, null);
    expect(ta.value).toBe('heading');
  });

  it('blank lines inside the selection stay blank', () => {
    mount('one\n\nthree', 0, 11);
    toggleLinePrefix(ta, '- ');
    expect(ta.value).toBe('- one\n\n- three');
  });

  it('indentation before the prefix survives the swap', () => {
    mount('  - nested', 4);
    toggleLinePrefix(ta, '> ');
    expect(ta.value).toBe('  > nested');
  });
});

describe('toggleOrderedList', () => {
  it('numbers every selected line', () => {
    mount('a\nb\nc', 0, 5);
    toggleOrderedList(ta);
    expect(ta.value).toBe('1. a\n2. b\n3. c');
  });

  it('strips when every line is already numbered', () => {
    mount('1. a\n2. b', 0, 9);
    toggleOrderedList(ta);
    expect(ta.value).toBe('a\nb');
  });

  it('a bullet list converts, renumbered', () => {
    mount('- a\n- b', 0, 7);
    toggleOrderedList(ta);
    expect(ta.value).toBe('1. a\n2. b');
  });
});

describe('setHeadingLevel', () => {
  it('promotes a plain line', () => {
    mount('title', 1);
    setHeadingLevel(ta, 2);
    expect(ta.value).toBe('## title');
  });

  it('replaces an existing level', () => {
    mount('# title', 1);
    setHeadingLevel(ta, 3);
    expect(ta.value).toBe('### title');
  });

  it('null demotes to a paragraph', () => {
    mount('## title', 1);
    setHeadingLevel(ta, null);
    expect(ta.value).toBe('title');
  });

  it('a list prefix is stripped too — one block shape at a time', () => {
    mount('- item', 1);
    setHeadingLevel(ta, 1);
    expect(ta.value).toBe('# item');
  });
});

describe('indentLines', () => {
  it('indents by two spaces', () => {
    mount('a\nb', 0, 3);
    indentLines(ta, 1);
    expect(ta.value).toBe('  a\n  b');
  });

  it('dedents at most two spaces', () => {
    mount('    deep', 0);
    indentLines(ta, -1);
    expect(ta.value).toBe('  deep');
    indentLines(ta, -1);
    expect(ta.value).toBe('deep');
  });
});

describe('continueListOnEnter', () => {
  it('continues a bullet with the same indentation', () => {
    mount('  - one', 7);
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('  - one\n  - ');
    expect(ta.selectionStart).toBe(ta.value.length);
  });

  it('continues and renumbers an ordered list', () => {
    mount('1. one', 6);
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('1. one\n2. ');
  });

  it('tasks continue as unchecked', () => {
    mount('- [x] done', 11);
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('- [x] done\n- [ ] ');
  });

  it('a marker-only line exits the list (Enter lifts)', () => {
    mount('- one\n- ', 8);
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('- one\n');
  });

  it('an indented marker-only line exits to its indentation', () => {
    mount('- a\n  - ', 8);
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('- a\n  ');
  });

  it('a plain paragraph line is native (returns false)', () => {
    mount('just text', 4);
    expect(continueListOnEnter(ta)).toBe(false);
    expect(ta.value).toBe('just text');
  });

  it('a heading line is native', () => {
    mount('## heading', 4);
    expect(continueListOnEnter(ta)).toBe(false);
  });

  // ---- the markdown sweep round (issues #53-#60) ----
  it('Enter with a selection on a list line REPLACES the selection', () => {
    mount('- hello world', 8, 13); // 'world' selected
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('- hello \n- ');
    expect(ta.selectionStart).toBe(ta.value.length);
  });

  it('Enter with the content of an item selected deletes it and continues', () => {
    mount('- one\n- two', 8, 11); // 'two' selected
    expect(continueListOnEnter(ta)).toBe(true);
    expect(ta.value).toBe('- one\n- \n- ');
  });
});

describe('toggleLinePrefix — checked tasks (issue #55)', () => {
  it('a checked task line disarms the list without resetting to unchecked', () => {
    mount('- [x] done', 10);
    toggleLinePrefix(ta, '- [ ] ');
    expect(ta.value).toBe('done');
  });

  it('a mixed selection disarms every task, keeping checked words', () => {
    mount('- [ ] a\n- [x] b', 0, 15);
    toggleLinePrefix(ta, '- [ ] ');
    expect(ta.value).toBe('a\nb');
  });

  it('a plain bullet still gains the task prefix', () => {
    mount('- plain', 5);
    toggleLinePrefix(ta, '- [ ] ');
    expect(ta.value).toBe('- [ ] plain');
  });
});

describe('applyLink — a selection inside an existing link (issue #53)', () => {
  it('retargets in place, keeping the WHOLE label', () => {
    mount('see [click here](old) now', 10, 14); // 'here' selected
    applyLink(ta, 'https://new.example');
    expect(ta.value).toBe('see [click here](https://new.example) now');
  });

  it('a selection outside any link still wraps it', () => {
    mount('plain words', 6, 11);
    applyLink(ta, 'https://x.example');
    expect(ta.value).toBe('plain [words](https://x.example)');
  });

  it('an explicit label overrides (the popover chip path)', () => {
    mount('see [click here](old) now', 10, 14);
    applyLink(ta, 'https://new.example', 'renamed');
    expect(ta.value).toBe('see [renamed](https://new.example) now');
  });
});

describe('clearFormatting — fenced code (issue #60)', () => {
  it('leaves prefixes inside a fenced block alone', () => {
    mount('```\n- item\n```', 9);
    clearFormatting(ta);
    expect(ta.value).toContain('- item');
  });

  it('clears prefixes outside fences as before', () => {
    mount('- item', 3);
    clearFormatting(ta);
    expect(ta.value).toBe('item');
  });
});

describe('wrapCodeBlock', () => {
  it('wraps the selection in fences', () => {
    mount('code here', 0, 9);
    wrapCodeBlock(ta);
    expect(ta.value).toBe('```\ncode here\n```');
  });

  it('mid-line selection fences the whole lines', () => {
    mount('keep\nfmt this\nkeep', 5, 13);
    wrapCodeBlock(ta);
    expect(ta.value).toBe('keep\n```\nfmt this\n```\nkeep');
  });

  it('already fenced unwraps', () => {
    mount('```\ncode\n```', 5);
    wrapCodeBlock(ta);
    expect(ta.value).toBe('code');
  });
});

describe('insertBlock + tableTemplate', () => {
  it('mid-line insertion splits the line: the block stands alone', () => {
    mount('para', 2);
    insertBlock(ta, tableTemplate(), [2, 10]);
    expect(ta.value).toBe(
      'pa\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |\nra',
    );
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('Column 1');
  });

  it('inserts a table template at the line end with the header selected', () => {
    mount('para', 4);
    insertBlock(ta, tableTemplate(), [2, 10]);
    expect(ta.value).toBe('para\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| | | |');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('Column 1');
  });

  it('inserts a divider block', () => {
    mount('text', 4);
    insertBlock(ta, '---');
    expect(ta.value).toBe('text\n---');
  });
});

describe('links', () => {
  it('wraps a selection as a link', () => {
    mount('go here', 3, 7);
    applyLink(ta, 'https://example.com');
    expect(ta.value).toBe('go [here](https://example.com)');
  });

  it('no selection plants link text', () => {
    mount('go ', 3);
    applyLink(ta, 'https://example.com');
    expect(ta.value).toBe('go [link text](https://example.com)');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('link text');
  });

  it('retargets the link under the caret in place', () => {
    mount('see [docs](https://old.example) now', 8);
    applyLink(ta, 'https://new.example');
    expect(ta.value).toBe('see [docs](https://new.example) now');
  });

  it('linkAroundCaret finds spans containing the caret', () => {
    mount('a [b](c) d', 6);
    const link = linkAroundCaret(ta);
    expect(link).toEqual({ start: 2, end: 8, text: 'b', href: 'c' });
  });

  it('removeLink strips to the text', () => {
    mount('a [b](c) d', 6);
    expect(removeLink(ta)).toBe(true);
    expect(ta.value).toBe('a b d');
  });
});

describe('clearFormatting', () => {
  it('strips wrap markers and line prefixes together', () => {
    mount('> **both** kinds', 2, 10);
    clearFormatting(ta);
    expect(ta.value).toBe('both kinds');
  });
});

describe('sourceSelectionState — the toolbar pressed states', () => {
  it('reads bold from markers around the selection', () => {
    mount('a **b** c', 4, 5);
    expect(sourceSelectionState(ta).bold).toBe(true);
  });

  it('reads the heading level from the caret line', () => {
    mount('### h3', 4);
    expect(sourceSelectionState(ta).heading).toBe(3);
  });

  it('reads quote, bullet, ordered and task shapes', () => {
    mount('> quoted', 3);
    expect(sourceSelectionState(ta).blockquote).toBe(true);
    mount('- bullet', 3);
    expect(sourceSelectionState(ta).bulletList).toBe(true);
    mount('3. ordered', 3);
    expect(sourceSelectionState(ta).orderedList).toBe(true);
    mount('- [ ] task', 3);
    expect(sourceSelectionState(ta).task).toBe(true);
  });

  it('a task line is not also a bullet (task wins)', () => {
    mount('- [ ] task', 3);
    const state = sourceSelectionState(ta);
    expect(state.task).toBe(true);
    expect(state.bulletList).toBe(false);
  });

  it('reads codeBlock from an unbalanced fence count above', () => {
    mount('```\nconst x = 1;', 12);
    expect(sourceSelectionState(ta).codeBlock).toBe(true);
  });

  it('a balanced fence count above is not a code block', () => {
    mount('```\nold\n```\nafter', 18);
    expect(sourceSelectionState(ta).codeBlock).toBe(false);
  });

  it('reads the link at the caret (href included)', () => {
    mount('see [docs](https://x.example) now', 10);
    const state = sourceSelectionState(ta);
    expect(state.link).toBe(true);
    expect(state.linkHref).toBe('https://x.example');
  });

  it('reads a table row from the pipe-led line', () => {
    mount('| a | b |', 4);
    expect(sourceSelectionState(ta).inTable).toBe(true);
    mount('| a | b |\nplain', 12);
    expect(sourceSelectionState(ta).inTable).toBe(false);
  });

  it('italic never reports when bold does (asterisk ambiguity)', () => {
    mount('**bold**', 2, 6);
    const state = sourceSelectionState(ta);
    expect(state.bold).toBe(true);
    expect(state.italic).toBe(false);
  });

  it('italic reports on its own single-asterisk wraps', () => {
    mount('a *b* c', 3, 4);
    const state = sourceSelectionState(ta);
    expect(state.italic).toBe(true);
    expect(state.bold).toBe(false);
  });
});

describe('listShapeOfLine', () => {
  it('classifies the three shapes', () => {
    expect(listShapeOfLine('- a')).toBe('bullet');
    expect(listShapeOfLine('1. a')).toBe('ordered');
    expect(listShapeOfLine('- [ ] a')).toBe('task');
    expect(listShapeOfLine('plain')).toBeNull();
  });
});
