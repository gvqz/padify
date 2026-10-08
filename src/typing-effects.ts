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

export function initTypingEffects(
  notepad: NotepadUI,
  editorConfig: EditorConfig,
): { reset: (config: EditorConfig) => void } {
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
  const confettiColors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ffffff'];
  const neonColors = ['#00f5d4', '#00bbf9', '#f15bb5', '#fee440', '#9b5de5'];
  const starColors = ['#ffd166', '#fff3b0', '#ffea00', '#ffffff'];
  const emojiPool = ['🎉', '✨', '💥', '🔥', '⭐', '💫', '🎊', '💜'];

  const randomFrom = <T>(pool: readonly T[]): T => pool[Math.floor(Math.random() * pool.length)];

  /**
   * Where is the caret on screen? The contenteditable Selection gives
   * us a client rect directly — no textarea mirror needed.
   */
  function getCaretClientPosition(): { left: number; top: number; height: number } | null {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();

    // Collapsed ranges at line ends can report an empty rect;
    // fall back to the last client rect or the editor's box.
    if ((rect.width === 0 && rect.height === 0) || Number.isNaN(rect.top)) {
      const rects = range.getClientRects();
      if (rects.length > 0) {
        rect = rects[rects.length - 1];
      } else {
        const editorRect = (
          notepad.note.get(0) as HTMLElement | undefined
        )?.getBoundingClientRect();
        if (!editorRect) return null;
        rect = editorRect;
      }
    }

    const computed = window.getComputedStyle(notepad.note.get(0) as HTMLElement);
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
  }

  function spawnParticle(layer: HTMLElement, spec: ParticleSpec): void {
    const particle = document.createElement('span');
    particle.className = spec.className;
    particle.style.left = `${baseX}px`;
    particle.style.top = `${baseY}px`;
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
  }

  let baseX = 0;
  let baseY = 0;

  function spawnClassic(layer: HTMLElement): void {
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 12 + Math.random() * 22;
      const size = 3 + Math.random() * 4;
      spawnParticle(layer, {
        className: 'keyburst-particle',
        width: size,
        height: size,
        color: randomFrom(keyburstColors),
        burstX: Math.cos(angle) * distance,
        burstY: Math.sin(angle) * distance,
        rotate: 0,
      });
    }
  }

  function spawnConfetti(layer: HTMLElement): void {
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 10 + Math.random() * 34;
      const width = 4 + Math.random() * 5;
      spawnParticle(layer, {
        className: 'keyburst-confetti',
        width,
        height: width * (Math.random() < 0.5 ? 0.55 : 1.1),
        color: randomFrom(confettiColors),
        burstX: Math.cos(angle) * distance,
        // Downward bias — confetti flutters out, then falls.
        burstY: Math.sin(angle) * distance + 14 + Math.random() * 26,
        rotate: (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 540),
      });
    }
  }

  function spawnFireworks(layer: HTMLElement): void {
    // A bright core flash…
    const flash = document.createElement('span');
    flash.className = 'keyburst-flash';
    flash.style.left = `${baseX}px`;
    flash.style.top = `${baseY}px`;
    flash.style.width = '14px';
    flash.style.height = '14px';
    flash.style.setProperty('--burst-color', randomFrom(['#ffd166', '#ff9f6b', '#fff3b0']));
    layer.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());

    // …then the sparks fly out and drop back down.
    for (let i = 0; i < 16; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 10 + Math.random() * 38;
      const size = 2.5 + Math.random() * 3.5;
      spawnParticle(layer, {
        className: 'keyburst-firework',
        width: size,
        height: size,
        color: randomFrom(keyburstColors),
        burstX: Math.cos(angle) * distance,
        burstY: Math.sin(angle) * distance - 6,
        rotate: 0,
      });
    }
  }

  function spawnShootingStars(layer: HTMLElement): void {
    for (let i = 0; i < 5; i++) {
      // Fan upward: -30° to -150° from the caret.
      const angle = -Math.PI * (0.17 + 0.66 * (i / 4) + (Math.random() - 0.5) * 0.12);
      const distance = 26 + Math.random() * 30;
      spawnParticle(layer, {
        className: 'keyburst-star',
        width: 12,
        height: 12,
        color: randomFrom(starColors),
        burstX: Math.cos(angle) * distance,
        burstY: Math.sin(angle) * distance,
        rotate: (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 200),
        text: '✦',
        fontSize: 9 + Math.random() * 5,
      });
    }
  }

  function spawnNeon(layer: HTMLElement): void {
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 8 + Math.random() * 14;
      const size = 4 + Math.random() * 4;
      spawnParticle(layer, {
        className: 'keyburst-neon',
        width: size,
        height: size,
        color: randomFrom(neonColors),
        burstX: Math.cos(angle) * distance,
        burstY: Math.sin(angle) * distance - 4,
        rotate: 45,
      });
    }
  }

  function spawnEmoji(layer: HTMLElement): void {
    const count = 7 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 8 + Math.random() * 26;
      spawnParticle(layer, {
        className: 'keyburst-emoji',
        width: 14,
        height: 14,
        color: '#ffffff',
        burstX: Math.cos(angle) * distance,
        burstY: -(18 + Math.random() * 30),
        rotate: (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 120),
        text: randomFrom(emojiPool),
        fontSize: 10 + Math.random() * 6,
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

  function triggerKeyburst(): void {
    if (!keyburstLayer.length) {
      return;
    }

    const caret = getCaretClientPosition();

    if (!caret) {
      return;
    }

    baseX = caret.left;
    baseY = caret.top + caret.height * 0.6;
    const layer = keyburstLayer.get(0) as HTMLElement | null;
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

    requestAnimationFrame(() => {
      triggerKeyburst();
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
