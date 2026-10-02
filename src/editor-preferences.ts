import { $ } from './lib/q';
import { closeModal } from './ui/behavior/modal';
import Swal from 'sweetalert2';
import type { EditorConfig, NotepadUI, StateKey } from './selector';
import { showToast } from './ui/toast';
import { updateWordCountPill } from './word-count-pill';
import { getEditorText } from './tabs';
import { stateGet } from './storage';
import { getSetting, removeSetting, setSetting } from './state/settings';

// --- "Reset to defaults" primitives ---------------------------------
// Every editor preference has a reset that returns the surface AND its
// control to the shipped default. They live here — with the module that
// owns the preferences — instead of a shared utils file, because no one
// outside the editor-preferences flow ever calls them.

export function resetFontSize(defaultFontSize: number): void {
  $('#note').css('font-size', defaultFontSize + 'px');
  $('#fontSize').val(defaultFontSize);
}

export function resetLineHeight(defaultLineHeight: number): void {
  $('#note').css('line-height', defaultLineHeight + 'px');
  $('#lineHeight').val(defaultLineHeight);
}

export function resetFontWeight(defaultFontWeight: string): void {
  $('#note').css('font-weight', defaultFontWeight);
  $('#fontWeight').val(defaultFontWeight);
}

export function resetShowWordCountPill(defaultShowWordCountPill: string): void {
  if (defaultShowWordCountPill === 'Yes') {
    $('.word-count-container').show();
  } else {
    $('.word-count-container').hide();
  }
  $('#showWordCountPill').prop('checked', defaultShowWordCountPill === 'Yes');
}

export function resetWriteDirection(defaultWriteDirection: string): void {
  $('#note').css('direction', defaultWriteDirection);
  $('#writeDirection').val(defaultWriteDirection);
}

export function resetTexture(defaultTexture: string): void {
  // The retired textures (chessboard/linen/marble) stay in this cleanup so
  // a body still carrying one of their classes from an old session lands
  // back on a paper that exists.
  $(document.body).removeClass(
    'dotted-paper graph-paper chessboard-paper starfield-paper grain-paper linen-paper recycled-paper newspaper-paper marble-paper',
  );
  $('#texture').val(defaultTexture);
}

export function resetFont(defaultFont: string): void {
  $('#note').removeClass('dyslexic monospaced serif handwritten humanist pixel typewriter crayon');
  $('#font').val(defaultFont);
}

export function resetOptimalLineLength(defaultEditorPadding: string, defaultOption: boolean): void {
  const textArea = document.getElementById('note')!;
  textArea.style.padding = defaultEditorPadding;
  $('#optimalLineLength').prop('checked', defaultOption);
}

export interface EditorPreferencesContext {
  notepad: NotepadUI;
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
  const { notepad, setState, editorConfig, optimalLineLengthPadding } = ctx;
  const removeState = removeSetting;

  // Retired textures (chessboard, linen, marble) are deliberately absent:
  // a stored choice of one of them fails this check and migrates to normal.
  const allowedTextures = [
    'normal',
    'dotted',
    'graph',
    'starfield',
    'grain',
    'recycled',
    'newspaper',
  ];

  function applyTexture(textureSelected: string): void {
    $(document.body).removeClass(
      'dotted-paper graph-paper starfield-paper grain-paper recycled-paper newspaper-paper',
    );

    if (textureSelected == 'dotted') {
      $(document.body).addClass('dotted-paper');
    } else if (textureSelected == 'graph') {
      $(document.body).addClass('graph-paper');
    } else if (textureSelected == 'starfield') {
      $(document.body).addClass('starfield-paper');
    } else if (textureSelected == 'grain') {
      $(document.body).addClass('grain-paper');
    } else if (textureSelected == 'recycled') {
      $(document.body).addClass('recycled-paper');
    } else if (textureSelected == 'newspaper') {
      $(document.body).addClass('newspaper-paper');
    }
  }

  // ---- restore stored preferences ---------------------------------

  const userChosenFontSize = getSetting('userChosenFontSize');
  if (userChosenFontSize) {
    notepad.note.css('font-size', userChosenFontSize + 'px');
    notepad.fontSize.val(userChosenFontSize);
  } else {
    resetFontSize(editorConfig.defaultFontSize);
  }

  const userChosenFontWeight = getSetting('userChosenFontWeight');
  if (userChosenFontWeight) {
    notepad.note.css('font-weight', userChosenFontWeight);
    notepad.fontWeight.val(userChosenFontWeight);
  } else {
    resetFontWeight(editorConfig.defaultFontWeight);
  }

  const userChosenLineHeight = getSetting('userChosenLineHeight');
  if (userChosenLineHeight) {
    notepad.note.css('line-height', userChosenLineHeight + 'px');
    notepad.lineHeight.val(userChosenLineHeight);
  } else {
    resetLineHeight(editorConfig.defaultLineHeight);
  }

