/**
 * The equation palette — Google Docs' answer to "don't make people
 * memorize LaTeX": the equation bubble carries a row of category tabs
 * (Greek letters, Operations, Relations, Arrows, Miscellaneous) and each
 * category opens a grid of rendered symbols. Picking a symbol inserts its
 * LaTeX at the input's caret — the input stays the single source of truth,
 * the live preview follows, and people who KNOW LaTeX keep typing the
 * complicated way.
 *
 * Structure macros (\frac{}{}, \sqrt{}, ^{}, _{}, \left(\right)) insert
 * with the caret placed inside the first brace pair — a `¦` in the insert
 * string marks that position.
 *
 * The component is deliberately dumb about the editor: it renders tabs +
 * grids, inserts into the given input and reports changes. The toolbar
 * owns the preview, the Insert/Apply gesture and closing the bubble.
 *
 * Accessibility: the grids use a roving tabindex — the category tabs are
 * ordinary tab stops, the active grid is one tab stop with arrow keys
 * moving between symbols, Enter picks.
 */

import katex from 'katex';

/** A palette symbol: what to insert, what to show, what to call it. */
export interface MathSymbol {
  /**
   * Inserted LaTeX. A `¦` marks where the caret lands after insertion
   * (omitted from the inserted text itself).
   */
  insert: string;
  /**
   * Rendered LaTeX for the button glyph — templates need a filled-in
   * example (`x^{2}`), plain macros default to themselves.
   */
  display?: string;
  /** Accessible name and tooltip tail. */
  label: string;
}

export interface MathCategory {
  id: string;
  label: string;
  /** The tab's short text (the full label is the aria name). */
  short: string;
  symbols: MathSymbol[];
}

/** The caret marker in insert strings. */
const CARET_MARK = '¦';

// --- the vocabulary ---------------------------------------------------------
// Every macro here is pinned by math-palette.test.ts against KaTeX itself,
// so a typo or an unsupported name fails CI instead of shipping a red glyph.

const GREEK: MathSymbol[] = [
  ...[
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'varepsilon',
    'zeta',
    'eta',
    'theta',
    'vartheta',
    'iota',
    'kappa',
    'lambda',
    'mu',
    'nu',
    'xi',
    'pi',
    'rho',
    'varrho',
    'sigma',
    'varsigma',
    'tau',
    'upsilon',
    'phi',
    'varphi',
    'chi',
    'psi',
    'omega',
  ].map((name) => ({ insert: `\\${name}`, label: name })),
  ...[
    'Gamma',
    'Delta',
    'Theta',
    'Lambda',
    'Xi',
    'Pi',
    'Sigma',
    'Upsilon',
    'Phi',
    'Psi',
    'Omega',
  ].map((name) => ({ insert: `\\${name}`, label: name })),
];

const OPERATIONS: MathSymbol[] = [
  { insert: '\\frac{¦}{}', display: '\\frac{a}{b}', label: 'fraction' },
  { insert: '\\sqrt{¦}', display: '\\sqrt{x}', label: 'square root' },
  { insert: '\\sqrt[¦]{}', display: '\\sqrt[n]{x}', label: 'nth root' },
  { insert: '^{¦}', display: 'x^{2}', label: 'superscript' },
  { insert: '_{¦}', display: 'x_{i}', label: 'subscript' },
  { insert: '\\left(¦\\right)', display: '\\left(x\\right)', label: 'auto-sized parentheses' },
  ...['times', 'div', 'pm', 'mp', 'cdot', 'ast', 'star', 'circ', 'bullet'].map((name) => ({
    insert: `\\${name}`,
    label: name,
  })),
  ...['oplus', 'ominus', 'otimes', 'oslash', 'odot'].map((name) => ({
    insert: `\\${name}`,
    label: name,
  })),
  ...[
    'sum',
    'prod',
    'coprod',
    'int',
    'iint',
    'iiint',
    'oint',
    'bigcup',
    'bigcap',
    'bigoplus',
    'bigotimes',
    'bigvee',
    'bigwedge',
  ].map((name) => ({ insert: `\\${name}`, label: name })),
  ...['log', 'ln', 'lim', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc'].map((name) => ({
    insert: `\\${name}`,
    label: name,
  })),
  ...['min', 'max', 'det', 'gcd'].map((name) => ({ insert: `\\${name}`, label: name })),
];

