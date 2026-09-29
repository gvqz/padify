import { describe, expect, it } from 'vitest';
import {
  buildMathShell,
  escapeHtmlAttr,
  MATH_LATEX_PATTERN,
} from './math';

describe('math shell building', () => {
  it('escapes quotes and angle brackets in the latex attribute', () => {
    const shell = buildMathShell('a"b<c>d&e');
    expect(shell).toContain('data-latex="a&quot;b&lt;c&gt;d&amp;e"');
    expect(shell).toContain('contenteditable="false"');
  });

  it('keeps backslashes (the LaTeX vocabulary) untouched', () => {
    expect(buildMathShell('\\frac{1}{2}')).toContain('data-latex="\\frac{1}{2}"');
  });

  it('caps the latex source length', () => {
    expect(MATH_LATEX_PATTERN.test('x^2')).toBe(true);
    expect(MATH_LATEX_PATTERN.test('x'.repeat(2001))).toBe(false);
  });

  it('escapeHtmlAttr round-trips through an attribute', () => {
    const raw = '\\sum_{i=1}^{n} "a<b" & c';
    const div = document.createElement('div');
    div.innerHTML = buildMathShell(raw);
    expect((div.firstChild as HTMLElement).getAttribute('data-latex')).toBe(raw);
    expect(escapeHtmlAttr('"')).toBe('&quot;');
  });
});
