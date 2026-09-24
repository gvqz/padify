import $ from 'jquery';

export type StateKey = string;

export interface NotepadUI {
  aboutModal: JQuery;
  clearNotes: JQuery;
  copyToClipboard: JQuery;
  downloadNotes: JQuery;
  downloadNotesPlain: JQuery;
  downloadNotesPdf: JQuery;
  downloadNotesDocx: JQuery;
  downloadNotesHtml: JQuery;
  fontSize: JQuery;
  fontWeight: JQuery;
  installApp: JQuery;
  lineHeight: JQuery;
  writeDirection: JQuery;
  texture: JQuery;
  note: JQuery;
  preferencesModal: JQuery;
  resetPreferences: JQuery;
  showWordCountPill: JQuery;
  clearTabIndentation: JQuery;
  wordCount: JQuery;
  installAppButtonContainer: JQuery;
  wordCountContainer: JQuery;
  keyboardShortcutsModal: JQuery;
  fullScreenButton: JQuery;
  optimalLineLength: JQuery;
  monospaced: JQuery;
  shareNotes: JQuery;
  dyslexic: JQuery;
  spellCheck: JQuery;
  breakReminders: JQuery;
  explodingEffect: JQuery;
  bottomLine: JQuery;
  focusModeButton: JQuery;
  focusModeCloseButton: JQuery;
  statisticsModal: JQuery;
  serif: JQuery;
}

export interface AppState {
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
  get: (context: string | HTMLElement | JQuery) => JQuery;
  getState: (state: StateKey) => string | null;
  setState: (state: StateKey, value: string) => void;
  removeState: (state: StateKey) => void;
  selectById: (id: string) => JQuery;
  selectByClassName: (className: string) => JQuery;
}

export function getState(state: StateKey): string | null {
  return localStorage.getItem(state);
}

export function setState(state: StateKey, value: string): void {
  localStorage.setItem(state, value);
}

export function removeState(state: StateKey): void {
  localStorage.removeItem(state);
}

export function selectById(id: string): JQuery {
  return $(`#${id}`);
}

export function selectByClassName(className: string): JQuery {
  return $(`.${className}`);
}

export function get(context: string | HTMLElement | JQuery): JQuery {
  return $(context as unknown as HTMLElement);
}

export function selector(): AppSelector {
  return {
    notepad: {
      aboutModal: selectById('aboutModal'),
      clearNotes: selectById('clearNotes'),
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
      monospaced: selectById('monospaced'),
      shareNotes: selectById('shareNotes'),
      dyslexic: selectById('dyslexic'),
      spellCheck: selectById('spellCheck'),
      breakReminders: selectById('breakReminders'),
      explodingEffect: selectById('explodingEffect'),
      bottomLine: selectByClassName('bottom-line'),
      focusModeButton: selectById('focusModeButton'),
      focusModeCloseButton: selectById('focusModeCloseButton'),
      statisticsModal: selectById('statisticsModal'),
      serif: selectById('serif'),
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
    defaultConfig: {
      defaultFontSize: 18,
      defaultLineHeight: 26,
      defaultFont: 'default',
      defaultFontWeight: 'normal',
      defaultShowWordCountPill: 'Yes',
      defaultWriteDirection: 'ltr',
      defaultTexture: 'normal',
      defaultOptimalLineLength: false,
      defaultOptimalLineLengthPadding: '15px 24px 80px',
      defaultSpellCheck: true,
      defaultTypewriterSound: false,
      defaultTypewriterVolume: 25,
      defaultBreakReminders: false,
      defaultExplodingEffect: false,
    },
    get,
    getState,
    setState,
    removeState,
    selectById,
    selectByClassName,
  };
}
