/**
 * Padify voice typing — dictation for the main editor via the Web Speech API.
 *
 * Click the mic in the navbar (or press alt/option + v) and speak; final
 * results are inserted at the caret as plain text through execCommand so the
 * browser's native undo keeps working. Interim results are shown live in a
 * floating bar above the editor.
 *
 * Behaviour notes:
 *  • Browsers end recognition after a pause, so while dictation is active we
 *    transparently restart until the user stops — one "Done" ends the session.
 *  • Nothing is inserted until a result is final, so the editor content never
 *    contains half-heard words.
 *  • Every failure path (no support, denied permission, offline) degrades to
 *    an honest toast and leaves the editor untouched.
 */

import { $, type Q } from './lib/q';
import { showToast } from './ui/toast';
import { getEditorPort } from './editor/port';
import { getTabManager, insertTextIntoActiveNote } from './tabs';
import { isHtmlContent, isMarkdownNote } from './editor/note-types';
import {
  markdownCharBeforeCaret,
  markdownSourceTextarea,
} from './editor/markdown/surface';

// ---------------------------------------------------------------------------
// Minimal typings for the Web Speech API (not in the default DOM lib)
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let recognition: SpeechRecognitionLike | null = null;
let listening = false;
let userWantsStop = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let supported = false;
/** Consecutive no-speech failures — two in a row with no audio in between
 *  is the signature of a microphone blocked at the DEVICE level (muted in
 *  the OS, a hardware privacy switch, another app holding the mic): the
 *  permission was granted, the engine runs, and yet nothing ever arrives.
 *  One strike is still an ordinary pause. */
let noSpeechStrikes = 0;
/** True while the device-block error state is showing (the bar stays up
 *  with the explanation until the user closes it). */
let showingMicError = false;

const RESTART_DELAY_MS = 250;
/** Consecutive no-speech events before the device-block error state. */
const NO_SPEECH_STRIKE_LIMIT = 2;

// ---------------------------------------------------------------------------
// Voice-bar lifecycle — the bar enters on a keyframe and must also LEAVE on
// one. Hiding it with a bare display:none snap against a 0.24s eased
// entrance read as a glitch, so every hide path rides .closing and waits
// for the animation (with a timer fallback for reduced-motion, where the
// animation is suppressed and `animationend` never fires).
// ---------------------------------------------------------------------------

/** Just past voice-bar-out's 160ms — the fallback for a swallowed
 *  `animationend`. */
const VOICE_BAR_EXIT_MS = 240;

let voiceBarExitTimer: ReturnType<typeof setTimeout> | null = null;

function voiceBarElement(): HTMLElement | null {
  const el = voiceBar().get(0);
  return el instanceof HTMLElement ? el : null;
}

/** Cancels a closing animation in progress — used when the bar is shown
 *  again mid-exit (a fresh session while the exit is still playing). */
function cancelVoiceBarExit(): void {
  if (voiceBarExitTimer) {
    clearTimeout(voiceBarExitTimer);
    voiceBarExitTimer = null;
  }
  const el = voiceBarElement();
  if (el) {
    el.classList.remove('closing');
  }
}

/** Hides the bar through its closing animation, then sets `hidden`. */
function hideVoiceBar(): void {
  const el = voiceBarElement();
  if (!el || el.hasAttribute('hidden')) {
    return;
  }
  cancelVoiceBarExit();
  el.classList.add('closing');
  const finish = (): void => {
    if (voiceBarExitTimer) {
      clearTimeout(voiceBarExitTimer);
      voiceBarExitTimer = null;
    }
    el.classList.remove('closing');
    voiceBar().attr('hidden', 'hidden');
  };
  el.addEventListener('animationend', finish, { once: true });
  voiceBarExitTimer = setTimeout(() => {
    voiceBarExitTimer = null;
    el.removeEventListener('animationend', finish);
    finish();
  }, VOICE_BAR_EXIT_MS);
}

// ---------------------------------------------------------------------------
// Insertion helpers — every path through the ACTIVE note's surface
// ---------------------------------------------------------------------------

/**
 * The dictation target: markdown notes take their own editor's caret,
 * html notes ride the EditorPort. One interface so the smart-spacing
 * logic below is shared verbatim.
 */
interface DictationTarget {
  focus(): void;
  charBefore(): string;
  insert(text: string): void;
}

function dictationTarget(): DictationTarget | null {
  const active = getTabManager()?.getActive();
  if (active && isMarkdownNote(active)) {
    const source = markdownSourceTextarea();
    if (!source) {
      return null;
    }
    return {
      focus: () => source.focus(),
      charBefore: () => markdownCharBeforeCaret(),
      insert: (text) => {
        insertTextIntoActiveNote(text);
      },
    };
  }
  const port = getEditorPort();
  if (!port) {
    return null;
  }
  return {
    focus: () => port.focus(),
    charBefore: () => port.charBeforeCaret(),
    insert: (text) => {
      port.insertText(text);
    },
  };
}

