import $ from 'jquery';
import { selector } from './selector';
import {
  showToast,
  calculateCharactersAndWords,
  calculateNoteStatistics,
  copyNotesToClipboard,
  debounce,
  saveTextAsFile,
  enableDarkMode,
  enableLightMode,
  enableDeviceTheme,
  resetFontSize,
  resetLineHeight,
  resetFontWeight,
  resetShowWordCountPill,
  resetWriteDirection,
  resetTexture,
  resetFont,
  resetOptimalLineLength,
  deleteNotes,
  toggleFocusMode,
  turnOffFocusMode,
  toggleFullScreen,
  exportNotesAsPDF,
  exportNotesAsDocx,
  downloadHTML,
  updateWordCountPill,
  getPWADisplayMode,
  getFileName,
  getPdfFileName,
  getDocxFileName,
  getHtmlFileName,
} from './utils';
import Swal from 'sweetalert2';
import { initUnicodePicker } from './unicode/picker';
import { TabManager, setTabManager, getEditorText, getEditorHtml, sanitizeNoteHtml } from './tabs';
import { initCloudSync } from './cloud/sync';
import { initCloudUI } from './cloud/ui';
import { initCloudShare } from './cloud/share';
import { initShareUI } from './cloud/share-ui';
import {
  initVoiceTyping,
  toggleVoiceTyping,
  isListening,
  stopVoiceTyping,
  handleTabSwitchedWhileListening,
} from './voice';

// Bootstrap 3's jQuery plugins (registered globally by the `bootstrap` import
// in main.ts) are not covered by @types/jquery. The `modal` member is also
// declared in utils.ts; identical declarations merge.
declare global {
  interface JQuery {
    modal(action: string | { [key: string]: unknown }): JQuery;
    tooltip(options?: Record<string, unknown>): JQuery;
  }
}

// The editor is a contenteditable <div id="note"> — see tabs.ts for the tab
// model and the storage format. Text readers go through getEditorText().

// `beforeinstallprompt` is not part of lib.dom's WindowEventMap.
declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

interface BreakReminderState {
  accumulatedMs: number;
  lastActivityAt: number;
  snoozedUntil: number;
  dismissedUntil: number;
}

