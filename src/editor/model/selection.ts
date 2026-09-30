/**
 * The model's coordinate system — stream offsets.
 *
 * One linear space: the note's plain text in document order, zero-width
 * markers excluded, math shells skipped (inline atoms — the caret cannot
 * sit inside one, and their rendered text is display plumbing). Offset N
 * means "between the (N-1)th and Nth character of the note's text".
 *
 * The same coordinates address the live surface and the detached model,
 * because parse() preserves structure and text (storage-subset.ts): an
 * offset captured on the surface before an operation addresses the exact
 * spot in the freshly absorbed model, and an intent computed in model
 * space places the caret on the repainted surface. That single mapping is
 * what lets every operation be written "somewhere between the user's
 * anchor and focus" instead of "somewhere in a live DOM the browser is
 * also editing".
 */

/**
 * A selection in model coordinates. anchor ≤ focus is NOT guaranteed —
 * the user's selection direction is preserved.
 */
export interface Offsets {
  anchor: number;
  focus: number;
}

/** Sorted [min, max] of a pair of stream offsets. */
export function ordered(pair: { anchor: number; focus: number }): [number, number] {
  return pair.anchor <= pair.focus ? [pair.anchor, pair.focus] : [pair.focus, pair.anchor];
}

/** True when the range covers at least one character. */
export function isRanged(coverage: [number, number]): boolean {
  return coverage[1] > coverage[0];
}

/**
 * The stream of a subtree — zero-width runs excluded, math shells skipped.
 */
function streamOfSubtree(node: Node | null): number {
  if (!node) {
    return 0;
  }
  if (node instanceof HTMLElement && node.classList.contains('padify-math')) {
    return 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? '').replace(/\u200B/g, '').length;
  }
  let count = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    count += streamOfSubtree(child);
  }
  return count;
}

/** The stream held by the first `until` children of a parent. */
function streamOfChildrenBefore(parent: Node, until: number): number {
  let count = 0;
  for (let i = 0; i < until && i < parent.childNodes.length; i += 1) {
    count += streamOfSubtree(parent.childNodes[i]);
  }
  return count;
}

/**
 * Maps a raw offset inside a text node to the stream offset it sits at.
 */
function rawToStream(text: Text, rawOffset: number): number {
  const value = text.nodeValue ?? '';
  let stream = 0;
  for (let i = 0; i < Math.min(rawOffset, value.length); i += 1) {
    if (value[i] !== '\u200B') {
      stream += 1;
    }
  }
  return stream;
}

/**
 * Maps a stream offset inside a text node to the raw offset (the number of
 * raw characters that precede that stream position in this node).
 */
function streamToRawInside(text: Text, streamOffset: number): number {
  const value = text.nodeValue ?? '';
  let raw = 0;
  let stream = 0;
  while (raw < value.length) {
    if (stream >= streamOffset) {
      break;
    }
    if (value[raw] !== '\u200B') {
      stream += 1;
    }
    raw += 1;
  }
  return raw;
}

/**
 * The stream position of a DOM boundary (container, offset) inside root,
 * or -1 when the boundary lives outside root's tree.
 */
export function boundaryToStream(root: HTMLElement, container: Node, offset: number): number {
  if (container === root) {
    return streamOfChildrenBefore(root, offset);
  }
  const path: Node[] = [];
  for (let node: Node | null = container; node; node = node.parentNode) {
    path.unshift(node);
    if (node === root) {
      break;
    }
  }
  if (path[0] !== root) {
    return -1;
  }
  let acc = 0;
  for (let level = 0; level < path.length - 1; level += 1) {
    const current = path[level]!;
    const next = path[level + 1]!;
    const index = Array.prototype.indexOf.call(current.childNodes, next);
    if (index < 0) {
      return -1;
    }
    acc += streamOfChildrenBefore(current, index);
  }
  const target = path[path.length - 1]!;
  if (target.nodeType === Node.TEXT_NODE) {
    return acc + rawToStream(target as Text, offset);
  }
  return acc + streamOfChildrenBefore(target, offset);
}

