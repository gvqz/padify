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

import $ from 'jquery';
import { showToast } from './utils';

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

const RESTART_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Insertion helpers
// ---------------------------------------------------------------------------

/**
 * Character just before the caret (empty string at the very start of the
 * note). Used to decide whether dictated text needs a separating space.
 */
function charBeforeCaret(): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return '';
  }

  const anchor = selection.getRangeAt(0).startContainer;
  const offset = selection.getRangeAt(0).startOffset;

  if (anchor.nodeType === Node.TEXT_NODE) {
    return (anchor.nodeValue ?? '').slice(0, offset).slice(-1);
  }

  // Element anchor: the text right before it, if any.
  const element = anchor as Element;
  const before = element.textContent ?? '';
  return offset > 0 ? before.slice(-1) : before;
}

/** Inserts dictated text at the caret with tidy spacing/capitalisation. */
function insertDictation(text: string): void {
  const editor = document.getElementById('note');
  if (!editor || !text.trim()) {
    return;
  }

  editor.focus();

  // If the caret drifted outside the editor (click on the bar, …), park it at
  // the end of the note so dictation never lands in the void.
  const selection = window.getSelection();
  const caretInside = !!selection && selection.rangeCount > 0
    && editor.contains(selection.getRangeAt(0).startContainer);
  if (!caretInside) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  let insertText = text.trim().replace(/\s+/g, ' ');

  const previous = charBeforeCaret();
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
  document.execCommand('insertText', false, `${insertText} `);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function voiceBar(): JQuery {
  return $('#voiceBar');
}

function setBarInterim(interim: string | null): void {
  const $text = $('#voiceBarText');
  if (interim) {
    $text.text(interim).addClass('interim');
  } else {
    $text.text('Listening…').removeClass('interim');
  }
}

function renderListeningUI(active: boolean): void {
  $('#voiceTypeButton').toggleClass('listening', active)
    .attr('aria-pressed', String(active));
  voiceBar().attr('hidden', active ? null : 'hidden');
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

  setBarInterim(interim.trim() ? interim : null);
}

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

function handleError(event: SpeechRecognitionErrorEventLike): void {
  const fatal = fatalErrorMessage(event.error);
  if (fatal) {
    showToast(fatal);
    stopListening();
    return;
  }

  // 'no-speech' and 'aborted' are normal pauses/interruptions — the onend
  // handler keeps the session alive; nothing to tell the user.
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
    // wants the session open, with a small guard against hot loops.
    if (listening && !userWantsStop) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (listening && !userWantsStop) {
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

  if (!supported) {
    showToast("Voice typing isn't supported in this browser.");
    return;
  }

  // Park the caret in the note first so the very first words land in it.
  const editor = document.getElementById('note');
  if (editor && document.activeElement !== editor) {
    const selection = window.getSelection();
    const caretInside = !!selection && selection.rangeCount > 0
      && editor.contains(selection.getRangeAt(0).startContainer);
    if (!caretInside) {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  startRecognition();
}

export function stopVoiceTyping(): void {
  stopListening();
}

function stopListening(): void {
  userWantsStop = true;
  listening = false;

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
 * wrong note, so an open session is closed quietly.
 */
export function handleTabSwitchedWhileListening(): void {
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
    stopVoiceTyping();
  });

  // Escape ends dictation without stealing focus from the editor.
  document.addEventListener('keydown', (event) => {
    if (listening && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopVoiceTyping();
    }
  }, true);
}
