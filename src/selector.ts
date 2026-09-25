import { $, type Q } from './lib/q';
import { stateGet, stateSet, stateRemove } from './storage';
import { DEFAULT_EDITOR_CONFIG, getSetting, isSettingKey, removeSetting, setSetting } from './state/settings';

export type StateKey = string;

export interface NotepadUI {
  aboutModal: Q;
  copyToClipboard: Q;
  downloadNotes: Q;
  downloadNotesPlain: Q;
  downloadNotesPdf: Q;
  downloadNotesDocx: Q;
  downloadNotesHtml: Q;
  fontSize: Q;
  fontWeight: Q;
  installApp: Q;
  lineHeight: Q;
  writeDirection: Q;
  texture: Q;
  note: Q;
  preferencesModal: Q;
  resetPreferences: Q;
  showWordCountPill: Q;
  clearTabIndentation: Q;
  wordCount: Q;
  installAppButtonContainer: Q;
  wordCountContainer: Q;
  keyboardShortcutsModal: Q;
  fullScreenButton: Q;
  optimalLineLength: Q;
  shareNotes: Q;
  spellCheck: Q;
  breakReminders: Q;
  explodingEffect: Q;
  bottomLine: Q;
  statisticsModal: Q;
}

export interface AppState {
  /**
   * A SNAPSHOT taken when selector() runs — values go stale as settings
   * change. New code should read through src/state/settings.ts instead;
   * this shape stays for the legacy consumers that destructure it once.
   */
  note: string | null;
  mode: string | null;
  isUserPreferredTheme: string | null;
  userChosenFontSize: string | null;
  userChosenFontWeight: string | null;
  userChosenLineHeight: string | null;
  hasUserDismissedDonationPopup: string | null;
  userChosenWordCountPillSelected: string | null;
  userChosenWriteDirection: string | null;
  userChosenTexture: string | null;
  userChosenOptimalLineLengthSelected: string | null;
  isMonospaced: string | null;
  isDyslexic: string | null;
  isSerif: string | null;
  userChosenSpellCheck: string | null;
  userChosenTabIndentation: string | null;
  userChosenTransparentWordCountPillSelected: string | null;
  userChosenTypewriterSound: string | null;
  userChosenTypewriterVolume: string | null;
  userChosenBreakReminders: string | null;
  userChosenExplodingEffect: string | null;
  selectedFont: string | null;
}

export interface EditorConfig {
  defaultFontSize: number;
  defaultLineHeight: number;
  defaultFont: string;
  defaultFontWeight: string;
  defaultShowWordCountPill: string;
  defaultWriteDirection: string;
  defaultTexture: string;
  defaultOptimalLineLength: boolean;
  defaultOptimalLineLengthPadding: string;
  defaultSpellCheck: boolean;
  defaultTypewriterSound: boolean;
  defaultTypewriterVolume: number;
  defaultBreakReminders: boolean;
  defaultExplodingEffect: boolean;
}

export interface AppSelector {
  notepad: NotepadUI;
  state: AppState;
  defaultConfig: EditorConfig;
  get: (context: string | HTMLElement | Q) => Q;
  getState: (state: StateKey) => string | null;
  setState: (state: StateKey, value: string) => void;
  removeState: (state: StateKey) => void;
  selectById: (id: string) => Q;
  selectByClassName: (className: string) => Q;
}

// Settings persist through the storage layer (IndexedDB + localStorage
// compatibility mirror — see src/storage/). Signatures are intentionally
// identical to the localStorage API. Writes and clears route through
// src/state/settings.ts — the typed choke point that also owns the key
// list, the editor defaults and change notifications — so every legacy
// setState caller gains change notifications for free. Reads stay direct
// (they have no side effects to unify).
export function getState(state: StateKey): string | null {
  return isSettingKey(state) ? getSetting(state) : stateGet(state);
}

export function setState(state: StateKey, value: string): void {
  if (isSettingKey(state)) {
    setSetting(state, value);
    return;
  }
  stateSet(state, value);
}

export function removeState(state: StateKey): void {
  if (isSettingKey(state)) {
    removeSetting(state);
    return;
  }
  stateRemove(state);
}

export function selectById(id: string): Q {
  return $(`#${id}`);
}

export function selectByClassName(className: string): Q {
  return $(`.${className}`);
}

export function get(context: string | HTMLElement | Q): Q {
  return $(context);
}

export function selector(): AppSelector {
  return {
    notepad: {
      aboutModal: selectById('aboutModal'),
      copyToClipboard: selectById('copyToClipboard'),
      downloadNotes: selectById('downloadNotes'),
      downloadNotesPlain: selectById('downloadNotesPlain'),
      downloadNotesPdf: selectById('downloadNotesPdf'),
      downloadNotesDocx: selectById('downloadNotesDocx'),
      downloadNotesHtml: selectById('downloadNotesHtml'),
      fontSize: selectById('fontSize'),
      fontWeight: selectById('fontWeight'),
      installApp: selectById('installApp'),
      lineHeight: selectById('lineHeight'),
      writeDirection: selectById('writeDirection'),
      texture: selectById('texture'),
      note: selectById('note'),
      preferencesModal: selectById('preferencesModal'),
      resetPreferences: selectById('resetPreferences'),
      showWordCountPill: selectById('showWordCountPill'),
      clearTabIndentation: selectById('clearTabIndentation'),
      wordCount: selectById('wordCount'),
      installAppButtonContainer: selectByClassName('install-app-btn-container'),
      wordCountContainer: selectByClassName('word-count-container'),
      keyboardShortcutsModal: selectById('keyboardShortcutsModal'),
      fullScreenButton: selectById('fullScreenButton'),
      optimalLineLength: selectById('optimalLineLength'),
      shareNotes: selectById('shareNotes'),
      spellCheck: selectById('spellCheck'),
      breakReminders: selectById('breakReminders'),
      explodingEffect: selectById('explodingEffect'),
      bottomLine: selectByClassName('bottom-line'),
      statisticsModal: selectById('statisticsModal'),
    },
    state: {
      note: getState('note'),
      mode: getState('mode'),
      isUserPreferredTheme: getState('isUserPreferredTheme'),
      userChosenFontSize: getState('userChosenFontSize'),
      userChosenFontWeight: getState('userChosenFontWeight'),
      userChosenLineHeight: getState('userChosenLineHeight'),
      hasUserDismissedDonationPopup: getState('hasUserDismissedDonationPopup'),
      userChosenWordCountPillSelected: getState('userChosenWordCountPillSelected'),
      userChosenWriteDirection: getState('userChosenWriteDirection'),
      userChosenTexture: getState('userChosenTexture'),
      userChosenOptimalLineLengthSelected: getState('userChosenOptimalLineLengthSelected'),
      isMonospaced: getState('monospaced'),
      isDyslexic: getState('dyslexicFont'),
      isSerif: getState('serifFont'),
      userChosenSpellCheck: getState('userChosenSpellCheck'),
      userChosenTabIndentation: getState('userChosenTabIndentation'),
      userChosenTransparentWordCountPillSelected: getState(
        'userChosenTransparentWordCountPillSelected',
      ),
      userChosenTypewriterSound: getState('userChosenTypewriterSound'),
      userChosenTypewriterVolume: getState('userChosenTypewriterVolume'),
      userChosenBreakReminders: getState('userChosenBreakReminders'),
      userChosenExplodingEffect: getState('userChosenExplodingEffect'),
      selectedFont: getState('selectedFont'),
    },
    defaultConfig: DEFAULT_EDITOR_CONFIG,
    get,
    getState,
    setState,
    removeState,
    selectById,
    selectByClassName,
  };
}