/**
 * Inserts dictated text at the caret with tidy spacing/capitalisation.
 * All caret positioning and insertion go through the ACTIVE note's
 * surface (the EditorPort for html notes, the Markdown surface for
 * markdown notes) — this module never touches the editor DOM directly.
 */
function insertDictation(text: string): void {
  if (!text.trim()) {
    return;
  }
  const target = dictationTarget();
  if (!target) {
    return;
  }

  target.focus();

  let insertText = text.trim().replace(/\s+/g, ' ');

  const previous = target.charBefore();
  if (previous) {
    // New sentence → capitalise; mid-sentence → separate with a space
    // unless the dictation itself opens with punctuation.
    if (/[.!?…]$/.test(previous)) {
      insertText = insertText.charAt(0).toUpperCase() + insertText.slice(1);
      insertText = ` ${insertText}`;
    } else if (!/\s$/.test(previous) && !/^[,.;:!?…»'")\]}]/.test(insertText)) {
      insertText = ` ${insertText}`;
    }
  } else {
    insertText = insertText.charAt(0).toUpperCase() + insertText.slice(1);
  }

  // Trailing space keeps consecutive dictation bursts (and hand typing after
  // a burst) from gluing words together.
  target.insert(`${insertText} `);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function voiceBar(): Q {
  return $('#voiceBar');
}

/** Re-runs the text-swap keyframes — a CSS animation restarts only via a
 *  reflow between the class remove and add. */
function retriggerVoiceTextSwap(): void {
  const el = $('#voiceBarText').get(0);
  if (el instanceof HTMLElement) {
    el.classList.remove('voice-text-swap');
    void el.offsetWidth;
    el.classList.add('voice-text-swap');
  }
}

function setBarInterim(interim: string | null): void {
  const $text = $('#voiceBarText');
  const next = interim ?? 'Listening…';
  // Identical interim frame — no repaint, and crucially no restart of the
  // swap animation (the engine emits repeated interim payloads).
  if ($text.text() === next) {
    return;
  }
  $text.toggleClass('interim', interim !== null);
  $text.text(next);
  retriggerVoiceTextSwap();
}

function renderListeningUI(active: boolean): void {
  $('#voiceTypeButton').toggleClass('listening', active).attr('aria-pressed', String(active));
  const bar = voiceBar();
  if (active) {
    // A re-show while the exit animation is mid-flight must cancel that
    // exit — otherwise it finishes and yanks the bar out from under the
    // new session.
    cancelVoiceBarExit();
    bar.removeAttr('hidden');
  } else {
    hideVoiceBar();
  }
  if (active) {
    setBarInterim(null);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function handleResult(event: SpeechRecognitionEventLike): void {
  let interim = '';

  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    const transcript = result[0]?.transcript ?? '';
    if (result.isFinal) {
      insertDictation(transcript);
    } else {
      interim += transcript;
    }
  }

  // Audio arrived — whatever the strikes counted, the mic works.
  noSpeechStrikes = 0;

  setBarInterim(interim.trim() ? interim : null);
}

/** The user-facing explanation for a mic the DEVICE has silenced. */
const MIC_BLOCKED_MESSAGE =
  'No voice detected. Your microphone may be muted at the system level, blocked by a privacy switch, or in use by another app.';

/** Error codes that should end the session with a human explanation. */
function fatalErrorMessage(code: string): string | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow it in your browser settings and try again.';
    case 'audio-capture':
      return 'No microphone was found on this device.';
    case 'network':
      return 'Voice typing needs an internet connection. Check yours and try again.';
    case 'language-not-supported':
      return `Voice typing doesn't support the language "${navigator.language}" in this browser.`;
    default:
      return null;
  }
}

/** Enters the device-block error state: the session ends, the bar stays
 *  up carrying the explanation (a toast would vanish mid-read), the mic
 *  button keeps the error face until the user closes it. */
function showMicBlockedError(): void {
  showingMicError = true;
  listening = false;
  userWantsStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  try {
    recognition?.abort();
  } catch {
    /* already gone — harmless */
  }
  recognition = null;

  $('#voiceTypeButton')
    .removeClass('listening')
    .addClass('voice-error')
    .attr('aria-pressed', 'false');
  const bar = voiceBar();
  cancelVoiceBarExit();
  bar.removeAttr('hidden').addClass('error');
  $('#voiceBarText')
    .text(MIC_BLOCKED_MESSAGE)
    .removeClass('interim')
    .attr('title', MIC_BLOCKED_MESSAGE);
  retriggerVoiceTextSwap();
}

/** Leaves the error state (Done, Escape, or a fresh session). */
function clearMicError(): void {
  showingMicError = false;
  noSpeechStrikes = 0;
  $('#voiceTypeButton').removeClass('voice-error');
  const bar = voiceBar();
  bar.removeClass('error');
  $('#voiceBarText').removeAttr('title');
  hideVoiceBar();
}

function handleError(event: SpeechRecognitionErrorEventLike): void {
  const fatal = fatalErrorMessage(event.error);
  if (fatal) {
    showToast(fatal);
    stopListening();
    return;
  }

  if (event.error === 'no-speech') {
    // One strike is an ordinary pause. Two with no audio in between is
    // the device-block signature — say so instead of listening into the
    // void behind a dancing waveform.
    noSpeechStrikes += 1;
    if (noSpeechStrikes >= NO_SPEECH_STRIKE_LIMIT) {
      showMicBlockedError();
    }
    return;
  }

  // 'aborted' is our own stop/abort — nothing to tell the user.
}

function startRecognition(): void {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    return;
  }

  const next = new Ctor();
  next.lang = navigator.language || 'en-US';
  next.continuous = true;
  next.interimResults = true;
  next.maxAlternatives = 1;

  next.onresult = handleResult;
  next.onerror = handleError;
  next.onend = () => {
    // Browsers end recognition on silence — restart while the user still
    // wants the session open, with a small guard against hot loops. The
    // error state (device-blocked mic) does not restart.
    if (listening && !userWantsStop && !showingMicError) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (listening && !userWantsStop && !showingMicError) {
          try {
            recognition?.start();
          } catch {
            /* already started — harmless */
          }
        }
      }, RESTART_DELAY_MS);
    }
  };

  recognition = next;

  try {
    next.start();
    listening = true;
    userWantsStop = false;
    renderListeningUI(true);
  } catch {
    recognition = null;
    listening = false;
    renderListeningUI(false);
    showToast('Voice typing could not start. Try again.');
  }
}

