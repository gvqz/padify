import { afterEach, describe, expect, it } from 'vitest';
import { noteContentIsEmpty, shareUrlFor } from './share';
import {
  DRAWING_SCENE_VERSION,
  emptyDrawingScene,
  serializeDrawingScene,
} from '../editor/drawing/scene';
import type { DrawingScene } from '../editor/drawing/scene';
import { serializeTaskNoteContent, emptyTaskNoteContent } from '../editor/tasks/content';

// The share link must live NEXT TO the app, wherever the host mounts it:
// a root deploy serves /share/?t=…, a subpath deploy (alwaysdata-style
// shared domains) serves /padify/share/?t=…. Building it from the origin
// instead of the document is the regression these pin out.

// noteContentIsEmpty rides the same module because it is the modal's
// other gate: the blank note a fresh tab or a delete-all leaves behind
// must never become a link. Its rules are per-kind (html projection,
// task list model, drawing scene), pinned here so a new kind cannot
// quietly regress the others' emptiness answers.

const navigate = (path: string): void => {
  window.history.replaceState(null, '', path);
};

describe('shareUrlFor', () => {
  afterEach(() => {
    navigate('/');
  });

  it('links the viewer next to the app at the domain root', () => {
    navigate('/index.html');

    expect(shareUrlFor('abc123')).toBe(`${window.location.origin}/share/?t=abc123`);
  });

  it('keeps subpath deployments inside the subpath', () => {
    navigate('/padify/index.html');

    expect(shareUrlFor('tok')).toBe(`${window.location.origin}/padify/share/?t=tok`);
  });

  it('resolves from a directory URL without index.html', () => {
    navigate('/padify/');

    expect(shareUrlFor('t')).toBe(`${window.location.origin}/padify/share/?t=t`);
  });

  it('drops the query the page URL carries so links stay clean', () => {
    navigate('/?utm=campaign');

    expect(shareUrlFor('t1')).toBe(`${window.location.origin}/share/?t=t1`);
  });

  it('encodes the token so it cannot smuggle extra parameters', () => {
    navigate('/');

    expect(shareUrlFor('a b&c=d')).toBe(`${window.location.origin}/share/?t=a+b%26c%3Dd`);
  });
});

// ---------------------------------------------------------------------------
// noteContentIsEmpty — the empty-note refusal, per kind
// ---------------------------------------------------------------------------

describe('noteContentIsEmpty', () => {
  it('html kinds read their text projection — markup alone is emptiness', () => {
    expect(noteContentIsEmpty('')).toBe(true);
    expect(noteContentIsEmpty('<p><br></p>')).toBe(true);
    expect(noteContentIsEmpty('<p>hello</p>', 'rich')).toBe(false);
    // Absent type = the default (standard) note.
    expect(noteContentIsEmpty('<p>hello</p>', null)).toBe(false);
  });

  it('task lists read their parsed model — an empty list is not a share', () => {
    expect(noteContentIsEmpty(serializeTaskNoteContent(emptyTaskNoteContent()), 'tasks')).toBe(
      true,
    );
    const withOne = emptyTaskNoteContent();
    withOne.tasks.push({
      id: 't-1',
      title: 'call the dentist',
      notes: '',
      completed: false,
      completedAt: '',
      dueDate: '',
      reminderAt: '',
      reminderNotifiedAt: '',
      flagged: false,
      priority: 'none',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      sortOrder: 0,
    });
    expect(noteContentIsEmpty(serializeTaskNoteContent(withOne), 'tasks')).toBe(false);
  });

  it('drawings read their scene — a never-drawn note and a cleared canvas are both empty', () => {
    // A brand-new drawing note: content '' until the first real edit.
    expect(noteContentIsEmpty('', 'drawing')).toBe(true);
    // The cleared-canvas envelope a canvas build writes: real JSON bytes,
    // nothing worth a link.
    expect(noteContentIsEmpty(serializeDrawingScene(emptyDrawingScene()), 'drawing')).toBe(true);
  });

  it('a drawing with elements is a share — the viewer shows the raw scene text', () => {
    const scene: DrawingScene = {
      version: DRAWING_SCENE_VERSION,
      savedAt: 1700000000000,
      elements: [{ id: 'el-1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
      appState: {},
    };
    expect(noteContentIsEmpty(serializeDrawingScene(scene), 'drawing')).toBe(false);
  });

  it('a scene this build cannot parse stays shareable — refusing to understand never blocks sharing', () => {
    // A newer build's format: real content, opaque bytes here. The share
    // viewer renders non-html kinds as raw text, so the link is honest.
    expect(noteContentIsEmpty('{"version":9,"elements":', 'drawing')).toBe(false);
    expect(noteContentIsEmpty('not json at all', 'drawing')).toBe(false);
  });
});
