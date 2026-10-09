/**
 * The document model — the canonical tree a note's content is edited as.
 *
 * The model IS a DOM subtree: parse() reads any markup (the live surface,
 * a stored note, a merged row) through the storage-subset rules, so the
 * model can only ever occupy the stored format — anything outside the
 * subset is not representable, which is what makes the engine's output
 * canonical without a cleanup pass. serialize() walks that same tree
 * back out as innerHTML, so an untouched note round-trips byte-exact and
 * the corpus contract (storage-format.test.ts) holds by construction.
 *
 * Why a DOM and not a hand-rolled typed tree: the stored subset admits
 * arbitrary nesting of its tags (a table inside a div inside a list item
 * is a legal note — the old engine produced exactly that, and those notes
 * still exist). A strict tree of typed nodes could not represent them
 * without either corrupting them or growing a raw escape node, and the
 * discipline the engine needs does not live in the node shapes anyway —
 * it lives in the pipeline: one parse, one serializer, one repaint, one
 * history, one announce. The operations in model/ops.ts are typed and
 * narrow; the tree they steer stays as wide as the format itself.
 */

import { sanitizeNoteHtml } from '../storage-subset';

/** The note surface media that make an "empty" note meaningful anyway. */
const EMPTY_SURFACE_MEDIA = 'img, hr, table, iframe, video, audio';

/**
 * The zero-width marker of the styled-caret run (see the collapsed-style
 * operations in ops.ts) — plumbing, not content: every text reader strips
 * it, and an empty note that carries one is a deliberate state.
 */
export const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Parses markup into a canonical model tree. One rule set for every
 * entry: storage load, surface absorb, snapshot restore — all through the
 * storage-subset sanitizer, so the model is a subset citizen by
 * construction and never needs a second cleanup pass.
 */
export function parse(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = sanitizeNoteHtml(html);
  return holder;
}

/** Serializes the model back to storage markup — innerHTML is the canon. */
export function serialize(model: HTMLElement): string {
  return model.innerHTML;
}

/**
 * Rewrites an "empty but not really" surface to a truly empty one (''),
 * and reports whether a rewrite happened.
 *
 * Why: engines never leave a contenteditable truly empty. Deleting
 * everything leaves a bare `<br>`, and if the last block carried a format
 * the whole skeleton (`<h1><br></h1>`) survives instead. The bare br has a
 * visible cost: the placeholder paints on the first line while the caret
 * blinks one line DOWN, and the first typed character then jumps back UP.
 * A truly empty surface keeps placeholder, caret and first typed character
 * on the same line.
 *
 * Guards: media/embeds make the surface meaningful, and a zero-width
 * styled caret run is a deliberate empty state (the collapsed-formatting
 * feature) and must survive.
 */
export function collapseEmptySurface(element: HTMLElement): boolean {
  if (element.innerHTML === '') {
    return false;
  }
  if (element.querySelector(EMPTY_SURFACE_MEDIA)) {
    return false;
  }
  if (hasStyledCaretRun(element)) {
    return false;
  }
  const text = (element.textContent ?? '').replace(/\u200B/g, '').trim();
  if (text !== '') {
    return false;
  }
  element.innerHTML = '';
  return true;
}

/** True when the surface carries a zero-width styled caret run. */
export function hasStyledCaretRun(element: HTMLElement): boolean {
  return Array.from(element.querySelectorAll('span')).some(
    (span) => span.textContent === ZERO_WIDTH_SPACE,
  );
}

/**
 * True when the surface reads empty to the user but may still be carrying
 * structure: no text (zero-width runs are plumbing), no media blocks. The
 * delete-normalization path uses this to decide whether a delete-type
 * input emptied the note — the same rule the load path applies through
 * collapseEmptySurface, read straight off the surface (cheaper than a
 * parse, and the answer is identical).
 */
export function surfaceLooksEmpty(element: HTMLElement): boolean {
  if (element.querySelector(EMPTY_SURFACE_MEDIA)) {
    return false;
  }
  return (element.textContent ?? '').replace(/\u200B/g, '').trim() === '';
}

/**
 * True when the empty state should paint the placeholder. This is the
 * JS-side mirror #note's placeholder CSS reads through [data-empty] —
 * and it has to be JS because CSS cannot see text nodes: the pre-fix
 * selector `#note:has(> br:only-child)` counts ELEMENT children only, so
 * a legacy note holding "text + br" (older builds stored their soft
 * breaks as brs) still matched it and painted the placeholder over the
 * user's typed words.
 *
 * The rule is text-aware emptiness: nothing to read (zero-width runs are
 * plumbing), no media, no armed formatting run — and no structured blocks
 * either, because an armed empty list or a lone block skeleton
 * (`<div><br></div>`) is deliberate structure, not an empty note, and the
 * placeholder painting a line above it reads as a glitch.
 */
export function surfaceIsEmptyForPlaceholder(element: HTMLElement): boolean {
  if (!surfaceLooksEmpty(element)) {
    return false;
  }
  if (hasStyledCaretRun(element)) {
    return false;
  }
  return !Array.from(element.children).some((child) => child.tagName !== 'BR');
}

// ---------------------------------------------------------------------------
// Block vocabulary — the block-level tags the engine's operations address.
// ---------------------------------------------------------------------------

/** Blocks that carry the margin-left indent step (lists nest natively). */
export const INDENTABLE_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE']);

/**
 * Block siblings a caret can safely move to when an insertion must escape
 * a list (tables/dividers nest inside <li> otherwise) — the note's block
 * set plus the lists and tables themselves.
 */
