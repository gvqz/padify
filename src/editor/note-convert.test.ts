/**
 * Note type conversion — the pair matrix behind "Change type".
 *
 * The contracts pinned here are the ones the old verbatim re-land broke:
 * html walks out of a markdown note as markdown (not HTML soup), markdown
 * walks into a text note as rendered formatting (not literal `#` lines),
 * a task list walks out as the checklist it is, and the structured kinds
 * (tasks, drawing) refuse to silently swallow or fabricate content — a
 * lossy conversion is flagged so the caller can confirm it.
 */

import { describe, expect, it } from 'vitest';
import { convertNoteContent, htmlToMarkdown, markdownToNoteHtml } from './note-convert';

describe('htmlToMarkdown', () => {
  it('carries the inline subset: bold, italic, underline, strike, links', () => {
    expect(htmlToMarkdown('<div><b>bold</b> <i>it</i></div>')).toBe('**bold** *it*');
    expect(htmlToMarkdown('<div><u>under</u> <s>gone</s></div>')).toBe('<u>under</u> ~~gone~~');
    expect(htmlToMarkdown('<div><a href="https://x.y">here</a></div>')).toBe('[here](https://x.y)');
  });

  it('reads headings, paragraphs and rules as markdown blocks', () => {
    expect(htmlToMarkdown('<h1>Top</h1><div>body</div><hr>')).toBe('# Top\n\nbody\n\n---');
    expect(htmlToMarkdown('<h2>Mid</h2>')).toBe('## Mid');
  });

  it('walks lists, nesting and checklists', () => {
    expect(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(htmlToMarkdown('<ol><li>first</li></ol>')).toBe('1. first');
    expect(htmlToMarkdown('<ul><li>outer<ul><li>inner</li></ul></li></ul>')).toBe(
      '- outer\n  - inner',
    );
    expect(
      htmlToMarkdown(
        '<ul data-rich-checklist="true"><li data-checked="true">done</li><li data-checked="false">open</li></ul>',
      ),
    ).toBe('- [x] done\n- [ ] open');
  });

  it('reads quotes, fences and tables', () => {
    expect(htmlToMarkdown('<blockquote><div>quoted</div></blockquote>')).toBe('> quoted');
    expect(htmlToMarkdown('<pre>keep   spacing</pre>')).toBe('```\nkeep   spacing\n```');
    expect(
      htmlToMarkdown('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'),
    ).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('escapes literal markdown punctuation and math shells read as LaTeX', () => {
    expect(htmlToMarkdown('<div>2 * 3 &lt; 5</div>')).toBe('2 \\* 3 \\< 5');
    expect(htmlToMarkdown('<span class="padify-math" data-latex="E=mc^2"></span>')).toBe(
      '$E=mc^2$',
    );
  });

  it('turns a blank editor note into nothing (no brace soup, no stray breaks)', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('<div><br></div>')).toBe('');
    expect(htmlToMarkdown('<div>a</div><div><br></div>')).toBe('a');
  });
});

describe('markdownToNoteHtml', () => {
  it('renders markdown into the note subset', () => {
    expect(markdownToNoteHtml('# Heading').html).toContain('<h1>Heading</h1>');
    // The sanitizer's canonical form for emphasis is <b> (the corpus
    // fixed point the whole app reads and writes).
    expect(markdownToNoteHtml('**bold**').html).toContain('<b>bold</b>');
  });

  it('folds h4–h6 into h3 (the subset tops out at h3)', () => {
    expect(markdownToNoteHtml('#### deep').html).toContain('<h3>deep</h3>');
  });

  it("turns GFM task lists into the editor's rich checklist", () => {
    const { html } = markdownToNoteHtml('- [x] done\n- [ ] open');
    expect(html).toContain('data-rich-checklist');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
    expect(html).not.toContain('<input');
  });

  it('keeps tables and reports dropped images as a lossy move', () => {
    expect(markdownToNoteHtml('| a | b |\n| --- | --- |\n| 1 | 2 |').html).toContain('<table>');
    const image = markdownToNoteHtml('![alt](https://x.y/p.png)');
    expect(image.lostImages).toBe(true);
    expect(image.html).not.toContain('<img');
  });
});

describe('convertNoteContent', () => {
  it('moves standard ↔ rich verbatim (one storage subset)', () => {
    expect(convertNoteContent('<p>x</p>', 'standard', 'rich')).toEqual({
      convertible: true,
      content: '<p>x</p>',
      lossy: false,
    });
  });

  it('lands rich content in markdown as markdown, not HTML soup', () => {
    const out = convertNoteContent('<div><b>bold</b> words</div>', 'standard', 'markdown');
    expect(out.lossy).toBe(false);
    expect(out.content).toBe('**bold** words');
  });

  it('lands markdown in a text note as rendered formatting, not literal # lines', () => {
    const out = convertNoteContent('# Heading\n\ntext', 'markdown', 'standard');
    expect(out.lossy).toBe(false);
    expect(out.content).toContain('<h1>Heading</h1>');
    expect(out.content).toContain('text');
    expect(out.content).not.toContain('# Heading');
  });

  it('projects a task list as the checklist it is', () => {
    const tasks = convertNoteContent(
      JSON.stringify({
        version: 1,
        color: 'blue',
        tasks: [
          {
            id: 't1',
            title: 'Buy milk',
            notes: '',
            completed: true,
            completedAt: '2026-01-01T00:00:00.000Z',
            dueDate: '',
            reminderAt: '',
            reminderNotifiedAt: '',
            flagged: false,
            priority: 'none',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            sortOrder: 0,
          },
        ],
      }),
      'tasks',
      'markdown',
    );
    expect(tasks.lossy).toBe(false);
    expect(tasks.content).toBe('- [x] Buy milk');
    // The html arm carries the checklist shape the editor edits.
    const rich = convertNoteContent(tasks.content, 'markdown', 'standard');
    expect(rich.content).toContain('data-rich-checklist');
  });

  it('flags a task list with reminders/flags/priorities as lossy text', () => {
    const content = JSON.stringify({
      version: 1,
      color: 'blue',
      tasks: [
        {
          id: 't1',
          title: 'Ring the bell',
          notes: '',
          completed: false,
          completedAt: '',
          dueDate: '',
          reminderAt: '2026-01-01T09:00:00.000Z',
          reminderNotifiedAt: '',
          flagged: false,
          priority: 'none',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sortOrder: 0,
        },
      ],
    });
    const out = convertNoteContent(content, 'tasks', 'markdown');
    expect(out.lossy).toBe(true);
    expect(out.content).toContain('- [ ] Ring the bell');
  });

  it("carries a drawing's text elements; a shapes-only scene says so", () => {
    const withText = convertNoteContent(
      JSON.stringify({ version: 1, elements: [{ type: 'text', text: 'sign here' }] }),
      'drawing',
      'markdown',
    );
    expect(withText.lossy).toBe(false);
    expect(withText.content).toContain('sign here');

    const shapesOnly = convertNoteContent(
      JSON.stringify({ version: 1, elements: [{ type: 'rect', x: 1 }] }),
      'drawing',
      'standard',
    );
    expect(shapesOnly.lossy).toBe(true);
    expect(shapesOnly.content).toBe('');
  });

  it('turns checklist-shaped notes into real tasks', () => {
    const fromHtml = convertNoteContent(
      '<ul data-rich-checklist="true"><li data-checked="false">milk</li><li data-checked="true">eggs</li></ul>',
      'standard',
      'tasks',
    );
    expect(fromHtml.lossy).toBe(false);
    expect(JSON.parse(fromHtml.content).tasks).toMatchObject([
      { title: 'milk', completed: false },
      { title: 'eggs', completed: true },
    ]);

    const fromMarkdown = convertNoteContent('- [ ] one\n- [x] two', 'markdown', 'tasks');
    expect(fromMarkdown.lossy).toBe(false);
    expect(JSON.parse(fromMarkdown.content).tasks).toHaveLength(2);
  });

  it('asks on behalf of prose a task list cannot hold', () => {
    const out = convertNoteContent('<div>just words</div>', 'standard', 'tasks');
    expect(out.lossy).toBe(true);
    expect(out.lossNote).toBeTruthy();
    expect(JSON.parse(out.content).tasks).toEqual([]);
  });

  it('starts a drawing fresh and says so when content was there', () => {
    const empty = convertNoteContent('', 'standard', 'drawing');
    expect(empty.lossy).toBe(false);
    expect(empty.content).toContain('"elements"');

    const full = convertNoteContent('<div>words</div>', 'standard', 'drawing');
    expect(full.lossy).toBe(true);
    expect(full.lossNote).toBeTruthy();
    expect(full.content).toContain('"elements"');
  });

  it('refuses a type this build does not know', () => {
    expect(convertNoteContent('anything', 'from-the-future', 'standard').convertible).toBe(false);
  });
});