/**
 * Captures the live selection into model coordinates, or null when the
 * selection does not sit inside root (the callers' "nothing selected in
 * the note" case).
 */
export function captureOffsets(root: HTMLElement): Offsets | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const anchor = boundaryToStream(root, selection.anchorNode!, selection.anchorOffset);
  const focus = boundaryToStream(root, selection.focusNode!, selection.focusOffset);
  if (anchor < 0 || focus < 0) {
    return null;
  }
  return { anchor, focus };
}

/**
 * A DOM position that can hold a caret: inside a text node at a raw
 * offset, or on an element between its children.
 */
export type DomSpot =
  | { kind: 'text'; node: Text; raw: number }
  | { kind: 'element'; node: Element; childIndex: number };

/** True for the zero-width text of a styled caret run. */
function isMarkerText(node: Text): boolean {
  return (node.nodeValue ?? '') === '\u200B' && node.parentElement?.tagName === 'SPAN';
}

/** The marker text inside an element, when it carries one. */
function markerTextOf(element: Element): Text | null {
  const first = element.firstChild;
  return first instanceof Text && isMarkerText(first) ? first : null;
}

/**
 * Resolves a stream offset to a caret spot inside root.
 *
 * Tie-breaks, in order: a position inside a text node wins over an
 * element boundary at the same spot (typing continues in place, and
 * Chrome keeps both in sync anyway); a landing at the END of content
 * with a trailing marker run resolves INSIDE the marker, past the
 * zero-width character, when `withinMarker` is set (the
 * "collapsed formatting carries into what is typed next" position); an
 * offset inside an empty block resolves to (block, 0) — the only caret
 * spot an empty line has.
 */
export function spotAtStream(
  root: HTMLElement,
  offset: number,
  withinMarker = false,
): DomSpot | null {
  const total = streamOfSubtree(root);
  const target = Math.min(Math.max(offset, 0), total);
  return descend(root, target, withinMarker);
}

function descend(element: Element, target: number, withinMarker: boolean): DomSpot | null {
  let consumed = 0;
  const kids = element.childNodes;
  for (let index = 0; index < kids.length; index += 1) {
    const child = kids[index]!;
    const length = streamOfSubtree(child);
    if (target < consumed + length) {
      // The offset lands inside this child's content.
      if (child.nodeType === Node.TEXT_NODE) {
        return {
          kind: 'text',
          node: child as Text,
          raw: streamToRawInside(child as Text, target - consumed),
        };
      }
      if (child instanceof HTMLElement && child.classList.contains('padify-math')) {
        // Inline atoms hold no stream; land on the boundary before one.
        return { kind: 'element', node: element, childIndex: index };
      }
      if (child.nodeType === Node.ELEMENT_NODE) {
        return descend(child as Element, target - consumed, withinMarker);
      }
      continue; // comments and other streamless nodes
    }
    if (target === consumed && length === 0) {
      // The offset sits exactly on a zero-length child. Tie-breaks: a
      // guard text node or marker run the caller asked to sit inside
      // (withinMarker — the "carries into what is typed next" position),
      // then the tail of a text node that ends right here (typing
      // continues the previous run, the convention the legacy engine
      // restored by), then inside an empty block.
      if (withinMarker && child.nodeType === Node.TEXT_NODE && child.nodeValue === '\u200B') {
        return { kind: 'text', node: child as Text, raw: 1 };
      }
      if (withinMarker && child.nodeType === Node.ELEMENT_NODE) {
        const marker = child instanceof Element ? markerTextOf(child) : null;
        if (marker) {
          return { kind: 'text', node: marker, raw: 1 };
        }
      }
      const previous = kids[index - 1];
      if (previous instanceof Text && (previous.nodeValue ?? '') !== '') {
        return { kind: 'text', node: previous, raw: (previous.nodeValue ?? '').length };
      }
      if (child.nodeType === Node.ELEMENT_NODE && child instanceof Element) {
        if (holdsCaretWhenEmpty(child)) {
          return { kind: 'element', node: child, childIndex: 0 };
        }
      }
      return { kind: 'element', node: element, childIndex: index };
    }
    consumed += length;
  }
  if (target === consumed) {
    // End of this element's content. Descend into the last child that
    // carries text — the caret belongs inside the last block's tail (the
    // end of a note that ends in a list item addresses the item's text,
    // not the list's boundary), then a marker run (when asked), then the
    // element boundary.
    return endOfContent(element, withinMarker);
  }
  return null;
}

