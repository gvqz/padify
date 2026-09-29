/**
 * Theme-aware ink for rich text notes.
 *
 * A color picked in light mode (near-black ink, dim teal) is illegible on
 * the dark surface. Docs solves this by never offering dark users the same
 * palette; padify instead keeps ONE palette whose members carry a light and
 * a dark value, and re-maps the note's inline colors when the theme flips:
 *
 *   - the swatch chips read CSS vars, so the palette itself adapts;
 *   - picking a swatch resolves the key through the CURRENT mode;
 *   - switching modes rewrites the note's stored colors from the old mode's
 *     values to the new mode's (attribute-only surgery — text nodes are
 *     never touched, so Chrome's undo transactions stay valid).
 *
 * Each note remembers which theme its colors were last written under
 * (NoteTab.colorTheme), because the stored HTML of an untouched note lags
 * behind until the user edits again. A note without a stamp (legacy) is
 * left exactly as stored.
 */

export type ThemeMode = 'light' | 'dark';

export interface PalettePair {
  light: string;
  dark: string;
}

/** The palette the color menu offers — one entry per swatch. */
export const RICH_PALETTE: Readonly<Record<string, PalettePair>> = {
  ink: { light: '#1a1a1a', dark: '#f1f3f4' },
  gray: { light: '#666666', dark: '#9aa0a6' },
  steel: { light: '#b3b3b3', dark: '#5f6368' },
  paper: { light: '#ffffff', dark: '#1a1a1a' },
  red: { light: '#ea4335', dark: '#f28b82' },
  pink: { light: '#e64980', dark: '#f9a8d4' },
  yellow: { light: '#fbbc04', dark: '#fdd663' },
  brown: { light: '#b45309', dark: '#f0b37e' },
  green: { light: '#34a853', dark: '#81c995' },
  teal: { light: '#0d9488', dark: '#2dd4bf' },
  blue: { light: '#4285f4', dark: '#8ab4f8' },
  purple: { light: '#9333ea', dark: '#c58af9' },
};

/** The mode the editor surface is currently painted in. */
export function currentThemeMode(): ThemeMode {
  return document.body.classList.contains('dark') ? 'dark' : 'light';
}

/** Resolves a palette key to the concrete color of the given mode. */
export function resolvePaletteColor(key: string, mode: ThemeMode): string | null {
  return RICH_PALETTE[key]?.[mode] ?? null;
}

/** Publishes the palette as CSS vars so the swatch chips adapt. */
export function applyPaletteVars(mode: ThemeMode): void {
  const rootStyle = document.documentElement.style;
  for (const [key, pair] of Object.entries(RICH_PALETTE)) {
    rootStyle.setProperty(`--rich-palette-${key}`, pair[mode]);
  }
}

/**
 * Normalizes a color string (hex, rgb(), rgba() with full alpha) to the
 * lowercase 6-digit hex key used by the palette map — or null.
 */
export function canonicalizeColor(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (hex) {
    const body = hex[1];
    if (body.length === 3) {
      return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
    }
    return `#${body}`;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(raw);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (r > 255 || g > 255 || b > 255) {
      return null;
    }
    const byte = (n: number): string => n.toString(16).padStart(2, '0');
    return `#${byte(r)}${byte(g)}${byte(b)}`;
  }
  return null;
}

/**
 * Rewrites every inline text color that matches a `from`-mode palette value
 * into its `to`-mode counterpart. Highlights (background-color) are pastels
 * that work on both surfaces and are left alone.
 */
export function transformNoteColors(root: HTMLElement, from: ThemeMode, to: ThemeMode): void {
  if (!root || from === to) {
    return;
  }
  const map = new Map<string, string>();
  for (const pair of Object.values(RICH_PALETTE)) {
    const source = canonicalizeColor(pair[from]);
    if (source) {
      map.set(source, pair[to]);
    }
  }
  const targets: HTMLElement[] = [root, ...root.querySelectorAll<HTMLElement>('[style]')];
  for (const el of targets) {
    const color = el.style.color;
    if (!color) {
      continue;
    }
    const key = canonicalizeColor(color);
    const next = key ? map.get(key) : undefined;
    if (next) {
      el.style.color = next;
    }
  }
}

/**
 * Wires the theme lifecycle: palette vars on boot, and on every theme flip
 * the editor surface's colors move with it. The DOM's ink theme is tracked
 * directly (not through the storage stamp) so the transform never depends
 * on debounced saves having run.
 */
let domInkTheme: ThemeMode = 'light';

export function initThemeColors(tabManager: {
  getActive: () => { colorTheme?: ThemeMode } | null;
}): void {
  domInkTheme = currentThemeMode();
  applyPaletteVars(domInkTheme);

  document.addEventListener('padify:theme', (event) => {
    const mode = (event as CustomEvent<{ mode: ThemeMode }>).detail?.mode;
    if (mode !== 'light' && mode !== 'dark') {
      return;
    }
    applyPaletteVars(mode);
    const note = document.getElementById('note');
    if (note && domInkTheme !== mode) {
      transformNoteColors(note, domInkTheme, mode);
      domInkTheme = mode;
    }
    // Stamp the active note so its next save persists the new ink.
    const active = tabManager.getActive();
    if (active) {
      active.colorTheme = mode;
    }
  });
}

/**
 * Called whenever a note has been rendered into the editor: a note whose
 * stored colors were written under the other theme is re-inked for display
 * (visual only — storage catches up on the next edit, so opening a note
 * never writes on its own).
 */
export function noteRenderedForTheme(element: HTMLElement | undefined, stamped?: ThemeMode): void {
  const mode = currentThemeMode();
  if (element && stamped && stamped !== mode) {
    transformNoteColors(element, stamped, mode);
  }
  domInkTheme = mode;
}