$(document).ready(function () {
  const breakReminderConfig = {
    // Show the reminder after this much active writing time.
    thresholdMs: 30 * 60 * 1000,

    // Ignore gaps longer than this so idle time does not count as writing.
    idleWindowMs: 2 * 60 * 1000,

    // Cap how much time a single input event can add to the session.
    activitySliceMs: 15000,

    // Hide the reminder for this long when the user snoozes it.
    snoozeMs: 10 * 60 * 1000,

    // Duration of the actual break countdown once started.
    breakDurationMs: 2 * 60 * 1000,

    // Keep the reminder suppressed for this long after dismissal.
    dismissCooldownMs: 30 * 60 * 1000,

    // localStorage key used to persist reminder state across reloads.
    storageKey: 'breakReminderState',
  };

  const breakReminderDefaults = {
    accumulatedMs: 0,
    lastActivityAt: 0,
    snoozedUntil: 0,
    dismissedUntil: 0,
  };

  let breakReminderState = loadBreakReminderState();
  let breakReminderCountdownTimer: ReturnType<typeof setInterval> | null = null;
  let breakRemindersEnabled = false;

  function loadBreakReminderState(): BreakReminderState {
    const rawState = localStorage.getItem(breakReminderConfig.storageKey);

    if (!rawState) {
      return { ...breakReminderDefaults };
    }

    try {
      return {
        ...breakReminderDefaults,
        ...JSON.parse(rawState),
      };
    } catch (error) {
      return { ...breakReminderDefaults };
    }
  }

  function persistBreakReminderState(): void {
    localStorage.setItem(breakReminderConfig.storageKey, JSON.stringify(breakReminderState));
  }

  function clearBreakReminderState(): void {
    breakReminderState = { ...breakReminderDefaults };
    localStorage.removeItem(breakReminderConfig.storageKey);
  }

  function closeBreakReminderPopup(): void {
    const $breakPopup = $('#breakReminderPopup');
    $breakPopup.addClass('hide');
    $('#breakVeil').removeClass('active');
    setTimeout(function () {
      $breakPopup.removeClass('show hide break-active');
      $('#breakReminderActions').show();
      $('#takeBreakAction').text('Take break');
      $('#snoozeBreakAction').show();
      $('#dismissBreakAction').show();
      $('#breakReminderTitle').text('Time for a 2-minute break?');
      $('#breakReminderText').text('Stand up, stretch, or look away from the screen for a minute.');
    }, 300);

    if (breakReminderCountdownTimer) {
      clearInterval(breakReminderCountdownTimer);
      breakReminderCountdownTimer = null;
    }
  }

  function resetBreakReminderSession(): void {
    breakReminderState.accumulatedMs = 0;
    breakReminderState.lastActivityAt = 0;
    persistBreakReminderState();
  }

  function disableBreakReminders(): void {
    breakRemindersEnabled = false;
    closeBreakReminderPopup();
    clearBreakReminderState();
  }

  function enableBreakReminders(): void {
    breakRemindersEnabled = true;
    breakReminderState = loadBreakReminderState();
  }

  function shouldBlockBreakReminder(now: number): boolean {
    return now < breakReminderState.snoozedUntil || now < breakReminderState.dismissedUntil;
  }

  function showBreakReminderPopup(): void {
    if (!breakRemindersEnabled) {
      return;
    }

    if ($('#breakReminderPopup').hasClass('show')) {
      return;
    }
    const $breakPopup = $('#breakReminderPopup');
    $breakPopup.removeClass('hide break-active').addClass('show');
    $('#breakReminderActions').show();
    $('#takeBreakAction').text('Take break');
    $('#snoozeBreakAction').show();
    $('#dismissBreakAction').show();
    $('#breakReminderTitle').text('Time for a 2-minute break?');
    $('#breakReminderText').text('Stand up, stretch, or look away from the screen for a minute.');
  }

  function maybeShowBreakReminder(now: number = Date.now()): void {
    if (!breakRemindersEnabled || document.hidden || shouldBlockBreakReminder(now)) {
      return;
    }

    if (breakReminderState.accumulatedMs >= breakReminderConfig.thresholdMs) {
      showBreakReminderPopup();
    }
  }

  function trackWritingActivity(): void {
    if (!breakRemindersEnabled || document.hidden) {
      return;
    }

    const now = Date.now();

    if (breakReminderState.lastActivityAt) {
      const delta = now - breakReminderState.lastActivityAt;

      if (delta <= breakReminderConfig.idleWindowMs) {
        breakReminderState.accumulatedMs += Math.min(delta, breakReminderConfig.activitySliceMs);
      }
    }

    breakReminderState.lastActivityAt = now;
    persistBreakReminderState();
    maybeShowBreakReminder(now);
  }

  function formatBreakCountdown(msRemaining: number): string {
    const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
    const minutes = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');

    return `${minutes}:${seconds}`;
  }

  function startBreakCountdown(): void {
    const breakEndsAt = Date.now() + breakReminderConfig.breakDurationMs;

    breakReminderState.snoozedUntil = breakEndsAt;
    resetBreakReminderSession();
    persistBreakReminderState();

    $('#breakReminderPopup').addClass('break-active');
    $('#breakVeil').addClass('active');
    $('#breakReminderActions').show();
    $('#breakReminderTitle').text(formatBreakCountdown(breakReminderConfig.breakDurationMs));
    $('#breakReminderText').text('Relax your eyes. Unclench your jaw. Breathe.');
    $('#takeBreakAction').text('Back to writing');
    $('#snoozeBreakAction').hide();
    $('#dismissBreakAction').hide();

    if (breakReminderCountdownTimer) {
      clearInterval(breakReminderCountdownTimer);
    }

    breakReminderCountdownTimer = setInterval(() => {
      const msRemaining = breakEndsAt - Date.now();

      if (msRemaining <= 0) {
        clearInterval(breakReminderCountdownTimer!);
        breakReminderCountdownTimer = null;
        closeBreakReminderPopup();
        showToast('Break complete. Welcome back.');
        return;
      }

      $('#breakReminderTitle').text(formatBreakCountdown(msRemaining));
    }, 1000);
  }

  $('#closeBreakReminderPopup').on('click', function () {
    breakReminderState.dismissedUntil = Date.now() + breakReminderConfig.dismissCooldownMs;
    resetBreakReminderSession();
    persistBreakReminderState();
    closeBreakReminderPopup();
  });

  $('#takeBreakAction').on('click', function () {
    if ($('#breakReminderPopup').hasClass('break-active')) {
      closeBreakReminderPopup();
      return;
    }

    startBreakCountdown();
  });

  $('#snoozeBreakAction').on('click', function () {
    breakReminderState.snoozedUntil = Date.now() + breakReminderConfig.snoozeMs;
    breakReminderState.lastActivityAt = 0;
    persistBreakReminderState();
    closeBreakReminderPopup();
  });

  $('#dismissBreakAction').on('click', function () {
    breakReminderState.dismissedUntil = Date.now() + breakReminderConfig.dismissCooldownMs;
    resetBreakReminderSession();
    persistBreakReminderState();
    closeBreakReminderPopup();
  });

  const darkmodeText = 'Enable dark mode [Ctrl/Cmd + M]';
  const lightmodeText = 'Enable light mode [Ctrl/Cmd + M]';
  const darkMetaColor = '#0a0a0a';
  const lightMetaColor = '#ffffff';
  const metaThemeColor = document.querySelector('meta[name=theme-color]') as HTMLElement | null;
  const { notepad, state, setState, removeState } = selector();
  const optimalLineLengthPadding = '15px 15vw 40px';

  const editorConfig = selector().defaultConfig;

  const themeConfig = {
    lightmodeText,
    darkmodeText,
    lightMetaColor,
    darkMetaColor,
    metaThemeColor,
  };

  const unicodePicker = initUnicodePicker(notepad);

  // Note tabs — multiple notes inside the one editor, shown as a rail
  // on the left of the page (see tabs.ts).
  const tabManager = new TabManager(notepad.note);
  setTabManager(tabManager);
  tabManager.onActiveChanged = () => {
    updateWordCountPill(tabManager.getActiveText());
    handleTabSwitchedWhileListening();
  };
  tabManager.init();

  // Share links stay fresh through the persist hook (no-op without a
  // configured cloud project).
  initCloudShare(tabManager);

  // Voice typing (Web Speech API) — hides its own UI when unsupported.
  initVoiceTyping();

  // Cloud sync boots only when a sync project is configured; the UI
  // (navbar icon, modal, settings section) stays hidden otherwise.
  void initCloudSync(tabManager).then(() => {
    initCloudUI();
    initShareUI();
  });
  const characterAndWordCountText = calculateCharactersAndWords(tabManager.getActiveText());

  let typewriterSoundEnabled: boolean;
  const typeSound = new Audio('/sounds/typewriter/typewriter-key-press-02.mp3');
  const carriageReturnSound = new Audio('/sounds/typewriter/typewriter-carriage-return-01.mp3');
  const spacebarSound = new Audio('/sounds/typewriter/space.mp3');

  typeSound.volume = 0.2; // keep it subtle
  const userChosenTypewriterSound = state.userChosenTypewriterSound;
  const userChosenTypewriterVolume = state.userChosenTypewriterVolume;
  const userChosenExplodingEffect = state.userChosenExplodingEffect;

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
        const editorRect = notepad.note.get(0)?.getBoundingClientRect();
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
    const currentVolume = localStorage.getItem('userChosenTypewriterVolume');
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
        const currentVolume = localStorage.getItem('userChosenTypewriterVolume');
        s.volume = currentVolume
          ? Number(currentVolume) / 100
          : editorConfig.defaultTypewriterVolume / 100;
        s.play();
      }

      return;
    } else if (e.key === ' ') {
      if (typewriterSoundEnabled) {
        const s = spacebarSound.cloneNode() as HTMLAudioElement;
        const currentVolume = localStorage.getItem('userChosenTypewriterVolume');
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

  // Handle editor auto-scroll for long notes
  let pendingAutoScrollRaf: number | null = null;

  notepad.note.on('input', () => {
    if (pendingAutoScrollRaf) return;

    pendingAutoScrollRaf = requestAnimationFrame(() => {
      pendingAutoScrollRaf = null;

      const editor = notepad.note.get(0) as HTMLElement | undefined;
      if (!editor) return;

      // Only follow the caret when it sits at the very end
      // of the note (same rule the textarea used). While the
      // note floats in a Picture-in-Picture window, read the
      // selection from the document that owns the editor.
      const selection = editor.ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;

      const range = selection.getRangeAt(0);
      if (!editor.contains(range.startContainer)) return;

      const tail = editor.ownerDocument.createRange();
      tail.selectNodeContents(editor);
      tail.setStart(range.endContainer, range.endOffset);

      if (tail.toString().length === 0) {
        editor.scrollTop = editor.scrollHeight;
      }
    });
  });
  // Handle editor auto-scroll for long notes

  notepad.note.on('input', (e) => {
    trackWritingActivity();

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

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && breakRemindersEnabled) {
      breakReminderState.lastActivityAt = 0;
      persistBreakReminderState();
    }
  });

  // Handle typewriter sound toggle
  $('#typewriterSound').on('change', function () {
    const isEnabled = $(this).is(':checked');
    localStorage.setItem('userChosenTypewriterSound', isEnabled ? 'Yes' : 'No');
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
    setState('userChosenExplodingEffect', isEnabled ? 'Yes' : 'No');
    explodingEffectEnabled = isEnabled;
  });

  // Handle typewriter volume change
  let volumePreviewTimer: ReturnType<typeof setTimeout> | null = null;
  $('#typewriterVolume').on('input', function () {
    const volume = $(this).val() as string;
    localStorage.setItem('userChosenTypewriterVolume', volume);

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

  notepad.wordCount.text(characterAndWordCountText);

  // Keep execCommand producing plain tags (b/i/u/strike) rather than
  // inline CSS spans, so stored notes stay small and portable.
  try {
    document.execCommand('styleWithCSS', false, 'false');
  } catch {
    /* unsupported — tags are still the usual outcome */
  }

  // Paste always lands as plain text — the editor keeps its own
  // formatting (bold/italic/underline/strike) and nothing else.
  notepad.note.on('paste', (e) => {
    const event = e.originalEvent as ClipboardEvent | undefined;
    const text = event?.clipboardData?.getData('text/plain');
    if (text === null || text === undefined) {
      return; // no plain text available — let the browser decide
    }

    e.preventDefault();
    if (text.length === 0) {
      return;
    }

    if (!document.execCommand('insertText', false, text)) {
      // Fallback: splice a text node into the current range.
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        notepad.note.trigger('input');
      }
    }
  });

  $('[data-toggle="tooltip"]').tooltip({
    container: 'body',
  });

  if (!state.isUserPreferredTheme) {
    setState('isUserPreferredTheme', 'false');
  }

  if (state.userChosenFontSize) {
    notepad.note.css('font-size', state.userChosenFontSize + 'px');
    notepad.fontSize.val(state.userChosenFontSize);
  } else {
    resetFontSize(editorConfig.defaultFontSize);
  }

  if (state.userChosenFontWeight) {
    notepad.note.css('font-weight', state.userChosenFontWeight);
    notepad.fontWeight.val(state.userChosenFontWeight);
  } else {
    resetFontWeight(editorConfig.defaultFontWeight);
  }

  if (state.userChosenLineHeight) {
    notepad.note.css('line-height', state.userChosenLineHeight + 'px');
    notepad.lineHeight.val(state.userChosenLineHeight);
  } else {
    resetLineHeight(editorConfig.defaultLineHeight);
  }

  const userChosenWordCountPillSelected = state.userChosenWordCountPillSelected;

  if (userChosenWordCountPillSelected) {
    if (userChosenWordCountPillSelected === 'Yes') {
      notepad.wordCountContainer.show();
    } else {
      notepad.wordCountContainer.hide();
    }
    notepad.showWordCountPill.prop('checked', userChosenWordCountPillSelected === 'Yes');
  } else {
    notepad.wordCountContainer.show();
    notepad.showWordCountPill.prop('checked', true);
  }

  // The word count pill always uses the counter pill style.
  notepad.wordCountContainer.addClass('transparency');

  if (state.userChosenWriteDirection) {
    notepad.note.css('direction', state.userChosenWriteDirection);
    notepad.writeDirection.val(state.userChosenWriteDirection);
  } else {
    resetWriteDirection(editorConfig.defaultWriteDirection);
  }

  if (state.userChosenTexture) {
    const allowedTextures = [
      'normal',
      'dotted',
      'graph',
      'chessboard',
      'starfield',
      'grain',
      'linen',
      'recycled',
      'newspaper',
      'marble',
    ];

    if (allowedTextures.includes(state.userChosenTexture)) {
      $(document.body).removeClass(
        'dotted-paper graph-paper chessboard-paper starfield-paper grain-paper linen-paper recycled-paper newspaper-paper marble-paper',
      );

      if (state.userChosenTexture == 'dotted') {
        $(document.body).addClass('dotted-paper');
      } else if (state.userChosenTexture == 'graph') {
        $(document.body).addClass('graph-paper');
      } else if (state.userChosenTexture == 'chessboard') {
        $(document.body).addClass('chessboard-paper');
      } else if (state.userChosenTexture == 'starfield') {
        $(document.body).addClass('starfield-paper');
      } else if (state.userChosenTexture == 'grain') {
        $(document.body).addClass('grain-paper');
      } else if (state.userChosenTexture == 'linen') {
        $(document.body).addClass('linen-paper');
      } else if (state.userChosenTexture == 'recycled') {
        $(document.body).addClass('recycled-paper');
      } else if (state.userChosenTexture == 'newspaper') {
        $(document.body).addClass('newspaper-paper');
      } else if (state.userChosenTexture == 'marble') {
        $(document.body).addClass('marble-paper');
      }

      notepad.texture.val(state.userChosenTexture);
    } else {
      removeState('userChosenTexture');
      resetTexture(editorConfig.defaultTexture);
    }
  }

  if (state.userChosenOptimalLineLengthSelected) {
    const textArea = document.getElementById('note')!;

    if (state.userChosenOptimalLineLengthSelected === 'Yes') {
      textArea.style.padding = optimalLineLengthPadding;
    } else {
      textArea.style.padding = editorConfig.defaultOptimalLineLengthPadding;
    }

    notepad.optimalLineLength.prop('checked', state.userChosenOptimalLineLengthSelected === 'Yes');
  } else {
    notepad.optimalLineLength.prop('checked', false);
  }

  if (state.userChosenSpellCheck) {
    if (state.userChosenSpellCheck === 'Yes') {
      notepad.note.attr('spellcheck', true as unknown as string);
    } else {
      notepad.note.attr('spellcheck', false as unknown as string);
    }

    notepad.spellCheck.prop('checked', state.userChosenSpellCheck === 'Yes');
  } else {
    notepad.spellCheck.prop('checked', true);
  }

  if (state.userChosenBreakReminders) {
    const isBreakRemindersEnabled = state.userChosenBreakReminders === 'Yes';
    notepad.breakReminders.prop('checked', isBreakRemindersEnabled);

    if (isBreakRemindersEnabled) {
      enableBreakReminders();
    } else {
      disableBreakReminders();
    }
  } else {
    notepad.breakReminders.prop('checked', editorConfig.defaultBreakReminders);
    disableBreakReminders();
  }

  if (state.mode && state.mode === 'dark') {
    enableDarkMode(lightmodeText, darkMetaColor, metaThemeColor);

    $('input[name="themes"][value="dark"]').prop('checked', true);
  } else if (state.mode && state.mode === 'light') {
    enableLightMode(darkmodeText, lightMetaColor, metaThemeColor);

    $('input[name="themes"][value="light"]').prop('checked', true);
  } else {
    enableDeviceTheme(themeConfig);

    $('input[name="themes"][value="device"]').prop('checked', true);
  }

  const themeRadios = document.querySelectorAll('input[name="themes"]');

  themeRadios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      switch ((event.target as HTMLInputElement).value) {
        case 'dark':
          enableDarkMode(lightmodeText, darkMetaColor, metaThemeColor);
          break;
        case 'light':
          enableLightMode(darkmodeText, lightMetaColor, metaThemeColor);
          break;
        case 'device':
          enableDeviceTheme(themeConfig);
          break;
      }
    });
  });

  notepad.note.on(
    'input',
    debounce(function () {
      tabManager.saveActiveFromEditor();
      updateWordCountPill(tabManager.getActiveText());
    }, 500),
  );

  // ---- save-state indicator ----------------------------------------
  // "Saving…" appears while keystrokes are in flight, "Saved" flips on
  // when the debounced persist actually ran, then quietly fades out.
  const $saveState = $('#saveState');
  let saveFadeTimer: ReturnType<typeof setTimeout> | null = null;
  notepad.note.on('input', function () {
    if (saveFadeTimer) {
      clearTimeout(saveFadeTimer);
      saveFadeTimer = null;
    }
    $saveState
      .removeClass('fade')
      .addClass('saving')
      .removeAttr('hidden')
      .find('.save-state-text')
      .text('Saving…');
  });
  tabManager.addPersistListener(function () {
    $saveState.removeClass('saving').find('.save-state-text').text('Saved');
    saveFadeTimer = setTimeout(function () {
      saveFadeTimer = null;
      $saveState.addClass('fade');
    }, 2000);
  });

  // ---- left note rail (mobile drawer) --------------------------------
  const rail = document.getElementById('tabRail');
  const railBackdrop = document.getElementById('tabRailBackdrop');
  const railToggle = document.getElementById('tabRailToggle');
  if (rail && railBackdrop && railToggle) {
    const setRailOpen = function (open: boolean) {
      rail.classList.toggle('open', open);
      railBackdrop.classList.toggle('show', open);
      railToggle.setAttribute('aria-expanded', String(open));
    };

    railToggle.addEventListener('click', function () {
      setRailOpen(!rail.classList.contains('open'));
    });
    railBackdrop.addEventListener('click', function () {
      setRailOpen(false);
    });

    // Picking a note (or adding one) closes the drawer on phones.
    tabManager.addPersistListener(function () {
      if (rail.classList.contains('open') && window.matchMedia('(max-width: 820px)').matches) {
        setRailOpen(false);
      }
    });
    $(document).on('keydown', function (event) {
      if (event.key === 'Escape' && rail.classList.contains('open')) {
        setRailOpen(false);
      }
    });
  }

  notepad.note.keydown(function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();

      const selection = window.getSelection();
      const tabCharacter = '\t';

      const selectedText = selection && selection.rangeCount > 0 ? selection.toString() : '';

      if (!selection || selection.rangeCount === 0 || selectedText.indexOf('\n') === -1) {
        // Single caret/selection (no line spans): insert a tab.
        document.execCommand('insertText', false, tabCharacter);
        return;
      }

      // Multi-line selection: indent / outdent every line.
      const lines = selectedText.split('\n');
      const replacement = (
        e.shiftKey
          ? lines.map((line) =>
              line.startsWith(tabCharacter) ? line.substring(tabCharacter.length) : line,
            )
          : lines.map((line) => tabCharacter + line)
      ).join('\n');

      // Replace through a text node, then re-select it so
      // Tab/Shift+Tab can be applied repeatedly.
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const inserted = document.createTextNode(replacement);
      range.insertNode(inserted);

      const reselect = document.createRange();
      reselect.setStart(inserted, 0);
      reselect.setEnd(inserted, replacement.length);
      selection.removeAllRanges();
      selection.addRange(reselect);
      notepad.note.trigger('input');
    }
  });

  notepad.clearNotes.on('click', function () {
    deleteNotes();
  });

  notepad.copyToClipboard.click(function () {
    copyNotesToClipboard(getEditorText());
  });

  notepad.downloadNotes.click(function (e) {
    e.stopPropagation(); // Stop click event from bubbling
    $('#iconDropdown').toggleClass('show');
    $('#moreToolsDropdown').removeClass('show');
  });

  notepad.moreTools.click(function (e) {
    e.stopPropagation(); // Stop click event from bubbling
    $('#moreToolsDropdown').toggleClass('show');
    $('#iconDropdown').removeClass('show');
  });

  notepad.downloadNotesPlain.click(function () {
    saveTextAsFile(getEditorText(), getFileName());
  });

  notepad.downloadNotesPdf.click(function () {
    exportNotesAsPDF(getEditorText(), getPdfFileName());
  });

  notepad.downloadNotesDocx.click(function () {
    const textToWrite = getEditorText();
    const fileNameToSaveAs = getDocxFileName();

    exportNotesAsDocx(textToWrite, fileNameToSaveAs);
  });

  notepad.downloadNotesHtml.click(function () {
    // HTML export keeps the formatting the editor rendered.
    downloadHTML(sanitizeNoteHtml(getEditorHtml()), getHtmlFileName());
  });

  // Close dropdown if clicked outside
  $(document).on('click', function () {
    $('#iconDropdown').removeClass('show');
    $('#moreToolsDropdown').removeClass('show');
  });

  notepad.fullScreenButton.click(function () {
    toggleFullScreen();
  });

  notepad.focusModeButton.click(function () {
    toggleFocusMode(notepad);
  });

  notepad.focusModeCloseButton.click(function () {
    turnOffFocusMode(notepad);
  });

  // Update statistics when modal is shown
  notepad.statisticsModal.on('show.bs.modal', function () {
    const stats = calculateNoteStatistics(getEditorText());

    $('#statWords').text(stats.words);
    $('#statCharacters').text(stats.characters);
    $('#statSentences').text(stats.sentences);
    $('#statParagraphs').text(stats.paragraphs);
    $('#statAvgWordLength').text(stats.averageWordLength);
    $('#statReadingTime').text(stats.readingTime);
    $('#statUniqueWords').text(stats.uniqueWords);
    $('#statMostCommonWord').text(stats.mostCommonWord);
    $('#statLexicalDensity').text(stats.lexicalDensityScore);
    $('#statReadabilityScore').text(stats.readabilityScore);
    $('#statEstimatedPages').text(stats.estimatedPages);
    $('#statEstimatedSpeakingTime').text(stats.estimatedSpeakingTime);
  });

  notepad.fontSize.on('change', function () {
    const fontSizeSelected = (this as HTMLSelectElement).value;

    notepad.note.css('font-size', fontSizeSelected + 'px');
    setState('userChosenFontSize', fontSizeSelected);
  });

  notepad.lineHeight.on('change', function () {
    const lineHeightSelected = (this as HTMLSelectElement).value;

    notepad.note.css('line-height', lineHeightSelected + 'px');
    setState('userChosenLineHeight', lineHeightSelected);
  });

  notepad.fontWeight.on('change', function () {
    const fontWeightSelected = (this as HTMLSelectElement).value;

    notepad.note.css('font-weight', fontWeightSelected);
    setState('userChosenFontWeight', fontWeightSelected);
  });

  notepad.writeDirection.on('change', function () {
    const writeDirectionSelected = (this as HTMLSelectElement).value;

    notepad.note.css('direction', writeDirectionSelected);
    setState('userChosenWriteDirection', writeDirectionSelected);
  });

  notepad.texture.on('change', function () {
    const textureSelected = (this as HTMLSelectElement).value;

    $(document.body).removeClass(
      'dotted-paper graph-paper chessboard-paper starfield-paper grain-paper linen-paper recycled-paper newspaper-paper marble-paper',
    );

    if (textureSelected == 'dotted') {
      $(document.body).addClass('dotted-paper');
    } else if (textureSelected == 'graph') {
      $(document.body).addClass('graph-paper');
    } else if (textureSelected == 'chessboard') {
      $(document.body).addClass('chessboard-paper');
    } else if (textureSelected == 'starfield') {
      $(document.body).addClass('starfield-paper');
    } else if (textureSelected == 'grain') {
      $(document.body).addClass('grain-paper');
    } else if (textureSelected == 'linen') {
      $(document.body).addClass('linen-paper');
    } else if (textureSelected == 'recycled') {
      $(document.body).addClass('recycled-paper');
    } else if (textureSelected == 'newspaper') {
      $(document.body).addClass('newspaper-paper');
    } else if (textureSelected == 'marble') {
      $(document.body).addClass('marble-paper');
    }

    setState('userChosenTexture', textureSelected);
  });

  notepad.showWordCountPill.on('change', function () {
    if ($(this).is(':checked')) {
      notepad.wordCountContainer.show();
      setState('userChosenWordCountPillSelected', 'Yes');
    } else {
      notepad.wordCountContainer.hide();
      setState('userChosenWordCountPillSelected', 'No');
    }
  });

  notepad.clearTabIndentation.on('click', function () {
    const noteText = getEditorText();
    const tabCount = (noteText.match(/\t/g) || []).length;

    if (tabCount === 0) {
      showToast('No tab indentation found in your notes.');
      return;
    }

    Swal.fire({
      title: 'Remove all tabs?',
      text: `This will remove ${tabCount} tab${tabCount === 1 ? '' : 's'} of indentation from your notes.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Remove tabs',
    }).then((result) => {
      if (!result.isConfirmed) {
        return;
      }

      const applyEdit = () => {
        // Strip tab characters from every text node in
        // the editor (formatting tags are untouched).
        const editor = notepad.note.get(0) as HTMLElement;
        let removed = 0;

        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        while (walker.nextNode()) {
          textNodes.push(walker.currentNode as Text);
        }

        textNodes.forEach((node) => {
          if (node.nodeValue && node.nodeValue.indexOf('\t') !== -1) {
            removed += (node.nodeValue.match(/\t/g) || []).length;
            node.nodeValue = node.nodeValue.replace(/\t/g, '');
          }
        });

        editor.dispatchEvent(new Event('input', { bubbles: true }));
        updateWordCountPill(getEditorText());
        showToast(`Removed ${removed} tab${removed === 1 ? '' : 's'} from your notes.`);
      };

      // Bootstrap modals hold focus while fading out — wait
      // for the dialog to be gone before touching the DOM.
      if ($('#preferencesModal').hasClass('in')) {
        $('#preferencesModal').one('hidden.bs.modal', applyEdit);
        $('#preferencesModal').modal('hide');
      } else {
        applyEdit();
      }
    });
  });

  notepad.optimalLineLength.on('change', function () {
    const textArea = document.getElementById('note')!;

    if ($(this).is(':checked')) {
      textArea.style.padding = optimalLineLengthPadding;
      setState('userChosenOptimalLineLengthSelected', 'Yes');
    } else {
      textArea.style.padding = editorConfig.defaultOptimalLineLengthPadding;
      setState('userChosenOptimalLineLengthSelected', 'No');
    }
  });

  notepad.spellCheck.on('change', function () {
    if ($(this).is(':checked')) {
      notepad.note.attr('spellcheck', true as unknown as string);
      setState('userChosenSpellCheck', 'Yes');
    } else {
      notepad.note.attr('spellcheck', false as unknown as string);
      setState('userChosenSpellCheck', 'No');
    }
  });

  notepad.breakReminders.on('change', function () {
    const isEnabled = $(this).is(':checked');
    setState('userChosenBreakReminders', isEnabled ? 'Yes' : 'No');

    if (isEnabled) {
      enableBreakReminders();
    } else {
      disableBreakReminders();
    }
  });

  notepad.resetPreferences.click(function () {
    if (selector().state.userChosenFontSize) {
      removeState('userChosenFontSize');
      resetFontSize(editorConfig.defaultFontSize);
    }

    if (selector().state.userChosenLineHeight) {
      removeState('userChosenLineHeight');
      resetLineHeight(editorConfig.defaultLineHeight);
    }

    if (selector().state.userChosenFontWeight) {
      removeState('userChosenFontWeight');
      resetFontWeight(editorConfig.defaultFontWeight);
    }

    if (selector().state.userChosenWordCountPillSelected) {
      removeState('userChosenWordCountPillSelected');
      resetShowWordCountPill(editorConfig.defaultShowWordCountPill);
    }

    if (selector().state.userChosenWriteDirection) {
      removeState('userChosenWriteDirection');
      resetWriteDirection(editorConfig.defaultWriteDirection);
    }

    if (selector().state.userChosenTexture) {
      removeState('userChosenTexture');
      resetTexture(editorConfig.defaultTexture);
    }

    if (selector().state.userChosenOptimalLineLengthSelected) {
      removeState('userChosenOptimalLineLengthSelected');
      resetOptimalLineLength(
        editorConfig.defaultOptimalLineLengthPadding,
        editorConfig.defaultOptimalLineLength,
      );
    }

    if (selector().state.selectedFont) {
      removeState('selectedFont');
      resetFont(editorConfig.defaultFont);
    }

    if (selector().state.userChosenSpellCheck) {
      removeState('userChosenSpellCheck');
      notepad.note.attr('spellcheck', false as unknown as string);
      notepad.spellCheck.prop('checked', editorConfig.defaultSpellCheck);
    }

    // Tab indentation is always enabled now — drop any legacy state.
    if (selector().state.userChosenTabIndentation) {
      removeState('userChosenTabIndentation');
    }

    if (selector().state.userChosenTypewriterSound) {
      removeState('userChosenTypewriterSound');
      typewriterSoundEnabled = editorConfig.defaultTypewriterSound;
      $('#typewriterSound').prop('checked', typewriterSoundEnabled);
      $('.typewriter-switch-volume').hide();
    }

    if (selector().state.userChosenTypewriterVolume) {
      removeState('userChosenTypewriterVolume');
      $('#typewriterVolume').val(editorConfig.defaultTypewriterVolume);
      $('#typewriterVolumeValue').text(editorConfig.defaultTypewriterVolume + '%');
    }

    if (selector().state.userChosenBreakReminders) {
      removeState('userChosenBreakReminders');
    }

    disableBreakReminders();
    notepad.breakReminders.prop('checked', editorConfig.defaultBreakReminders);

    if (selector().state.userChosenExplodingEffect) {
      removeState('userChosenExplodingEffect');
      explodingEffectEnabled = editorConfig.defaultExplodingEffect;
      $('#explodingEffect').prop('checked', explodingEffectEnabled);
    }

    // Reset to device theme as default
    $('input[name="themes"][value="device"]').prop('checked', true);
    enableDeviceTheme(themeConfig);
  });

  const pipButton = document.getElementById('pip')!;

  // Only show the Picture-in-Picture
  // button if the browser supports it
  if ('documentPictureInPicture' in window) {
    $('#pipContainer').show();

    let pipWindow: Window | null = null;
    let pipThemeObserver: MutationObserver | null = null;
    let pipSwitching = false;

    /** Mirrors the app's dark mode onto the floating editor. */
    const applyPipTheme = () => {
      if (!pipWindow) return;
      pipWindow.document.body.classList.toggle('dark', document.body.classList.contains('dark'));
    };

    const syncPipButton = () => {
      $('#pip').attr('title', pipWindow ? 'Close Floating Window' : 'Activate Floating Window');
    };

    pipButton.addEventListener('click', async () => {
      if (pipSwitching) return;

      // The button toggles: while a floating window is open,
      // clicking again closes it instead of opening a second
      // one (which used to race the close handler and could
      // leave the editor stranded in the wrong document).
      if (pipWindow) {
        pipWindow.close();
        return;
      }

      const appTextarea = document.getElementById('textareaContainer');

      if (!appTextarea) return;

      pipSwitching = true;
      try {
        // Open a Picture-in-Picture window. The API can
        // reject (blocked iframe, too many windows, no
        // user gesture) — tell the user instead of
        // leaving a silent unhandled rejection.
        let newPipWindow: Window;
        try {
          newPipWindow = await documentPictureInPicture!.requestWindow({
            width: 350,
            height: 500,
          });
        } catch {
          showToast('The floating window could not be opened. Try again.');
          return;
        }
        pipWindow = newPipWindow;

        // Move the editor back into the main window
        // when the floating window closes (X button,
        // Escape, or the PiP button again).
        newPipWindow.addEventListener('pagehide', () => {
          pipWindow = null;
          pipThemeObserver?.disconnect();
          pipThemeObserver = null;
          syncPipButton();

          const floatingEditor = newPipWindow.document.getElementById('textareaContainer');
          newPipWindow.document.body?.classList.remove('pip-host', 'dark');

          if (floatingEditor) {
            // Restore it to its exact original slot: the
            // last child of #editorShell, next to the note
            // rail (appending to #mainContainer used to drop
            // it outside the shell's flex layout).
            const editorShell = document.getElementById('editorShell');
            (editorShell ?? document.getElementById('mainContainer'))?.append(floatingEditor);
            floatingEditor.classList.remove('dark');
          }

          document.getElementById('mainContainer')?.classList.remove('pip');
          const overlay = document.querySelector('.overlay') as HTMLElement | null;
          if (overlay) {
            overlay.style.display = 'none';
            overlay.style.pointerEvents = 'none';
          }

          // Bring the caret back so typing can continue
          // right where it left off.
          const mainEditor = document.getElementById('note');
          mainEditor?.focus({ preventScroll: true });
        });

        newPipWindow.document.title = 'Padify — Floating note';

        Array.from(document.styleSheets).forEach((styleSheet) => {
          try {
            const cssRules = Array.from(styleSheet.cssRules)
              .map((rule) => rule.cssText)
              .join('');
            const style = document.createElement('style');

            style.textContent = cssRules;
            newPipWindow.document.head.appendChild(style);
          } catch {
            const link = document.createElement('link');

            link.rel = 'stylesheet';
            link.type = styleSheet.type;
            link.media = styleSheet.media as unknown as string;
            link.href = styleSheet.href!;
            newPipWindow.document.head.appendChild(link);
          }
        });

        // Move the editor into the floating window.
        newPipWindow.document.body.append(appTextarea);
        newPipWindow.document.body.classList.add('pip-host');
        applyPipTheme();

        // Keep the theme in sync while floating (the
        // observer fires for every body class change,
        // so radio picks, reset and device theme all
        // propagate).
        pipThemeObserver = new MutationObserver(applyPipTheme);
        pipThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        // Keyboard support inside the floating window:
        // Escape closes it, the format shortcuts edit,
        // Ctrl/Cmd+S exports the note.
        newPipWindow.document.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            newPipWindow.close();
            return;
          }

          const target = event.target as HTMLElement | null;
          if (!target || (target.id !== 'note' && target.closest('#note') === null)) return;

          if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            let command: string | null = null;
            if (event.shiftKey && event.code === 'KeyX') {
              command = 'strikeThrough';
            } else if (!event.shiftKey) {
              if (event.code === 'KeyB') command = 'bold';
              else if (event.code === 'KeyI') command = 'italic';
              else if (event.code === 'KeyU') command = 'underline';
              else if (event.code === 'KeyS') {
                event.preventDefault();
                saveTextAsFile(getEditorText(), getFileName());
                return;
              }
            }
            if (command) {
              event.preventDefault();
              try {
                newPipWindow.document.execCommand(command);
              } catch {
                /* command unsupported in this browser */
              }
            }
          }
        });

        // Put the caret at the end of the note so the
        // floating window is immediately typeable.
        const editor = newPipWindow.document.getElementById('note');
        if (editor) {
          editor.focus({ preventScroll: true });
          const selection = newPipWindow.document.getSelection();
          if (selection) {
            const range = newPipWindow.document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }

        syncPipButton();
      } finally {
        pipSwitching = false;
      }
    });

    documentPictureInPicture!.addEventListener('enter', () => {
      const mainContainer = document.querySelector('#mainContainer');
      const overlay = document.querySelector('.overlay') as HTMLElement | null;

      mainContainer?.classList.add('pip');
      if (overlay) {
        overlay.style.display = 'block';
        overlay.style.pointerEvents = 'all';
      }

      // Dictation drives the main window's selection — stop
      // it when the note moves into the floating window.
      if (isListening()) {
        stopVoiceTyping();
      }

      applyPipTheme();
    });
  }

  // This changes the application's theme when
  // user toggles device's theme preference
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.mode && state.mode === 'device') {
      enableDeviceTheme(themeConfig);
    }
  });

  // This hides the install app button
  // if the app is already installed
  if (getPWADisplayMode() === 'standalone') {
    notepad.installApp.hide();
  }

  window.matchMedia('(display-mode: standalone)').addEventListener('change', ({ matches }) => {
    if (matches) {
      notepad.installApp.hide();
    } else {
      notepad.installApp.show();
    }
  });

  // This listens for keyboard shortcuts
  document.onkeydown = function (event: KeyboardEvent) {
    event = event || (window.event as KeyboardEvent);

    if (event.key === 'Escape') {
      $('.modal').modal('hide');
      $('#iconDropdown').removeClass('show');
      $('#moreToolsDropdown').removeClass('show');
      // Only exit focus mode when it is actually on — otherwise
      // every Escape keypress (context menu, dialogs, etc.)
      // yanked focus back to the note textarea.
      if (document.documentElement.hasAttribute('data-focus-mode')) {
        turnOffFocusMode(notepad);
      }
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
      saveTextAsFile(getEditorText(), getFileName());
      event.preventDefault();
    }

    if (event.altKey && event.code === 'KeyS') {
      exportNotesAsPDF(getEditorText(), getPdfFileName());
      event.preventDefault();
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'Comma') {
      event.preventDefault();

      if (notepad.preferencesModal.hasClass('in')) return;

      $('.modal').modal('hide');
      notepad.preferencesModal.modal('show');
    }

    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
      event.preventDefault();

      if (notepad.keyboardShortcutsModal.hasClass('in')) return;

      $('.modal').modal('hide');
      notepad.keyboardShortcutsModal.modal('show');
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyO') {
      event.preventDefault();
      unicodePicker.open();
    }

    if (event.altKey && event.code === 'KeyC') {
      event.preventDefault();
      copyNotesToClipboard(getEditorText());
    }

    if (
      (event.ctrlKey && event.shiftKey && event.code === 'Delete') ||
      (event.metaKey && event.shiftKey && event.code === 'Backspace')
    ) {
      event.preventDefault();
      deleteNotes();
    }

    if (event.altKey && event.code === 'KeyF') {
      event.preventDefault();

      toggleFocusMode(notepad);
    }

    // Alt/option + v toggles voice typing.
    if (event.altKey && event.code === 'KeyV') {
      event.preventDefault();
      toggleVoiceTyping();
    }

    // Ctrl/Cmd + Alt + Arrow keys move between note tabs.
    if (
      (event.ctrlKey || event.metaKey) &&
      event.altKey &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      tabManager.cycle(event.key === 'ArrowRight' ? 1 : -1);
    }
  };

  // Font selection handler
  const fontSelect = document.getElementById('font') as HTMLSelectElement;

  // Check for legacy font preferences and migrate them to the new system
  function migrateLegacyFontPrefs(): void {
    const dyslexicFont = localStorage.getItem('dyslexicFont') === 'true';
    const monospacedFont = localStorage.getItem('monospaced') === 'true';
    const serifFont = localStorage.getItem('serifFont') === 'true';

    if (dyslexicFont) {
      localStorage.setItem('selectedFont', 'dyslexic');
    } else if (monospacedFont) {
      localStorage.setItem('selectedFont', 'monospaced');
    } else if (serifFont) {
      localStorage.setItem('selectedFont', 'serif');
    } else {
      localStorage.setItem('selectedFont', 'default');
    }

    // Clear old preferences
    localStorage.removeItem('dyslexicFont');
    localStorage.removeItem('monospaced');
    localStorage.removeItem('serifFont');
  }

  // Apply font based on selection
  function applyFont(fontType: string): void {
    // Remove all font classes first
    notepad.note.removeClass(
      'dyslexic monospaced serif handwritten humanist pixel typewriter crayon',
    );

    // Add the selected font class
    switch (fontType) {
      case 'dyslexic':
        notepad.note.addClass('dyslexic');
        break;
      case 'monospaced':
        notepad.note.addClass('monospaced');
        break;
      case 'serif':
        notepad.note.addClass('serif');
        break;
      case 'handwritten':
        notepad.note.addClass('handwritten');
        break;
      case 'humanist':
        notepad.note.addClass('humanist');
        break;
      case 'pixel':
        notepad.note.addClass('pixel');
        break;
      case 'typewriter':
        notepad.note.addClass('typewriter');
        break;
      case 'crayon':
        notepad.note.addClass('crayon');
        break;
      // 'default' case doesn't need any class
    }
  }

  // Initialize font selection
  function initFontSelection(): void {
    // Migrate legacy preferences if needed
    if (
      localStorage.getItem('dyslexicFont') !== null ||
      localStorage.getItem('monospaced') !== null ||
      localStorage.getItem('serifFont') !== null
    ) {
      migrateLegacyFontPrefs();
    }

    // Get the selected font or default to 'default'
    const selectedFont = localStorage.getItem('selectedFont') || 'default';

    // Set the dropdown value
    fontSelect.value = selectedFont;

    // Apply the font
    applyFont(selectedFont);
  }

  // Handle font selection change
  fontSelect.addEventListener('change', (e) => {
    const selectedFont = (e.target as HTMLSelectElement).value;
    localStorage.setItem('selectedFont', selectedFont);
    applyFont(selectedFont);
  });

  // Initialize font selection on page load
  initFontSelection();
});

document.addEventListener('fullscreenchange', function () {
  if (!document.fullscreenElement) {
    $('#arrowPointsIn').hide();
    $('#arrowPointsOut').show();
  }
});

// Registering ServiceWorker
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').then(
    function (registration) {
      // Registration was successful
      console.log('ServiceWorker registration successful with scope: ', registration.scope);
    },
    function (err) {
      // registration failed :(
      console.log('ServiceWorker registration failed: ', err);
    },
  );
}

let deferredPrompt: BeforeInstallPromptEvent | null;

window.addEventListener('beforeinstallprompt', (e) => {
  selector().notepad.installAppButtonContainer.show();
  deferredPrompt = e;

  e.userChoice.then(function (choiceResult) {
    if (choiceResult.outcome === 'accepted') {
      deferredPrompt = null;
    }
  });
});

const installApp = document.getElementById('installApp')!;

installApp.addEventListener('click', async () => {
  if (deferredPrompt !== null) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredPrompt = null;
    }
  } else {
    showToast('Padify is already installed.');
  }
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
});