function endOfContent(element: Element, withinMarker: boolean): DomSpot | null {
  const last = element.lastChild;
  if (last instanceof Text && (last.nodeValue ?? '') !== '') {
    return { kind: 'text', node: last, raw: (last.nodeValue ?? '').length };
  }
  if (last instanceof Element) {
    if (streamOfSubtree(last) > 0) {
      return endOfContent(last, withinMarker);
    }
    // No text inside: an empty caret-holding block holds the spot at its
    // start; anything else leaves the boundary on the parent.
    if (holdsCaretWhenEmpty(last)) {
      return { kind: 'element', node: last, childIndex: 0 };
    }
  }
  if (withinMarker && element instanceof Element) {
    const marker = markerTextOf(element);
    if (marker) {
      return { kind: 'text', node: marker, raw: 1 };
    }
  }
  return { kind: 'element', node: element, childIndex: element.childNodes.length };
}

/** Elements that hold the caret when empty (the note's block/inline set —
 *  never an equation shell: atoms hold no caret position). */
function holdsCaretWhenEmpty(node: Node): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  if (node.classList.contains('padify-math')) {
    return false;
  }
  return /^(DIV|P|H[1-3]|LI|BLOCKQUOTE|PRE|B|STRONG|I|EM|U|S|STRIKE|DEL|SUB|SUP|TD|TH|SPAN|A)$/.test(
    node.tagName,
  );
}

/**
 * Applies a spot to the live selection as a collapsed caret; false when
 * the spot cannot be placed (caller keeps the selection it had).
 */
export function placeCaretAtSpot(root: HTMLElement, spot: DomSpot | null): boolean {
  if (!spot) {
    return false;
  }
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) {
    return false;
  }
  const range = doc.createRange();
  try {
    if (spot.kind === 'text') {
      range.setStart(spot.node, spot.raw);
    } else {
      range.setStart(spot.node, spot.childIndex);
    }
  } catch {
    return false;
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Applies a stream range to the live selection (start becomes the anchor).
 */
export function placeRange(root: HTMLElement, start: number, end: number): boolean {
  if (start === end) {
    const spot = spotAtStream(root, start);
    return placeCaretAtSpot(root, spot);
  }
  const from = spotAtStream(root, start);
  const to = spotAtStream(root, end);
  if (!from || !to) {
    return false;
  }
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) {
    return false;
  }
  const range = doc.createRange();
  try {
    if (from.kind === 'text') {
      range.setStart(from.node, from.raw);
    } else {
      range.setStart(from.node, from.childIndex);
    }
    if (to.kind === 'text') {
      range.setEnd(to.node, to.raw);
    } else {
      range.setEnd(to.node, to.childIndex);
    }
  } catch {
    return false;
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** The stream length of the whole root — the clamp bound for restores. */
export function streamLengthOf(root: HTMLElement): number {
  return streamOfSubtree(root);
}

/**
 * The spot's element — the node a tag walk starts from, regardless of
 * which spot shape it came in.
 */
export function spotElement(spot: DomSpot): HTMLElement {
  return (spot.kind === 'text' ? spot.node.parentElement : spot.node) as HTMLElement;
}

/**
 * The child-index path of a node from root, or null when the node is not
 * in root's tree.
 */
export function pathTo(root: Node, node: Node): number[] | null {
  if (node === root) {
    return [];
  }
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) {
      return null;
    }
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    if (index < 0) {
      return null;
    }
    path.unshift(index);
    current = parent;
  }
  return current === root ? path : null;
}

/** The node at a child-index path from root (null when the path breaks). */
export function nodeAtPath(root: Node, path: number[]): Node | null {
  let current: Node = root;
  for (const step of path) {
    if (step < 0 || step >= current.childNodes.length) {
      return null;
    }
    current = current.childNodes[step]!;
  }
  return current;
}
