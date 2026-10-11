import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { $ } from './lib/q';
import type { EditorConfig, NotepadUI } from './selector';
import { initEditorPreferences } from './editor-preferences';
import { resetStorageForTests, storageReady } from './storage';

/**
 * The spell-check toggle's live-apply contract (issue #116): the Markdown
 * WYSIWYG pins its spellcheck at MOUNT (the ProseMirror root, not the
 * host), so the toggle must write BOTH the host attribute (which the
 * source textarea inherits) AND the mounted view — or the setting takes
 * effect only after the next note switch.
 *
 * The shell mounts exactly what initEditorPreferences touches at runtime:
 * the note host with a nested ProseMirror root, the settings controls,
 * and the word-count container the pill toggle drives.
 */

const editorConfig: EditorConfig = {
  defaultFontSize: 16,
  defaultLineHeight: 24,
  defaultOptimalLineLengthPadding: '0px',
  defaultOptimalLineLength: false,
  defaultShowWordCountPill: 'Yes',
  defaultSpellCheck: true,
  defaultWriteDirection: 'ltr',
  defaultTexture: 'normal',
  defaultFont: 'default',
} as unknown as EditorConfig;

function mountShell(): void {
  document.body.innerHTML = `
    <div id="note" spellcheck="true">
      <div class="ProseMirror padify-markdown" contenteditable="true" spellcheck="true"></div>
    </div>
    <select id="fontSize"><option>16</option></select>
    <select id="lineHeight"><option>24</option></select>
    <select id="writeDirection"><option value="ltr">ltr</option></select>
    <select id="texture"><option value="normal">normal</option></select>
    <select id="font"><option value="default">default</option></select>
    <input type="checkbox" id="optimalLineLength" />
    <input type="checkbox" id="spellCheck" checked />
    <input type="checkbox" id="showWordCountPill" checked />
    <div class="word-count-container"></div>
    <button id="resetPreferences"></button>
  `;
}

function wirePreferences(): void {
  const notepad = {
    note: $('#note'),
    fontSize: $('#fontSize'),
    lineHeight: $('#lineHeight'),
    writeDirection: $('#writeDirection'),
    texture: $('#texture'),
    optimalLineLength: $('#optimalLineLength'),
    spellCheck: $('#spellCheck'),
    showWordCountPill: $('#showWordCountPill'),
    wordCountContainer: $('.word-count-container'),
  } as unknown as NotepadUI;

  initEditorPreferences({
    notepad,
    setState: () => {},
    editorConfig,
    optimalLineLengthPadding: '48px',
  });
}

describe('the spell-check toggle applies live to the mounted Markdown WYSIWYG (issue #116)', () => {
  beforeEach(async () => {
    resetStorageForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
    localStorage.clear();
    await storageReady();
    mountShell();
    wirePreferences();
  });

  const proseRoot = (): HTMLElement => document.querySelector('#note .ProseMirror') as HTMLElement;

  it('toggling OFF writes the host AND the mounted ProseMirror root', () => {
    expect(proseRoot().getAttribute('spellcheck')).toBe('true');

    $('#spellCheck').prop('checked', false).trigger('change');

    // The host: what the source textarea inherits.
    expect(document.getElementById('note')!.getAttribute('spellcheck')).toBe('false');
    // The mounted WYSIWYG: what used to wait for the next note switch.
    expect(proseRoot().getAttribute('spellcheck')).toBe('false');
  });

  it('toggling back ON restores both, and the textarea path stays host-driven', () => {
    $('#spellCheck').prop('checked', false).trigger('change');
    $('#spellCheck').prop('checked', true).trigger('change');

    expect(proseRoot().getAttribute('spellcheck')).toBe('true');
    expect(document.getElementById('note')!.getAttribute('spellcheck')).toBe('true');
  });

  it('a plain note (no ProseMirror mounted) toggles without throwing', () => {
    document.querySelector('#note .ProseMirror')!.remove();

    $('#spellCheck').prop('checked', false).trigger('change');

    expect(document.getElementById('note')!.getAttribute('spellcheck')).toBe('false');
  });
});
