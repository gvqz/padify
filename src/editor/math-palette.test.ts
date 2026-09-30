import { describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import {
  MATH_CATEGORIES,
  mountMathPalette,
  symbolCaretOffset,
  symbolDisplay,
  symbolLatex,
  type MathSymbol,
} from './math-palette';

/** Flattens every palette symbol, once. */
function* allSymbols(): Generator<{ category: string; symbol: MathSymbol }> {
  for (const category of MATH_CATEGORIES) {
    for (const symbol of category.symbols) {
      yield { category: category.id, symbol };
    }
  }
}

describe('math palette vocabulary', () => {
  it('every glyph renders in KaTeX without the error class', () => {
    const broken: string[] = [];
    for (const { category, symbol } of allSymbols()) {
      const html = katex.renderToString(symbolDisplay(symbol), { throwOnError: false });
      if (html.includes('katex-error')) {
        broken.push(`${category}: ${symbolDisplay(symbol)}`);
      }
    }
    expect(broken, 'typo or unsupported macro in the palette').toEqual([]);
  });

  it('every insert string renders clean once the caret mark is stripped', () => {
    const broken: string[] = [];
    for (const { category, symbol } of allSymbols()) {
      const html = katex.renderToString(symbolLatex(symbol), { throwOnError: false });
      if (html.includes('katex-error')) {
        // Template fragments (^{}, \frac{}{}) may legitimately be partial —
        // they are completed by the user; only flag fully-formed macros.
        const complete = !symbol.insert.includes('¦');
        if (complete) broken.push(`${category}: ${symbolLatex(symbol)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('template symbols carry a caret mark inside their first brace pair', () => {
    const frac = MATH_CATEGORIES.find((c) => c.id === 'operations')!.symbols[0];
    expect(frac.insert).toBe('\\frac{¦}{}');
    expect(symbolLatex(frac)).toBe('\\frac{}{}');
    expect(symbolCaretOffset(frac)).toBe('\\frac{'.length);
  });

  it('plain macros have no caret mark', () => {
    const alpha = MATH_CATEGORIES[0].symbols[0];
    expect(alpha.insert).toBe('\\alpha');
    expect(symbolCaretOffset(alpha)).toBeNull();
    expect(symbolLatex(alpha)).toBe('\\alpha');
  });

  it('the five Docs categories are present with real vocabularies', () => {
    expect(MATH_CATEGORIES.map((c) => c.id)).toEqual([
      'greek',
      'operations',
      'relations',
      'arrows',
      'misc',
    ]);
    for (const category of MATH_CATEGORIES) {
      expect(category.symbols.length, category.id).toBeGreaterThan(10);
    }
  });
});

describe('mounted palette interactions', () => {
  function setup() {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(host, input);
    const onChange = vi.fn();
    const onEscape = vi.fn();
    mountMathPalette(host, { input, onChange, onEscape });
    return { host, input, onChange, onEscape };
  }

  it('builds the tabs and reveals only the active category', () => {
    const { host } = setup();
    const tabs = host.querySelectorAll<HTMLButtonElement>('.rich-math-tab');
    expect(tabs).toHaveLength(5);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    const visible = host.querySelectorAll<HTMLButtonElement>('.rich-math-symbol:not([hidden])');
    expect(visible.length).toBeGreaterThan(10);
    visible.forEach((button) => expect(button.dataset.category).toBe('greek'));
    // Rendered glyphs are KaTeX spans, not raw text.
    expect(visible[0].querySelector('.katex')).not.toBeNull();
  });

  it('switching categories reveals another grid and lazy-renders its glyphs', () => {
    const { host } = setup();
    const tabs = host.querySelectorAll<HTMLButtonElement>('.rich-math-tab');
    tabs[3].click(); // Arrows
    expect(tabs[3].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    const visible = host.querySelectorAll<HTMLButtonElement>('.rich-math-symbol:not([hidden])');
    expect(visible.length).toBe(25);
    expect(visible[0].dataset.category).toBe('arrows');
    expect(visible[0].querySelector('.katex')).not.toBeNull();
  });

  it('picking a plain symbol inserts it after the caret and reports the change', () => {
    const { host, input, onChange } = setup();
    input.value = 'x+';
    input.setSelectionRange(2, 2);
    const visible = host.querySelectorAll<HTMLButtonElement>('.rich-math-symbol:not([hidden])');
    Array.from(visible)
      .find((button) => button.dataset.label === 'gamma')!
      .click();
    expect(input.value).toBe('x+\\gamma');
    expect(input.selectionStart).toBe('x+\\gamma'.length);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('picking a template lands the caret inside the first brace pair', () => {
    const { host, input } = setup();
    const tabs = host.querySelectorAll<HTMLButtonElement>('.rich-math-tab');
    tabs[1].click(); // Operations
    const visible = host.querySelectorAll<HTMLButtonElement>('.rich-math-symbol:not([hidden])');
    Array.from(visible)
      .find((button) => button.dataset.label === 'fraction')!
      .click();
    expect(input.value).toBe('\\frac{}{}');
    expect(input.selectionStart).toBe('\\frac{'.length);
  });

  it('insertion replaces the current selection', () => {
    const { host, input } = setup();
    input.value = 'a\\times b';
    input.setSelectionRange(1, 7); // select "\times"
    const tabs = host.querySelectorAll<HTMLButtonElement>('.rich-math-tab');
    tabs[1].click(); // Operations
    const visible = host.querySelectorAll<HTMLButtonElement>('.rich-math-symbol:not([hidden])');
    Array.from(visible)
      .find((button) => button.dataset.label === 'pm')!
      .click();
    expect(input.value).toBe('a\\pm b');
  });

  it('Escape inside the tabs and the grid asks the host to close', () => {
    const { host, onEscape } = setup();
    const tabs = host.querySelectorAll<HTMLButtonElement>('.rich-math-tab');
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
