import { describe, expect, it } from 'vitest';
import {
  noteContentHasSubstance,
  noteContentIsEmpty,
  noteContentIdentity,
  noteExportHtmlBody,
  notePlainText,
  noteStripBadge,
  noteUnitCount,
  registerNoteProjection,
} from './note-projections';
// The tasks kind's adapter registers at import time — the same wiring
// the app's import graph performs; the drawing adapter registers
// statically inside the seam module itself.
import './tasks/projection';
import { buildTask, emptyTaskNoteContent, serializeTaskNoteContent } from './tasks/content';
import { escapeHtml } from '../lib/escape';
import { sanitizeNoteHtml } from './storage-subset';

/**
 * The projection seam's own contract: the kind defaults for
 * unregistered types, the registration dispatch, and the readings the
 * tasks and drawing adapters register. The per-consumer behavior
 * (snapshots, share) is pinned by their own suites; this file pins the
 * seam so a new kind's author finds the mechanics tested, not guessed.
 */
describe('note content projections — the seam', () => {
  it('unregistered types read as their raw bytes', () => {
    // An unknown type id (a newer build's kind) is its bytes — unknown
    // never means damaged, and never means unreadable-as-bytes.
    expect(noteContentIsEmpty('   ', 'future-kind')).toBe(true);
    expect(noteContentIsEmpty('words', 'future-kind')).toBe(false);
    expect(noteContentHasSubstance('   ', 'future-kind')).toBe(false);
    expect(noteContentHasSubstance('words', 'future-kind')).toBe(true);
    expect(notePlainText('a < b', 'future-kind')).toBe('a < b');
    expect(noteUnitCount('one two  three', 'future-kind')).toEqual({ count: 3, unit: 'word' });
    expect(noteUnitCount('   ', 'future-kind')).toEqual({ count: 0, unit: 'word' });
    expect(noteContentIdentity('{"x":1}', 'future-kind')).toBe('{"x":1}');
    expect(noteStripBadge('{"x":1}', 'future-kind')).toBeNull();
    // Absent type = the default = a standard html note.
    expect(noteContentIsEmpty('  ', undefined)).toBe(true);
  });

  it('html kinds read through the tag stripper, not their bytes', () => {
    // A bare <p></p> or <br> is emptiness wearing markup.
    expect(noteContentIsEmpty('<p></p><br>', 'standard')).toBe(true);
    expect(noteContentIsEmpty('<p>words</p>', 'rich')).toBe(false);
    expect(notePlainText('<p>hello <b>world</b></p>', 'standard')).toContain('hello world');
    expect(noteUnitCount('<p>hello world</p>', 'standard')).toEqual({ count: 2, unit: 'word' });
    // Markdown is a TEXT kind — its source is its text, verbatim.
    expect(notePlainText('# heading', 'markdown')).toBe('# heading');
  });

  it('a registered projection answers only for its own type', () => {
    registerNoteProjection('probe-projection', {
      plainText: () => 'PROBED',
      stripBadge: () => ({ kind: 'list-dot', color: 'red' }),
    });
    expect(notePlainText('anything', 'probe-projection')).toBe('PROBED');
    expect(noteStripBadge('anything', 'probe-projection')?.color).toBe('red');
    // Other types keep their defaults — a registration claims one type.
    expect(notePlainText('anything', 'standard')).not.toBe('PROBED');
    expect(notePlainText('anything', undefined)).not.toBe('PROBED');
  });

  it('the export body renders markdown, sanitizes html, escapes the rest', () => {
    expect(noteExportHtmlBody('# hi', 'markdown')).toContain('<h1>hi</h1>');
    expect(noteExportHtmlBody('<p>hi<script>x()</script></p>', 'standard')).toBe(
      sanitizeNoteHtml('<p>hi<script>x()</script></p>'),
    );
    expect(noteExportHtmlBody('a < b', 'future-kind')).toBe(`<pre>${escapeHtml('a < b')}</pre>`);
  });

  it('the tasks adapter reads the model: empty lists, rows, colors, the checklist export', () => {
    const empty = serializeTaskNoteContent(emptyTaskNoteContent('teal'));
    expect(noteContentIsEmpty(empty, 'tasks')).toBe(true);
    expect(noteContentHasSubstance(empty, 'tasks')).toBe(false);
    expect(noteStripBadge(empty, 'tasks')).toEqual({ kind: 'list-dot', color: 'teal' });

    const withRows = serializeTaskNoteContent({
      version: 1,
      color: 'purple',
      tasks: [
        buildTask({ title: 'ship <the> seam', dueDate: '2030-01-02T09:00:00.000Z' }, 0),
        { ...buildTask({ title: 'done one' }, 0), completed: true },
      ],
    });
    expect(noteContentIsEmpty(withRows, 'tasks')).toBe(false);
    expect(noteContentHasSubstance(withRows, 'tasks')).toBe(true);
    expect(noteUnitCount(withRows, 'tasks')).toEqual({ count: 2, unit: 'task' });
    expect(notePlainText(withRows, 'tasks')).toContain('ship <the> seam');

    // The export is the checklist it is: list color on the wrapper,
    // every string escaped, done rows marked, the due chip in prose.
    const body = noteExportHtmlBody(withRows, 'tasks');
    expect(body).toContain('<ul class="padify-task-list" data-color="purple">');
    expect(body).toContain('ship &lt;the&gt; seam');
    expect(body).toContain('class="padify-task is-done"');
    expect(body).toMatch(/due [^<]*<\/span>/);
    expect(body).not.toContain('<the>');
  });

  it('the drawing emptiness readings keep their documented asymmetry', () => {
    // A scene whose every element is soft-deleted: nothing a SAFETY COPY
    // adds (the substance gate counts visible elements), but not the
    // share gate's business to refuse (the recipient's viewer decides
    // what a newer build's scene means).
    const allDeleted = JSON.stringify({
      version: 1,
      appState: {},
      elements: [
        { id: 'e1', type: 'rectangle', isDeleted: true },
        { id: 'e2', type: 'text', isDeleted: true, text: 'gone' },
      ],
    });
    expect(noteContentHasSubstance(allDeleted, 'drawing')).toBe(false);
    expect(noteContentIsEmpty(allDeleted, 'drawing')).toBe(false);
    expect(noteUnitCount(allDeleted, 'drawing')).toEqual({ count: 0, unit: 'shape' });

    // Unparseable scene bytes: a newer build's real drawing — it stays
    // shareable, and it stays worth a safety copy.
    const foreign = '{"scene":"a format this build has never met"}';
    expect(noteContentIsEmpty(foreign, 'drawing')).toBe(false);
    expect(noteContentHasSubstance(foreign, 'drawing')).toBe(true);

    // The empty envelope and the never-drawn note are empty both ways.
    expect(noteContentIsEmpty('', 'drawing')).toBe(true);
    const cleared = JSON.stringify({ version: 1, appState: {}, elements: [] });
    expect(noteContentIsEmpty(cleared, 'drawing')).toBe(true);
    expect(noteContentHasSubstance(cleared, 'drawing')).toBe(false);
  });

  it('the drawing identity canonicalizes — the savedAt stamp never makes a drawing "new"', () => {
    const scene = (savedAt: number): string =>
      JSON.stringify({
        version: 1,
        appState: {},
        elements: [{ id: 'e1', type: 'rectangle', isDeleted: false }],
        savedAt,
      });
    expect(noteContentIdentity(scene(1), 'drawing')).toBe(noteContentIdentity(scene(2), 'drawing'));
    // Unregistered kinds fall back to their bytes.
    expect(noteContentIdentity(scene(1), 'future-kind')).toBe(scene(1));
  });
});
