import { describe, expect, it } from 'vitest';
import { MAX_MERGE_BYTES, mergeNoteVersions, type NoteVersion } from './notes';
import { tagsBalance, tokenizeHtml, tokenizeText, detokenize } from './tokens';

const version = (name: string | null, content: string, noteType?: string): NoteVersion => ({
  name,
  content,
  ...(noteType ? { noteType: noteType as NoteVersion['noteType'] } : {}),
});

describe('mergeNoteVersions — status routing', () => {
  it('html notes merge their words and their names', () => {
    const merge = mergeNoteVersions(
      version('List', '<p>buy milk</p><p>walk dog</p>'),
      version('Groceries', '<p>buy oat milk</p><p>walk dog</p>'),
      version('List', '<p>buy milk</p><p>walk the dog</p>'),
    );
    expect(merge.status).toBe('clean');
    expect(merge.name).toBe('Groceries'); // only one side renamed
    expect(merge.content).toBe('<p>buy oat milk</p><p>walk the dog</p>');
  });

  it('markdown notes merge as text', () => {
    const merge = mergeNoteVersions(
      version(null, '# title\n\nbody', 'markdown'),
      version(null, '# Title\n\nbody', 'markdown'),
      version(null, '# title\n\nbody with more', 'markdown'),
    );
    expect(merge.status).toBe('clean');
    expect(merge.content).toBe('# Title\n\nbody with more');
  });

  it('two different renames conflict even when the words merge', () => {
    const merge = mergeNoteVersions(
      version('Base', '<p>same words</p>'),
      version('Mine', '<p>same words and mine</p>'),
      version('Theirs', '<p>same words and theirs</p>'),
    );
    // The words overlap too — but even words that WOULD merge carry the
    // name conflict to review.
    expect(merge.status).toBe('conflict');
  });

  it('a rename on one side with a clean word merge stays clean', () => {
    const merge = mergeNoteVersions(
      version('Base', 'a b c'),
      version('Base', 'a b c d'), // mine: appended
      version('Renamed', 'a b c'), // theirs: renamed only
    );
    expect(merge.status).toBe('clean');
    expect(merge.name).toBe('Renamed');
    expect(merge.content).toBe('a b c d');
  });

  it('task lists never merge — json is not prose', () => {
    const merge = mergeNoteVersions(
      version(null, '{"tasks":[]}', 'tasks'),
      version(null, '{"tasks":[{"title":"mine"}]}', 'tasks'),
      version(null, '{"tasks":[{"title":"theirs"}]}', 'tasks'),
    );
    expect(merge.status).toBe('unmergeable');
    expect(merge.content).toBe('{"tasks":[{"title":"mine"}]}'); // mine kept
  });

  it('drawings never merge', () => {
    const merge = mergeNoteVersions(
      version(null, '{}', 'drawing'),
      version(null, '{"a":1}', 'drawing'),
      version(null, '{"b":2}', 'drawing'),
    );
    expect(merge.status).toBe('unmergeable');
  });

  it('a kind change between versions never merges', () => {
    const merge = mergeNoteVersions(
      version(null, '<p>html</p>'),
      version(null, '<p>html edited</p>'),
      version(null, 'markdown now', 'markdown'),
    );
    expect(merge.status).toBe('unmergeable');
  });

  it('oversized notes answer conflict instead of a giant splice', () => {
    const big = 'x'.repeat(MAX_MERGE_BYTES + 1);
    const merge = mergeNoteVersions(
      version(null, big),
      version(null, `${big} mine`),
      version(null, `${big} theirs`),
    );
    expect(merge.status).toBe('conflict');
  });
});

describe('mergeNoteVersions — html well-formedness', () => {
  it('merged html keeps its tags balanced', () => {
    const merge = mergeNoteVersions(
      version(null, '<p>alpha beta gamma</p>'),
      version(null, '<p><b>alpha</b> beta gamma</p>'),
      version(null, '<p>alpha beta <i>gamma</i></p>'),
    );
    expect(merge.status).toBe('clean');
    expect(tagsBalance(tokenizeHtml(merge.content))).toBe(true);
  });

  it('a merge that would split a tag pair answers conflict', () => {
    // Both sides change inside the SAME tag's text differently — the
    // merge engine answers conflict before any soup can form.
    const merge = mergeNoteVersions(
      version(null, '<p>one</p>'),
      version(null, '<p>one two</p>'),
      version(null, '<p>one three</p>'),
    );
    expect(merge.status).toBe('conflict');
  });
});

describe('tokens — the merge substrate', () => {
  it('html tokenization keeps whole tags as single atoms', () => {
    const tokens = tokenizeHtml('<p class="x">hi <b>there</b></p>');
    expect(tokens.map((t) => t.value)).toEqual([
      '<p class="x">',
      'hi',
      ' ',
      '<b>',
      'there',
      '</b>',
      '</p>',
    ]);
    expect(detokenize(tokens)).toBe('<p class="x">hi <b>there</b></p>');
  });

  it('text tokenization splits words and whitespace runs', () => {
    expect(tokenizeText('a  b\n\nc').map((t) => t.value)).toEqual(['a', '  ', 'b', '\n\n', 'c']);
  });

  it('a stray unclosed < reads as text', () => {
    const tokens = tokenizeHtml('a < b');
    expect(tokens.every((t) => t.kind === 'text')).toBe(true);
    expect(detokenize(tokens)).toBe('a < b');
  });

  it('tagsBalance accepts nested and void tags', () => {
    expect(tagsBalance(tokenizeHtml('<div><p>a<br>b<img src="x"></p></div>'))).toBe(true);
  });

  it('tagsBalance rejects split and stray pairs', () => {
    expect(tagsBalance(tokenizeHtml('<div><p></div></p>'))).toBe(false);
    expect(tagsBalance(tokenizeHtml('</p>'))).toBe(false);
    expect(tagsBalance(tokenizeHtml('<div>unclosed'))).toBe(false);
  });
});
