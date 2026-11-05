import { describe, expect, it } from 'vitest';
import { mergeThreeWay } from './diff3';
import { tokenizeHtml, tokenizeText, detokenize } from './tokens';

const words = (source: string) => tokenizeText(source);
const mergeWords = (base: string, mine: string, theirs: string) => {
  const result = mergeThreeWay(words(base), words(mine), words(theirs));
  return { ...result, text: detokenize(result.merged) };
};

describe('mergeThreeWay — the cheap wins', () => {
  it('both sides identical: that version wins', () => {
    const merge = mergeWords('buy milk', 'buy oat milk', 'buy oat milk');
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('buy oat milk');
  });

  it('mine never moved: theirs wins wholesale', () => {
    const merge = mergeWords('buy milk', 'buy milk', 'buy milk and eggs');
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('buy milk and eggs');
  });

  it('theirs never moved: mine wins wholesale', () => {
    const merge = mergeWords('buy milk', 'buy milk and eggs', 'buy milk');
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('buy milk and eggs');
  });
});

describe('mergeThreeWay — the auto-merge', () => {
  it('edits at opposite ends of the list merge — the grocery story', () => {
    const merge = mergeWords(
      'milk\nbread\neggs\nrice\ncoffee', // base
      'oat milk\nbread\neggs\nrice\ncoffee', // here: renamed the top item
      'milk\nbread\neggs\nrice\ndecaf coffee', // there: fixed the bottom
    );
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('oat milk\nbread\neggs\nrice\ndecaf coffee');
  });

  it('an insertion and a deletion at different spots merge', () => {
    const merge = mergeWords('one two three four', 'one two three four five', 'one three four');
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('one three four five');
  });

  it('both sides made the SAME change: it applies once', () => {
    const merge = mergeWords('buy milk', 'buy oat milk', 'buy oat milk');
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('buy oat milk');
  });

  it('interleaved but non-overlapping edits merge', () => {
    const base = 'a b c d e f g h';
    const mine = 'a B c d e f g h'; // capitalized b
    const theirs = 'a b c d e f G h'; // capitalized g
    const merge = mergeWords(base, mine, theirs);
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('a B c d e f G h');
  });
});

describe('mergeThreeWay — the conflicts', () => {
  it('both sides edited the SAME word differently', () => {
    const merge = mergeWords('buy milk', 'buy red milk', 'buy blue milk');
    expect(merge.conflict).toBe(true);
  });

  it('one deleted the words the other edited', () => {
    const merge = mergeWords('keep this line', 'keep THIS line', '');
    expect(merge.conflict).toBe(true);
  });

  it('overlapping replacements conflict even when the starts differ', () => {
    const merge = mergeWords('a b c d', 'a X c d', 'a Y c d');
    expect(merge.conflict).toBe(true);
  });

  it('a hunk that reaches back into an applied region conflicts', () => {
    // theirs rewrites b c (base [1,3)); mine rewrites c d (base [2,4)) —
    // theirs applies first, mine then reaches back into the consumed
    // region [1,3).
    const merge = mergeWords('a b c d e', 'a b Q R e', 'a X Y d e');
    expect(merge.conflict).toBe(true);
  });

  it('identical overlapping hunks apply once without conflict', () => {
    const merge = mergeWords('a b c d e', 'a X Y d e', 'a X Y d e');
    expect(merge.conflict).toBe(false);
    expect(merge.text).toBe('a X Y d e');
  });
});

describe('mergeThreeWay — html safety', () => {
  it('tags stay atomic: formatting edits merge without slicing tags', () => {
    const base = '<p>plain words here</p>';
    const mine = '<p><b>plain words</b> here</p>'; // bolded the first two
    const theirs = '<p>plain words there</p>'; // changed the last word
    const result = mergeThreeWay(tokenizeHtml(base), tokenizeHtml(mine), tokenizeHtml(theirs));
    expect(result.conflict).toBe(false);
    expect(detokenize(result.merged)).toBe('<p><b>plain words</b> there</p>');
  });

  it('a tag inserted by one side and words by the other merge', () => {
    const base = '<div>alpha beta</div>';
    const mine = '<div><i>alpha</i> beta</div>';
    const theirs = '<div>alpha beta gamma</div>';
    const result = mergeThreeWay(tokenizeHtml(base), tokenizeHtml(mine), tokenizeHtml(theirs));
    expect(result.conflict).toBe(false);
    expect(detokenize(result.merged)).toBe('<div><i>alpha</i> beta gamma</div>');
  });

  it('both sides wrapping the same words in different tags conflicts', () => {
    const base = '<p>words</p>';
    const mine = '<p><b>words</b></p>';
    const theirs = '<p><i>words</i></p>';
    const result = mergeThreeWay(tokenizeHtml(base), tokenizeHtml(mine), tokenizeHtml(theirs));
    expect(result.conflict).toBe(true);
  });
});
