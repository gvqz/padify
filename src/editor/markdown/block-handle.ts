/**
 * The Markdown block handle — the drag-to-reorder affordance the Crepe
 * playground shows beside every block: hover the editor and a grip
 * floats in the left gutter beside the active block; grab it and drag —
 * the kit's BlockService drives the whole drag (mousedown node-selects
 * the block, dragstart serializes it onto the dataTransfer, ProseMirror
 * moves it on drop) while a drop-cursor line paints where the block
 * will land.
 *
 * This module owns the pixels (the grip, monochrome and quiet, on the
 * app's tokens) and the lifecycle: the provider is created per editor
 * (the service instance it binds belongs to one editor's context), and
 * a superseded editor detaches it on teardown. The gutter the handle
 * lives in is reserved by 18-markdown.css (the edit pane's left
 * padding); the drop line reads the border token.
 */
import type { Editor } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $prose } from '@milkdown/kit/utils';
import { BlockProvider, block } from '@milkdown/kit/plugin/block';
import { dropCursor } from '@milkdown/kit/prose/dropcursor';
import { shift } from '@floating-ui/dom';

/** The handle's reserved gutter, in px (mirrors 18-markdown.css). */
const GUTTER_PX = 24;
/** The grip's own width — the anchor sits the grip flush in the gutter. */
const HANDLE_PX = 18;

/**
 * The drop indicator — a 2px line where the dragged block will land,
 * classed (not colored inline) so it reads the theme token. Imported
 * from the kit's prose re-export; riding the same bundle everything
 * else does.
 */
export const dropCursorPlugin = $prose(() => dropCursor({ class: 'md-drop-cursor', width: 2 }));

/** Everything the surface .use()s for the block handle. */
export const blockHandle = {
  get plugins(): MilkdownPlugin[] {
    return [...block, dropCursorPlugin];
  },
};

let active: { provider: BlockProvider; el: HTMLElement } | null = null;

/**
 * Attaches the handle to a freshly created editor (the surface's
 * .create().then()): the provider binds the editor's own block service
 * and parks the grip in the gutter. Any previous provider stands down —
 * its service belongs to an editor that is already gone.
 */
export function attachBlockHandle(editor: Editor): void {
  detachBlockHandle();

  const el = document.createElement('div');
  el.className = 'md-block-handle';
  el.dataset.show = 'false';
  el.title = 'Drag to move this block';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="2" cy="2" r="1.3"/><circle cx="8" cy="2" r="1.3"/>' +
    '<circle cx="2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/>' +
    '<circle cx="2" cy="14" r="1.3"/><circle cx="8" cy="14" r="1.3"/></svg>';

  editor.action((ctx) => {
    const provider = new BlockProvider({
      ctx,
      content: el,
      root: document.body,
      getPlacement: () => 'left',
      // No flip: the anchor IS the gutter's inner edge, so 'left' is the
      // only honest placement (a flipped grip would sit on the text).
      // shift keeps the grip inside the viewport vertically.
      floatingUIOptions: {
        middleware: [shift({ padding: 8 })],
      },
      getPosition: ({ active: current, editorDom }) => {
        const editorRect = editorDom.getBoundingClientRect();
        const blockRect = current.el.getBoundingClientRect();
        // editorDom is the ProseMirror root, whose left edge sits one
        // gutter in from the pane's — the anchor parks the grip flush
        // against the gutter's inner edge, top-aligned with the block.
        const anchorX = editorRect.left - (GUTTER_PX - HANDLE_PX) / 2;
        return new DOMRect(anchorX, blockRect.top + 12, 0.1, 0.1);
      },
    });
    provider.update();
    active = { provider, el };
  });
}

/** Detaches the handle (a superseded or destroyed editor). */
export function detachBlockHandle(): void {
  if (!active) {
    return;
  }
  try {
    active.provider.destroy();
  } catch {
    // The editor behind it is already gone; the element goes regardless.
    active.el.remove();
  }
  active = null;
}

/**
 * Hides the grip without tearing the provider down — a wholesale content
 * replace (a note switch inside the shared editor) moves every block, so
 * the hover position the grip floats at belongs to the PREVIOUS note's
 * doc. Left alone it stayed visible, frozen over the fresh note until a
 * stray mousemove re-evaluated it; what one note showed must not open
 * on another.
 */
export function hideBlockHandle(): void {
  if (active) {
    active.el.dataset.show = 'false';
  }
}

/** Test seam: the live handle element (null while detached). */
export function markdownBlockHandleElement(): HTMLElement | null {
  return active?.el ?? null;
}
