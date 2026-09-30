import { describe, expect, it } from 'vitest';
import {
  boundaryToStream,
  captureOffsets,
  ordered,
  placeCaretAtSpot,
  placeRange,
  spotAtStream,
  streamLengthOf,
} from './selection';

/**
 * The coordinate system: offsets captured on one tree place on another
 * tree with the same structure — the property the whole engine pipeline
 * (capture on the surface, operate on the model, restore on the repainted
 * surface) stands on.
 */

function surfaceOf(html: string): HTMLElement {
  const element = document.createElement('div');
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

function caretSpot(
  element: HTMLElement,
  at: number,
  withinMarker = false,
): { container: Node; offset: number } {
  const spot = spotAtStream(element, at, withinMarker);
  if (!spot) {
    throw new Error(`no spot at ${at}`);
  }
  return {
    container: spot.kind === 'text' ? spot.node : spot.node,
    offset: spot.kind === 'text' ? spot.raw : spot.childIndex,
  };
}

describe('boundary → stream offsets', () => {
  it('counts plain text at the root', () => {
    const element = surfaceOf('hello world');
    const text = element.firstChild as Text;
    expect(boundaryToStream(element, text, 0)).toBe(0);
    expect(boundaryToStream(element, text, 5)).toBe(5);
    expect(boundaryToStream(element, text, 11)).toBe(11);
    expect(boundaryToStream(element, element, 1)).toBe(11); // end of content
    element.remove();
  });

  it('skips math shells and zero-width markers', () => {
    const element = surfaceOf(
      'ab<span class="padify-math" data-latex="x">KaTeX rendered text</span>cd<span style="font-size: 24px">\u200B</span>ef',
    );
    expect(streamLengthOf(element)).toBe(6); // ab cd ef — no shell, no marker
    const cd = element.childNodes[2] as Text; // 'cd'
    expect(boundaryToStream(element, cd, 0)).toBe(2);
    const marker = element.querySelector('span:not(.padify-math)')!.firstChild as Text;
    expect(boundaryToStream(element, marker, 1)).toBe(4); // after 'cd', marker contributes 0
    element.remove();
  });

  it('maps offsets across inline marks and nested blocks', () => {
    const element = surfaceOf('<b>bold</b> plain <div>block</div>');
    const plain = element.childNodes[1] as Text;
    expect(boundaryToStream(element, plain, 0)).toBe(4);
    const blockText = element.querySelector('div')!.firstChild as Text;
    expect(boundaryToStream(element, blockText, 2)).toBe(13); // 4 'bold' + 7 ' plain ' + 2
    element.remove();
  });
});

describe('stream → spot placements', () => {
  it('lands inside text nodes and on element boundaries', () => {
    const element = surfaceOf('hello <b>big</b> world');
    const inHello = caretSpot(element, 3);
    expect(inHello.container).toBe(element.firstChild);
    expect(inHello.offset).toBe(3);

    const beforeWorld = caretSpot(element, 9); // between </b> and ' world'
    expect((beforeWorld.container as Text).nodeValue).toBe(' world');
    expect(beforeWorld.offset).toBe(0);
    element.remove();
  });

  it('resolves the end of content onto the trailing text', () => {
    const element = surfaceOf('hello <b>big</b> tail');
    const end = caretSpot(element, streamLengthOf(element));
    expect((end.container as Text).nodeValue).toBe(' tail');
    expect(end.offset).toBe(5);
    element.remove();
  });

  it('resolves inside an empty block at its start', () => {
    const element = surfaceOf('<div>first</div><div><br></div>');
    const emptyLine = caretSpot(element, 5);
    expect(emptyLine.container).toBe(element.querySelectorAll('div')[1]);
    expect(emptyLine.offset).toBe(0);
    element.remove();
  });

  it('lands inside a marker run past the zero-width character when asked', () => {
    const element = surfaceOf('ab<span style="font-size: 24px">\u200B</span>cd');
    const inside = caretSpot(element, 2, true);
    expect((inside.container as Text).nodeValue).toBe('\u200B');
    expect(inside.offset).toBe(1);
    // Without the flag the same offset continues the previous run.
    const outside = caretSpot(element, 2);
    expect((outside.container as Text).nodeValue).toBe('ab');
    expect(outside.offset).toBe(2);
    element.remove();
  });

  it('lands before an inline atom, never inside it', () => {
    const element = surfaceOf('x<span class="padify-math" data-latex="a"></span>y');
    const atBoundary = caretSpot(element, 1);
    // The position after 'x', before the shell — expressed as the tail of
    // the 'x' text node; never inside the atom itself.
    expect((atBoundary.container as Text).nodeValue).toBe('x');
    expect(atBoundary.offset).toBe(1);
    expect(element.querySelector('.padify-math')!.contains(atBoundary.container)).toBe(false);
    element.remove();
  });

  it('an empty surface resolves to (root, 0)', () => {
    const element = surfaceOf('');
    const start = caretSpot(element, 0);
    expect(start.container).toBe(element);
    expect(start.offset).toBe(0);
    element.remove();
  });
});

describe('capture and place on the live selection', () => {
  it('round-trips a selection through offsets onto a rebuilt tree', () => {
    const element = surfaceOf('one <b>two</b> three');
    const selection = window.getSelection();
    const range = document.createRange();
    const boldText = element.querySelector('b')!.firstChild as Text;
    range.setStart(boldText, 0);
    range.setEnd(element.lastChild!, 2); // ' t' of ' three'
    selection?.removeAllRanges();
    selection?.addRange(range);

    const captured = captureOffsets(element);
    expect(captured).toEqual({ anchor: 4, focus: 9 });

    // Same structure, fresh tree: the offsets place identically.
    const rebuilt = surfaceOf('one <b>two</b> three');
    expect(placeRange(rebuilt, captured!.anchor, captured!.focus)).toBe(true);
    const placed = window.getSelection();
    expect(placed?.toString()).toBe('two t');

    const spotBack = spotAtStream(rebuilt, captured!.anchor);
    placeCaretAtSpot(rebuilt, spotBack);
    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(
      rebuilt.querySelector('b')!.firstChild,
    );
    element.remove();
    rebuilt.remove();
  });

  it('ordered sorts a backwards selection without losing direction info', () => {
    expect(ordered({ anchor: 9, focus: 3 })).toEqual([3, 9]);
  });
});
