/**
 * Note text statistics — pure functions, no DOM. Everything the statistics
 * modal and the word-count pill display is computed here: word/character/
 * sentence/paragraph counts, reading and speaking time, lexical density,
 * the Flesch readability estimate and the most common content word.
 *
 * THE ONE UNIT MODEL (the statistics are only as honest as the units they
 * all share). A "word" is:
 *   • a whitespace-separated chunk with its EDGE punctuation stripped —
 *     internal punctuation stays, so "don't", "well-known", "3.14" and
 *     "e^{i\pi}+1=0" are each ONE word (splitting them internally is what
 *     once made "unique words" exceed "words" on URL- and equation-heavy
 *     notes); or
 *   • a single CJK character (the Word/Docs convention for spaceless
 *     scripts — a Han ideograph or kana is a word by itself).
 * A chunk that strips to nothing ("—", "，") is not a word.
 *
 * Two derived subsets, both BY CONSTRUCTION subsets of the units:
 *   • vocabulary units — units that contain letters, except URL-shaped
 *     addresses (an address is a word for counting, but not a vocabulary
 *     word: no "most common word: https://…");
 *   • content units — vocabulary units outside the stop-word sets
 *     (English function words + the common CJK particles).
 * From those subsets the impossible outputs become structurally
 * impossible: uniqueWords ≤ words, and lexical density ≤ 100% — the QA
 * report caught both ("unique 10 > words 7", "density 142.9%") when the
 * counters were three private tokenizers that disagreed.
 *
 * Sentences end at runs of . ! ? 。！？ followed by whitespace or the end
 * of the text — EXCEPT inside protected spans (URLs, e-mail addresses,
 * decimal numbers, bare domains), so "https://example.com" and "3.14" no
 * longer end sentences. Abbreviations ("Mr. Smith") stay unhandled: the
 * heuristics describe a note, they don't grade it. Tests pin the exact
 * numbers in src/lib/text-stats.test.ts.
 */

/** The CJK ranges that count word-per-character (Hiragana, Katakana, Han). */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Same ranges, global — for counting and peeling characters. */
const CJK_CHAR_GLOBAL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/**
 * A whole unit that is a web address. Counted as a word (it occupies the
 * sentence), but never a vocabulary word — it would poison unique-word,
 * most-common-word and syllable statistics.
 */
const URL_UNIT = /^(?:https?:\/\/|www\.)\S*$/i;

/** Strips edge punctuation, keeping internal characters (don't, 3.14). */
function stripEdgePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

/** One word — see the unit model in the module header. */
interface WordUnit {
  /** The unit as the user sees it (edges stripped). */
  text: string;
  /** Comparison form: lowercased text. */
  key: string;
  /** True when the unit counts as a vocabulary word. */
  isVocabulary: boolean;
}

/**
 * Enumerates every word unit in the text — the ONE list every statistic
 * is derived from (see the module header for the model).
 */
function wordUnits(str: string): WordUnit[] {
  const units: WordUnit[] = [];
  for (const chunk of str.split(/\s+/)) {
    if (chunk === '') {
      continue;
    }
    // CJK characters peel off as individual units; the remainder is (at
    // most) one more unit.
    let rest = '';
    for (const ch of chunk) {
      if (CJK_CHAR.test(ch)) {
        units.push({ text: ch, key: ch, isVocabulary: true });
      } else {
        rest += ch;
      }
    }
    const word = stripEdgePunctuation(rest);
    if (word !== '') {
      units.push({
        text: word,
        key: word.toLowerCase(),
        isVocabulary: /\p{L}/u.test(word) && !URL_UNIT.test(word),
      });
    }
  }
  return units;
}

export function countWords(str: string): number {
  return wordUnits(str).length;
}

/**
 * The vocabulary units' comparison forms — lowercase words with edge
 * punctuation removed, internal punctuation kept. Digits-only and
 * URL-shaped units are not vocabulary.
 */
export function extractWordTokens(str: string): string[] {
  return wordUnits(str)
    .filter((unit) => unit.isVocabulary)
    .map((unit) => unit.key);
}

