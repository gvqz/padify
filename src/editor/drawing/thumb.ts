/**
 * Scene thumbnails — a drawing's page for the History sheet's card
 * gallery, painted WITHOUT the canvas.
 *
 * The canvas island is a lazy chunk by design (React + Excalidraw join
 * the app only when a drawing note opens — see canvas.ts), and the
 * History sheet must never be the door they sneak through: a trash
 * browser that costs 1–2 MB is a trash browser nobody asked for. So
 * this module projects the stored scene itself — the same Generation-2
 * envelope the canvas round-trips — into a static inline SVG:
 * thumbnail-grade, vendor-free, pure (string in, markup out).
 *
 * THE PROJECTION is honest, not exact. roughjs wobbles are dropped (a
 * thumbnail wants the geometry, and a hand-drawn line reads as a line);
 * hachure and cross-hatch fills come back as clipped hatch lines at the
 * roughjs angle; text wraps by estimated metrics instead of the canvas's
 * measured ones. Everything else is the scene as it was drawn: element
 * order (painter's), rotation, opacity, stroke style and width, the
 * arrowhead vocabulary, and the canvas's own background color — a
 * document previews as itself, not as the UI's theme.
 *
 * SECURITY: the markup this module emits is the ONE trusted non-plain
 * payload a SheetRowModel can carry (see SheetThumb in ui/sheet-kit.ts).
 * The trust is earned here, at build time: every string the scene
 * supplies — text content, colors — is XML-escaped or validated against
 * a strict hex pattern before it is embedded; every number is coerced
 * through a finite-or-fallback read. A hostile scene can choose its
 * geometry, nothing else.
 */

import { parseDrawingScene, type DrawingSceneElement } from './scene';

/** What the gallery card paints a drawing grave's page with. */
export interface DrawingThumb {
  /** A complete inline `<svg>` — viewBox-sized to the scene's content,
   *  aspect-preserving, aria-hidden by its host. */
  markup: string;
  /** The scene's own canvas color, validated hex — the page's paper
   *  behind the drawing. Null when the scene set none (or set junk):
   *  the card's default paper stands in. */
  background: string | null;
}

/** Rendered elements per thumbnail. A pathological scene must not turn
 *  one card into a thousand nodes; the first cap (paint order — the
 *  order the canvas itself composes in) renders and the rest dissolve.
 *  Real scenes sit 1–2 orders of magnitude below the line. */
const THUMB_ELEMENT_CAP = 600;

/** Breathing room around the content, in scene units — the same idea
 *  as the canvas's own export padding, a touch wider: a thumbnail
 *  shares its card with chrome on every side, and a drawing pressed
 *  against its own paper's edge reads as cropped, not composed (the
 *  audit's one finding worth keeping). */
const THUMB_PADDING = 16;

/** Excalidraw's text line height — the vertical rhythm of tspans. */
const THUMB_LINE_HEIGHT = 1.25;

/** roughjs hatches at -41°; cross-hatch adds the perpendicular. */
const HATCH_ANGLE = -41;

/** Hatch gap/weight, in scene units — faint lines, the way a hachure
 *  reads at a glance (a solid slab of fill would shout). */
const HATCH_GAP = 8;
const HATCH_WEIGHT = 1;

/** The arrowhead's reach before clamps — Excalidraw keeps a floor so a
 *  thin arrow still points, and a ceiling so a fat one stays a head. */
const ARROW_MIN = 20;
const ARROW_MAX = 40;

/** The arrowhead's flare (half-angle, degrees) — matched by eye. */
const ARROW_FLARE = 30;

// ---------------------------------------------------------------------------
// Safe reads — every scene-supplied value crosses one of these
// ---------------------------------------------------------------------------

/** A finite number, or the fallback. NaN/Infinity/absent never render. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** XML-escapes the five characters markup cares about. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Hex colors only (#rgb … #rrggbbaa) — the canvas palette is hex, so
 *  anything else (a hand-edited `url(…)`, a `javascript:` string) is
 *  not a color this scene ever owned. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A valid hex color, or null. */
function colorOpt(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed : null;
}

/** Rounds to 2 decimals — keeps the markup compact without letting
 *  floating-point dust become attributes. */
function r2(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? String(rounded) : '0';
}

/** One scene element, read as the loose record it is. */
type Element = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The AABB a rotated element truly occupies — rotation is around the
 *  element's own center (the canvas's one rule), so the corners rotate
 *  and the union re-bounds them. */
