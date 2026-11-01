import { describe, expect, it } from 'vitest';
import { getFieldCaretPosition, resolveKeyburstLayer } from './typing-effects';

/**
 * Typing effects — layer resolution and caret measurement plumbing.
 *
 * The floating (PiP) window moves the editor into another DOCUMENT. The
 * burst layer must live in that same document (coordinates are per-window
 * viewport coordinates) and the caret must be read from that document's
 * view. These tests pin the document-routing contract without needing a
 * real PiP window (unavailable headless).
 */
describe('resolveKeyburstLayer', () => {
  it('creates the layer in the target document when the editor lives elsewhere', () => {
    // A second document, as the PiP window's document would be.
    const pipDoc = document.implementation.createHTMLDocument('floating');
    const editor = pipDoc.createElement('textarea');
    pipDoc.body.append(editor);

    const layer = resolveKeyburstLayer(editor, document);

    expect(layer).not.toBeNull();
    expect(layer!.ownerDocument).toBe(pipDoc);
    expect(pipDoc.getElementById('keyburstLayer')).toBe(layer);
    expect(layer!.getAttribute('aria-hidden')).toBe('true');
    // The main document must NOT have grown a stray layer for it.
    expect(document.querySelectorAll('#keyburstLayer').length).toBeLessThanOrEqual(1);
  });

  it('reuses the same layer on every keystroke — one per document', () => {
    const pipDoc = document.implementation.createHTMLDocument('floating');
    const editor = pipDoc.createElement('textarea');
    pipDoc.body.append(editor);

    const first = resolveKeyburstLayer(editor, document);
    const second = resolveKeyburstLayer(editor, document);
    expect(second).toBe(first);
    expect(pipDoc.querySelectorAll('#keyburstLayer').length).toBe(1);
  });

  it('uses an existing layer in the target document instead of duplicating', () => {
    const pipDoc = document.implementation.createHTMLDocument('floating');
    const existing = pipDoc.createElement('div');
    existing.id = 'keyburstLayer';
    pipDoc.body.append(existing);
    const editor = pipDoc.createElement('div');
    pipDoc.body.append(editor);

    expect(resolveKeyburstLayer(editor, document)).toBe(existing);
  });

  it('falls back to the given document for targets without one', () => {
    const layer = resolveKeyburstLayer(null, document);
    expect(layer).not.toBeNull();
    expect(layer!.ownerDocument).toBe(document);
  });

  it('routes a non-Node event target (contenteditable edge) to the fallback document', () => {
    const pipDoc = document.implementation.createHTMLDocument('floating');
    // An EventTarget that is NOT a Node — the layer must come from fallbackDoc.
    const plainTarget = new EventTarget();
    const layer = resolveKeyburstLayer(plainTarget, document);
    expect(layer!.ownerDocument).toBe(document);
    void pipDoc;
  });
});

describe('getFieldCaretPosition', () => {
  it('measures into the field\'s own document and leaves no mirror behind', () => {
    // A second document stands in for the PiP window's document: the
    // mirror div must be built and measured THERE, then removed.
    const pipDoc = document.implementation.createHTMLDocument('floating');
    const field = pipDoc.createElement('textarea');
    field.value = 'abc';
    pipDoc.body.append(field);

    const pos = getFieldCaretPosition(field);

    expect(pos).not.toBeNull();
    expect(pipDoc.body.querySelectorAll('div').length).toBe(0);
  });
});
