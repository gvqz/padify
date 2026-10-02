/**
 * Note text statistics — pure functions, no DOM. Everything the statistics
 * modal and the word-count pill display is computed here: word/character/
 * sentence/paragraph counts, reading and speaking time, lexical density,
 * the Flesch readability estimate and the most common content word.
 *
 * The heuristics are deliberately simple (stop-word list, syllable
 * guessing, 200 wpm reading pace); they describe a note, they don't grade
 * it. Tests pin the exact numbers in src/lib/text-stats.test.ts.
 */

export function countWords(str: string): number {
  const trimmedText = str.trim();

  if (trimmedText === '') {
    return 0;
  }

  return trimmedText.split(/\s+/).length;
}

export function extractWordTokens(str: string): string[] {
  return str.toLowerCase().match(/\b[a-z']+\b/g) || [];
}

export function countSyllables(word: string): number {
  const cleanedWord = word.toLowerCase().replace(/[^a-z']/g, '');

  if (cleanedWord.length === 0) {
    return 0;
  }

  const syllableMatches = cleanedWord
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);

  return syllableMatches ? syllableMatches.length : 1;
}

export function calculateCharactersAndWords(str: string): string {
  const characterCount = str.length;
  const wordCount = str !== '' ? countWords(str) : 0;
  const characterString = characterCount === 1 ? 'character' : 'characters';
  const wordString = wordCount === 1 ? 'word' : 'words';
  const wordCountText = `${characterCount} ${characterString} • ${wordCount} ${wordString}`;

  return wordCountText;
}

export interface NoteStatistics {
  characters: number;
  words: number;
  sentences: number;
  paragraphs: number;
  averageWordLength: string | number;
  readingTime: string;
  uniqueWords: number;
  lexicalDensity: string;
  lexicalDensityScore: string;
  mostCommonWord: string;
  readabilityScore: string;
  estimatedPages: string;
  estimatedSpeakingTime: string;
}

export function calculateNoteStatistics(str: string): NoteStatistics {
  if (!str || str.trim() === '') {
    return {
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
    };
  }

  const characters = str.length;
  const words = countWords(str);
  const wordTokens = extractWordTokens(str);

  // Count sentences (split by . ! ?)
  const sentences = str.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;

  // Count paragraphs (split by double newlines or multiple line breaks)
  const paragraphs = str.split(/\n\n+/).filter((p) => p.trim().length > 0).length;

  // Calculate average word length
  const averageWordLength = words > 0 ? (characters / words).toFixed(2) : 0;

  // Calculate reading time (average 200 words per minute)
  const readingTimeMinutes = Math.ceil(words / 200);
  const readingTime = readingTimeMinutes === 1 ? '1 min' : `${readingTimeMinutes} mins`;

  const contentWords = wordTokens.filter((word) => !STOP_WORDS.has(word));

  // Calculate unique words from the full token set
  const wordFrequency: Record<string, number> = {};
  wordTokens.forEach((word) => {
    wordFrequency[word] = (wordFrequency[word] || 0) + 1;
  });

  // Calculate most common content word separately so stop words are excluded
  const contentWordFrequency: Record<string, number> = {};
  let maxCount = 0;
  let mostCommonWord = 'N/A';

  contentWords.forEach((word) => {
    contentWordFrequency[word] = (contentWordFrequency[word] || 0) + 1;
    if (contentWordFrequency[word] > maxCount) {
      maxCount = contentWordFrequency[word];
      mostCommonWord = word;
    }
  });

  const uniqueWords = Object.keys(wordFrequency).length;
  const lexicalDensityScore = words > 0 ? ((contentWords.length / words) * 100).toFixed(1) : 0;

  const syllableCount = wordTokens.reduce((total, word) => total + countSyllables(word), 0);
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

  return {
    characters,
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
    lexicalDensityScore: `${lexicalDensityScore}%`,
  };
}

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
