/**
 * The Markdown selection bubble — the Crepe playground's signature
 * affordance in Padify's skin: select text and the format toolbar floats
 * above the selection (Bold · Italic · Strikethrough · Code · Link ·
 * Equation), one gesture away, no trip to the top toolbar.
 *
 * The kit's TooltipProvider owns positioning and visibility
 * (floating-ui against the selection's rect, flip + shift so the bubble
 * never leaves the viewport); this module owns every pixel — the panel
 * reuses the rich-btn vocabulary (the app's one toolbar aesthetic) —
 * and every action routes through the same injected handlers the slash
 * menu uses (app.ts wires them from the toolbar's own exports), so
 * there is exactly one grammar for formatting.
 *
 * The panel element lives in document.body (NOT the surface wrapper):
 * the surface rebuilds when another note kind evicts its wrapper, and a
 * body-level panel survives those remounts. The provider is created at
 * CONFIGURE time (before any editor's plugin view runs, so the first
 * editor is wired as surely as the tenth); the handlers arrive at init
 * time and are only read on click.
 */
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import { TooltipProvider, tooltipFactory } from '@milkdown/kit/plugin/tooltip';
import type { EditorState } from '@milkdown/kit/prose/state';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

/**
 * The format actions, injected by the composition root (app.ts) from the
 * toolbar's own exports — this module deliberately imports nothing from
 * its siblings, so the module graph stays acyclic (pinned by
 * architecture.test.ts): surface → bubble, toolbar → surface, app → both.
 */
export interface MarkdownBubbleHandlers {
  runToolbarAction(action: string): boolean;
  openLink(): void;
  openEquation(): void;
  /** The caret's mark state, for the buttons' pressed faces (structural — no sibling import). */
  selectionState(): {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    code: boolean;
  } | null;
}

let handlers: MarkdownBubbleHandlers | null = null;

/** The provider's update debounce — snappy for selection drags, short for tests. */
const BUBBLE_DEBOUNCE_MS = 30;

interface BubbleButton {
  id: string;
  action: string;
  label: string;
  /** SVG path data, 24×24 viewBox, stroked at 2 (the toolbar's own icons). */
  glyph: 'text' | 'path';
  content: string;
}

const BUTTONS: BubbleButton[] = [
  {
    id: 'bold',
    action: 'bold',
    label: 'Bold (Ctrl+B)',
    glyph: 'text',
    content: 'B',
  },
  {
    id: 'italic',
    action: 'italic',
    label: 'Italic (Ctrl+I)',
    glyph: 'text',
    content: 'I',
  },
  {
    id: 'strikethrough',
    action: 'strikethrough',
    label: 'Strikethrough',
    glyph: 'text',
    content: 'S',
  },
  {
    id: 'code',
    action: 'code',
    label: 'Inline code',
    glyph: 'text',
    content: '</>',
  },
  {
    id: 'link',
    action: 'link',
    label: 'Link (Ctrl+K)',
    glyph: 'path',
    content:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  },
  {
    id: 'equation',
    action: 'equation',
    label: 'Insert equation',
    glyph: 'path',
    content: '<path d="m3 12 3.5 5L11 4h10"/>',
  },
];

const factory = tooltipFactory('padifyBubble');

let provider: TooltipProvider | null = null;
let panel: HTMLElement | null = null;

/** Runs one button's action through the injected handlers. */
function runButton(button: BubbleButton): void {
  if (!handlers) {
    return;
  }
  if (button.action === 'link') {
    provider?.hide();
    handlers.openLink();
    return;
  }
  if (button.action === 'equation') {
    provider?.hide();
    handlers.openEquation();
    return;
  }
  // A toggle leaves the selection in place — the bubble stays put for
  // the next gesture (Crepe's own behavior).
  handlers.runToolbarAction(button.action);
  paintPressedStates();
}

/** Reflects the caret's mark state on the bubble's format buttons. */
function paintPressedStates(): void {
  if (!panel || !handlers) {
    return;
  }
  const state = handlers.selectionState();
  if (!state) {
    return;
  }
  const pressed: Record<string, boolean> = {
    bold: state.bold,
    italic: state.italic,
    strikethrough: state.strikethrough,
    code: state.code,
  };
  panel.querySelectorAll<HTMLElement>('.markdown-bubble-btn').forEach((button) => {
    const id = button.dataset.bubbleId ?? '';
    if (id in pressed) {
      button.setAttribute('aria-pressed', pressed[id] ? 'true' : 'false');
    }
  });
}

