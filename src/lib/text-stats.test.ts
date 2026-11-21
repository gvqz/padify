import { describe, expect, it } from 'vitest';
import {
  countWords,
  extractWordTokens,
  countSyllables,
  calculateNoteStatistics,
  splitSentences,
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

describe('calculateNoteStatistics', () => {
  it('returns the all-zero shape for empty input', () => {
    expect(calculateNoteStatistics('')).toEqual({
      characters: 0,
      charactersNoSpaces: 0,
      words: 0,
      sentences: 0,
      paragraphs: 0,
      averageWordLength: 0,
      readingTime: '0 min',
      uniqueWords: 0,
      lexicalDensity: '0%',
      mostCommonWord: 'N/A',
      readabilityScore: '0.0',
      estimatedPages: '0 pages',
      estimatedSpeakingTime: '0 min',
      writingTime: '0 min',
      wordsPerSentence: '0.0',
      longestWord: 'N/A',
      longestSentence: '0 words',
    });
  });

  it('computes the fun extras: records, no-space characters, writing time', () => {
    const stats = calculateNoteStatistics(
      'Padify keeps every note safe. extraordinary Persistence!',
    );
    expect(stats.longestWord).toBe('extraordinary');
    expect(stats.longestSentence).toBe('5 words');
    expect(stats.charactersNoSpaces).toBe(
      calculateNoteStatistics('Padify keeps every note safe. extraordinary Persistence!')
        .characters - 6,
    );
    expect(stats.wordsPerSentence).toBe('3.5');
    // 7 words at a 40 wpm typing pace — one minute after rounding up.
    expect(stats.writingTime).toBe('1 min');
  });

  it('computes full statistics for a known sentence pair', () => {
    const stats = calculateNoteStatistics('The cat sat on the mat. The dog ran away!');
    expect(stats.characters).toBe(41);
    expect(stats.words).toBe(10);
    expect(stats.sentences).toBe(2);
    expect(stats.paragraphs).toBe(1);
    // The TRUE mean word length: the ten words are 3,3,3,2,3,3,3,3,3,4
    // letters long — 30/10. (The old formula divided ALL characters,
    // spaces included, by words and reported 4.10.)
    expect(stats.averageWordLength).toBe('3.00');
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

describe('CJK and CRLF accounting', () => {
  it('counts Han characters as words (the spaceless-note fix)', () => {
    // A spaceless Chinese sentence used to count as ONE word.
    expect(countWords('你好世界')).toBe(4);
    // Mixed content: 2 Latin words + 4 Han characters.
    expect(countWords('hello 你好世界 world')).toBe(6);
    // Pure Latin keeps the whitespace split.
    expect(countWords('one two three')).toBe(3);
  });

  it('CRLF paragraphs split on \\r\\n\\r\\n breaks', () => {
    const stats = calculateNoteStatistics('first paragraph.\r\n\r\nsecond paragraph.');
    expect(stats.paragraphs).toBe(2);
  });

  it('CJK notes report real unique words (not N/A)', () => {
    const stats = calculateNoteStatistics('你好 你好 世界');
    expect(stats.uniqueWords).toBeGreaterThan(0);
    expect(stats.mostCommonWord).not.toBe('N/A');
  });
});

describe('the one unit model (the QA impossibilities, pinned)', () => {
  it('a URL is one word and never vocabulary: unique words cannot exceed words', () => {
    // The QA report's exact class: "Unique words 10 > Words 7". The old
    // unique-words tokenizer split the URL into https/one/com/… while the
    // word counter saw one whitespace chunk.
    const stats = calculateNoteStatistics('Check https://one.com and https://two.com please.');
    expect(stats.words).toBe(5);
    expect(stats.uniqueWords).toBe(3); // check, and, please — the URLs are not vocabulary
    expect(stats.uniqueWords).toBeLessThanOrEqual(stats.words);
  });

  it('lexical density is bounded by construction, even on equation soup', () => {
    // The QA report saw 142.9%: content TOKENS over whitespace WORDS, two
    // different units. Both sides of the fraction are units now.
    const stats = calculateNoteStatistics('e^{i\\pi}+1=0 and x_2 = 3.14!');
    expect(stats.words).toBe(4); // the equation, and, x_2, 3.14
    expect(stats.uniqueWords).toBe(3);
    expect(stats.lexicalDensity).toBe('50.0%'); // 2 content of 4 units
    expect(parseFloat(stats.lexicalDensity)).toBeLessThanOrEqual(100);
  });

  it('dots inside URLs, e-mails, decimals and bare domains do not end sentences', () => {
    expect(splitSentences('Pi is 3.14 rounded.')).toHaveLength(1); // was 2
    expect(splitSentences('See https://example.com/docs now. Thanks.')).toHaveLength(2);
    expect(splitSentences('Visit example.com today.')).toHaveLength(1);
    expect(splitSentences('Mail me at a.b@host.com or not.')).toHaveLength(1);
    expect(calculateNoteStatistics('See https://example.com/docs now. Thanks.').sentences).toBe(2);
  });

  it('an ellipsis run ends one sentence, and fullwidth stops end CJK ones', () => {
    expect(splitSentences('wait... then go!')).toHaveLength(2);
    expect(splitSentences('你好。再见！')).toHaveLength(2);
  });

  it('punctuation-only chunks are not words (the fullwidth-comma fix)', () => {
    // The old whitespace split counted 你好，世界。 as SIX words — four
    // characters plus the comma and the stop as standalone "words".
    expect(countWords('你好，世界。')).toBe(4);
    expect(countWords('hello — world')).toBe(2);
  });

  it('CJK particles are stop words: a pure-CJK note is not 100% dense', () => {
    const stats = calculateNoteStatistics('我是中国人');
    expect(stats.words).toBe(5);
    expect(stats.lexicalDensity).toBe('80.0%'); // 是 is a function character
  });

  it('syllables: CJK characters count, other scripts get a nonzero floor', () => {
    expect(countSyllables('你好')).toBe(2);
    expect(countSyllables('مرحبا')).toBe(1);
    expect(countSyllables('abc你好')).toBe(3); // 1 ASCII + 2 CJK
  });

  it('the invariants hold across a battery of hostile inputs', () => {
    const battery = [
      'Visit https://example.com/page?a=1&b=2 for more. It helps.',
      'e^{i\\pi}+1=0 and x_2 = 3.14!',
      '你好，世界。我是中国人。',
      'one two three four five six seven eight nine ten.',
      'Mr. Jones went to Washington. He returned!',
      '123 456 789 !!! ??? ...',
      'a',
      'https://only-a-url.example.com',
    ];
    for (const text of battery) {
      const stats = calculateNoteStatistics(text);
      expect(stats.uniqueWords).toBeLessThanOrEqual(stats.words);
      expect(parseFloat(stats.lexicalDensity)).toBeLessThanOrEqual(100);
      expect(stats.words).toBeGreaterThanOrEqual(0);
    }
  });
});
