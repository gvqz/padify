/**
 * A single entry in the Unicode character database backing the picker.
 */
export interface UnicodeSymbol {
  /** The literal character to insert. */
  char: string;
  /** Human-readable name, e.g. "Rightwards arrow". */
  name: string;
  /** Friendly category label used for grouping in the picker. */
  category: string;
  /** Decimal code point value, e.g. 8594 for U+2192. */
  codepoint: number;
  /** Present (1) when an emoji variation selector should be appended on insert. */
  fe0f?: 1;
}

/**
 * Persisted picker state (favorites and recents store raw characters,
 * resolved against the symbol table at runtime).
 */
export interface UnicodePickerPersisted {
  favorites: string[];
  recents: string[];
}

export interface UnicodeSymbolData {
  symbols: UnicodeSymbol[];
  categories: string[];
}