/** True when the selection deserves the bubble: real text, really selected. */
function selectionDeservesBubble(view: EditorView): boolean {
  const { state } = view;
  const { selection, doc } = state;
  // Atom selections (an equation, an image chip) are their own
  // affordances — the bubble's marks cannot touch them.
  if (selection instanceof NodeSelection) {
    return false;
  }
  const { empty, from, to } = selection;
  if (empty) {
    return false;
  }
  if (!doc.textBetween(from, to).length) {
    return false;
  }
  if (!view.editable) {
    return false;
  }
  return true;
}

/**
 * The surface's wiring handle: configure() lands in the editor's
 * .config() phase — it creates the panel + provider on first use (a
 * provider created after the first editor's plugin view ran would miss
 * it), then arms the spec the plugin spreads itself into.
 */
export const bubble = {
  configure(ctx: Ctx): void {
    ensureProvider();
    ctx.update(factory.key, (prev) => ({
      ...prev,
      props: {
        handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
          if (event.key === 'Escape' && provider && provider.element.dataset.show === 'true') {
            provider.hide();
            return true;
          }
          return false;
        },
      },
      // The PluginView rides the plugin's own lifecycle: every state
      // dispatch asks the provider to reconsider (selection moved,
      // doc changed), and a destroyed editor hides the bubble.
      view: (view: EditorView) => ({
        update: (nextView: EditorView, prevState: EditorState) => {
          void view;
          provider?.update(nextView, prevState);
        },
        destroy: () => {
          provider?.hide();
        },
      }),
    }));
  },
  get plugins(): MilkdownPlugin[] {
    return [...factory];
  },
};

/** Creates the panel + provider exactly once. */
function ensureProvider(): void {
  if (provider) {
    return;
  }
  panel = document.createElement('div');
  panel.className = 'markdown-bubble';
  panel.setAttribute('data-show', 'false');
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', 'Text formatting');

  for (const def of BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'markdown-bubble-btn';
    button.dataset.bubbleId = def.id;
    button.setAttribute('title', def.label);
    button.setAttribute('aria-label', def.label);
    if (['bold', 'italic', 'strikethrough', 'code'].includes(def.id)) {
      button.setAttribute('aria-pressed', 'false');
    }
    if (def.glyph === 'text') {
      const glyph = document.createElement('span');
      glyph.className = 'markdown-bubble-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      if (def.id === 'italic') {
        glyph.innerHTML = '<i>I</i>';
      } else if (def.id === 'strikethrough') {
        glyph.innerHTML = '<s>S</s>';
      } else {
        glyph.textContent = def.content;
      }
      button.append(glyph);
    } else {
      button.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.content}</svg>`;
    }
    // mousedown (not click) so the editor never loses its selection.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      runButton(def);
    });
    panel.append(button);
  }
  document.body.append(panel);

  provider = new TooltipProvider({
    content: panel,
    debounce: BUBBLE_DEBOUNCE_MS,
    root: document.body,
    shouldShow: (view) => selectionDeservesBubble(view),
  });
  provider.onShow = () => {
    paintPressedStates();
  };
}

/**
 * Boots the selection bubble's actions (and its panel + provider —
 * normally born at configure time, before any editor's plugin view
 * runs; init re-arms them after a test reset). Called from app.ts once
 * the shell is up; safe to call again after a reset.
 */
export function initMarkdownBubble(wiring: MarkdownBubbleHandlers): void {
  handlers = wiring;
  ensureProvider();
}

/**
 * Hides the bubble (the surface's stand-down call — dismiss). The
 * provider's own hide rides the editor's plugin-view destroy; that hook
 * only exists once an editor FINISHED building, so a switch away from a
 * still-mounting note (or a non-destroy transition) needs the explicit
 * call — an open bubble must not open on the next note.
 */
export function hideMarkdownBubble(): void {
  provider?.hide();
}

/** Test seam: the live panel element (null before the first configure). */
export function markdownBubblePanel(): HTMLElement | null {
  return panel;
}

/** Test seam: the live provider's element show state ('true' while visible). */
export function markdownBubbleVisible(): boolean {
  return provider?.element.dataset.show === 'true';
}

/** Test seam: forget the provider so a fresh shell can boot it. */
export function resetMarkdownBubbleForTests(): void {
  handlers = null;
  provider?.destroy();
  panel?.remove();
  provider = null;
  panel = null;
}
