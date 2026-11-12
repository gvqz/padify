import { describe, expect, it } from 'vitest';
import { drawingSceneThumb } from './thumb';

/** A scene envelope around raw elements (the format the canvas owns). */
function sceneWith(elements: object[], appState: object = {}): string {
  return JSON.stringify({ version: 1, savedAt: 0, elements, appState });
}

/** A rectangle the canvas might have saved. */
function rect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rect-1',
    type: 'rectangle',
    x: 100,
    y: 50,
    width: 80,
    height: 40,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'hachure',
    strokeWidth: 2,
    strokeStyle: 'solid',
    opacity: 100,
    ...overrides,
  };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('drawingSceneThumb — what declines a thumbnail', () => {
  it('junk, an empty scene, or a scene of only ghosts answers null', () => {
    expect(drawingSceneThumb('')).toBeNull();
    expect(drawingSceneThumb('not json at all')).toBeNull();
    expect(drawingSceneThumb('{"nope":true}')).toBeNull();
    expect(drawingSceneThumb(sceneWith([]))).toBeNull();
    expect(drawingSceneThumb(sceneWith([rect({ isDeleted: true })]))).toBeNull();
  });

  it('elements it cannot project (a newer canvas\u2019s kinds) answer null', () => {
    expect(drawingSceneThumb(sceneWith([{ id: 'f', type: 'frame', x: 0, y: 0 }]))).toBeNull();
  });
});

describe('drawingSceneThumb — the projection', () => {
  it('paints a rectangle inside a viewBox padded around the content', () => {
    const thumb = drawingSceneThumb(sceneWith([rect()]));
    expect(thumb).not.toBeNull();
    expect(thumb!.markup.startsWith('<svg')).toBe(true);
    // 100..180 by 50..90, padded 16 on every side.
    expect(thumb!.markup).toContain('viewBox="84 34 112 72"');
    expect(thumb!.markup).toContain('<rect');
    expect(thumb!.markup).toContain('stroke="#1e1e1e"');
    expect(thumb!.markup).toContain('fill="none"');
  });

  it('solid fill paints the background; hachure hatches it through a clip', () => {
    const solid = drawingSceneThumb(
      sceneWith([rect({ fillStyle: 'solid', backgroundColor: '#a5d8ff' })]),
    );
    expect(solid!.markup).toContain('fill="#a5d8ff"');
    expect(solid!.markup).not.toContain('clipPath');

    const hatch = drawingSceneThumb(sceneWith([rect({ backgroundColor: '#a5d8ff' })]));
    // The outline stays hollow…
    expect(hatch!.markup).toContain('fill="none"');
    // …and the fill speaks in faint lines through a clip of the shape.
    expect(hatch!.markup).toContain('clipPath');
    expect(hatch!.markup).toContain('stroke="#a5d8ff"');
    expect(hatch!.markup).toContain('<line');

    // Cross-hatch doubles the directions; hachure keeps one.
    const cross = drawingSceneThumb(
      sceneWith([rect({ backgroundColor: '#a5d8ff', fillStyle: 'cross-hatch' })]),
    );
    expect(count(cross!.markup, 'rotate(-41')).toBe(1);
    expect(count(cross!.markup, 'rotate(49')).toBe(1);
    expect(count(hatch!.markup, '<g clip-path')).toBe(1);
  });

  it('a freedraw stroke smooths into a path; a tap lands as a dot', () => {
    const stroke = drawingSceneThumb(
      sceneWith([
        {
          id: 'd1',
          type: 'draw',
          x: 10,
          y: 10,
          strokeColor: '#e03131',
          strokeWidth: 4,
          points: [
            [0, 0],
            [10, 5],
            [20, 0],
          ],
        },
      ]),
    );
    expect(stroke!.markup).toContain('<path');
    expect(stroke!.markup).toContain('Q ');
    expect(stroke!.markup).toContain('stroke="#e03131"');

    const tap = drawingSceneThumb(
      sceneWith([{ id: 'd2', type: 'draw', x: 5, y: 5, strokeColor: '#000000', points: [[0, 0]] }]),
    );
    expect(tap!.markup).toContain('<circle');
  });

  it('an arrow earns its heads — the vocabulary the canvas saves', () => {
    const base = {
      id: 'a1',
      type: 'arrow',
      x: 0,
      y: 0,
      strokeColor: '#1e1e1e',
      strokeWidth: 2,
      points: [
        [0, 0],
        [100, 0],
      ],
    };
    const triangle = drawingSceneThumb(sceneWith([{ ...base, endArrowhead: 'triangle' }]));
    expect(triangle!.markup).toContain('<polygon');

    // An open head stays strokes, not fills.
    const open = drawingSceneThumb(sceneWith([{ ...base, endArrowhead: 'arrow' }]));
    expect(open!.markup).toContain('<path');
    expect(open!.markup).not.toContain('<polygon');

    const dot = drawingSceneThumb(
      sceneWith([{ ...base, endArrowhead: 'dot', startArrowhead: null }]),
    );
    expect(dot!.markup).toContain('<circle');
  });

  it('text paints its words, escaped, in its ink and alignment', () => {
    const thumb = drawingSceneThumb(
      sceneWith([
        {
          id: 't1',
          type: 'text',
          x: 0,
          y: 0,
          width: 120,
          height: 25,
          text: 'hello & <world>',
          fontSize: 20,
          strokeColor: '#087f5b',
          textAlign: 'left',
        },
      ]),
    );
    expect(thumb!.markup).toContain('hello &amp; &lt;world&gt;');
    expect(thumb!.markup).toContain('fill="#087f5b"');
    expect(thumb!.markup).toContain('text-anchor="start"');
    // Centered text centers; mono speaks monospace.
    const centered = drawingSceneThumb(
      sceneWith([
        {
          id: 't2',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 20,
          text: 'mid',
          fontSize: 16,
          textAlign: 'center',
        },
      ]),
    );
    expect(centered!.markup).toContain('text-anchor="middle"');
    const mono = drawingSceneThumb(
      sceneWith([
        {
          id: 't3',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 20,
          text: 'x = 1',
          fontSize: 16,
          fontFamily: 3,
        },
      ]),
    );
    expect(mono!.markup).toContain('font-family="monospace"');
  });

  it('a container-bound label wraps by its box, not its raw line', () => {
    const thumb = drawingSceneThumb(
      sceneWith([
        {
          id: 't4',
          type: 'text',
          x: 0,
          y: 0,
          width: 60,
          height: 60,
          text: 'one two three four five six',
          fontSize: 10,
          containerId: 'box-1',
        },
      ]),
    );
    // One raw line, wrapped to several tspans by the 60px box.
    expect(count(thumb!.markup, '<tspan')).toBeGreaterThan(1);
  });

  it('rotation turns the element and grows the bounds it occupies', () => {
    const flat = drawingSceneThumb(sceneWith([rect()]));
    const turned = drawingSceneThumb(sceneWith([rect({ angle: Math.PI / 4 })]));
    expect(turned!.markup).toContain('transform="rotate(45');
    const flatBox = flat!.markup.match(/viewBox="([^"]+)"/)![1];
    const turnedBox = turned!.markup.match(/viewBox="([^"]+)"/)![1];
    expect(Number(turnedBox.split(' ')[2])).toBeGreaterThan(Number(flatBox.split(' ')[2]));
    expect(Number(turnedBox.split(' ')[3])).toBeGreaterThan(Number(flatBox.split(' ')[3]));
  });

  it('opacity dresses the element; the dashed and dotted dialects ride', () => {
    const dim = drawingSceneThumb(sceneWith([rect({ opacity: 40 })]));
    expect(dim!.markup).toContain('<g opacity="0.4">');
    const dashed = drawingSceneThumb(sceneWith([rect({ strokeStyle: 'dashed' })]));
    expect(dashed!.markup).toContain('stroke-dasharray');
    const dotted = drawingSceneThumb(sceneWith([rect({ strokeStyle: 'dotted' })]));
    expect(dotted!.markup).toContain('stroke-dasharray');
  });

  it('the scene\u2019s canvas color rides along as the page\u2019s paper', () => {
    const dark = drawingSceneThumb(sceneWith([rect()], { viewBackgroundColor: '#282828' }));
    expect(dark!.background).toBe('#282828');
    const unset = drawingSceneThumb(sceneWith([rect()]));
    expect(unset!.background).toBeNull();
    const junk = drawingSceneThumb(sceneWith([rect()], { viewBackgroundColor: 'url(#steal)' }));
    expect(junk!.background).toBeNull();
  });
});

