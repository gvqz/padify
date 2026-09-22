import { describe, expect, it } from 'vitest';
import { CASES, type CaseDef } from './case-conversions';

const byId = (id: string): CaseDef => {
  const def = CASES.find((entry) => entry.id === id);
  if (!def) throw new Error(`unknown case id: ${id}`);
  return def;
};

const convert = (id: string, text: string): string => byId(id).convert(text);

describe('case conversions', () => {
  it('exposes 12 unique, labelled transformations', () => {
    expect(CASES).toHaveLength(12);
    const ids = CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(12);
    for (const entry of CASES) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('uppercases and lowercases', () => {
    expect(convert('upper', 'Hello World')).toBe('HELLO WORLD');
    expect(convert('lower', 'Hello World')).toBe('hello world');
  });

  it('sentence case capitalises sentence starts and lowercases the rest', () => {
    expect(convert('sentence', 'hello there. GENERAL kenobi!')).toBe(
      'Hello there. General kenobi!',
    );
  });

  it('sentence case handles multiple paragraphs', () => {
    expect(convert('sentence', 'a. b!\n\nc? d.')).toBe('A. B!\n\nC? D.');
  });

  it('title case keeps small words lowercase mid-sentence', () => {
    expect(convert('title', 'the quick brown fox and the dog')).toBe(
      'The Quick Brown Fox and the Dog',
    );
  });

  it('title case always capitalises the first and last word', () => {
    expect(convert('title', 'a dog and a cat')).toBe('A Dog and a Cat');
  });

  it('capitalise-each-word', () => {
    expect(convert('capitalized', 'hello world foo')).toBe('Hello World Foo');
  });

  it('camelCase splits on spaces, dashes, underscores and camel humps', () => {
    expect(convert('camel', 'Hello World-example fooBar')).toBe('helloWorldExampleFooBar');
  });

  it('PascalCase', () => {
    expect(convert('pascal', 'hello world')).toBe('HelloWorld');
  });

  it('snake_case', () => {
    expect(convert('snake', 'Hello World')).toBe('hello_world');
  });

  it('kebab-case', () => {
    expect(convert('kebab', 'Hello World')).toBe('hello-world');
  });

  it('CONSTANT_CASE', () => {
    expect(convert('constant', 'hello world')).toBe('HELLO_WORLD');
  });

  it('aLtErNaTiNg starts uppercase on even indices', () => {
    expect(convert('alternating', 'abcdef')).toBe('AbCdEf');
  });

  it('tOGGLE cASE flips every character', () => {
    expect(convert('inverse', 'Hello World')).toBe('hELLO wORLD');
  });

  it('leaves text without letters untouched for every case', () => {
    for (const entry of CASES) {
      expect(entry.convert('123')).toBe('123');
    }
  });
});