export function countSyllables(word: string): number {
  const asciiWord = word.toLowerCase().replace(/[^a-z']/g, '');
  let total = 0;

  if (asciiWord.length > 0) {
    const syllableMatches = asciiWord
      .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
      .replace(/^y/, '')
      .match(/[aeiouy]{1,2}/g);
    total += syllableMatches ? syllableMatches.length : 1;
  }

  // A CJK character is one syllable (the standard approximation — the
  // heuristic above sees no ASCII vowels in 你好 and used to return 0,
  // inflating Flesch to its ceiling on every CJK note).
  total += (word.match(CJK_CHAR_GLOBAL) ?? []).length;

  // Other scripts (Arabic, Cyrillic, …) have no honest heuristic here;
  // one syllable keeps the readability denominator nonzero.
  if (total === 0 && /\p{L}/u.test(word)) {
    total = 1;
  }

  return total;
}

/** Sentence terminators, ASCII and fullwidth. */
const SENTENCE_TERMINATOR = /[.!?。！？]/;

/** The fullwidth (CJK) subset — they end sentences without a space. */
const FULLWIDTH_TERMINATOR = /[。！？]/;

/** Spans whose dots must not end a sentence. */
const PROTECTED_SPANS = [
  // Full URLs (scheme or www.) — greedy to the first whitespace.
  /\b(?:https?:\/\/|www\.)\S+/gi,
  // E-mail addresses.
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  // Decimal numbers: 3.14, 1,000.50, version 1.2.3.
  /\d+(?:[.,]\d+)+/g,
  // Bare domains: example.com — but not at a sentence end, where the
  // trailing dot is the terminator (the (?![\w.]) lookahead stops the
  // match before "example.com." swallows the full stop).
  /\b[\w-]+\.[a-z]{2,}(?![\w.])/gi,
];

/**
 * The text's sentences as trimmed spans. A sentence ends at a RUN of
 * terminators followed by whitespace or end-of-text; terminators inside
 * protected spans (URLs, e-mails, decimals, bare domains) never end one.
 * Text without any terminator is one sentence, like the old split — but
 * "https://example.com is live" no longer counts as two.
 */
export function splitSentences(str: string): string[] {
  const protectedFlags = new Uint8Array(str.length);
  for (const pattern of PROTECTED_SPANS) {
    for (const match of str.matchAll(pattern)) {
      protectedFlags.fill(1, match.index!, match.index! + match[0].length);
    }
  }

  const spans: Array<[number, number]> = [];
  const length = str.length;
  let spanStart = -1;
  let i = 0;
  while (i < length) {
    const ch = str[i]!;
    if (!protectedFlags[i] && SENTENCE_TERMINATOR.test(ch)) {
      let end = i + 1;
      while (end < length && !protectedFlags[end] && SENTENCE_TERMINATOR.test(str[end])) {
        end++;
      }
      // When does the run end a sentence?
      //  • at end-of-text, or before whitespace — the Latin rule;
      //  • before a non-word character (')' , ',' after the dot);
      //  • ALWAYS for the fullwidth terminators — CJK scripts write no
      //    space after the stop, so "你好。再见" must be two sentences
      //    (an ASCII dot stays glued to "note.com"-shaped words).
      const next = end < length ? str[end] : '';
      const atBreak =
        end >= length ||
        /\s/.test(next) ||
        !/[\p{L}\p{N}_]/u.test(next) ||
        FULLWIDTH_TERMINATOR.test(ch);
      if (atBreak && spanStart !== -1) {
        spans.push([spanStart, i]);
        spanStart = -1;
      }
      i = end;
      continue;
    }
    if (spanStart === -1 && !/\s/.test(ch)) {
      spanStart = i;
    }
    i++;
  }
  if (spanStart !== -1) {
    spans.push([spanStart, length]);
  }
  return spans.map(([start, end]) => str.slice(start, end).trim()).filter((span) => span !== '');
}

export interface NoteStatistics {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  sentences: number;
  paragraphs: number;
  averageWordLength: string | number;
  readingTime: string;
  uniqueWords: number;
  lexicalDensity: string;
  mostCommonWord: string;
  readabilityScore: string;
  estimatedPages: string;
  estimatedSpeakingTime: string;
  writingTime: string;
  wordsPerSentence: string;
  longestWord: string;
  longestSentence: string;
}

export function calculateNoteStatistics(str: string): NoteStatistics {
  if (!str || str.trim() === '') {
    return {
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
    };
  }

  const characters = str.length;

  // The ONE unit list — every countable word below comes from here.
  const units = wordUnits(str);
  const words = units.length;
  const vocabulary = units.filter((unit) => unit.isVocabulary);
  // Content units: vocabulary minus the function words. content ⊆
  // vocabulary ⊆ units, so uniqueWords ≤ words and density ≤ 100% hold
  // structurally, not by clamping.
  const content = vocabulary.filter((unit) => !isStopWord(unit.key));

  // Sentences — dots inside URLs, e-mails and decimals protected.
  const sentenceSpans = splitSentences(str);
  const sentences = sentenceSpans.length;

  // Count paragraphs — CRLF content normalizes first: a `\r\n\r\n`
  // break never matched the \n-only pattern, so a pasted CRLF note read
  // as ONE paragraph.
  const normalizedBreaks = str.replace(/\r\n?/g, '\n');
  const paragraphs = normalizedBreaks.split(/\n{2,}/).filter((p) => p.trim().length > 0).length;

  // Average word length: the mean of the units' lengths in code points
  // (a "👍" is one character, not two UTF-16 halves).
  const totalUnitLength = units.reduce((total, unit) => total + [...unit.text].length, 0);
  const averageWordLength = words > 0 ? (totalUnitLength / words).toFixed(2) : 0;

  // Reading time at 200 wpm.
  const readingTimeMinutes = Math.ceil(words / 200);
  const readingTime = readingTimeMinutes === 1 ? '1 min' : `${readingTimeMinutes} mins`;

  // Unique words: distinct vocabulary keys.
  const uniqueWords = new Set(vocabulary.map((unit) => unit.key)).size;

  // Lexical density: content units over all units.
  const lexicalDensityScore = words > 0 ? ((content.length / words) * 100).toFixed(1) : 0;

  // Most common content word; the first wins a frequency tie.
  const contentFrequency: Record<string, number> = {};
  let maxCount = 0;
  let mostCommonWord = 'N/A';
  content.forEach((unit) => {
    contentFrequency[unit.key] = (contentFrequency[unit.key] || 0) + 1;
    if (contentFrequency[unit.key] > maxCount) {
      maxCount = contentFrequency[unit.key];
      mostCommonWord = unit.key;
    }
  });

  // Flesch reading ease, clamped to 0–100. Syllables come from the
  // vocabulary (a URL has letters but no syllables worth counting).
  const syllableCount = vocabulary.reduce((total, unit) => total + countSyllables(unit.text), 0);
  const averageWordsPerSentence = sentences > 0 ? words / sentences : words;
  const averageSyllablesPerWord = words > 0 ? syllableCount / words : 0;
  const readabilityScore =
    sentences > 0 && words > 0
      ? Math.max(
          0,
          Math.min(100, 206.835 - 1.015 * averageWordsPerSentence - 84.6 * averageSyllablesPerWord),
        ).toFixed(1)
      : '0.0';

  const estimatedPagesValue = Math.round((words / 250) * 10) / 10;
  const estimatedPages =
    estimatedPagesValue === 0
      ? '0.0 pages'
      : `${estimatedPagesValue.toFixed(1)} ${estimatedPagesValue === 1 ? 'page' : 'pages'}`;

  const speakingTimeMinutes = Math.ceil(words / 130);
  const estimatedSpeakingTime = speakingTimeMinutes === 1 ? '1 min' : `${speakingTimeMinutes} mins`;

  // The fun extras: writing time at a 40 wpm typing pace, characters
  // without whitespace, the shape of a sentence on average, and the
  // note's records (its longest word and longest sentence).
  const charactersNoSpaces = str.replace(/\s/g, '').length;

  const writingTimeMinutes = Math.ceil(words / 40);
  const writingTime = writingTimeMinutes === 1 ? '1 min' : `${writingTimeMinutes} mins`;

  const wordsPerSentence = sentences > 0 ? (words / sentences).toFixed(1) : '0.0';

  let longestWord = 'N/A';
  let longestWordLength = 0;
  for (const unit of units) {
    const unitLength = [...unit.text].length;
    if (unitLength > longestWordLength) {
      longestWordLength = unitLength;
      longestWord = unit.text;
    }
  }

  let longestSentenceWords = 0;
  for (const span of sentenceSpans) {
    longestSentenceWords = Math.max(longestSentenceWords, wordUnits(span).length);
  }
  const longestSentence = `${longestSentenceWords} words`;

  return {
    characters,
    charactersNoSpaces,
    words,
    sentences,
    paragraphs,
    averageWordLength,
    readingTime,
    uniqueWords,
    lexicalDensity: `${lexicalDensityScore}%`,
    mostCommonWord:
      mostCommonWord === 'N/A'
        ? mostCommonWord
        : mostCommonWord.charAt(0).toUpperCase() + mostCommonWord.slice(1),
    readabilityScore,
    estimatedPages,
    estimatedSpeakingTime,
    writingTime,
    wordsPerSentence,
    longestWord,
    longestSentence,
  };
}

/** True for English stop words and the common CJK particles. */
function isStopWord(key: string): boolean {
  return STOP_WORDS.has(key) || CJK_FUNCTION_CHARS.has(key);
}

/**
 * The particles that glue CJK sentences together — the function-word
 * equivalents of "the"/"is"/"of". Without them every Han character read
 * as a content word and pure-CJK notes reported ~100% lexical density.
 * Approximate by design: real CJK segmentation needs a dictionary.
 */
const CJK_FUNCTION_CHARS = new Set([
  ...'的了是在和也就都而及与或但呢吧吗啊呀哦嘛么于把被让给跟对从向着',
]);

export const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);
