/**
 * The 12 case conversions behind the editor's right-click menu.
 *
 * Extracted from context-menu.ts so the pure string transformations live in
 * their own module — they are one of the pieces that survives the editor
 * rewrite, and they are trivially unit-testable with zero DOM deps.
 */

export interface CaseDef {
  id: string;
  label: string;
  hint?: string;
  convert: (text: string) => string;
}

const SMALL_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'of',
  'at',
  'by',
  'for',
  'nor',
  'so',
  'yet',
  'to',
  'up',
  'off',
  'out',
]);

function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

export const CASES: CaseDef[] = [
  {
    id: 'upper',
    label: 'UPPERCASE',
    convert: (text) => text.toUpperCase(),
  },
  {
    id: 'lower',
    label: 'lowercase',
    convert: (text) => text.toLowerCase(),
  },
  {
    id: 'sentence',
    label: 'Sentence case',
    convert: (text) =>
      text
        .split(/\n{2,}/)
        .map((paragraph) =>
          paragraph
            .split(/([.!?]\s+)/)
            .map((chunk) =>
              chunk.startsWith(' ') || chunk.startsWith('\n')
                ? chunk
                : chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase(),
            )
            .join(''),
        )
        .join('\n\n'),
  },
  {
    id: 'title',
    label: 'Title Case',
    convert: (text) =>
      text
        .split('\n')
        .map((line) => {
          const words = line.split(' ');
          const last = words.length - 1;
          return words
            .map((word, index) => {
              const lower = word.toLowerCase();
              if (index > 0 && index < last && SMALL_WORDS.has(lower.replace(/[^a-z]/g, ''))) {
                return lower;
              }
              return lower.charAt(0).toUpperCase() + lower.slice(1);
            })
            .join(' ');
        })
        .join('\n'),
  },
  {
    id: 'capitalized',
    label: 'Capitalize Each Word',
    convert: (text) =>
      text
        .toLowerCase()
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' '),
  },
  {
    id: 'camel',
    label: 'camelCase',
    convert: (text) =>
      splitWords(text)
        .map((word, index) =>
          index === 0
            ? word.toLowerCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(''),
  },
  {
    id: 'pascal',
    label: 'PascalCase',
    convert: (text) =>
      splitWords(text)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(''),
  },
  {
    id: 'snake',
    label: 'snake_case',
    convert: (text) =>
      splitWords(text)
        .map((word) => word.toLowerCase())
        .join('_'),
  },
  {
    id: 'kebab',
    label: 'kebab-case',
    convert: (text) =>
      splitWords(text)
        .map((word) => word.toLowerCase())
        .join('-'),
  },
  {
    id: 'constant',
    label: 'CONSTANT_CASE',
    convert: (text) =>
      splitWords(text)
        .map((word) => word.toUpperCase())
        .join('_'),
  },
  {
    id: 'alternating',
    label: 'aLtErNaTiNg',
    convert: (text) =>
      text
        .split('')
        .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char.toLowerCase()))
        .join(''),
  },
  {
    id: 'inverse',
    label: 'tOGGLE cASE',
    convert: (text) =>
      text
        .split('')
        .map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
        .join(''),
  },
];