export const BLOCK_SIBLING_TAGS = new Set([...INDENTABLE_TAGS, 'UL', 'OL', 'TABLE']);

/** The stored px step per indent level, clamped to MAX_INDENT_PX. */
export const INDENT_STEP_PX = 40;
export const MAX_INDENT_PX = 240;

/** The checklist vocabulary on the stored subset (see ops.ts). */
export const CHECKLIST_ATTR = 'data-rich-checklist';
export const CHECKED_ATTR = 'data-checked';

/**
 * The block-level ancestor of a node inside the editor, or null — the
 * nearest tag from the engine's block vocabulary, stopping at the root.
 * Bare root text answers null (it is the implicit paragraph).
 */
export function blockAncestorOf(node: Node | null, root: HTMLElement): Element | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el && el !== root && !BLOCK_SIBLING_TAGS.has(el.tagName)) {
    el = el.parentElement;
  }
  return el && el !== root ? el : null;
}

/**
 * The plain-text stream of a subtree, zero-width runs and math shells
 * excluded — the coordinate space selection.ts counts offsets in. Math
 * shells are inline atoms (their rendered text is display plumbing, and
 * the caret cannot sit inside them), and U+200B is a marker, not content.
 */
export function textStreamOf(root: HTMLElement): string {
  let out = '';
  walkTextStream(root, (_node, _start, visible) => {
    out += visible;
  });
  return out;
}

/**
 * Visits every text node of the subtree in document order with its stream
 * start offset and its zero-width-excluded content, skipping math shells
 * (inline atoms — never text positions). The shared walker for offset
 * counting and caret placement.
 */
export function walkTextStream(
  root: HTMLElement,
  visit: (node: Text, start: number, visible: string) => void,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (text.parentElement?.closest('.padify-math')) {
      continue;
    }
    const visible = (text.nodeValue ?? '').replace(/\u200B/g, '');
    const start = consumed;
    consumed += visible.length;
    visit(text, start, visible);
  }
}

/**
 * The stream length of a text node's content — zero-width markers
 * excluded, so offsets agree with walkTextStream's counting.
 */
export function streamLength(text: Text): number {
  return (text.nodeValue ?? '').replace(/\u200B/g, '').length;
}

/**
 * Splits a text node at a STREAM offset (zero-width-excluded) inside it
 * and returns the node that holds the stream from that offset on. Offsets
 * at or before the head and at or past the tail return the node itself —
 * no split needed; the caller decides what an empty head/tail means.
 */
export function splitTextAtStream(text: Text, streamOffset: number): Text {
  const value = text.nodeValue ?? '';
  if (streamOffset <= 0 || streamOffset >= streamLength(text)) {
    return text;
  }
  let raw = 0;
  let stream = 0;
  while (raw < value.length) {
    if (value[raw] !== ZERO_WIDTH_SPACE) {
      if (stream === streamOffset) {
        break;
      }
      stream += 1;
    }
    raw += 1;
  }
  return raw > 0 && raw < value.length ? (text.splitText(raw) as Text) : text;
}

// ---------------------------------------------------------------------------
// Style attributes — parse/format helpers so the engine's emission is
// canonical (one order, one spacing) no matter who set the property.
// ---------------------------------------------------------------------------

/**
 * Reads a style attribute into a property map. Only the storage subset's
 * properties survive parsing anywhere (storage-subset.ts), so the map is
 * small by construction.
 */
export function parseStyleAttr(raw: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) {
    return out;
  }
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (prop !== '' && value !== '') {
      out.set(prop, value);
    }
  }
  return out;
}

/** The canonical emission order — the sanitizer's own property order. */
const INLINE_PROP_ORDER = ['color', 'background-color', 'font-size', 'font-family'] as const;
const BLOCK_PROP_ORDER = ['text-align', 'margin-left'] as const;

/** Formats a property map back into a style attribute value. */
export function formatStyleAttr(
  props: Map<string, string>,
  kind: 'inline' | 'block',
): string | null {
  const order = kind === 'inline' ? INLINE_PROP_ORDER : BLOCK_PROP_ORDER;
  const kept: string[] = [];
  for (const prop of order) {
    const value = props.get(prop);
    if (value !== undefined && value !== '') {
      kept.push(`${prop}: ${value}`);
    }
  }
  for (const [prop, value] of props) {
    // Unknown properties cannot occur through the subset; keep them last
    // rather than dropping them, so round-trips never lose bytes.
    if (!order.includes(prop as never) && value !== '') {
      kept.push(`${prop}: ${value}`);
    }
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * Reads one declaration off an element's style attribute (canonical form,
 * or null when absent).
 */
export function stylePropOf(element: HTMLElement, prop: string): string | null {
  return parseStyleAttr(element.getAttribute('style')).get(prop) ?? null;
}

/**
 * Writes one declaration onto an element's style attribute, preserving the
 * others — or removes the attribute entirely when it empties. The element
 * is returned so call sites can chain.
 */
export function setStyleProp(
  element: HTMLElement,
  prop: string,
  value: string | null,
  kind: 'inline' | 'block',
): HTMLElement {
  const props = parseStyleAttr(element.getAttribute('style'));
  if (value === null || value === '') {
    props.delete(prop);
  } else {
    props.set(prop, value);
  }
  const formatted = formatStyleAttr(props, kind);
  if (formatted === null) {
    element.removeAttribute('style');
  } else {
    element.setAttribute('style', formatted);
  }
  return element;
}