function rotatedBounds(bounds: Bounds, angle: number): Bounds {
  if (!angle) {
    return bounds;
  }
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: [number, number][] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of corners) {
    const dx = px - cx;
    const dy = py - cy;
    const x = cx + dx * cos - dy * sin;
    const y = cy + dx * sin + dy * cos;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Valid absolute points of a linear element (line/arrow/draw), with
 *  the element's own origin folded in. Junk entries drop away. */
function linearPoints(el: Element): [number, number][] {
  const ox = num(el.x, 0);
  const oy = num(el.y, 0);
  const raw = el.points;
  if (!Array.isArray(raw)) {
    return [];
  }
  const points: [number, number][] = [];
  for (const entry of raw) {
    if (
      Array.isArray(entry) &&
      typeof entry[0] === 'number' &&
      Number.isFinite(entry[0]) &&
      typeof entry[1] === 'number' &&
      Number.isFinite(entry[1])
    ) {
      points.push([ox + entry[0], oy + entry[1]]);
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Paint vocabulary
// ---------------------------------------------------------------------------

/** The stroke every shaped element speaks: color, width, caps, and the
 *  dash dialect (the canvas's solid/dashed/dotted trinity). */
function strokeAttrs(el: Element, fallbackWidth: number): string {
  const width = Math.max(0.5, num(el.strokeWidth, fallbackWidth));
  let attrs = ` stroke="${esc(colorOpt(el.strokeColor) ?? '#1e1e1e')}"`;
  attrs += ` stroke-width="${r2(width)}" stroke-linecap="round" stroke-linejoin="round"`;
  const style = el.strokeStyle;
  if (style === 'dashed') {
    attrs += ` stroke-dasharray="${r2(Math.max(4, width * 3))} ${r2(Math.max(3, width * 2))}"`;
  } else if (style === 'dotted') {
    attrs += ` stroke-dasharray="${r2(Math.max(1, width * 0.6))} ${r2(Math.max(2.5, width * 1.8))}"`;
  }
  return attrs;
}

/** The ink color as a validated attribute value (text fills with its
 *  stroke color — the canvas's one exception to stroke-owns-the-line). */
function inkColor(el: Element): string {
  return esc(colorOpt(el.strokeColor) ?? '#1e1e1e');
}

/** Clip ids must be unique across every card the sheet paints — a
 *  module counter hands each thumbnail its own namespace. */
let clipSeq = 0;

/** Hatch lines through `clip` (a shape tag) in the fill color — the
 *  hachure/cross-hatch family. One direction for hachure; the
 *  perpendicular too for cross-hatch. */
function hatchFill(clip: string, box: Bounds, fill: string, cross: boolean): string {
  const id = `thumb-clip-${++clipSeq}`;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const reach = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2 + HATCH_GAP;
  const directions = cross ? [HATCH_ANGLE, HATCH_ANGLE + 90] : [HATCH_ANGLE];
  const groups = directions
    .map((angle) => {
      const lines: string[] = [];
      for (let y = cy - reach; y <= cy + reach + HATCH_GAP; y += HATCH_GAP) {
        lines.push(
          `<line x1="${r2(cx - reach)}" y1="${r2(y)}" x2="${r2(cx + reach)}" y2="${r2(y)}"/>`,
        );
      }
      return `<g transform="rotate(${r2(angle)} ${r2(cx)} ${r2(cy)})">${lines.join('')}</g>`;
    })
    .join('');
  return (
    `<clipPath id="${id}">${clip}</clipPath>` +
    `<g clip-path="url(#${id})" stroke="${esc(fill)}" stroke-width="${r2(HATCH_WEIGHT)}">${groups}</g>`
  );
}

/** A closed shape (rect/diamond/ellipse) with its fill discipline:
 *  transparent → outline only; solid → painted; the hachure family →
 *  outline plus faint hatch through a clip. `outline` and `clip` are
 *  the same shape tag (geometry only — this adds the paint). */
function closedShape(el: Element, tag: string, box: Bounds): string {
  const fill = colorOpt(el.backgroundColor);
  if (fill === null) {
    return `<${tag} fill="none"${strokeAttrs(el, 2)}/>`;
  }
  if (el.fillStyle === 'solid') {
    return `<${tag} fill="${esc(fill)}"${strokeAttrs(el, 2)}/>`;
  }
  // hachure | cross-hatch | zigzag (zigzag reads as hachure at
  // thumbnail scale — the rhythm, not the weave, is the information).
  return (
    hatchFill(`<${tag}/>`, box, fill, el.fillStyle === 'cross-hatch') +
    `<${tag} fill="none"${strokeAttrs(el, 2)}/>`
  );
}

/** A corner-radius for rounded rectangles — adaptive (proportional, the
 *  canvas's default) or fixed (the legacy value it stored). */
function cornerRadius(el: Element, width: number, height: number): number {
  const roundness = el.roundness;
  if (!roundness || typeof roundness !== 'object') {
    return 0;
  }
  const record = roundness as Record<string, unknown>;
  const value = num(record.value, NaN);
  if (record.type === 1 && Number.isFinite(value)) {
    return value;
  }
  return 0.25 * Math.min(width, height);
}

/** An arrowhead at `tip`, pointing outward along the unit vector
 *  `dir`. The four heads the canvas can save, in the stroke's color. */
function arrowhead(
  el: Element,
  tip: [number, number],
  dir: [number, number],
  kind: unknown,
  segment: number,
): string {
  if (kind !== 'arrow' && kind !== 'triangle' && kind !== 'dot' && kind !== 'bar') {
    return '';
  }
  const width = Math.max(0.5, num(el.strokeWidth, 2));
  // The head never outgrows its segment — a stub arrow keeps a head it
  // can carry (the canvas shrinks the same way).
  const reach = Math.min(Math.max(ARROW_MIN, 3 * width), ARROW_MAX, Math.max(4, segment * 0.6));
  const flare = (ARROW_FLARE * Math.PI) / 180;
  const cos = Math.cos(flare);
  const sin = Math.sin(flare);
  const back1: [number, number] = [
    tip[0] - reach * (dir[0] * cos - dir[1] * sin),
    tip[1] - reach * (dir[0] * sin + dir[1] * cos),
  ];
  const back2: [number, number] = [
    tip[0] - reach * (dir[0] * cos + dir[1] * sin),
    tip[1] - reach * (dir[0] * sin - dir[1] * cos),
  ];
  const ink = inkColor(el);
  if (kind === 'triangle') {
    return (
      `<polygon points="${r2(tip[0])},${r2(tip[1])} ${r2(back1[0])},${r2(back1[1])} ` +
      `${r2(back2[0])},${r2(back2[1])}" fill="${ink}" stroke="${ink}" ` +
      `stroke-width="${r2(width)}" stroke-linejoin="round"/>`
    );
  }
  if (kind === 'dot') {
    const radius = Math.max(2, width * 2);
    return `<circle cx="${r2(tip[0])}" cy="${r2(tip[1])}" r="${r2(radius)}" fill="${ink}"/>`;
  }
  if (kind === 'bar') {
    const half = Math.max(6, width * 2.5);
    return (
      `<line x1="${r2(tip[0] - dir[1] * half)}" y1="${r2(tip[1] + dir[0] * half)}" ` +
      `x2="${r2(tip[0] + dir[1] * half)}" y2="${r2(tip[1] - dir[0] * half)}"` +
      strokeAttrs(el, 2) +
      '/>'
    );
  }
  // 'arrow' — the open V.
  return (
    `<path d="M ${r2(back1[0])} ${r2(back1[1])} L ${r2(tip[0])} ${r2(tip[1])} ` +
    `L ${r2(back2[0])} ${r2(back2[1])}" fill="none"${strokeAttrs(el, 2)}/>`
  );
}

/** Greedy word wrap by estimated metrics — the container-bound label's
 *  approximation (the canvas measures; a thumbnail estimates). Words
 *  longer than the box overflow rather than break mid-word: a thumbnail
 *  that hyphenates lies worse than one that runs wide. */
function wrapEstimate(text: string, width: number, fontSize: number, mono: boolean): string[] {
  const perChar = fontSize * (mono ? 0.6 : 0.52);
  const budget = Math.max(1, Math.floor(width / perChar));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line === '') {
      line = word;
    } else if ((line + ' ' + word).length <= budget) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '' || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

/** One text element — tspans on the element's own baseline rhythm,
 *  anchored by its alignment, in its ink. Mono is the one family a
 *  thumbnail can promise (the canvas's code family); every other
 *  family inherits the app's own face and stays theme-native. */
function textShape(el: Element): { markup: string; lines: string[] } | null {
  const raw = typeof el.text === 'string' ? el.text : '';
  if (raw.trim() === '') {
    return null;
  }
  const x = num(el.x, 0);
  const y = num(el.y, 0);
  const width = Math.max(0, num(el.width, 0));
  const fontSize = Math.max(1, num(el.fontSize, 20));
  const mono = el.fontFamily === 3;
  const wrapped =
    typeof el.containerId === 'string' && el.containerId !== '' && width > 0 && !raw.includes('\n');
  const lines = wrapped ? wrapEstimate(raw, width, fontSize, mono) : raw.split('\n');
  // The first baseline: the canvas stores it when it measured one;
  // otherwise ~one em down from the top is the honest guess.
  const baseline = num(el.baseline, fontSize);
  const align = el.textAlign;
  const anchorX =
    align === 'center' ? x + width / 2 : align === 'right' || align === 'end' ? x + width : x;
  const anchor =
    align === 'center' ? 'middle' : align === 'right' || align === 'end' ? 'end' : 'start';
  const tspans = lines
    .map((line, index) => {
      const body = esc(line) === '' ? '\u00a0' : esc(line);
      return (
        `<tspan x="${r2(anchorX)}" y="${r2(y + baseline + index * fontSize * THUMB_LINE_HEIGHT)}">` +
        `${body}</tspan>`
      );
    })
    .join('');
  const family = mono ? ' font-family="monospace"' : '';
  const markup =
    `<text${family} font-size="${r2(fontSize)}" text-anchor="${anchor}" ` +
    `fill="${inkColor(el)}">${tspans}</text>`;
  return { markup, lines };
}

// ---------------------------------------------------------------------------
// One element → shapes + bounds
// ---------------------------------------------------------------------------

interface Painted {
  markup: string;
  bounds: Bounds;
}

function renderElement(el: Element): Painted | null {
  const type = el.type;
  const x = num(el.x, 0);
  const y = num(el.y, 0);
  const width = Math.max(0, num(el.width, 0));
  const height = Math.max(0, num(el.height, 0));
  const angle = num(el.angle, 0);

  if (type === 'rectangle' || type === 'image') {
    if (width <= 0 || height <= 0) {
      return null;
    }
    const box = { minX: x, minY: y, maxX: x + width, maxY: y + height };
    // An image element cannot resolve (its bits never persisted — the
    // scene keeps vectors only), but it still OWNS its rectangle: a
    // dashed placeholder keeps the layout honest.
    const markup =
      type === 'image'
        ? `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(width)}" height="${r2(height)}" fill="none" stroke="#a1a1aa" stroke-width="1" stroke-dasharray="4 4"/>`
        : closedShape(
            el,
            `rect x="${r2(x)}" y="${r2(y)}" width="${r2(width)}" height="${r2(height)}" rx="${r2(cornerRadius(el, width, height))}"`,
            box,
          );
    return wrap(el, markup, box, angle);
  }

  if (type === 'ellipse') {
    if (width <= 0 || height <= 0) {
      return null;
    }
    const box = { minX: x, minY: y, maxX: x + width, maxY: y + height };
    const tag =
      `ellipse cx="${r2(x + width / 2)}" cy="${r2(y + height / 2)}" ` +
      `rx="${r2(width / 2)}" ry="${r2(height / 2)}"`;
    return wrap(el, closedShape(el, tag, box), box, angle);
  }

  if (type === 'diamond') {
    if (width <= 0 || height <= 0) {
      return null;
    }
    const box = { minX: x, minY: y, maxX: x + width, maxY: y + height };
    const cx = x + width / 2;
    const cy = y + height / 2;
    const tag =
      `polygon points="${r2(cx)},${r2(y)} ${r2(x + width)},${r2(cy)} ` +
      `${r2(cx)},${r2(y + height)} ${r2(x)},${r2(cy)}"`;
    return wrap(el, closedShape(el, tag, box), box, angle);
  }

  if (type === 'line' || type === 'arrow' || type === 'draw') {
    const points = linearPoints(el);
    if (points.length === 0) {
      return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    const box = { minX, minY, maxX, maxY };
    const markup =
      points.length === 1
        ? // A tap — the canvas paints a dot; so does the thumbnail.
          `<circle cx="${r2(points[0][0])}" cy="${r2(points[0][1])}" r="${r2(Math.max(0.5, num(el.strokeWidth, 2) / 2))}" fill="${inkColor(el)}"/>`
        : freedrawOrLinear(el, points);
    return wrap(el, markup, box, angle);
  }

  if (type === 'text') {
    const painted = textShape(el);
    if (painted === null) {
      return null;
    }
    const textHeight = Math.max(
      num(el.height, 0),
      painted.lines.length * num(el.fontSize, 20) * THUMB_LINE_HEIGHT,
    );
    const box = {
      minX: x,
      minY: y,
      maxX: x + Math.max(0, num(el.width, 0)),
      maxY: y + textHeight,
    };
    return wrap(el, painted.markup, box, angle);
  }

  // Frames and whatever a newer canvas invents: no projection, no
  // bounds — the thumbnail stays a summary of what it understands.
  return null;
}

/** A freedraw stroke becomes a smoothed path (quadratics through
 *  midpoints — the same idea the canvas's own simplification keeps);
 *  lines and arrows stay honest polylines, arrows wearing their heads. */
function freedrawOrLinear(el: Element, points: [number, number][]): string {
  const stroke = strokeAttrs(el, 2);
  if (el.type === 'draw') {
    let d = `M ${r2(points[0][0])} ${r2(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      d += ` Q ${r2(ax)} ${r2(ay)} ${r2((ax + bx) / 2)} ${r2((ay + by) / 2)}`;
    }
    const last = points[points.length - 1];
    d += ` L ${r2(last[0])} ${r2(last[1])}`;
    return `<path d="${d}" fill="none"${stroke}/>`;
  }
  let d = `M ${r2(points[0][0])} ${r2(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${r2(points[i][0])} ${r2(points[i][1])}`;
  }
  let markup = `<path d="${d}" fill="none"${stroke}/>`;
  if (el.type === 'arrow') {
    const first = points[0];
    const second = points[1];
    const last = points[points.length - 1];
    const before = points[points.length - 2];
    const unit = (from: [number, number], to: [number, number]): [number, number] => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      return length === 0 ? [1, 0] : [dx / length, dy / length];
    };
    const startDir = unit(second, first);
    const endDir = unit(before, last);
    markup += arrowhead(
      el,
      first,
      startDir,
      el.startArrowhead,
      Math.hypot(second[0] - first[0], second[1] - first[1]),
    );
    markup += arrowhead(
      el,
      last,
      endDir,
      el.endArrowhead,
      Math.hypot(last[0] - before[0], last[1] - before[1]),
    );
  }
  return markup;
}

/** Rotation and opacity dress the element; the bounds re-rotate. */
function wrap(el: Element, markup: string, box: Bounds, angle: number): Painted {
  let out = markup;
  if (angle) {
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    out = `<g transform="rotate(${r2((angle * 180) / Math.PI)} ${r2(cx)} ${r2(cy)})">${out}</g>`;
  }
  const opacity = num(el.opacity, 100);
  if (opacity < 100) {
    out = `<g opacity="${r2(Math.max(0, opacity / 100))}">${out}</g>`;
  }
  return { markup: out, bounds: rotatedBounds(box, angle) };
}

// ---------------------------------------------------------------------------
// The thumbnail
// ---------------------------------------------------------------------------

/**
 * Projects a stored scene into a card page. Null when there is nothing
 * a thumbnail can honestly show: unparseable content (a newer build's
 * payload stays opaque), an empty scene, or a scene whose every element
 * is a deleted ghost — the caller falls back to the ruled-lines page
 * (the readable projection already speaks those cases).
 */
export function drawingSceneThumb(content: string): DrawingThumb | null {
  const scene = parseDrawingScene(content);
  if (scene === null) {
    return null;
  }
  const visible: Element[] = [];
  for (const element of scene.elements as DrawingSceneElement[]) {
    if (
      element &&
      typeof element === 'object' &&
      (element as { isDeleted?: boolean }).isDeleted !== true
    ) {
      visible.push(element as Element);
    }
  }
  if (visible.length === 0) {
    return null;
  }

  const shapes: string[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const cap = Math.min(visible.length, THUMB_ELEMENT_CAP);
  for (let i = 0; i < cap; i++) {
    const painted = renderElement(visible[i]);
    if (painted === null) {
      continue;
    }
    if (painted.markup !== '') {
      shapes.push(painted.markup);
    }
    minX = Math.min(minX, painted.bounds.minX);
    minY = Math.min(minY, painted.bounds.minY);
    maxX = Math.max(maxX, painted.bounds.maxX);
    maxY = Math.max(maxY, painted.bounds.maxY);
  }
  if (shapes.length === 0 || !Number.isFinite(minX)) {
    return null;
  }

  const width = Math.max(1, maxX - minX + THUMB_PADDING * 2);
  const height = Math.max(1, maxY - minY + THUMB_PADDING * 2);
  const originX = minX - THUMB_PADDING;
  const originY = minY - THUMB_PADDING;
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(originX)} ${r2(originY)} ` +
    `${r2(width)} ${r2(height)}" preserveAspectRatio="xMidYMid meet" focusable="false">` +
    `${shapes.join('')}</svg>`;

  return { markup, background: colorOpt(scene.appState.viewBackgroundColor) };
}
