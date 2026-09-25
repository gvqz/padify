import { $ } from './lib/q';
import Swal from 'sweetalert2';
import type { AppState, EditorConfig, NotepadUI, StateKey } from './selector';
import { resetFontSize, resetLineHeight, resetFontWeight, resetShowWordCountPill, resetWriteDirection, resetTexture, resetOptimalLineLength, resetFont, showToast, updateWordCountPill } from './utils';
import { getEditorText } from './tabs';
import { stateGet, stateSet, stateRemove } from './storage';
import { selector } from './selector';

export interface EditorPreferencesContext {
  notepad: NotepadUI;
  state: AppState;
  setState: (key: StateKey, value: string) => void;
  editorConfig: EditorConfig;
  optimalLineLengthPadding: string;
}

/**
 * Editor appearance preferences — font family/size/weight, line height,
 * write direction, paper texture, word-count pill, optimal line length
 * and spell check. Wires the preferences-modal controls, restores the
 * stored choices on boot and handles the font-selection migration.
 */
export function initEditorPreferences(ctx: EditorPreferencesContext): {
  resetToDefaults: () => void;
} {
  const { notepad, state, setState, editorConfig, optimalLineLengthPadding } = ctx;
  const removeState = stateRemove;

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

  function applyTexture(textureSelected: string): void {
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
  }

  // ---- restore stored preferences ---------------------------------

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
    if (allowedTextures.includes(state.userChosenTexture)) {
      applyTexture(state.userChosenTexture);

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

  // ---- preferences-modal change handlers ---------------------------

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

    applyTexture(textureSelected);
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

  // ---- font selection ----------------------------------------------

  const fontSelect = document.getElementById('font') as HTMLSelectElement;

  // Check for legacy font preferences and migrate them to the new system
  function migrateLegacyFontPrefs(): void {
    const dyslexicFont = stateGet('dyslexicFont') === 'true';
    const monospacedFont = stateGet('monospaced') === 'true';
    const serifFont = stateGet('serifFont') === 'true';

    if (dyslexicFont) {
      stateSet('selectedFont', 'dyslexic');
    } else if (monospacedFont) {
      stateSet('selectedFont', 'monospaced');
    } else if (serifFont) {
      stateSet('selectedFont', 'serif');
    } else {
      stateSet('selectedFont', 'default');
    }

    // Clear old preferences
    stateRemove('dyslexicFont');
    stateRemove('monospaced');
    stateRemove('serifFont');
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
      stateGet('dyslexicFont') !== null ||
      stateGet('monospaced') !== null ||
      stateGet('serifFont') !== null
    ) {
      migrateLegacyFontPrefs();
    }

    // Get the selected font or default to 'default'
    const selectedFont = stateGet('selectedFont') || 'default';

    // Set the dropdown value
    fontSelect.value = selectedFont;

    // Apply the font
    applyFont(selectedFont);
  }

  // Handle font selection change
  fontSelect.addEventListener('change', (e) => {
    const selectedFont = (e.target as HTMLSelectElement).value;
    stateSet('selectedFont', selectedFont);
    applyFont(selectedFont);
  });

  // Initialize font selection on page load
  initFontSelection();

  return {
    /** Clears the persisted appearance preferences and restores defaults. */
    resetToDefaults(): void {
      // Read the CURRENT state — the boot-time snapshot captured in ctx
      // is stale once the user has changed preferences this session.
      const state = selector().state;

      if (state.userChosenFontSize) {
        removeState('userChosenFontSize');
        resetFontSize(editorConfig.defaultFontSize);
      }

      if (state.userChosenLineHeight) {
        removeState('userChosenLineHeight');
        resetLineHeight(editorConfig.defaultLineHeight);
      }

      if (state.userChosenFontWeight) {
        removeState('userChosenFontWeight');
        resetFontWeight(editorConfig.defaultFontWeight);
      }

      if (state.userChosenWordCountPillSelected) {
        removeState('userChosenWordCountPillSelected');
        resetShowWordCountPill(editorConfig.defaultShowWordCountPill);
      }

      if (state.userChosenWriteDirection) {
        removeState('userChosenWriteDirection');
        resetWriteDirection(editorConfig.defaultWriteDirection);
      }

      if (state.userChosenTexture) {
        removeState('userChosenTexture');
        resetTexture(editorConfig.defaultTexture);
      }

      if (state.userChosenOptimalLineLengthSelected) {
        removeState('userChosenOptimalLineLengthSelected');
        resetOptimalLineLength(
          editorConfig.defaultOptimalLineLengthPadding,
          editorConfig.defaultOptimalLineLength,
        );
      }

      if (state.selectedFont) {
        removeState('selectedFont');
        resetFont(editorConfig.defaultFont);
      }

      if (state.userChosenSpellCheck) {
        removeState('userChosenSpellCheck');
        notepad.note.attr('spellcheck', false as unknown as string);
        notepad.spellCheck.prop('checked', editorConfig.defaultSpellCheck);
      }

      // Tab indentation is always enabled now — drop any legacy state.
      if (state.userChosenTabIndentation) {
        removeState('userChosenTabIndentation');
      }
    },
  };
}

/**
 * "Clear tab indentation" action from the preferences modal — strips
 * tab characters from every text node in the editor.
 */
export function clearTabIndentation(notepad: NotepadUI): void {
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
}