  const userChosenWordCountPillSelected = getSetting('userChosenWordCountPillSelected');

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

  const userChosenWriteDirection = getSetting('userChosenWriteDirection');
  if (userChosenWriteDirection) {
    notepad.note.css('direction', userChosenWriteDirection);
    notepad.writeDirection.val(userChosenWriteDirection);
  } else {
    resetWriteDirection(editorConfig.defaultWriteDirection);
  }

  const userChosenTexture = getSetting('userChosenTexture');
  if (userChosenTexture) {
    if (allowedTextures.includes(userChosenTexture)) {
      applyTexture(userChosenTexture);

      notepad.texture.val(userChosenTexture);
    } else {
      removeState('userChosenTexture');
      resetTexture(editorConfig.defaultTexture);
    }
  }

  const userChosenOptimalLineLengthSelected = getSetting('userChosenOptimalLineLengthSelected');
  if (userChosenOptimalLineLengthSelected) {
    const textArea = document.getElementById('note')!;

    if (userChosenOptimalLineLengthSelected === 'Yes') {
      textArea.style.padding = optimalLineLengthPadding;
    } else {
      textArea.style.padding = editorConfig.defaultOptimalLineLengthPadding;
    }

    notepad.optimalLineLength.prop('checked', userChosenOptimalLineLengthSelected === 'Yes');
  } else {
    notepad.optimalLineLength.prop('checked', false);
  }

  const userChosenSpellCheck = getSetting('userChosenSpellCheck');
  if (userChosenSpellCheck) {
    if (userChosenSpellCheck === 'Yes') {
      notepad.note.attr('spellcheck', true as unknown as string);
    } else {
      notepad.note.attr('spellcheck', false as unknown as string);
    }

    notepad.spellCheck.prop('checked', userChosenSpellCheck === 'Yes');
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
      setSetting('selectedFont', 'dyslexic');
    } else if (monospacedFont) {
      setSetting('selectedFont', 'monospaced');
    } else if (serifFont) {
      setSetting('selectedFont', 'serif');
    } else {
      setSetting('selectedFont', 'default');
    }

    // Clear old preferences
    removeSetting('dyslexicFont');
    removeSetting('monospaced');
    removeSetting('serifFont');
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
    setSetting('selectedFont', selectedFont);
    applyFont(selectedFont);
  });

  // Initialize font selection on page load
  initFontSelection();

  return {
    /** Clears the persisted appearance preferences and restores defaults. */
    resetToDefaults(): void {
      // Fresh reads (getSetting) — the point of reset is to clear what is
      // set NOW, not what was set when the module booted.

      const userChosenFontSize = getSetting('userChosenFontSize');
  if (userChosenFontSize) {
        removeState('userChosenFontSize');
        resetFontSize(editorConfig.defaultFontSize);
      }

      const userChosenLineHeight = getSetting('userChosenLineHeight');
  if (userChosenLineHeight) {
        removeState('userChosenLineHeight');
        resetLineHeight(editorConfig.defaultLineHeight);
      }

      const userChosenFontWeight = getSetting('userChosenFontWeight');
  if (userChosenFontWeight) {
        removeState('userChosenFontWeight');
        resetFontWeight(editorConfig.defaultFontWeight);
      }

      if (getSetting('userChosenWordCountPillSelected')) {
        removeState('userChosenWordCountPillSelected');
        resetShowWordCountPill(editorConfig.defaultShowWordCountPill);
      }

      const userChosenWriteDirection = getSetting('userChosenWriteDirection');
  if (userChosenWriteDirection) {
        removeState('userChosenWriteDirection');
        resetWriteDirection(editorConfig.defaultWriteDirection);
      }

      if (getSetting('userChosenTexture')) {
        removeState('userChosenTexture');
        resetTexture(editorConfig.defaultTexture);
      }

      if (getSetting('userChosenOptimalLineLengthSelected')) {
        removeState('userChosenOptimalLineLengthSelected');
        resetOptimalLineLength(
          editorConfig.defaultOptimalLineLengthPadding,
          editorConfig.defaultOptimalLineLength,
        );
      }

      if (getSetting('selectedFont')) {
        removeState('selectedFont');
        resetFont(editorConfig.defaultFont);
      }

      if (getSetting('userChosenSpellCheck')) {
        removeState('userChosenSpellCheck');
        notepad.note.attr('spellcheck', false as unknown as string);
        notepad.spellCheck.prop('checked', editorConfig.defaultSpellCheck);
      }

      // Tab indentation is always enabled now — drop any legacy state.
      if (getSetting('userChosenTabIndentation')) {
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
      closeModal($('#preferencesModal').get(0));
    } else {
      applyEdit();
    }
  });
}