export function startVoiceTyping(): void {
  if (listening) {
    return;
  }

  if (showingMicError) {
    // A fresh click is a fresh attempt — the error state stands down.
    clearMicError();
  }

  if (!supported) {
    showToast("Voice typing isn't supported in this browser.");
    return;
  }

  // Park the caret in the note first so the very first words land in it.
  const target = dictationTarget();
  if (!target) {
    showToast("The editor isn't ready yet — try again in a moment.");
    return;
  }
  target.focus();

  startRecognition();
}

export function stopVoiceTyping(): void {
  stopListening();
}

function stopListening(): void {
  userWantsStop = true;
  listening = false;
  noSpeechStrikes = 0;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  try {
    recognition?.stop();
  } catch {
    /* already stopped — harmless */
  }
  recognition = null;

  renderListeningUI(false);
}

/** Toggled by the mic button and alt/option + v. */
export function toggleVoiceTyping(): void {
  // Dictation rides the ACTIVE note's surface: the EditorPort for html
  // notes, the Markdown surface's own caret for markdown notes. Other
  // kinds (boards, drawings) have no text caret yet — the toggle says
  // so instead of silently doing nothing.
  const active = getTabManager()?.getActive();
  if (active && !isHtmlContent(active.noteType) && !isMarkdownNote(active)) {
    showToast('Voice typing works in plain, rich and Markdown notes.');
    return;
  }
  if (active && isMarkdownNote(active) && !markdownSourceTextarea()) {
    showToast('Open the note\u2019s source to dictate into.');
    return;
  }
  if (listening) {
    stopVoiceTyping();
  } else {
    startVoiceTyping();
  }
}

/** Whether a dictation session is currently open. */
export function isListening(): boolean {
  return listening;
}

/**
 * Called when the active note changes — dictation must never spill into the
 * wrong note, so an open session (or a lingering error state) is closed
 * quietly.
 */
export function handleTabSwitchedWhileListening(): void {
  if (showingMicError) {
    clearMicError();
  }
  if (listening) {
    stopVoiceTyping();
    showToast('Voice typing stopped — you switched notes.');
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initVoiceTyping(): void {
  supported = getRecognitionCtor() !== null;
  if (!supported) {
    // Keep the mic hidden on browsers without the Web Speech API.
    return;
  }

  $('#voiceTypeContainer').removeAttr('hidden');

  $('#voiceTypeButton').on('click', (event) => {
    event.preventDefault();
    toggleVoiceTyping();
  });

  $('#voiceBarStop').on('click', (event) => {
    event.preventDefault();
    if (showingMicError) {
      clearMicError();
      return;
    }
    stopVoiceTyping();
  });

  // Escape ends dictation (or closes the mic error) without stealing
  // focus from the editor.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && (listening || showingMicError)) {
        event.preventDefault();
        event.stopPropagation();
        if (showingMicError) {
          clearMicError();
        } else {
          stopVoiceTyping();
        }
      }
    },
    true,
  );
}