const RELATIONS: MathSymbol[] = [
  ...[
    'leq',
    'geq',
    'neq',
    'approx',
    'equiv',
    'sim',
    'simeq',
    'cong',
    'propto',
    'asymp',
    'doteq',
    'll',
    'gg',
    'subset',
    'supset',
    'subseteq',
    'supseteq',
    'in',
    'ni',
    'notin',
    'perp',
    'parallel',
    'mid',
    'therefore',
    'because',
  ].map((name) => ({ insert: `\\${name}`, label: name })),
];

const ARROWS: MathSymbol[] = [
  ...[
    'rightarrow',
    'leftarrow',
    'leftrightarrow',
    'Rightarrow',
    'Leftarrow',
    'Leftrightarrow',
    'longrightarrow',
    'longleftarrow',
    'longleftrightarrow',
    'mapsto',
    'longmapsto',
    'uparrow',
    'downarrow',
    'updownarrow',
    'Uparrow',
    'Downarrow',
    'nearrow',
    'searrow',
    'swarrow',
    'nwarrow',
    'hookrightarrow',
    'hookleftarrow',
    'rightharpoonup',
    'leftharpoonup',
    'rightleftharpoons',
  ].map((name) => ({ insert: `\\${name}`, label: name })),
];

const MISC: MathSymbol[] = [
  ...[
    'infty',
    'partial',
    'nabla',
    'hbar',
    'ell',
    'Re',
    'Im',
    'aleph',
    'forall',
    'exists',
    'nexists',
    'neg',
    'emptyset',
    'varnothing',
    'angle',
    'measuredangle',
    'triangle',
    'square',
    'top',
    'bot',
    'vdash',
    'vDash',
    'models',
    'degree',
    'prime',
    'ldots',
    'cdots',
    'vdots',
    'ddots',
  ].map((name) => ({ insert: `\\${name}`, label: name })),
];

export const MATH_CATEGORIES: MathCategory[] = [
  { id: 'greek', label: 'Greek letters', short: 'Greek', symbols: GREEK },
  { id: 'operations', label: 'Operations', short: 'Operations', symbols: OPERATIONS },
  { id: 'relations', label: 'Relations', short: 'Relations', symbols: RELATIONS },
  { id: 'arrows', label: 'Arrows', short: 'Arrows', symbols: ARROWS },
  { id: 'misc', label: 'Miscellaneous', short: 'Misc', symbols: MISC },
];

/** The LaTeX a symbol inserts (caret mark stripped). */
export function symbolLatex(symbol: MathSymbol): string {
  return symbol.insert.replace(CARET_MARK, '');
}

/** Where the caret lands after insertion, relative to the insert start. */
export function symbolCaretOffset(symbol: MathSymbol): number | null {
  const mark = symbol.insert.indexOf(CARET_MARK);
  return mark === -1 ? null : mark;
}

/** The LaTeX a button renders (templates show a filled-in example). */
export function symbolDisplay(symbol: MathSymbol): string {
  return symbol.display ?? symbol.insert;
}

export interface MathPaletteOptions {
  /** The LaTeX input the palette inserts into. */
  input: HTMLInputElement;
  /** Called after an insertion — the toolbar refreshes the preview. */
  onChange: () => void;
  /** Called when Escape is pressed inside the palette (close the bubble). */
  onEscape: () => void;
}

/**
 * Builds the tab row + symbol grid into `host` and wires the interactions.
 * The first category renders its glyphs immediately; the others render on
 * first activation to keep the first bubble open snappy.
 */
