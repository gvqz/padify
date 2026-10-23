/**
 * The drawing note surface — the scaffold's claims, pinned.
 *
 * Two registries are in play and both must hold: the TYPE-keyed claim
 * (noteSurfaceFor answers the drawing surface for 'drawing' notes) and
 * the KIND layer's integrity ('tasks' notes keep the tasks surface; other
 * json types keep falling to the kind/opaque path). The card itself is
 * held to the opaque discipline — the note's bytes never enter the host,
 * capture answers null, and the projections read the model.
 */
import { describe, expect, it } from 'vitest';
import { DrawingNoteSurface } from './surface';
import { emptyDrawingScene, serializeDrawingScene } from './scene';
// The tasks surface registers itself for the 'json' kind at import time
// — importing it here is what makes the coexistence test honest.
import '../tasks/surface';
import { noteSurfaceFor, opaqueNoteSurface } from '../surface';

const surface = new DrawingNoteSurface();

const sceneWithElements = serializeDrawingScene({
  version: 1,
  savedAt: 1700000000000,
  elements: [{ id: 'a', type: 'rectangle' }],
  appState: { viewBackgroundColor: '#ffffff' },
});

describe('the registry claim', () => {
  it('drawing notes resolve to the drawing surface (type-keyed, ahead of the json kind)', () => {
    expect(noteSurfaceFor({ content: sceneWithElements, noteType: 'drawing' })).toBeInstanceOf(
      DrawingNoteSurface,
    );
  });

  it('tasks notes keep the tasks surface — two json types coexist', () => {
    const tasks = noteSurfaceFor({ content: '{"tasks":[]}', noteType: 'tasks' });
    expect(tasks).not.toBeInstanceOf(DrawingNoteSurface);
    expect(tasks.editable).toBe(true); // the tasks page, not a placeholder
  });

  it('an unknown json type stays opaque — this surface claims only ‘drawing’', () => {
    // 'kanban' is this test's stand-in for a future json type: the type
    // registry answers 'opaque' for ids it does not know, so the note
    // renders the opaque card directly and this surface never sees it.
    expect(noteSurfaceFor({ content: '{}', noteType: 'kanban' })).toBe(opaqueNoteSurface);
  });

  it('absent note types still resolve to the html surface (the default note)', () => {
    expect(noteSurfaceFor({ content: '<p>hi</p>' }).kind).toBe('html');
    expect(noteSurfaceFor(null).kind).toBe('html');
  });
});

describe('the scaffold state', () => {
  it('is display-only — the canvas ships with the next phase', () => {
    expect(surface.editable).toBe(false);
    expect(surface.kind).toBe('json');
  });
});

describe('display — the placeholder card', () => {
  it('paints the card with the scene summary when the content parses', () => {
    const host = document.createElement('div');
    surface.display(host, { content: sceneWithElements, noteType: 'drawing' });
    expect(host.getAttribute('contenteditable')).toBe('false');
    const card = host.querySelector('.unsupported-note');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.unsupported-note-title')!.textContent).toContain('Drawing');
    expect(card!.querySelector('.unsupported-note-body')!.textContent).toContain('1 element');
  });

  it('treats empty content as an empty drawing', () => {
    const host = document.createElement('div');
    surface.display(host, { content: '', noteType: 'drawing' });
    const body = host.querySelector('.unsupported-note-body')!;
    expect(body.textContent).toContain('empty');
  });

  it('explains a newer build’s scene instead of pretending to open it', () => {
    const host = document.createElement('div');
    surface.display(host, { content: '{"version":9,"elements":[', noteType: 'drawing' });
    const body = host.querySelector('.unsupported-note-body')!;
    expect(body.textContent).toContain('newer Padify');
  });

  it('paints nothing but clears the host when no note is open', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>old paint</p>';
    surface.display(host, null);
    expect(host.textContent).toBe('');
  });

  it('clear repaints the empty state without touching the model', () => {
    const host = document.createElement('div');
    surface.clear(host);
    expect(host.querySelector('.unsupported-note')).not.toBeNull();
  });
});

describe('capture — the opaque discipline', () => {
  it('answers null (the placeholder never writes the note)', () => {
    expect(surface.capture(document.createElement('div'))).toBeNull();
  });
});

describe('visibleText — the projection ships with the scaffold', () => {
  it('reads text elements as the note’s words', () => {
    const scene = serializeDrawingScene({
      version: 1,
      savedAt: 1,
      elements: [{ id: 't', type: 'text', text: 'sketch of the idea' }],
      appState: {},
    });
    expect(surface.visibleText(null, { content: scene, noteType: 'drawing' })).toBe(
      'sketch of the idea',
    );
  });

  it('reads empty drawings as empty', () => {
    expect(surface.visibleText(null, { content: '', noteType: 'drawing' })).toBe('');
    expect(
      surface.visibleText(null, {
        content: serializeDrawingScene(emptyDrawingScene()),
        noteType: 'drawing',
      }),
    ).toBe('');
  });

  it('reads unparseable bytes as their raw content — never the card’s copy', () => {
    expect(surface.visibleText(null, { content: 'raw bytes', noteType: 'drawing' })).toBe(
      'raw bytes',
    );
  });
});

describe('commit — snapshot restores repaint the card', () => {
  it('applies fresh bytes as a paint and leaves the persist to the caller', () => {
    const host = document.createElement('div');
    const applied = surface.commit(host, sceneWithElements);
    expect(applied).toBe(false);
    expect(host.querySelector('.unsupported-note-body')!.textContent).toContain('1 element');
  });
});
