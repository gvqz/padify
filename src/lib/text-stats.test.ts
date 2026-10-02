import { describe, expect, it } from 'vitest';
import {
  countWords,
  extractWordTokens,
  countSyllables,
  calculateCharactersAndWords,
  calculateNoteStatistics,
  STOP_WORDS,
} from './text-stats';

describe('countWords', () => {
  it('returns 0 for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });

  it('counts words separated by any whitespace run', () => {
    expect(countWords('one')).toBe(1);
    expect(countWords('hello world')).toBe(2);
    expect(countWords('a  b\tc')).toBe(3);
  });
});

describe('extractWordTokens', () => {
  it('lowercases and strips punctuation', () => {
    expect(extractWordTokens('Hello, WORLD!')).toEqual(['hello', 'world']);
  });

  it('keeps apostrophes inside words', () => {
    expect(extractWordTokens("don't stop")).toEqual(["don't", 'stop']);
  });

  it('drops purely numeric runs', () => {
    expect(extractWordTokens('123 456')).toEqual([]);
  });
});

describe('countSyllables', () => {
  it('returns 0 for words without letters', () => {
    expect(countSyllables('')).toBe(0);
    expect(countSyllables('123')).toBe(0);
  });

  it('counts simple words', () => {
    expect(countSyllables('a')).toBe(1);
    expect(countSyllables('cat')).toBe(1);
    expect(countSyllables('hello')).toBe(2);
    expect(countSyllables('banana')).toBe(3);
  });

  it('drops a silent trailing e, but keeps -le endings (classic heuristics)', () => {
    // 'make' → 'ma' after the silent-e strip → 1 syllable.
    expect(countSyllables('make')).toBe(1);
    // 'l' is excluded from the strip set, so 'table' keeps its final e → 2.
    expect(countSyllables('table')).toBe(2);
  });
});

describe('calculateCharactersAndWords', () => {
  it('formats counts with pluralisation', () => {
    expect(calculateCharactersAndWords('hello world')).toBe('11 characters • 2 words');
    expect(calculateCharactersAndWords('a')).toBe('1 character • 1 word');
  });

  it('formats zero counts as plural', () => {
    expect(calculateCharactersAndWords('')).toBe('0 characters • 0 words');
  });
});

describe('calculateNoteStatistics', () => {
  it('returns the all-zero shape for empty input', () => {
    expect(calculateNoteStatistics('')).toEqual({
      characters: 0,
      words: 0,
      sentences: 0,
      paragraphs: 0,
      averageWordLength: 0,
      readingTime: '0 min',
      uniqueWords: 0,
      lexicalDensity: '0%',
      lexicalDensityScore: '0%',
      mostCommonWord: 'N/A',
      readabilityScore: '0.0',
      estimatedPages: '0 pages',
      estimatedSpeakingTime: '0 min',
    });
  });

  it('computes full statistics for a known sentence pair', () => {
    const stats = calculateNoteStatistics('The cat sat on the mat. The dog ran away!');
    expect(stats.characters).toBe(41);
    expect(stats.words).toBe(10);
    expect(stats.sentences).toBe(2);
    expect(stats.paragraphs).toBe(1);
    expect(stats.averageWordLength).toBe('4.10');
    expect(stats.uniqueWords).toBe(8); // the ×3 collapses; 8 distinct tokens
    expect(stats.readingTime).toBe('1 min');
    expect(stats.estimatedSpeakingTime).toBe('1 min');
    expect(stats.estimatedPages).toBe('0.0 pages');
    // 6 content words (stop words excluded) out of 10 total.
    expect(stats.lexicalDensity).toBe('60.0%');
    // First content word wins the frequency tie.
    expect(stats.mostCommonWord).toBe('Cat');
    // Flesch clamps at 100 for this easy sentence.
    expect(stats.readabilityScore).toBe('100.0');
  });

  it('separates paragraphs on blank lines', () => {
    expect(calculateNoteStatistics('one two\n\nthree').paragraphs).toBe(2);
  });
});

describe('STOP_WORDS', () => {
  it('contains the common English stop words', () => {
    expect(STOP_WORDS.has('the')).toBe(true);
    expect(STOP_WORDS.has('and')).toBe(true);
    expect(STOP_WORDS.size).toBeGreaterThan(50);
  });
});