export function mountMathPalette(host: HTMLElement, options: MathPaletteOptions): void {
  const { input, onChange, onEscape } = options;

  host.classList.add('rich-math-palette');
  host.innerHTML = '';

  const tabsRow = document.createElement('div');
  tabsRow.className = 'rich-math-tabs';
  tabsRow.setAttribute('role', 'tablist');
  tabsRow.setAttribute('aria-label', 'Symbol categories');

  const grid = document.createElement('div');
  grid.className = 'rich-math-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Symbols');

  host.append(tabsRow, grid);

  let activeCategory: MathCategory = MATH_CATEGORIES[0];
  /** Category ids whose glyph spans already rendered. */
  const rendered = new Set<string>();
  const tabButtons = new Map<string, HTMLButtonElement>();

  const renderGlyph = (button: HTMLButtonElement, symbol: MathSymbol): void => {
    try {
      button.innerHTML = katex.renderToString(symbolDisplay(symbol), {
        throwOnError: false,
      });
    } catch {
      // Never let a glyph quirk take the palette down — the label reads on.
      button.textContent = symbolLatex(symbol);
    }
  };

  const activateCategory = (category: MathCategory): void => {
    activeCategory = category;
    for (const [id, button] of tabButtons) {
      button.setAttribute('aria-selected', String(id === category.id));
      button.tabIndex = id === category.id ? 0 : -1;
    }

    if (!rendered.has(category.id)) {
      for (const button of grid.querySelectorAll<HTMLButtonElement>(
        `.rich-math-symbol[data-category="${category.id}"]`,
      )) {
        const symbol = category.symbols.find((entry) => entry.label === button.dataset.label);
        if (symbol) {
          renderGlyph(button, symbol);
        }
      }
      rendered.add(category.id);
    }
    for (const button of grid.children) {
      (button as HTMLElement).hidden = (button as HTMLElement).dataset.category !== category.id;
    }
  };

  for (const category of MATH_CATEGORIES) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'rich-math-tab';
    tab.textContent = category.short;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', category.label);
    tab.addEventListener('click', () => activateCategory(category));
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape();
      }
    });
    tabButtons.set(category.id, tab);
    tabsRow.append(tab);
  }

  // Every symbol gets a button upfront (cheap spans) — the KaTeX glyph
  // rendering is what's lazy, category by category.
  for (const category of MATH_CATEGORIES) {
    for (const symbol of category.symbols) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rich-math-symbol';
      button.dataset.category = category.id;
      button.dataset.label = symbol.label;
      button.title = `${symbolLatex(symbol)} — ${symbol.label}`;
      button.setAttribute('aria-label', `${symbol.label} (${symbolLatex(symbol)})`);
      button.tabIndex = -1;
      button.hidden = true;
      button.addEventListener('click', () => {
        insertSymbol(symbol);
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onEscape();
        }
      });
      grid.append(button);
    }
  }

  const insertSymbol = (symbol: MathSymbol): void => {
    const latex = symbolLatex(symbol);
    const caretOffset = symbolCaretOffset(symbol);
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + latex + input.value.slice(end);
    // Templates land the caret inside the first brace pair; plain symbols
    // park it right after themselves.
    const caret = start + (caretOffset ?? latex.length);
    input.focus();
    input.setSelectionRange(caret, caret);
    onChange();
  };

  // Arrow-key roving across the active grid: focus moves in DOM order
  // (the grid is one row per category.width symbols), wrapping at the ends.
  const gridButtons = (): HTMLButtonElement[] =>
    Array.from(grid.querySelectorAll<HTMLButtonElement>('.rich-math-symbol')).filter(
      (button) => !button.hidden,
    );

  grid.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();
    const buttons = gridButtons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (buttons.length === 0) {
      return;
    }
    let next: number;
    if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = buttons.length - 1;
    } else if (event.key === 'ArrowLeft') {
      next = (index - 1 + buttons.length) % buttons.length;
    } else if (event.key === 'ArrowRight') {
      next = (index + 1) % buttons.length;
    } else if (event.key === 'ArrowUp') {
      next = index === -1 ? 0 : Math.max(0, index - 1);
    } else {
      next = index === -1 ? 0 : Math.min(buttons.length - 1, index + 1);
    }
    buttons[next]?.focus();
  });

  // The active category renders now; the others on first activation.
  activateCategory(activeCategory);
}
