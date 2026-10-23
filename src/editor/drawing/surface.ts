/**
 * The drawing note surface — the scaffold for noteType 'drawing'.
 *
 * WHAT THIS BUILD SHOWS. A drawing note opens as a display-only card: the
 * scene is stored safely and syncs untouched, and the Excalidraw canvas
 * that will own this host ships with the next phase (see
 * docs/DRAWINGPAD_PLAN.md). The card follows the opaque surface's
 * discipline exactly — contenteditable off, the note's bytes never enter
 * the editor DOM, capture() answers null — with drawing-specific copy and
 * a scene summary (element count, last-saved) when the content parses.
 *
 * WHY A TYPE-KEYED CLAIM, NOT THE 'json' KIND. 'tasks' and 'drawing' are
 * both 'json' notes; the tasks surface owns the kind, so this surface
 * claims the TYPE through registerNoteSurfaceForType — the kind layer
 * stays the default for every other json type, and an old build that has
 * never imported this module renders drawings through the opaque fallback
 * (bytes safe, exactly the same story).
 *
 * WHAT PHASE 2 REPLACES HERE (the plan's contract, kept in one place):
 *  - editable flips true; display() mounts the canvas inside the host
 *    (contenteditable stays false — the canvas is the editable) and
 *    feed it the parsed scene as initialData;
 *  - every user mutation announces through ONE bubbling `input` event on
 *    the host (autosave/word-pill/save-indicator all follow it), with a
 *    300ms trailing-debounce autosave that swallows quota failures;
 *  - capture() returns the live serialized scene; commit()/clear()
 *    repaint from fresh bytes (clear = the confirmed destructive action
 *    the Gen-2 pad kept — a Padify confirm, never the vendor's);
 *  - focusTarget() answers the canvas mount; dismiss() disposes it
 *    (bind through an AbortController — CONTRIBUTING's teardown rule);
 *  - visibleText keeps reading drawingScenePlainText — the projection
 *    ships now, so statistics do not change when the canvas lands.
 */

import { registerNoteSurfaceForType, type NoteSurface, type SurfaceNote } from '../surface';
import { drawingScenePlainText, parseDrawingScene, type DrawingScene } from './scene';

export class DrawingNoteSurface implements NoteSurface {
  readonly kind = 'json' as const;
  /** Display-only until the canvas ships (phase 2 flips this — and the
   * test that pins it). */
  readonly editable = false;

  display(host: HTMLElement, note: SurfaceNote | null): void {
    host.setAttribute('contenteditable', 'false');
    host.textContent = '';
    if (note) {
      host.append(this.buildCard(note));
    }
    host.scrollTop = 0;
  }

  capture(_host: HTMLElement | null): null {
    // Nothing on this surface belongs to the note — the note's real
    // content lives in the model, byte-exact (the opaque discipline).
    return null;
  }

  visibleText(_host: HTMLElement | null, note: SurfaceNote): string {
    // The projection ships with the scaffold so the pill, statistics,
    // exports and prompts never read the placeholder card's copy as the
    // note's text.
    return drawingScenePlainText(note.content);
  }

  commit(host: HTMLElement | null, content: string): boolean {
    // Snapshot restores and external edits repaint the card; the caller
    // owns the persist (no port channel exists for this kind).
    if (host) {
      this.display(host, { content });
    }
    return false;
  }

  clear(host: HTMLElement): void {
    this.display(host, { content: '' });
  }

  private buildCard(note: SurfaceNote): HTMLElement {
    const card = document.createElement('div');
    card.className = 'unsupported-note';
    card.dataset.noteType = 'drawing';

    const title = document.createElement('p');
    title.className = 'unsupported-note-title';
    title.textContent = 'Drawing — the canvas ships with the next Padify build';

    const body = document.createElement('p');
    body.className = 'unsupported-note-body';
    body.textContent = this.cardSummary(note.content);

    card.append(title, body);
    return card;
  }

  /** The card's second line, honest about what the note holds. */
  private cardSummary(content: string): string {
    if (content.trim() === '') {
      return 'This drawing is empty. It is stored with your notes and syncs like any other once drawn on.';
    }
    const scene: DrawingScene | null = parseDrawingScene(content);
    if (scene === null) {
      return 'The note holds a drawing from a newer Padify. It is stored safely and syncs untouched — open it there to edit it.';
    }
    const count = scene.elements.length;
    if (count === 0) {
      return 'This drawing is empty. It is stored with your notes and syncs like any other once drawn on.';
    }
    const shapes = `${count} element${count === 1 ? '' : 's'}`;
    return `The scene (${shapes}) is stored safely and syncs untouched across your devices.`;
  }
}

registerNoteSurfaceForType('drawing', new DrawingNoteSurface());
