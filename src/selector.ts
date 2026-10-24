import { $, type Q } from './lib/q';
import { stateGet, stateSet, stateRemove } from './storage';
import {
  DEFAULT_EDITOR_CONFIG,
  getSetting,
  isSettingKey,
  removeSetting,
  setSetting,
} from './state/settings';

export type StateKey = string;

export interface NotepadUI {
  aboutModal: Q;
  copyToClipboard: Q;
  downloadNotes: Q;
  downloadNotesPlain: Q;
  downloadNotesPdf: Q;
  downloadNotesDocx: Q;
  downloadNotesHtml: Q;
  downloadNotesMarkdown: Q;
  downloadNotesPng: Q;
  downloadNotesSvg: Q;
  splitViewButton: Q;
  splitViewContainer: Q;
  fontSize: Q;
  installApp: Q;
  lineHeight: Q;
  writeDirection: Q;
  texture: Q;
  note: Q;
  preferencesModal: Q;
  resetPreferences: Q;
  installAppButtonContainer: Q;
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

export interface EditorConfig {
  defaultFontSize: number;
  defaultLineHeight: number;
  defaultFont: string;
  defaultWriteDirection: string;
  defaultTexture: string;
  defaultOptimalLineLength: boolean;
  defaultOptimalLineLengthPadding: string;
  defaultSpellCheck: boolean;
  defaultBreakReminders: boolean;
  defaultExplodingEffect: boolean;
  defaultExplodingEffectStyle: string;
}

export interface AppSelector {
  notepad: NotepadUI;
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
function getState(state: StateKey): string | null {
  return isSettingKey(state) ? getSetting(state) : stateGet(state);
}

function setState(state: StateKey, value: string): void {
  if (isSettingKey(state)) {
    setSetting(state, value);
    return;
  }
  stateSet(state, value);
}

function removeState(state: StateKey): void {
  if (isSettingKey(state)) {
    removeSetting(state);
    return;
  }
  stateRemove(state);
}

function selectById(id: string): Q {
  return $(`#${id}`);
}

function selectByClassName(className: string): Q {
  return $(`.${className}`);
}

function get(context: string | HTMLElement | Q): Q {
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
      downloadNotesMarkdown: selectById('downloadNotesMarkdown'),
      downloadNotesPng: selectById('downloadNotesPng'),
      downloadNotesSvg: selectById('downloadNotesSvg'),
      splitViewButton: selectById('splitViewButton'),
      splitViewContainer: selectById('splitViewContainer'),
      fontSize: selectById('fontSize'),
      installApp: selectById('installApp'),
      lineHeight: selectById('lineHeight'),
      writeDirection: selectById('writeDirection'),
      texture: selectById('texture'),
      note: selectById('note'),
      preferencesModal: selectById('preferencesModal'),
      resetPreferences: selectById('resetPreferences'),
      installAppButtonContainer: selectByClassName('install-app-btn-container'),
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
    defaultConfig: DEFAULT_EDITOR_CONFIG,
    get,
    getState,
    setState,
    removeState,
    selectById,
    selectByClassName,
  };
}
