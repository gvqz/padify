/**
 * The one registry of dismissable layers — dropdown menus and popovers
 * that close when you click elsewhere, click another layer, press
 * Escape, or blur the window.
 *
 * Why a registry: every menu used to wire its own document-level click
 * closer, and every menu OPENER stopped propagation so its own click
 * never reached those closers. Clicking the download menu while the
 * brand menu was open left BOTH open — and the note-type menu, and the
 * right-click menu, hung the same way. One capture-phase listener
 * walking the registry fixes the class of bug rather than an instance:
 * openers no longer need stopPropagation to survive their own click,
 * and no layer can outlive a pointer press on another one.
 *
 * The listener runs in the CAPTURE phase on pointerdown — earlier than
 * any bubbling click handler and immune to stopPropagation — so the
 * "close the others" sweep has finished before an opener toggles its
 * own layer. Clicking a layer's own trigger keeps the layer (the
 * trigger's click then toggles it closed); clicking anywhere else
 * closes everything the pointer is outside of.
 *
 * Regions are STATELESS views over their menu's own truth (`isOpen`
 * reads the DOM, `setOpen` writes it) — so a menu that opens through
 * some other path (the right-click menu) still reads as open to the
 * sweep, and no registry-side flag can drift from reality.
 */

export interface LayerRegion {
  /** Every element that counts as "inside" the layer: trigger(s) + panel. */
  readonly elements: readonly Element[];

  /** The menu's own open state (reads the DOM — `.show`, `hidden`, …). */
  isOpen(): boolean;

  /** Shows/hides the menu (idempotent; the registry only ever closes). */
  setOpen(open: boolean): void;
}

export interface LayerHandle {
  open(): void;
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

const layers: LayerRegion[] = [];

let wired = false;

/** The one-time document wiring: capture-phase pointerdown, Escape, blur. */
function ensureRegistryWiring(): void {
  if (wired) {
    return;
  }
  wired = true;

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      for (const region of layers) {
        if (region.isOpen() && !region.elements.some((el) => el.contains(target))) {
          region.setOpen(false);
        }
      }
    },
    true,
  );

  // The same sweep on click, bubble phase — the net that catches
  // activations that never produce a pointerdown: keyboard Enter/Space
  // fires click alone, and so do synthetic .click() calls. By the time
  // this runs, opener handlers have already toggled their own layer, so
  // a click inside a layer's elements is a no-op here; only the
  // keyboard-opened-menu-on-top-of-menu case actually closes anything.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    // A node that left the document mid-dispatch — a re-render replaced
    // the clicked element's markup during this same click (the tasks
    // hub's month navigation does exactly this) — cannot be judged
    // "outside" any layer: contains() walks the tree as it is NOW, and
    // a detached node is contained by nothing. Closing on its account
    // would dismiss the very surface the click was operating on.
    if (!target.isConnected) {
      return;
    }
    for (const region of layers) {
      if (region.isOpen() && !region.elements.some((el) => el.contains(target))) {
        region.setOpen(false);
      }
    }
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        for (const region of layers) {
          if (region.isOpen()) {
            region.setOpen(false);
          }
        }
      }
    },
    true,
  );

  window.addEventListener('blur', () => {
    for (const region of layers) {
      if (region.isOpen()) {
        region.setOpen(false);
      }
    }
  });
}

/**
 * Registers a dismissable layer and returns the handle its trigger
 * drives. Opening sweeps every other open layer first — two menus can
 * no longer be open at once.
 */
export function registerLayer(region: LayerRegion): LayerHandle {
  ensureRegistryWiring();
  layers.push(region);

  const closeOtherLayers = (): void => {
    for (const other of layers) {
      if (other !== region && other.isOpen()) {
        other.setOpen(false);
      }
    }
  };

  return {
    open(): void {
      closeOtherLayers();
      region.setOpen(true);
    },
    close(): void {
      region.setOpen(false);
    },
    toggle(): void {
      if (region.isOpen()) {
        region.setOpen(false);
      } else {
        this.open();
      }
    },
    isOpen(): boolean {
      return region.isOpen();
    },
  };
}
