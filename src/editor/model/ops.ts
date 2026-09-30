/**
 * The typed operations — every mutation the port performs, one per
 * vocabulary verb, in model coordinates.
 *
 * An operation takes the canonical model and the user's selection (stream
 * offsets), mutates the tree, and answers where the caret should land:
 * a spot in model space (mapped onto the repainted surface by the port —
 * paint renders the model exactly, so the coordinates carry over), a
 * range to keep selected, or "preserve" (put it back where it was,
 * clamped). Operations never touch the live surface, never call an
 * engine command, and never announce — the port does the absorbing,
 * painting, history and announcing, once, for all of them.
 */

import {
  BLOCK_SIBLING_TAGS,
  CHECKED_ATTR,
  CHECKLIST_ATTR,
  INDENTABLE_TAGS,
  INDENT_STEP_PX,
  MAX_INDENT_PX,
  setStyleProp,
} from './document';
import { spotAtStream, spotElement, type DomSpot } from './selection';

/** Where the caret/selection should land after an operation. */
export type OpIntent = { spot: DomSpot } | { range: [number, number] } | { preserve: true };

/** The standard operation result. */
export interface OpResult {
  changed: boolean;
  intent?: OpIntent;
}

const UNCHANGED: OpResult = { changed: false };

/** Format marks and their toggle families. */
const MARK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL']);

// ---------------------------------------------------------------------------
// Shared addressing helpers.
// ---------------------------------------------------------------------------

/**
 * Splits the model's text at the coverage edges so every covered segment
 * is addressable as whole text nodes (the wrap/unwrap primitives below
 * never re-split). Returns nothing; the model is mutated in place.
 */
function splitAtEdges(model: HTMLElement, coverage: [number, number]): void {
  for (const edge of coverage) {
    if (edge <= 0) {
      continue;
    }
    const spot = spotAtStream(model, edge);
    if (!spot || spot.kind !== 'text') {
      continue;
    }
    const text = spot.node;
    if (spot.raw > 0 && spot.raw < (text.nodeValue ?? '').length) {
      text.splitText(spot.raw);
    }
  }
}

/**
 * The text nodes the coverage touches (whole nodes after splitAtEdges),
 * document order — the runs a mark or style operation addresses.
 */
function coveredTextNodes(model: HTMLElement, coverage: [number, number]): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(model, NodeFilter.SHOW_TEXT);
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
    if (start >= coverage[1]) {
      break;
    }
    const end = start + visible.length;
    if (end > coverage[0] && (visible !== '' || start >= coverage[0])) {
      out.push(text);
    }
  }
  return out;
}

/**
 * The nearest ancestor of a node (up to the block boundary) matching a
 * predicate — the walk the mark queries and unwraps use.
 */
