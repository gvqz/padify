import { $ } from './lib/q';
import type { NotepadUI, EditorConfig } from './selector';
import { stateGet } from './storage';
import { removeSetting, setSetting } from './state/settings';

/**
 * Typing effects — the "exploding keys" particle burst at the caret.
 *
 * One toggle turns it on; the style picker chooses the flavor. The
 * 'surprise' style rolls a different concrete style on every keystroke,
 * so a sentence sparkles, confetti-pops and firework-cracks as it goes.
 */

/** Every selectable explosion style. */
export const EXPLOSION_STYLES = [
  'classic',
  'confetti',
  'fireworks',
  'shooting',
  'neon',
  'emoji',
  'surprise',
] as const;

export type ExplosionStyle = (typeof EXPLOSION_STYLES)[number];

/** Styles that draw something concrete ('surprise' rolls among these). */
const CONCRETE_STYLES: readonly Exclude<ExplosionStyle, 'surprise'>[] = [
  'classic',
  'confetti',
  'fireworks',
  'shooting',
  'neon',
  'emoji',
];

function isExplosionStyle(value: string | null): value is ExplosionStyle {
  return (EXPLOSION_STYLES as readonly string[]).includes(value ?? '');
}

interface CaretPosition {
  left: number;
  top: number;
  height: number;
}

/**
 * Caret rect for a textarea/input — form fields the document Selection
 * cannot see. Reflects the text up to the caret in a hidden mirror styled
 * exactly like the field, then reads back the position of a zero-width
 * mark riding at the caret edge; the field's scroll offsets convert it to
 * viewport coordinates. (The contenteditable surface keeps using the
 * Selection API — see getCaretClientPosition.)
 */
export function getFieldCaretPosition(
  field: HTMLTextAreaElement | HTMLInputElement,
): CaretPosition | null {
  const doc = field.ownerDocument;
  if (!doc) return null;

  const caretIndex = field.selectionStart ?? field.value.length;
  // Style is read from the field's OWN window: the editor can live in the
  // floating (PiP) window, another document from this one.
  const cs = (field.ownerDocument.defaultView ?? window).getComputedStyle(field);

  const mirror = doc.createElement('div');
  // Text geometry — copy everything that moves a glyph.
  for (const prop of [
    'boxSizing',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'fontVariantLigatures',
    'letterSpacing',
    'wordSpacing',
    'textIndent',
    'textTransform',
    'tabSize',
    'lineHeight',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
  ] as const) {
    mirror.style[prop] = cs[prop];
  }
  // Reserve the field's real border box (transparent) so the padding box —
  // and with it the text's wrap width — matches the field exactly.
  mirror.style.borderStyle = 'solid';
  mirror.style.borderColor = 'transparent';
  mirror.style.borderWidth = `${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth}`;
  // clientWidth is the field's padding box with the scrollbar already
  // deducted — exactly the wrap width the text sees.
  mirror.style.width = `${
    field.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
  }px`;
  mirror.style.whiteSpace = cs.whiteSpace === 'pre' ? 'pre' : 'pre-wrap';
  mirror.style.overflowWrap = cs.overflowWrap;
  mirror.style.wordWrap = cs.wordWrap;
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';

  mirror.appendChild(doc.createTextNode(field.value.slice(0, caretIndex)));
  // The zero-width mark rides at the caret edge — reading its rect reads
  // the caret's position. (A plain empty span would collapse.)
  const mark = doc.createElement('span');
  mark.textContent = '\u200b';
  mirror.appendChild(mark);
  doc.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  mirror.remove();

  if (!markRect || Number.isNaN(markRect.top) || !mirrorRect) return null;

  const fieldRect = field.getBoundingClientRect();
  return {
    left:
      fieldRect.left +
      parseFloat(cs.borderLeftWidth) +
      (markRect.left - mirrorRect.left) -
      field.scrollLeft,
    top:
      fieldRect.top +
      parseFloat(cs.borderTopWidth) +
      (markRect.top - mirrorRect.top) -
      field.scrollTop,
    height: markRect.height || parseFloat(cs.lineHeight) || 16,
  };
}

