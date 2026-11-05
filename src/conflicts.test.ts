import { describe, expect, it } from 'vitest';
import { renderTrackedDiff } from './conflicts';
import type { NoteConflict } from './tabs';

const conflict = (
  mine: string,
  theirs: string,
  overrides: Partial<NoteConflict> = {},
): NoteConflict => ({
  kind: 'edit',
  detectedAt: 1_000,
  mine: { name: null, content: mine },
  theirs: { name: null, content: theirs, updatedAt: 2_000 },
  ...overrides,
});

describe('renderTrackedDiff — the review body', () => {
  it('marks my lost words struck and their words underlined', () => {
    const html = renderTrackedDiff(conflict('<p>buy red milk</p>', '<p>buy blue milk</p>'));

    expect(html).toContain('<del');
    expect(html).toContain('red');
    expect(html).toContain('<ins');
    expect(html).toContain('blue');
    // The shared words read as plain text, not markup.
    expect(html).toContain('buy');
    expect(html).toContain('milk');
  });

  it('identical words with different formatting note it instead of soup', () => {
    const html = renderTrackedDiff(conflict('<p><b>words</b></p>', '<p><i>words</i></p>'));
    expect(html).toContain('Formatting also differs');
  });

  it('a name difference gets its own note', () => {
    const html = renderTrackedDiff(
      conflict('<p>body</p>', '<p>body</p>', {
        mine: { name: 'Mine', content: '<p>body</p>' },
        theirs: { name: 'Theirs', content: '<p>body</p>', updatedAt: 2 },
      }),
    );
    expect(html).toContain('Mine');
    expect(html).toContain('Theirs');
    expect(html).toContain('name differs');
  });

  it('the preview never renders the note — hostile markup dies in the pass', () => {
    const html = renderTrackedDiff(
      conflict('<p>plain & safe</p>', '<p>changed</p><img src=x onerror=alert(1)>'),
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).toContain('changed');
  });

  it('markdown notes diff as source text', () => {
    const html = renderTrackedDiff(
      conflict('# title\n\nmy body', '# title\n\ntheir body'),
      'markdown',
    );
    expect(html).toContain('my');
    expect(html).toContain('their');
  });
});
