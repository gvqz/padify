import $ from 'jquery';
import type { NotepadUI, EditorConfig } from './selector';
import { stateGet, stateSet, stateRemove } from './storage';

/**
 * Typing effects — optional typewriter key sounds (key, space, carriage
 * return, with a volume slider and live preview) and the "exploding
 * keys" particle burst at the caret.
 */
export function initTypingEffects(
  notepad: NotepadUI,
  editorConfig: EditorConfig,
): { reset: (config: EditorConfig) => void } {
  let typewriterSoundEnabled: boolean;
  const typeSound = new Audio('/sounds/typewriter/typewriter-key-press-02.mp3');
  const carriageReturnSound = new Audio('/sounds/typewriter/typewriter-carriage-return-01.mp3');
  const spacebarSound = new Audio('/sounds/typewriter/space.mp3');

  typeSound.volume = 0.2; // keep it subtle
  const userChosenTypewriterVolume = stateGet('userChosenTypewriterVolume');
  const userChosenTypewriterSound = stateGet('userChosenTypewriterSound');
  const userChosenExplodingEffect = stateGet('userChosenExplodingEffect');

  let explodingEffectEnabled: boolean;

  let keyburstLayer = $('#keyburstLayer');
  let pendingKeyburst = false;

  if (keyburstLayer.length === 0) {
    keyburstLayer = $('<div id="keyburstLayer" aria-hidden="true"></div>');
    $('body').append(keyburstLayer);
  }

  const keyburstColors = ['#ff4d6d', '#ffe66d', '#6bffb4', '#6bb7ff', '#d06bff', '#ff9f6b'];
  const keyburstParticleCount = 8;

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
        const editorRect = (notepad.note.get(0) as HTMLElement | undefined)?.getBoundingClientRect();
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

  function triggerKeyburst(): void {
    if (!keyburstLayer.length) {
      return;
    }

    const caret = getCaretClientPosition();

    if (!caret) {
      return;
    }

    const baseX = caret.left;
    const baseY = caret.top + caret.height * 0.6;
    const layer = keyburstLayer[0];

    for (let i = 0; i < keyburstParticleCount; i++) {
      const particle = document.createElement('span');
      const angle = Math.random() * Math.PI * 2;
      const distance = 12 + Math.random() * 22;
      const size = 3 + Math.random() * 4;
      const color = keyburstColors[Math.floor(Math.random() * keyburstColors.length)];

      particle.className = 'keyburst-particle';
      particle.style.left = `${baseX}px`;
      particle.style.top = `${baseY}px`;
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.setProperty('--burst-x', `${Math.cos(angle) * distance}px`);
      particle.style.setProperty('--burst-y', `${Math.sin(angle) * distance}px`);
      particle.style.setProperty('--burst-color', color);

      layer.appendChild(particle);
      particle.addEventListener('animationend', () => {
        particle.remove();
      });
    }
  }

  // Initialize typewriter sound preference
  if (!userChosenTypewriterSound) {
    typewriterSoundEnabled = editorConfig.defaultTypewriterSound;
    $('#typewriterSound').prop('checked', typewriterSoundEnabled);
  } else {
    typewriterSoundEnabled = userChosenTypewriterSound == 'Yes';
    $('#typewriterSound').prop('checked', typewriterSoundEnabled);
  }

  if (typewriterSoundEnabled) {
    $('.typewriter-switch-volume').show();
  } else {
    $('.typewriter-switch-volume').hide();
  }

  if (!userChosenTypewriterVolume) {
    $('#typewriterVolume').val(editorConfig.defaultTypewriterVolume);
    $('#typewriterVolumeValue').text(editorConfig.defaultTypewriterVolume + '%');
  } else {
    $('#typewriterVolume').val(userChosenTypewriterVolume);
    $('#typewriterVolumeValue').text(userChosenTypewriterVolume + '%');
  }

  // Initialize explosion effect preference
  if (!userChosenExplodingEffect) {
    explodingEffectEnabled = editorConfig.defaultExplodingEffect;
    $('#explodingEffect').prop('checked', explodingEffectEnabled);
  } else {
    explodingEffectEnabled = userChosenExplodingEffect == 'Yes';
    $('#explodingEffect').prop('checked', explodingEffectEnabled);
  }

  function playTypeSound(): void {
    if (!typewriterSoundEnabled) return;

    // Clone so rapid typing doesn't cut the previous sound
    const s = typeSound.cloneNode() as HTMLAudioElement;

    // Add random pitch for realism (±5% variation)
    s.playbackRate = 0.95 + Math.random() * 0.1;
    const currentVolume = stateGet('userChosenTypewriterVolume');
    s.volume = currentVolume
      ? Number(currentVolume) / 100
      : editorConfig.defaultTypewriterVolume / 100;
    s.play();
  }

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

    if (e.key === 'Enter') {
      if (typewriterSoundEnabled) {
        const s = carriageReturnSound.cloneNode() as HTMLAudioElement;
        const currentVolume = stateGet('userChosenTypewriterVolume');
        s.volume = currentVolume
          ? Number(currentVolume) / 100
          : editorConfig.defaultTypewriterVolume / 100;
        s.play();
      }

      return;
    } else if (e.key === ' ') {
      if (typewriterSoundEnabled) {
        const s = spacebarSound.cloneNode() as HTMLAudioElement;
        const currentVolume = stateGet('userChosenTypewriterVolume');
        s.volume = currentVolume
          ? Number(currentVolume) / 100
          : editorConfig.defaultTypewriterVolume / 100;
        s.play();
      }

      return;
    }

    const isPrintable =
      // Single character keys (letters, numbers, symbols)
      e.key.length === 1 ||
      // Common editing keys
      [
        'Delete',
        'Backspace',
        'Enter',
        ' ',
        'Space',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(e.key) ||
      // Mobile-specific keys and special cases
      e.key === 'Unidentified' || // Some mobile keyboards
      e.key === 'Process' || // Some IME inputs
      e.key === 'Dead' || // Dead keys (for accents)
      e.key === 'Compose'; // Compose key

    if (isPrintable) {
      playTypeSound();
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

  // Handle typewriter sound toggle
  $('#typewriterSound').on('change', function () {
    const isEnabled = $(this).is(':checked');
    stateSet('userChosenTypewriterSound', isEnabled ? 'Yes' : 'No');
    typewriterSoundEnabled = isEnabled;

    if (isEnabled) {
      $('.typewriter-switch-volume').show();
    } else {
      $('.typewriter-switch-volume').hide();
    }
  });

  // Handle explosion effect toggle
  $('#explodingEffect').on('change', function () {
    const isEnabled = $(this).is(':checked');
    stateSet('userChosenExplodingEffect', isEnabled ? 'Yes' : 'No');
    explodingEffectEnabled = isEnabled;
  });

  // Handle typewriter volume change
  let volumePreviewTimer: ReturnType<typeof setTimeout> | null = null;
  $('#typewriterVolume').on('input', function () {
    const volume = $(this).val() as string;
    stateSet('userChosenTypewriterVolume', volume);

    if (typewriterSoundEnabled) {
      typeSound.volume = Number(volume) / 100;
      carriageReturnSound.volume = Number(volume) / 100;
      $('#typewriterVolumeValue').text(volume + '%');
    }

    // Clear previous preview timer
    clearTimeout(volumePreviewTimer!);

    // Set new preview timer (user stopped sliding for 500ms)
    volumePreviewTimer = setTimeout(() => {
      playTypeSound();
    }, 500);
  });

  return {
    /**
     * Clears the persisted typing-effect preferences and restores the
     * defaults in the UI (used by "Reset to defaults" in preferences).
     */
    reset(config: EditorConfig): void {
      stateRemove('userChosenTypewriterSound');
      typewriterSoundEnabled = config.defaultTypewriterSound;
      $('#typewriterSound').prop('checked', typewriterSoundEnabled);
      $('.typewriter-switch-volume').hide();

      stateRemove('userChosenTypewriterVolume');
      $('#typewriterVolume').val(config.defaultTypewriterVolume);
      $('#typewriterVolumeValue').text(config.defaultTypewriterVolume + '%');

      stateRemove('userChosenExplodingEffect');
      explodingEffectEnabled = config.defaultExplodingEffect;
      $('#explodingEffect').prop('checked', explodingEffectEnabled);
    },
  };
}