/**
 * The layer a burst spawns into — resolved in the document that owns the
 * editor.
 *
 * When the note is open in the floating (PiP) window, the editor is a
 * node of ANOTHER document: coordinates there are that window's viewport
 * coordinates, and the main window's layer would paint the burst over
 * the main window's UI (or nowhere at all) instead of over the caret the
 * user is typing at. Each document gets its own lazily-created layer.
 */
export function resolveKeyburstLayer(
  target: EventTarget | null,
  fallbackDoc: Document,
): HTMLElement | null {
  const doc = target instanceof Node ? (target.ownerDocument ?? fallbackDoc) : fallbackDoc;
  let layer = doc.getElementById('keyburstLayer');
  if (!layer && doc.body) {
    layer = doc.createElement('div');
    layer.id = 'keyburstLayer';
    layer.setAttribute('aria-hidden', 'true');
    doc.body.append(layer);
  }
  return layer;
}

export function initTypingEffects(
  notepad: NotepadUI,
  editorConfig: EditorConfig,
): { reset: (config: EditorConfig) => void } {
  // Decorative by definition: when the OS asks for reduced motion the
  // bursts simply don't spawn (the CSS hides the layer as well — but a
  // display:none layer would still collect never-animated particles that
  // only animationend could remove, so the gate lives here too).
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const userChosenExplodingEffect = stateGet('userChosenExplodingEffect');
  const storedStyle = stateGet('userChosenExplodingEffectStyle');

  let explodingEffectEnabled: boolean;
  const defaultStyle = editorConfig.defaultExplodingEffectStyle;
  let explosionStyle: ExplosionStyle = isExplosionStyle(storedStyle)
    ? storedStyle
    : isExplosionStyle(defaultStyle)
      ? defaultStyle
      : 'classic';

  let keyburstLayer = $('#keyburstLayer');
  let pendingKeyburst = false;

  if (keyburstLayer.length === 0) {
    keyburstLayer = $('<div id="keyburstLayer" aria-hidden="true"></div>');
    $('body').append(keyburstLayer);
  }

  const keyburstColors = ['#ff4d6d', '#ffe66d', '#6bffb4', '#6bb7ff', '#d06bff', '#ff9f6b'];
  // No white pieces: the editor surface is white, so white confetti simply
  // vanished — a burst of twelve that read as ten.
  const confettiColors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff9f1c'];
  const neonColors = ['#00f5d4', '#00bbf9', '#f15bb5', '#fee440', '#9b5de5'];
  // Deep ambers/oranges only: pale gold, cream and WHITE stars on the white
  // page made the shooting style invisible — five stars spawned and the user
  // saw nothing.
  const starColors = ['#ffb703', '#ffd60a', '#fb8500', '#ff9e00'];
  const emojiPool = ['🎉', '✨', '💥', '🔥', '⭐', '💫', '🎊', '💜'];

  const randomFrom = <T>(pool: readonly T[]): T => pool[Math.floor(Math.random() * pool.length)];

  /**
   * Where is the caret on screen?
   *
   * Two regimes:
   *  - The HTML surface (contenteditable #note): the Selection API gives a
   *    client rect directly — no textarea mirror needed.
   *  - The markdown surface (a <textarea> inside #note): form fields keep
   *    their caret OUT of the document Selection, so getSelection() reports
   *    whatever stale selection the last click left behind (or nothing at
   *    all) and bursts fire far from the real caret. For fields the caret
   *    is measured with the mirror-div technique instead (see
   *    getFieldCaretPosition).
   */
  function getCaretClientPosition(target?: EventTarget | null): {
    left: number;
    top: number;
    height: number;
  } | null {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      return getFieldCaretPosition(target);
    }
    // The selection must come from the editor's OWN window: when the note
    // lives in the floating (PiP) window, the main window's Selection is a
    // stale leftover (or empty) and bursts fire at the wrong place — or at
    // the fallback box. target IS the editor surface in practice, so its
    // document's view is the authoritative one.
    const targetDoc = target instanceof Node ? target.ownerDocument : null;
    const view = targetDoc?.defaultView ?? window;
    const selection = view.getSelection();

    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();

    // Collapsed ranges at line ends can report an empty rect;
    // fall back to the last client rect, the caret's own block, or the
    // editor's box (offset by its padding so the burst lands where the
    // caret actually sits, not at the box's bare corner).
    if ((rect.width === 0 && rect.height === 0) || Number.isNaN(rect.top)) {
      const rects = range.getClientRects();
      if (rects.length > 0) {
        rect = rects[rects.length - 1];
      } else {
        // An empty paragraph or an untouched empty note: the caret's block
        // (the collapsed range's container) carries the line box position.
        const startEl =
          range.startContainer instanceof HTMLElement
            ? range.startContainer
            : range.startContainer.parentElement;
        const blockRect = startEl?.getBoundingClientRect();
        const editorEl = notepad.note.get(0) as HTMLElement | undefined;
        const editorRect = editorEl?.getBoundingClientRect();
        if (blockRect && blockRect.height > 0) {
          rect = blockRect;
        } else if (editorRect && editorEl) {
          // Last resort — the editor's text origin: box corner plus its
          // padding, which is where the caret sits in a bare empty note.
          const ecs = view.getComputedStyle(editorEl);
          const lineHeight = parseFloat(ecs.lineHeight) || parseFloat(ecs.fontSize) || 16;
          return {
            left: editorRect.left + (parseFloat(ecs.paddingLeft) || 0),
            top: editorRect.top + (parseFloat(ecs.paddingTop) || 0),
            height: lineHeight,
          };
        } else {
          return null;
        }
      }
    }

    const computed = view.getComputedStyle(notepad.note.get(0) as HTMLElement);
    const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) || 16;

    return {
      left: rect.left,
      top: rect.top,
      height: rect.height || lineHeight,
    };
  }

  interface ParticleSpec {
    className: string;
    width: number;
    height: number;
    color: string;
    burstX: number;
    burstY: number;
    rotate: number;
    text?: string;
    fontSize?: number;
    /** Extra upward offset from the caret line the particle spawns at. */
    liftY?: number;
    /** Extra random spread at spawn, so glyphs don't stack on one pixel. */
    jitterX?: number;
    jitterY?: number;
  }

  function spawnParticle(layer: HTMLElement, spec: ParticleSpec): void {
    // Particles are created in the LAYER's document: when the editor lives
    // in the floating (PiP) window, that is another document from this one,
    // and a main-document node appended cross-document (or positioned with
    // another window's viewport coordinates) lands in the wrong window.
    const particle = layer.ownerDocument.createElement('span');
    particle.className = spec.className;
    // A little spawn scatter keeps the burst from stacking every particle
    // into one bright clump on a single pixel at the keystroke moment.
    const scatterX = Math.random() * 6 - 3;
    const scatterY = Math.random() * 4 - 2;
    const jitterX = spec.jitterX ? Math.random() * spec.jitterX * 2 - spec.jitterX : 0;
    const jitterY = spec.jitterY ? Math.random() * spec.jitterY * 2 - spec.jitterY : 0;
    particle.style.left = `${baseX + scatterX + jitterX}px`;
    particle.style.top = `${baseY - (spec.liftY ?? 0) + scatterY + jitterY}px`;
    particle.style.width = `${spec.width}px`;
    particle.style.height = `${spec.height}px`;
    if (spec.text) {
      particle.textContent = spec.text;
      particle.style.fontSize = `${spec.fontSize ?? 12}px`;
    }
    particle.style.setProperty('--burst-x', `${spec.burstX}px`);
    particle.style.setProperty('--burst-y', `${spec.burstY}px`);
    particle.style.setProperty('--burst-rotate', `${spec.rotate}deg`);
    particle.style.setProperty('--burst-color', spec.color);

    layer.appendChild(particle);
    particle.addEventListener('animationend', () => {
      particle.remove();
    });
    // Failsafe: animationend never fires if the animation is disabled
    // mid-flight (reduced motion flipping on, the tab hidden) — the
    // longest burst runs 900ms, so 2s is safely past every animation.
    setTimeout(() => particle.remove(), 2_000);
  }

  let baseX = 0;
  let baseY = 0;

  function spawnClassic(layer: HTMLElement): void {
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 14 + Math.random() * 24;
      const size = 3 + Math.random() * 4;
      spawnParticle(layer, {
        className: 'keyburst-particle',
        width: size,
        height: size,
        color: randomFrom(keyburstColors),
        burstX: Math.cos(angle) * distance,
        // Upward bias — the dots leave the text line immediately.
        burstY: Math.sin(angle) * distance - 12,
        rotate: 0,
      });
    }
  }

  function spawnConfetti(layer: HTMLElement): void {
    for (let i = 0; i < 12; i++) {
      const angle = Math.PI * (0.1 + 0.8 * Math.random());
      const distance = 14 + Math.random() * 26;
      const width = 4 + Math.random() * 5;
      spawnParticle(layer, {
        className: 'keyburst-confetti',
        width,
        height: width * (Math.random() < 0.5 ? 0.55 : 1.1),
        color: randomFrom(confettiColors),
        burstX: Math.cos(angle) * distance,
        // Confetti-pop arc: the apex (--burst-y) sits ABOVE the text line
        // and the keyframe's second half flutters back down while fading,
        // so the pieces never sit on the fresh text at full opacity.
        burstY: -(14 + Math.random() * 22),
        rotate: (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 540),
        // Born just clear of the line box, never on the glyphs — and
        // pre-spread so twelve pieces don't stack into one blob at spawn.
        liftY: 2,
        jitterX: 8,
        jitterY: 5,
      });
    }
  }

  function spawnFireworks(layer: HTMLElement): void {
    // A bright core flash — spawned just ABOVE the text line so the white
    // core never sits on the character being typed…
    const flash = layer.ownerDocument.createElement('span');
    flash.className = 'keyburst-flash';
    flash.style.left = `${baseX}px`;
    flash.style.top = `${baseY - 14}px`;
    flash.style.width = '14px';
    flash.style.height = '14px';
    flash.style.setProperty('--burst-color', randomFrom(['#ffd166', '#ff9f6b', '#fff3b0']));
    layer.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());

    // …then the sparks fly UP AND OUT ONLY — the old full-circle fan let
    // half the sparks arc down onto the fresh glyphs at full opacity. The
    // rise is capped so first-line bursts stay under the toolbar.
    for (let i = 0; i < 12; i++) {
      const angle = Math.PI * (0.08 + 0.84 * Math.random());
      const distance = 10 + Math.random() * 30;
      const size = 2.5 + Math.random() * 3.5;
      spawnParticle(layer, {
        className: 'keyburst-firework',
        width: size,
        height: size,
        color: randomFrom(keyburstColors),
        burstX: Math.cos(angle) * distance,
        burstY: -Math.sin(angle) * distance - 6,
        rotate: 0,
      });
    }
  }

  function spawnShootingStars(layer: HTMLElement): void {
    for (let i = 0; i < 5; i++) {
      // Fan upward: -30° to -150° from the caret.
      const angle = -Math.PI * (0.17 + 0.66 * (i / 4) + (Math.random() - 0.5) * 0.12);
      const distance = 24 + Math.random() * 22;
      spawnParticle(layer, {
        className: 'keyburst-star',
        width: 12,
        height: 12,
        color: randomFrom(starColors),
        burstX: Math.cos(angle) * distance,
        burstY: Math.sin(angle) * distance,
        rotate: (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 200),
        // '★' is a dense filled glyph; the old thin '✦' at 9-14px in pale
        // gold read as nothing at all on the white page.
        text: '★',
        fontSize: 12 + Math.random() * 6,
        jitterX: 7,
        jitterY: 5,
      });
    }
  }

  function spawnNeon(layer: HTMLElement): void {
    // Few, small and spread: ten 8px glowing squares packed into a 16px
    // radius merged into one opaque blob that hid the typed characters.
    for (let i = 0; i < 6; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 10 + Math.random() * 16;
      const size = 3 + Math.random() * 3;
      spawnParticle(layer, {
        className: 'keyburst-neon',
        width: size,
        height: size,
        color: randomFrom(neonColors),
        burstX: Math.cos(angle) * distance,
        // Clear the line fast — the glow is at full strength on arrival.
        burstY: Math.sin(angle) * distance - 16,
        rotate: 45,
      });
    }
  }

  function spawnEmoji(layer: HTMLElement): void {
    const count = 7 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 12 + Math.random() * 30;
      spawnParticle(layer, {
        className: 'keyburst-emoji',
        width: 14,
        height: 14,
        color: '#ffffff',
        burstX: Math.cos(angle) * distance,
        burstY: -(20 + Math.random() * 20),
        rotate: (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 120),
        text: randomFrom(emojiPool),
        fontSize: 11 + Math.random() * 5,
        // Glyphs are big — spawn them clear of the line AND of each other:
        // with no per-particle spread all eight stacked into one blob that
        // read as a single orange smudge.
        liftY: 8,
        jitterX: 12,
        jitterY: 8,
      });
    }
  }

  const spawnByStyle: Record<Exclude<ExplosionStyle, 'surprise'>, (layer: HTMLElement) => void> = {
    classic: spawnClassic,
    confetti: spawnConfetti,
    fireworks: spawnFireworks,
    shooting: spawnShootingStars,
    neon: spawnNeon,
    emoji: spawnEmoji,
  };

  function triggerKeyburst(target?: EventTarget | null): void {
    if (!keyburstLayer.length) {
      return;
    }

    if (reducedMotion?.matches) {
      return;
    }

    const caret = getCaretClientPosition(target);

    if (!caret) {
      return;
    }

    baseX = caret.left;
    // The TOP of the line box, not its middle: the old 0.45 factor put the
    // origin mid-glyph, so every style was born sitting on the character
    // that was just typed. From the top edge the bright first frames are
    // already clear of the text and the upward biases below carry them
    // higher — the just-typed word stays readable under every style.
    baseY = caret.top + caret.height * 0.12;
    const layer = resolveKeyburstLayer(target ?? null, document);
    if (!layer) {
      return;
    }

    const style = explosionStyle === 'surprise' ? randomFrom(CONCRETE_STYLES) : explosionStyle;
    spawnByStyle[style](layer);
  }

  // Initialize explosion effect preference
  if (!userChosenExplodingEffect) {
    explodingEffectEnabled = editorConfig.defaultExplodingEffect;
    $('#explodingEffect').prop('checked', explodingEffectEnabled);
  } else {
    explodingEffectEnabled = userChosenExplodingEffect == 'Yes';
    $('#explodingEffect').prop('checked', explodingEffectEnabled);
  }

  $('#explodingEffectStyle').val(explosionStyle);

  notepad.note.on('keydown', (e) => {
    const shouldExplode =
      explodingEffectEnabled &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key.length === 1 || e.key === 'Enter');

    if (shouldExplode) {
      pendingKeyburst = true;
    }
  });

  notepad.note.on('input', (e) => {
    if (!explodingEffectEnabled) {
      pendingKeyburst = false;
      return;
    }

    const inputType =
      e.originalEvent && (e.originalEvent as InputEvent).inputType
        ? (e.originalEvent as InputEvent).inputType
        : (e as unknown as InputEvent).inputType;
    const isInsert =
      pendingKeyburst ||
      (inputType &&
        inputType.startsWith('insert') &&
        inputType !== 'insertFromPaste' &&
        inputType !== 'insertFromDrop');

    if (!isInsert) {
      pendingKeyburst = false;
      return;
    }

    pendingKeyburst = false;

    const burstTarget = e.target;
    requestAnimationFrame(() => {
      triggerKeyburst(burstTarget);
    });
  });

  // Handle explosion effect toggle
  $('#explodingEffect').on('change', function () {
    const isEnabled = $(this).is(':checked');
    setSetting('userChosenExplodingEffect', isEnabled ? 'Yes' : 'No');
    explodingEffectEnabled = isEnabled;
  });

  // Handle explosion style change
  $('#explodingEffectStyle').on('change', function () {
    const style = (this as HTMLSelectElement).value;
    if (isExplosionStyle(style)) {
      setSetting('userChosenExplodingEffectStyle', style);
      explosionStyle = style;
    }
  });

  return {
    /**
     * Clears the persisted typing-effect preferences and restores the
     * defaults in the UI (used by "Reset to defaults" in preferences).
     */
    reset(config: EditorConfig): void {
      removeSetting('userChosenExplodingEffect');
      explodingEffectEnabled = config.defaultExplodingEffect;
      $('#explodingEffect').prop('checked', explodingEffectEnabled);

      removeSetting('userChosenExplodingEffectStyle');
      const defaultStyle = config.defaultExplodingEffectStyle;
      explosionStyle = isExplosionStyle(defaultStyle) ? defaultStyle : 'classic';
      $('#explodingEffectStyle').val(explosionStyle);
    },
  };
}