function inlineAncestor(
  model: HTMLElement,
  node: Node | null,
  match: (el: HTMLElement) => boolean,
): HTMLElement | null {
  let el = node instanceof Element ? node : (node?.parentElement ?? null);
  while (
    el &&
    el !== model &&
    !BLOCK_SIBLING_TAGS.has(el.tagName) &&
    el.tagName !== 'LI' &&
    el.tagName !== 'TD' &&
    el.tagName !== 'TH'
  ) {
    if (match(el as HTMLElement)) {
      return el as HTMLElement;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * The block-level element an operation addresses for a coverage: the
 * nearest block-ish ancestor of the covered range's start — LI and table
 * cells count as blocks here (alignment and indent apply to items and
 * cells), lists and tables do not.
 */
export function blockAt(model: HTMLElement, coverage: [number, number]): HTMLElement | null {
  const spot = spotAtStream(model, coverage[0]);
  if (!spot) {
    return null;
  }
  let el: HTMLElement | null = spotElement(spot);
  while (el && el !== model) {
    if (
      INDENTABLE_TAGS.has(el.tagName) ||
      el.tagName === 'LI' ||
      el.tagName === 'TD' ||
      el.tagName === 'TH'
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * The blocks a multi-block coverage touches: the start block, the end
 * block, and every block sibling between them when they share a parent.
 */
export function coveredBlocks(model: HTMLElement, coverage: [number, number]): HTMLElement[] {
  let start = blockAt(model, [coverage[0], coverage[0]]);
  // Bare root text at the coverage start: materialize its root-level run
  // into a real block first, so a coverage reaching from typed root text
  // into following blocks addresses ALL of them (line semantics — the
  // whole covered range becomes list items, not just its first line).
  if (!start) {
    const materialized = materializeRootRun(model, coverage);
    if (materialized) {
      start = materialized;
    }
  }
  const endSpot = spotAtStream(model, coverage[1]);
  const end = endSpot ? blockAt(model, [coverage[1], coverage[1]]) : null;
  if (!start) {
    return [];
  }
  if (!end || start === end) {
    return [start];
  }
  const parent = start.parentElement;
  if (parent && parent === end.parentElement) {
    const kids = Array.from(parent.children);
    const from = kids.indexOf(start);
    const to = kids.indexOf(end);
    if (from >= 0 && to >= from) {
      return kids
        .slice(from, to + 1)
        .filter(
          (el): el is HTMLElement =>
            el instanceof HTMLElement && (INDENTABLE_TAGS.has(el.tagName) || el.tagName === 'LI'),
        );
    }
  }
  return [start, end];
}

/**
 * Materializes bare root-level text into a real block: the root's inline
 * run around the coverage is wrapped into a DIV (the surface's own
 * paragraph spelling), so block operations have an element to address.
 * Returns the new block, or null when there is nothing to materialize.
 */
function materializeRootRun(model: HTMLElement, coverage: [number, number]): HTMLElement | null {
  // The root's MAXIMAL consecutive inline run containing the coverage
  // start: from the first block boundary at/before it to the first at/after
  // it. Line semantics — the whole root-level line becomes a real block,
  // exactly what a formatBlock/align/indent over typed root text means.
  const kids = Array.from(model.childNodes);
  const isBlock = (node: Node): boolean =>
    node instanceof Element &&
    (INDENTABLE_TAGS.has(node.tagName) ||
      node.tagName === 'UL' ||
      node.tagName === 'OL' ||
      node.tagName === 'TABLE' ||
      node.tagName === 'HR');

  // Find the child whose content holds the coverage start.
  let seen = 0;
  let holder = -1;
  for (let index = 0; index < kids.length; index += 1) {
    const length = streamLengthOfNode(kids[index]!);
    if (!isBlock(kids[index]!) && seen + length > coverage[0] && length > 0) {
      holder = index;
      break;
    }
    seen += length;
    if (!isBlock(kids[index]!) && seen >= coverage[0] && holder === -1 && coverage[0] === seen) {
      // The coverage starts exactly at a zero-length inline child.
      holder = index;
      break;
    }
  }
  if (holder === -1) {
    return null;
  }
  // Extend to the maximal consecutive inline run around the holder.
  let from = holder;
  while (from > 0 && !isBlock(kids[from - 1]!)) {
    from -= 1;
  }
  let to = holder;
  while (to + 1 < kids.length && !isBlock(kids[to + 1]!)) {
    to += 1;
  }
  const wrapper = document.createElement('div');
  const anchor = kids[to]!.nextSibling;
  for (let index = from; index <= to; index += 1) {
    wrapper.append(kids[index]!);
  }
  model.insertBefore(wrapper, anchor);
  return wrapper;
}

function streamLengthOfNode(node: Node): number {
  if (node instanceof HTMLElement && node.classList.contains('padify-math')) {
    return 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? '').replace(/\u200B/g, '').length;
  }
  let count = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    count += streamLengthOfNode(child);
  }
  return count;
}
/** Replaces an element with its children. */
export function unwrap(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) {
    return;
  }
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  el.remove();
  parent.normalize();
}
/** Wraps one text node into a fresh element. */
function wrapTextNode(text: Text, tag: string): HTMLElement {
  const wrapper = document.createElement(tag);
  text.replaceWith(wrapper);
  wrapper.append(text);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Inline marks.
// ---------------------------------------------------------------------------

/**
 * Toggles a format mark over the coverage. All covered runs already
 * carrying the mark → unwrap them everywhere covered (the OFF direction);
 * otherwise wrap the uncovered runs (the press means "mark it all").
 * Cross-block coverages wrap per run — marks are inline and never span
 * blocks.
 */
export function toggleMark(
  model: HTMLElement,
  coverage: [number, number],
  tag: 'b' | 'i' | 'u' | 'strike' | 'sub' | 'sup',
): OpResult {
  if (coverage[1] <= coverage[0]) {
    return UNCHANGED;
  }
  splitAtEdges(model, coverage);
  const texts = coveredTextNodes(model, coverage).filter((t) => (t.nodeValue ?? '') !== '');
  if (texts.length === 0) {
    return UNCHANGED;
  }
  const carries = (el: HTMLElement): boolean => el.tagName === tag.toUpperCase();

  if (texts.every((text) => inlineAncestor(model, text, carries) !== null)) {
    // Toggle OFF: unwrap every wrapper around the covered runs.
    const wrappers = new Set<HTMLElement>();
    for (const text of texts) {
      let el: HTMLElement | null = text.parentElement;
      while (el && el !== model) {
        if (carries(el)) {
          wrappers.add(el);
        }
        el = el.parentElement;
      }
    }
    [...wrappers]
      .sort((a, b) => (a.contains(b) ? -1 : b.contains(a) ? 1 : 0))
      .forEach((el) => unwrap(el));
    return { changed: true, intent: { range: coverage } };
  }

  // Toggle ON: wrap the uncovered runs.
  let wrapped = false;
  for (const text of texts) {
    if (inlineAncestor(model, text, carries) !== null) {
      continue;
    }
    wrapTextNode(text, tag);
    wrapped = true;
  }
  return wrapped ? { changed: true, intent: { range: coverage } } : UNCHANGED;
}

/**
 * Clears inline formatting over the coverage: marks unwrapped, styled
 * spans unwrapped (an emptied span disappears entirely), links and block
 * styles kept — Docs' "clear formatting" shape.
 */
export function removeInlineFormatting(model: HTMLElement, coverage: [number, number]): OpResult {
  if (coverage[1] <= coverage[0]) {
    return UNCHANGED;
  }
  splitAtEdges(model, coverage);
  const texts = coveredTextNodes(model, coverage).filter((t) => (t.nodeValue ?? '') !== '');
  if (texts.length === 0) {
    return UNCHANGED;
  }
  const victims = new Set<HTMLElement>();
  for (const text of texts) {
    let el: HTMLElement | null = text.parentElement;
    while (el && el !== model) {
      if (
        BLOCK_SIBLING_TAGS.has(el.tagName) ||
        el.tagName === 'LI' ||
        el.tagName === 'TD' ||
        el.tagName === 'TH'
      ) {
        break;
      }
      if (MARK_TAGS.has(el.tagName) || el.tagName === 'SUB' || el.tagName === 'SUP') {
        victims.add(el);
      }
      if (el.tagName === 'SPAN' && el.getAttribute('style')) {
        victims.add(el);
      }
      el = el.parentElement;
    }
  }
  if (victims.size === 0) {
    return UNCHANGED;
  }
  [...victims]
    .sort((a, b) => (a.contains(b) ? -1 : b.contains(a) ? 1 : 0))
    .forEach((el) => unwrap(el));
  return { changed: true, intent: { range: coverage } };
}

// ---------------------------------------------------------------------------
// Inline styles (the Docs vocabulary: size, family, ink, highlight).
// ---------------------------------------------------------------------------

/**
 * Sets one inline style declaration over the coverage. A covered run whose
 * parent already carries styles merges into that span (one span, both
 * declarations); otherwise the run wraps into a fresh span.
 */
export function setInlineStyle(
  model: HTMLElement,
  coverage: [number, number],
  prop: 'color' | 'background-color' | 'font-size' | 'font-family',
  value: string,
): OpResult {
  if (coverage[1] <= coverage[0]) {
    return UNCHANGED;
  }
  splitAtEdges(model, coverage);
  const texts = coveredTextNodes(model, coverage).filter((t) => (t.nodeValue ?? '') !== '');
  if (texts.length === 0) {
    return UNCHANGED;
  }
  let changed = false;
  for (const text of texts) {
    const parent = text.parentElement;
    if (parent && parent.tagName === 'SPAN' && parent.getAttribute('style')) {
      setStyleProp(parent, prop, value, 'inline');
      changed = true;
      continue;
    }
    const span = wrapTextNode(text, 'span');
    setStyleProp(span, prop, value, 'inline');
    changed = true;
  }
  return changed ? { changed: true, intent: { range: coverage } } : UNCHANGED;
}

/**
 * Strips one inline style declaration over the coverage: every span that
 * intersects the coverage loses the declaration (Chrome's hilite-None
 * semantics — "clear it entirely"), and a span emptied of all declarations
 * unwraps away.
 */
export function clearInlineStyle(
  model: HTMLElement,
  coverage: [number, number],
  prop: 'color' | 'background-color' | 'font-size' | 'font-family',
): OpResult {
  if (coverage[1] <= coverage[0]) {
    return UNCHANGED;
  }
  splitAtEdges(model, coverage);
  const texts = coveredTextNodes(model, coverage);
  const spans = new Set<HTMLElement>();
  for (const text of texts) {
    let el: HTMLElement | null = text.parentElement;
    while (el && el !== model) {
      if (
        BLOCK_SIBLING_TAGS.has(el.tagName) ||
        el.tagName === 'LI' ||
        el.tagName === 'TD' ||
        el.tagName === 'TH'
      ) {
        break;
      }
      if (el.tagName === 'SPAN' && el.getAttribute('style')) {
        spans.add(el);
      }
      el = el.parentElement;
    }
  }
  if (spans.size === 0) {
    return UNCHANGED;
  }
  for (const span of spans) {
    setStyleProp(span, prop, null, 'inline');
    if (!span.getAttribute('style')) {
      unwrap(span);
    }
  }
  return { changed: true, intent: { range: coverage } };
}

/**
 * The styled-caret run: plants `<span style="…">\u200B</span>` at a
 * collapsed caret so the next keystrokes join a run that already carries
 * the picked styles — the Docs "pick, then type" behavior.
 */
export function plantStyledCaret(
  model: HTMLElement,
  at: number,
  styles: Record<string, string>,
): OpResult {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const styleAttr = Object.entries(styles)
    .filter(([, value]) => value !== '')
    .map(([prop, value]) => `${prop}: ${value}`)
    .join('; ');
  if (styleAttr === '') {
    return UNCHANGED;
  }
  const span = document.createElement('span');
  span.setAttribute('style', styleAttr);
  span.append(document.createTextNode('\u200B'));
  if (spot.kind === 'text') {
    const text = spot.node;
    if (spot.raw >= (text.nodeValue ?? '').length) {
      text.parentNode?.insertBefore(span, text.nextSibling);
    } else if (spot.raw === 0) {
      text.parentNode?.insertBefore(span, text);
    } else {
      const tail = text.splitText(spot.raw);
      tail.parentNode?.insertBefore(span, tail);
    }
  } else {
    if (spot.childIndex >= spot.node.childNodes.length) {
      spot.node.append(span);
    } else {
      spot.node.insertBefore(span, spot.node.childNodes[spot.childIndex]!);
    }
  }
  return {
    changed: true,
    intent: { spot: { kind: 'text', node: span.firstChild as Text, raw: 1 } },
  };
}

/**
 * "None" highlight at a collapsed caret: the styled caret run the caret
 * sits in loses its background. Addressed by run index — a marker run
 * holds no stream position to point at (the same structural rule as
 * empty items and empty cells). No run under the caret: a no-op success
 * (plain ink is already the state).
 */
export function clearStyledCaretRun(model: HTMLElement, runIndex: number): OpResult {
  const runs = Array.from(model.querySelectorAll('span')).filter(
    (span) => span.textContent === '\u200B' && span.getAttribute('style'),
  );
  const run = runs[runIndex];
  if (!(run instanceof HTMLElement)) {
    return { changed: false };
  }
  setStyleProp(run, 'background-color', null, 'inline');
  if (!run.getAttribute('style')) {
    // The run emptied of every declaration: it existed only to carry the
    // pending style, so the run AND its zero-width marker go together —
    // a stray \u200B text node is plumbing left behind in the note.
    run.remove();
    return { changed: true, intent: { preserve: true } };
  }
  // Style remains (other declarations): the run survives as a styled
  // caret run; the caret stays inside it, past the marker.
  const marker = run.firstChild instanceof Text ? run.firstChild : null;
  return marker
    ? { changed: true, intent: { spot: { kind: 'text', node: marker, raw: 1 } } }
    : { changed: true, intent: { preserve: true } };
}

// ---------------------------------------------------------------------------
// Block format — the paragraph/headings/quote/code vocabulary.
// ---------------------------------------------------------------------------

const BLOCK_FORMAT_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE']);

/**
 * Rewrites the covered blocks' tag: div↔p↔h1..3↔blockquote↔pre. Bare root
 * text materializes into the target tag first; list items and table cells
 * are left alone (formatting never destroys a list or a table). Block
 * styles survive the rewrite.
 */
export function applyBlockTag(
  model: HTMLElement,
  coverage: [number, number],
  tag: 'p' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre',
): OpResult {
  let blocks = coveredBlocks(model, coverage).filter((block) =>
    BLOCK_FORMAT_TAGS.has(block.tagName),
  );
  if (blocks.length === 0) {
    const materialized = materializeRootRun(model, coverage);
    if (materialized) {
      blocks = [materialized];
    }
  }
  if (blocks.length === 0) {
    return UNCHANGED;
  }
  for (const block of blocks) {
    const replacement = document.createElement(tag);
    for (const attr of Array.from(block.attributes)) {
      replacement.setAttribute(attr.name, attr.value);
    }
    while (block.firstChild) {
      replacement.append(block.firstChild);
    }
    block.replaceWith(replacement);
  }
  return { changed: true, intent: { preserve: true } };
}

/**
 * Sets one block-level declaration (alignment) over the covered blocks.
 * Bare root text materializes into a DIV; list items and cells carry the
 * declaration themselves (the subset admits block props on LI/TD).
 */
export function setBlockStyleProp(
  model: HTMLElement,
  coverage: [number, number],
  prop: 'text-align' | 'margin-left',
  value: string | null,
): OpResult {
  const blocks = coveredBlocks(model, coverage).filter(
    (block) =>
      BLOCK_FORMAT_TAGS.has(block.tagName) ||
      block.tagName === 'LI' ||
      block.tagName === 'TD' ||
      block.tagName === 'TH',
  );
  blocks.push(...rootRunsToMaterialize(model, coverage));
  if (blocks.length === 0) {
    return UNCHANGED;
  }
  let changed = false;
  for (const block of blocks) {
    setStyleProp(block, prop, value, 'block');
    changed = true;
  }
  return changed ? { changed: true, intent: { preserve: true } } : UNCHANGED;
}

/**
 * Steps the margin-left indent of the covered blocks by ±INDENT_STEP_PX,
 * clamped to [0, MAX_INDENT_PX]. Reads and writes the style attribute (the
 * model's truth), not the computed style.
 */
export function shiftBlockIndent(
  model: HTMLElement,
  coverage: [number, number],
  delta: 1 | -1,
): OpResult {
  const blocks = coveredBlocks(model, coverage).filter((block) =>
    INDENTABLE_TAGS.has(block.tagName),
  );
  blocks.push(...rootRunsToMaterialize(model, coverage));
  if (blocks.length === 0) {
    return UNCHANGED;
  }
  let changed = false;
  for (const block of blocks) {
    const current =
      parseInt(
        block.getAttribute('style')?.match(/margin-left:\s*(\d+(?:\.\d+)?)px/)?.[1] ?? '0',
        10,
      ) || 0;
    const next = Math.min(Math.max(current + delta * INDENT_STEP_PX, 0), MAX_INDENT_PX);
    if (next === current) {
      continue;
    }
    setStyleProp(block, 'margin-left', next > 0 ? `${next}px` : null, 'block');
    changed = true;
  }
  return changed ? { changed: true, intent: { preserve: true } } : UNCHANGED;
}

/**
 * The root-level inline runs the coverage touches, materialized into DIVs
 * (each run becomes one). Empty when the coverage lives inside real blocks.
 */
function rootRunsToMaterialize(model: HTMLElement, coverage: [number, number]): HTMLElement[] {
  if (blockAt(model, coverage) !== null) {
    return [];
  }
  const materialized = materializeRootRun(model, coverage);
  return materialized ? [materialized] : [];
}

// ---------------------------------------------------------------------------
// Lists and checklists.
// ---------------------------------------------------------------------------

/** The list (UL/OL) an offset sits inside, or null. */
export function listAt(model: HTMLElement, at: number): HTMLElement | null {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return null;
  }
  let el: HTMLElement | null = spotElement(spot);
  while (el && el !== model) {
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Toggles a list over the coverage.
 *
 *  • plain list over a checklist of the other button: converts — the boxes
 *    go (ul strips the checklist mark, ol changes the tag), the list never
 *    dies (Docs semantics: a bullet button on a checklist is a conversion);
 *  • checklist over a checklist: OFF — items return to plain paragraphs;
 *  • any list kind over non-list blocks: WRAP — the covered blocks become
 *    items of one list; bare root text materializes first; a checklist
 *    gains data-rich-checklist and the unchecked default on every item.
 */
export function toggleListKind(
  model: HTMLElement,
  coverage: [number, number],
  kind: 'ul' | 'ol' | 'checklist',
): OpResult {
  const current = listAt(model, coverage[0]);
  const currentKind: 'ul' | 'ol' | 'checklist' | null =
    current === null
      ? null
      : current.tagName === 'OL'
        ? 'ol'
        : current.hasAttribute(CHECKLIST_ATTR)
          ? 'checklist'
          : 'ul';

  // Conversions in place.
  if (current && currentKind === 'checklist' && (kind === 'ul' || kind === 'ol')) {
    current.removeAttribute(CHECKLIST_ATTR);
    current.querySelectorAll('li').forEach((li) => li.removeAttribute(CHECKED_ATTR));
    if (kind === 'ol') {
      const ordered = document.createElement('ol');
      for (const attr of Array.from(current.attributes)) {
        ordered.setAttribute(attr.name, attr.value);
      }
      while (current.firstChild) {
        ordered.append(current.firstChild);
      }
      current.replaceWith(ordered);
    }
    return { changed: true, intent: { preserve: true } };
  }
  if (current && kind === 'checklist' && currentKind === 'checklist') {
    // OFF: items return to plain paragraphs (the list dies).
    return liftListItems(model, current);
  }
  if (
    current &&
    ((kind === 'ul' && currentKind === 'ol') || (kind === 'ol' && currentKind === 'ul'))
  ) {
    const replacement = document.createElement(kind === 'ul' ? 'ul' : 'ol');
    for (const attr of Array.from(current.attributes)) {
      replacement.setAttribute(attr.name, attr.value);
    }
    replacement.removeAttribute(CHECKLIST_ATTR);
    while (current.firstChild) {
      replacement.append(current.firstChild);
    }
    current.replaceWith(replacement);
    return { changed: true, intent: { preserve: true } };
  }

  // WRAP: the covered blocks become one list's items.
  let blocks = coveredBlocks(model, coverage).filter(
    (block) => BLOCK_FORMAT_TAGS.has(block.tagName) && block.tagName !== 'LI',
  );
  if (blocks.length === 0) {
    const materialized = materializeRootRun(model, coverage);
    if (materialized) {
      blocks = [materialized];
    }
  }
  const list = document.createElement(kind === 'ol' ? 'ol' : 'ul');
  if (kind === 'checklist') {
    list.setAttribute(CHECKLIST_ATTR, 'true');
  }
  if (blocks.length === 0) {
    // Nothing to wrap — a bare caret on an empty note (or a textless
    // context): the list is born with ONE empty item, caret inside it.
    // An intentional empty block, never a normalization away.
    const item = document.createElement('li');
    if (kind === 'checklist') {
      item.setAttribute(CHECKED_ATTR, 'false');
    }
    list.append(item);
    model.append(list);
    return { changed: true, intent: { spot: { kind: 'element', node: item, childIndex: 0 } } };
  }
  const first = blocks[0]!;
  for (const block of blocks) {
    const item = document.createElement('li');
    if (kind === 'checklist') {
      item.setAttribute(CHECKED_ATTR, 'false');
    }
    while (block.firstChild) {
      item.append(block.firstChild);
    }
    list.append(item);
  }
  first.replaceWith(list);
  for (const block of blocks.slice(1)) {
    block.remove();
  }
  return { changed: true, intent: { preserve: true } };
}

/**
 * Lifts every item of a list out of it: each li becomes a DIV holding its
 * content, placed where the list was. The checklist OFF and the top-level
 * list outdent both land here.
 */
function liftListItems(model: HTMLElement, list: HTMLElement): OpResult {
  void model;
  const parent = list.parentNode;
  if (!parent) {
    return UNCHANGED;
  }
  const anchor = list.nextSibling;
  const lifted: HTMLElement[] = [];
  for (const item of Array.from(list.children)) {
    if (item.tagName !== 'LI') {
      continue;
    }
    const div = document.createElement('div');
    for (const attr of Array.from(item.attributes)) {
      if (attr.name === 'style') {
        div.setAttribute('style', attr.value);
      }
    }
    while (item.firstChild) {
      div.append(item.firstChild);
    }
    lifted.push(div);
  }
  for (const div of lifted) {
    parent.insertBefore(div, anchor);
  }
  list.remove();
  return { changed: true, intent: { preserve: true } };
}

/**
 * Nests the caret's list item under its previous sibling (Tab inside a
 * list): the item moves into a nested list of the parent's kind inside the
 * previous item, created when it does not exist yet. No previous sibling —
 * no-op (the first item cannot nest).
 */
export function nestListItem(model: HTMLElement, at: number): OpResult {
  const spot = spotAtStream(model, at);
  const item = spot ? closestByTag(spot, 'LI') : null;
  if (!item || !item.parentElement) {
    return UNCHANGED;
  }
  const list = item.parentElement;
  const previous = item.previousElementSibling;
  if (!(previous instanceof HTMLElement) || previous.tagName !== 'LI') {
    return UNCHANGED;
  }
  let nested = previous.querySelector(':scope > ul, :scope > ol');
  if (!nested) {
    nested = document.createElement(list.tagName === 'OL' ? 'ol' : 'ul');
    if (list.hasAttribute(CHECKLIST_ATTR)) {
      nested.setAttribute(CHECKLIST_ATTR, 'true');
    }
    previous.append(nested);
  }
  nested.append(item);
  return { changed: true, intent: { preserve: true } };
}

/**
 * Unnests the caret's list item (Shift+Tab inside a list): the item moves
 * out to sit after its grandparent item; a top-level item lifts out of
 * the list entirely (the item becomes a paragraph, the list splits around
 * it).
 */
export function unnestListItem(model: HTMLElement, at: number): OpResult {
  const spot = spotAtStream(model, at);
  const item = spot ? closestByTag(spot, 'LI') : null;
  if (!item || !item.parentElement) {
    return UNCHANGED;
  }
  const list = item.parentElement;
  const nestedIn = list.parentElement; // the grandparent LI when nested
  if (nestedIn instanceof HTMLElement && nestedIn.tagName === 'LI') {
    nestedIn.parentNode?.insertBefore(item, nestedIn.nextSibling);
    if (list.children.length === 0) {
      list.remove();
    }
    return { changed: true, intent: { preserve: true } };
  }
  // Top level: lift this one item out of the list.
  return liftOneListItem(model, list, item);
}

function liftOneListItem(model: HTMLElement, list: HTMLElement, item: HTMLElement): OpResult {
  void model;
  const parent = list.parentNode;
  if (!parent) {
    return UNCHANGED;
  }
  const div = document.createElement('div');
  const style = item.getAttribute('style');
  if (style) {
    div.setAttribute('style', style);
  }
  while (item.firstChild) {
    div.append(item.firstChild);
  }
  const anchor = list.nextSibling;
  list.parentNode?.insertBefore(div, anchor);
  item.remove();
  if (list.children.length === 0) {
    list.remove();
  }
  return { changed: true, intent: { preserve: true } };
}

/**
 * Flips a checklist item's box state — the gutter-click mutation.
 * Addressed by (checklist index, item index): the surface and the model
 * share the structure, so the indices the click resolved to on the surface
 * address the same nodes here.
 */
export function flipChecklistItem(
  model: HTMLElement,
  listIndex: number,
  itemIndex: number,
): OpResult {
  const lists = model.querySelectorAll(`ul[${CHECKLIST_ATTR}]`);
  const list = lists.item(listIndex);
  if (!list) {
    return UNCHANGED;
  }
  const item = list.children.item(itemIndex);
  if (!(item instanceof HTMLElement) || item.tagName !== 'LI') {
    return UNCHANGED;
  }
  const next = item.getAttribute(CHECKED_ATTR) === 'true' ? 'false' : 'true';
  item.setAttribute(CHECKED_ATTR, next);
  return { changed: true, intent: { preserve: true } };
}

/**
 * Empty checked items lose their state — the Enter continuation
 * normalization (Docs starts the next item unchecked, never as an empty
 * done item). Addressed structurally, not by offset: an empty item holds
 * no stream position to point at, so every empty checked item in a
 * checklist flips (there is no meaningful "which one" — they are all the
 * same no-text done-item state).
 */
export function uncheckEmptyItems(model: HTMLElement): OpResult {
  let changed = false;
  model.querySelectorAll(`ul[${CHECKLIST_ATTR}] li`).forEach((li) => {
    if (!(li instanceof HTMLElement)) {
      return;
    }
    if ((li.textContent ?? '').replace(/\u200B/g, '').trim() !== '') {
      return;
    }
    if (li.getAttribute(CHECKED_ATTR) !== 'true') {
      return;
    }
    li.setAttribute(CHECKED_ATTR, 'false');
    changed = true;
  });
  return changed ? { changed: true, intent: { preserve: true } } : UNCHANGED;
}

function closestByTag(spot: DomSpot, tag: 'LI' | 'UL' | 'OL' | 'TD' | 'TH'): HTMLElement | null {
  let el: HTMLElement | null = spotElement(spot);
  while (el) {
    if (el.tagName === tag) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Links.
// ---------------------------------------------------------------------------

/**
 * Links the covered range: segments already inside an anchor retarget it;
 * the rest wrap into a fresh anchor. The covered range stays selected.
 */
export function wrapLink(model: HTMLElement, coverage: [number, number], href: string): OpResult {
  if (coverage[1] <= coverage[0]) {
    return UNCHANGED;
  }
  splitAtEdges(model, coverage);
  const texts = coveredTextNodes(model, coverage).filter((t) => (t.nodeValue ?? '') !== '');
  if (texts.length === 0) {
    return UNCHANGED;
  }
  let changed = false;
  for (const text of texts) {
    const anchor = inlineAncestor(model, text, (el) => el.tagName === 'A');
    if (anchor) {
      anchor.setAttribute('href', href);
      changed = true;
      continue;
    }
    const a = wrapTextNode(text, 'a');
    a.setAttribute('href', href);
    changed = true;
  }
  return changed ? { changed: true, intent: { range: coverage } } : UNCHANGED;
}

/**
 * The paste-a-link gesture at a bare caret: the href itself becomes the
 * linked text. The caret lands after the new anchor.
 */
export function plantLink(model: HTMLElement, at: number, href: string): OpResult {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href);
  anchor.append(document.createTextNode(href));
  if (spot.kind === 'text') {
    const text = spot.node;
    if (spot.raw >= (text.nodeValue ?? '').length) {
      text.parentNode?.insertBefore(anchor, text.nextSibling);
    } else if (spot.raw === 0) {
      text.parentNode?.insertBefore(anchor, text);
    } else {
      const tail = text.splitText(spot.raw);
      tail.parentNode?.insertBefore(anchor, tail);
    }
  } else if (spot.childIndex >= spot.node.childNodes.length) {
    spot.node.append(anchor);
  } else {
    spot.node.insertBefore(anchor, spot.node.childNodes[spot.childIndex]!);
  }
  return {
    changed: true,
    intent: { spot: { kind: 'text', node: anchor.firstChild as Text, raw: href.length } },
  };
}

/** Removes the anchor around the caret, keeping its text. */
export function unwrapLinkAt(model: HTMLElement, at: number): OpResult {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const anchor = inlineAncestor(model, spotElement(spot), (el) => el.tagName === 'A');
  if (!anchor) {
    return UNCHANGED;
  }
  unwrap(anchor);
  return { changed: true, intent: { preserve: true } };
}

/** Repoints the anchor at the caret. */
export function retargetAnchorAt(model: HTMLElement, at: number, href: string): OpResult {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const anchor = inlineAncestor(model, spotElement(spot), (el) => el.tagName === 'A');
  if (!anchor) {
    return UNCHANGED;
  }
  anchor.setAttribute('href', href);
  return { changed: true, intent: { preserve: true } };
}

// ---------------------------------------------------------------------------
// Math equations.
// ---------------------------------------------------------------------------

/**
 * Drops an equation shell at the caret — an inline atom carrying only its
 * LaTeX source. The caret lands after the shell.
 */
export function plantMath(model: HTMLElement, at: number, latex: string): OpResult {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const shell = document.createElement('span');
  shell.setAttribute('class', 'padify-math');
  shell.setAttribute('data-latex', latex);
  let afterSpot: DomSpot;
  if (spot.kind === 'text') {
    const text = spot.node;
    const parent = text.parentNode!;
    if (spot.raw >= (text.nodeValue ?? '').length) {
      parent.insertBefore(shell, text.nextSibling);
      afterSpot = {
        kind: 'element',
        node: parent as Element,
        childIndex: Array.prototype.indexOf.call(parent.childNodes, shell) + 1,
      };
    } else if (spot.raw === 0) {
      parent.insertBefore(shell, text);
      afterSpot = {
        kind: 'element',
        node: parent as Element,
        childIndex: Array.prototype.indexOf.call(parent.childNodes, shell) + 1,
      };
    } else {
      const tail = text.splitText(spot.raw);
      parent.insertBefore(shell, tail);
      afterSpot = { kind: 'text', node: tail, raw: 0 };
    }
  } else {
    const parent = spot.node;
    if (spot.childIndex >= parent.childNodes.length) {
      parent.append(shell);
    } else {
      parent.insertBefore(shell, parent.childNodes[spot.childIndex]!);
    }
    afterSpot = {
      kind: 'element',
      node: parent,
      childIndex: Array.prototype.indexOf.call(parent.childNodes, shell) + 1,
    };
  }
  return { changed: true, intent: { spot: afterSpot } };
}

/**
 * Repoints the Nth equation (handles are per-render surface artifacts, so
 * the op addresses shells by index — surface and model share structure).
 */
export function retargetMath(model: HTMLElement, index: number, latex: string): OpResult {
  const shell = model.querySelectorAll('.padify-math').item(index);
  if (!(shell instanceof HTMLElement)) {
    return UNCHANGED;
  }
  shell.setAttribute('data-latex', latex);
  return { changed: true, intent: { preserve: true } };
}

// ---------------------------------------------------------------------------
// Plain-text insertion (voice, unicode picker, tab indentation).
// ---------------------------------------------------------------------------

/**
 * Inserts plain text at the caret, replacing the coverage when one exists.
 * The caret lands at the end of the inserted text — native typing
 * continues inside it.
 */
export function insertPlainText(
  model: HTMLElement,
  coverage: [number, number],
  text: string,
): OpResult {
  if (text === '') {
    return UNCHANGED;
  }
  splitAtEdges(model, coverage);
  const spot = spotAtStream(model, coverage[0]);
  if (!spot) {
    return UNCHANGED;
  }
  // Delete the covered runs first.
  if (coverage[1] > coverage[0]) {
    const victims = coveredTextNodes(model, coverage);
    for (const victim of victims) {
      if (coverageTouchesFully(victim)) {
        victim.remove();
      }
    }
  }
  const fresh = spotAtStream(model, coverage[0]);
  if (!fresh) {
    return UNCHANGED;
  }
  const node = document.createTextNode(text);
  if (fresh.kind === 'text') {
    const target = fresh.node;
    if (fresh.raw >= (target.nodeValue ?? '').length) {
      target.parentNode?.insertBefore(node, target.nextSibling);
    } else if (fresh.raw === 0) {
      target.parentNode?.insertBefore(node, target);
    } else {
      const tail = target.splitText(fresh.raw);
      tail.parentNode?.insertBefore(node, tail);
    }
  } else if (fresh.childIndex >= fresh.node.childNodes.length) {
    fresh.node.append(node);
  } else {
    fresh.node.insertBefore(node, fresh.node.childNodes[fresh.childIndex]!);
  }
  return {
    changed: true,
    intent: { spot: { kind: 'text', node: node, raw: text.length } },
  };
}

/** After splitAtEdges, a covered text node lies fully inside the coverage
 *  unless it is a zero-length marker run — those survive. */
function coverageTouchesFully(node: Text): boolean {
  return (node.nodeValue ?? '') !== '';
}

// ---------------------------------------------------------------------------
// Dividers and tables.
// ---------------------------------------------------------------------------

/**
 * Drops a horizontal rule at the caret. In a list, the caret escapes to
 * the paragraph after the list first (a divider nested inside an item
 * inherits the gutter, the strike and the indents — never wanted). The
 * caret lands at the start of the content after the rule; a trailing
 * paragraph is appended when nothing follows, so typing continues below.
 */
export function plantRule(model: HTMLElement, at: number): OpResult {
  const spot = escapeListAt(model, at) ?? spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const block = spotBlock(spot);
  const holder = block ?? model;
  const rule = document.createElement('hr');
  if (spot.kind === 'text' && block) {
    // Split the block at the caret: rule between the halves.
    const text = spot.node;
    if (spot.raw >= (text.nodeValue ?? '').length) {
      holder.insertBefore(rule, block.nextSibling);
    } else if (spot.raw === 0) {
      holder.insertBefore(rule, block);
    } else {
      const tail = splitBlockAt(block, spot);
      holder.insertBefore(rule, tail);
    }
  } else {
    holder.insertBefore(rule, block ? block.nextSibling : null);
  }
  // A following paragraph when nothing comes after the rule.
  const nextBlock = rule.nextElementSibling;
  if (!nextBlock) {
    const paragraph = document.createElement('div');
    paragraph.append(document.createElement('br'));
    const host = (block && block.parentElement) || model;
    host.insertBefore(paragraph, rule.nextSibling);
  }
  const after = rule.nextElementSibling;
  const intent: OpIntent = after
    ? { spot: { kind: 'element', node: after, childIndex: 0 } }
    : { preserve: true };
  return { changed: true, intent };
}

/**
 * Splits a block element at a text spot and returns the TAIL half (a
 * sibling after the head). Styles carry onto both halves.
 */
function splitBlockAt(block: HTMLElement, spot: DomSpot): HTMLElement {
  if (spot.kind !== 'text') {
    return block;
  }
  const text = spot.node;
  const parent = text.parentElement ?? block;
  const tail = document.createElement(block.tagName.toLowerCase());
  const style = block.getAttribute('style');
  if (style) {
    tail.setAttribute('style', style);
  }
  if (spot.raw >= (text.nodeValue ?? '').length) {
    return block; // nothing after the caret — the whole block is the head
  }
  if (spot.raw === 0) {
    // everything after the caret becomes the tail
    while (block.firstChild) {
      tail.append(block.firstChild);
    }
    block.parentElement?.insertBefore(tail, block.nextSibling);
    return tail;
  }
  // Split the text node: the part after belongs to the tail.
  const head = text.splitText(spot.raw);
  const toMove: Node[] = [];
  for (let el: Node | null = head; el; el = el.nextSibling) {
    toMove.push(el);
  }
  for (const el of toMove) {
    tail.append(el);
  }
  void parent;
  block.parentElement?.insertBefore(tail, block.nextSibling);
  return tail;
}

/**
 * Inserts a rows×cols table at the caret, insertHTML semantics: the caret
 * escapes a list first, then the table (plus its trailing paragraph)
 * splices in at the caret inside the target block. The caret lands in the
 * first cell.
 */
export function plantTable(model: HTMLElement, at: number, rows: number, cols: number): OpResult {
  const safeRows = Math.min(Math.max(Math.floor(rows), 1), 20);
  const safeCols = Math.min(Math.max(Math.floor(cols), 1), 10);
  const spot = escapeListAt(model, at) ?? spotAtStream(model, at);
  if (!spot) {
    return UNCHANGED;
  }
  const table = document.createElement('table');
  const body = document.createElement('tbody');
  for (let r = 0; r < safeRows; r += 1) {
    const row = document.createElement('tr');
    for (let c = 0; c < safeCols; c += 1) {
      row.append(document.createElement('td'));
    }
    body.append(row);
  }
  table.append(body);
  const paragraph = document.createElement('div');
  paragraph.append(document.createElement('br'));
  const fragment = document.createDocumentFragment();
  fragment.append(table, paragraph);

  if (spot.kind === 'text') {
    const text = spot.node;
    const parent = (text.parentElement ?? model) as HTMLElement;
    if (spot.raw >= (text.nodeValue ?? '').length) {
      parent.insertBefore(fragment, text.nextSibling);
    } else if (spot.raw === 0) {
      parent.insertBefore(fragment, text);
    } else {
      const tail = text.splitText(spot.raw);
      parent.insertBefore(fragment, tail);
    }
  } else {
    const parent = spot.node;
    if (spot.childIndex >= parent.childNodes.length) {
      parent.append(fragment);
    } else {
      parent.insertBefore(fragment, parent.childNodes[spot.childIndex]!);
    }
  }
  const firstCell = table.querySelector('td');
  return {
    changed: true,
    intent: firstCell
      ? { spot: { kind: 'element', node: firstCell, childIndex: 0 } }
      : { preserve: true },
  };
}

/**
 * Runs a table structure operation at the given cell. The caller resolves
 * the cell from the live selection (an empty table holds no stream
 * positions — cell addressing is structural, not offset-based); the caret
 * follows the touched structure — same cell of the new row, the new
 * column's cell, the neighbor row after a delete — and the block after
 * the table when the table itself goes.
 */
export function runTableActionAt(
  model: HTMLElement,
  table: HTMLTableElement,
  cell: HTMLTableCellElement,
  action: string,
): OpResult {
  void model;
  const rows = Array.from(table.querySelectorAll('tr'));
  const rowIndex = rows.findIndex((row) => row.contains(cell));
  const row = rows[rowIndex] ?? null;
  if (!row) {
    return UNCHANGED;
  }
  const cellIndex = Array.prototype.indexOf.call(row.children, cell);

  const placeAt = (target: Element | null, index = 0): OpIntent =>
    target ? { spot: { kind: 'element', node: target, childIndex: index } } : { preserve: true };

  switch (action) {
    case 'row-above':
    case 'row-below': {
      const fresh = document.createElement('tr');
      for (let c = 0; c < row.children.length; c += 1) {
        fresh.append(document.createElement('td'));
      }
      row.insertAdjacentElement(action === 'row-above' ? 'beforebegin' : 'afterend', fresh);
      const target = fresh.children[cellIndex] ?? fresh.children[0] ?? null;
      return { changed: true, intent: placeAt(target, 0) };
    }
    case 'col-left':
    case 'col-right': {
      const offset = action === 'col-left' ? 0 : 1;
      for (const each of rows) {
        const insertion = document.createElement('td');
        each.children[cellIndex]?.insertAdjacentElement(
          offset === 0 ? 'beforebegin' : 'afterend',
          insertion,
        );
      }
      const target = row.children[cellIndex + offset] ?? null;
      return { changed: true, intent: placeAt(target, 0) };
    }
    case 'row-delete': {
      if (rows.length === 1) {
        return deleteTable(model, table);
      }
      const next = rows[rowIndex + 1] ?? rows[rowIndex - 1] ?? null;
      row.remove();
      const target = next?.children[cellIndex] ?? next?.children[0] ?? null;
      return { changed: true, intent: placeAt(target, 0) };
    }
    case 'col-delete': {
      if (row.children.length === 1) {
        return deleteTable(model, table);
      }
      for (const each of rows) {
        each.children[cellIndex]?.remove();
      }
      const clamped = Math.min(cellIndex, row.children.length - 1);
      const target = row.children[clamped] ?? null;
      return { changed: true, intent: placeAt(target, 0) };
    }
    case 'table-delete':
      return deleteTable(model, table);
    default:
      return UNCHANGED;
  }
}

function deleteTable(model: HTMLElement, table: HTMLElement): OpResult {
  const next = table.nextElementSibling;
  table.remove();
  const target = next ?? model;
  const intent: OpIntent = next
    ? { spot: { kind: 'element', node: next, childIndex: 0 } }
    : { preserve: true };
  void target;
  return { changed: true, intent };
}

/** The table + cell an offset sits in, or null. */
export function tableContextAt(
  model: HTMLElement,
  at: number,
): {
  table: HTMLTableElement;
  cell: HTMLTableCellElement;
  rows: number;
  cols: number;
  rowIndex: number;
  colIndex: number;
} | null {
  const spot = spotAtStream(model, at);
  if (!spot) {
    return null;
  }
  let el: HTMLElement | null = spotElement(spot);
  let cell: HTMLTableCellElement | null = null;
  while (el && el !== model) {
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      cell = el as HTMLTableCellElement;
      break;
    }
    el = el.parentElement;
  }
  if (!cell) {
    return null;
  }
  const table = cell.closest('table');
  if (!(table instanceof HTMLTableElement) || !model.contains(table)) {
    return null;
  }
  const rows = Array.from(table.querySelectorAll('tr'));
  const rowIndex = rows.findIndex((row) => row.contains(cell));
  if (rowIndex === -1) {
    return null;
  }
  const cols = rows[rowIndex]!.children.length;
  const colIndex = Array.prototype.indexOf.call(rows[rowIndex]!.children, cell);
  return {
    table,
    cell,
    rows: rows.length,
    cols,
    rowIndex,
    colIndex: colIndex === -1 ? 0 : colIndex,
  };
}

/** The block element a spot lives in, or null (root-level content). */
function spotBlock(spot: DomSpot): HTMLElement | null {
  let el: HTMLElement | null = spotElement(spot);
  while (el) {
    if (
      BLOCK_SIBLING_TAGS.has(el.tagName) ||
      el.tagName === 'LI' ||
      el.tagName === 'TD' ||
      el.tagName === 'TH'
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Escapes a list at the caret: when the spot sits inside a list item, the
 * return is a SPOT at the start of the block after the list (a fresh
 * paragraph appended after it when nothing usable follows); null when the
 * caret is not in a list. A spot, not an offset: the escape target is an
 * empty paragraph — zero stream — which offsets cannot address.
 */
function escapeListAt(model: HTMLElement, at: number): DomSpot | null {
  const start = spotAtStream(model, at);
  const item = start ? closestByTagFrom(start, 'li') : null;
  const list = item?.parentElement ?? null;
  if (!item || !list || (list.tagName !== 'UL' && list.tagName !== 'OL')) {
    return null;
  }
  let next = list.nextElementSibling;
  if (!next || !BLOCK_SIBLING_TAGS.has(next.tagName)) {
    const paragraph = document.createElement('div');
    paragraph.append(document.createElement('br'));
    list.parentElement?.insertBefore(paragraph, list.nextSibling);
    next = paragraph;
  }
  return { kind: 'element', node: next, childIndex: 0 };
}

function closestByTagFrom(spot: DomSpot, tag: 'li' | 'sup' | 'sub'): HTMLElement | null {
  const upper = tag.toUpperCase();
  let el: HTMLElement | null = spotElement(spot);
  while (el) {
    if (el.tagName === upper) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scripts — the collapsed-caret OFF direction.
// ---------------------------------------------------------------------------

/**
 * Splits the script wrappers around a collapsed caret: the content after
 * the caret exits every same-script ancestor (one level per pass, nested
 * chains repaired in one press), a zero-width guard text node lands
 * between the halves, and the caret sits past the guard — outside the
 * scripts, so typing continues plain.
 *
 * The guard is the load-bearing trick: a caret resting directly against a
 * script run's end is visually equivalent to a position inside the run's
 * end, and the browser's caret correction snaps it back in — the next
 * keystroke would rejoin the script (the compounding bug). The guard
 * breaks the equivalence; every text reader strips it.
 */
export function splitScriptChain(
  model: HTMLElement,
  at: number,
  tag: 'sup' | 'sub',
  oppositeTag: 'sup' | 'sub' | null,
): OpResult {
  let splitAny = false;
  let caret: DomSpot | null = null;
  for (let pass = 0; pass < 8; pass += 1) {
    // Each pass follows the guard the previous pass planted: the caret
    // MOVES one level up with every split, and re-resolving from the
    // original offset would re-split the same wrapper forever (the guard
    // contributes no stream, so the offset cannot see the escape).
    const spot = caret ?? spotAtStream(model, at);
    if (!spot) {
      break;
    }
    const wrapper = closestByTagFrom(spot, tag);
    if (!wrapper) {
      break;
    }
    const result = splitWrapperAt(spot, wrapper);
    if (!result) {
      break;
    }
    splitAny = true;
    caret = result;
  }
  if (oppositeTag) {
    const spot = caret ? spotFromGuard(caret) : spotAtStream(model, at);
    if (spot) {
      const opposite = closestByTagFrom(spot, oppositeTag);
      if (opposite) {
        const result = splitWrapperAt(spot, opposite);
        if (result) {
          splitAny = true;
          caret = result;
        }
      }
    }
  }
  return splitAny && caret ? { changed: true, intent: { spot: caret } } : UNCHANGED;
}

/** Re-resolves the spot from the guard node the split planted. */
function spotFromGuard(caret: DomSpot): DomSpot | null {
  return caret.kind === 'text' ? caret : null;
}

/**
 * Splits one wrapper at the caret: the content after the caret moves out
 * of the wrapper (before the wrapper's next sibling), a guard text node
 * lands between them, and the caret sits past the guard. Returns the
 * caret spot, or null when the split does not apply.
 */
function splitWrapperAt(spot: DomSpot, wrapper: HTMLElement): DomSpot | null {
  if (spot.kind !== 'text') {
    return null;
  }
  const parent = wrapper.parentNode;
  if (!parent) {
    return null;
  }
  const text = spot.node;
  if (!wrapper.contains(text)) {
    return null;
  }
  const from = spot.raw;
  const tail = document.createRange();
  tail.setStart(text, from);
  tail.setEnd(wrapper, wrapper.childNodes.length);
  const fragment = tail.extractContents();
  if (fragment.firstChild) {
    parent.insertBefore(fragment, wrapper.nextSibling);
  }
  const guard = document.createTextNode('\u200B');
  parent.insertBefore(guard, wrapper.nextSibling);
  return { kind: 'text', node: guard, raw: 1 };
}