describe('drawingSceneThumb — hostile scenes choose geometry, nothing else', () => {
  it('colors that are not hex fall back instead of injecting', () => {
    const thumb = drawingSceneThumb(
      sceneWith([rect({ strokeColor: 'javascript:alert(1)', backgroundColor: 'url(#x)' })]),
    );
    expect(thumb!.markup).toContain('stroke="#1e1e1e"');
    expect(thumb!.markup).not.toContain('javascript:');
    expect(thumb!.markup).not.toContain('url(');
  });

  it('text with quotes and tags stays escaped', () => {
    const thumb = drawingSceneThumb(
      sceneWith([
        {
          id: 'evil',
          type: 'text',
          x: 0,
          y: 0,
          width: 50,
          height: 20,
          text: '"onmouseover="alert(1)',
          fontSize: 12,
        },
      ]),
    );
    expect(thumb!.markup).toContain('&quot;onmouseover=&quot;');
    expect(thumb!.markup).not.toContain('"onmouseover="alert');
  });

  it('dimensions that are not numbers fall back, never NaN', () => {
    const thumb = drawingSceneThumb(sceneWith([rect({ x: 'nope', y: Number.NaN, angle: 'lots' })]));
    expect(thumb).not.toBeNull();
    expect(thumb!.markup).not.toContain('NaN');
    // A zero-sized shape declines honestly — it has no page to paint.
    const degenerate = drawingSceneThumb(sceneWith([rect({ width: Infinity })]));
    expect(degenerate).toBeNull();
  });

  it('the element cap keeps a pathological scene thumbnail-sized', () => {
    const many = Array.from({ length: 700 }, (_, i) =>
      rect({ id: `r${i}`, x: i * 5, y: 0, backgroundColor: 'transparent' }),
    );
    const thumb = drawingSceneThumb(sceneWith(many));
    expect(count(thumb!.markup, '<rect')).toBe(600);
  });
});
