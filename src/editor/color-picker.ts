/**
 * The rich text color picker — one component serving text color and
 * highlight color.
 *
 * Layout follows Docs' vocabulary with the custom picker inline instead of
 * behind a second dialog: theme-aware palette, session recents, then a
 * saturation/value pad with a hue slider and a hex field. Palette picks
 * apply instantly (one undo step, same as before); the custom picker
 * previews live and commits on Apply/Enter.
 *
 * The component is deliberately dumb about the editor: it renders, tracks
 * HSV state and reports picks. The toolbar owns applying colors through the
 * EditorPort, the session preview in the toolbar glyph and menu closing.
 *
 * Accessibility note: the 2D pad is a pointer enhancement (aria-hidden) —
 * full keyboard control exists through the native hue slider and the hex
 * field, which together reach every color the pad can.
 */

export interface Hsv {
  /** Hue, degrees 0–360. */
  h: number;
  /** Saturation, 0–1. */
  s: number;
  /** Value (brightness), 0–1. */
  v: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** '#rgb'/'#rrggbb'/bare hex → lowercase '#rrggbb', or null when invalid. */
export function normalizeHex(raw: string): string | null {
  let value = raw.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(value)) {
    value = value
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  if (!/^[0-9a-f]{6}$/.test(value)) {
    return null;
  }
  return `#${value}`;
}

export function hexToHsv(hex: string): Hsv {
  const value = normalizeHex(hex) ?? '#000000';
  const r = parseInt(value.slice(1, 3), 16) / 255;
  const g = parseInt(value.slice(3, 5), 16) / 255;
  const b = parseInt(value.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (hh < 60) {
    rgb = [c, x, 0];
  } else if (hh < 120) {
    rgb = [x, c, 0];
  } else if (hh < 180) {
    rgb = [0, c, x];
  } else if (hh < 240) {
    rgb = [0, x, c];
  } else if (hh < 300) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }
  const [r, g, b] = rgb.map((channel) => Math.round((channel + m) * 255));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** 'rgb(r, g, b)' (Chrome's queryCommandValue dialect) → '#rrggbb', else null. */
export function rgbStringToHex(value: string): string | null {
  const match =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*(0?\.\d+|1)\s*)?\)$/i.exec(
      value.trim(),
    );
  if (!match) {
    return null;
  }
  const [, r = '', g = '', b = ''] = match;
  const channel = (raw: string): number => Math.min(255, Math.round(parseFloat(raw)));
  const hex = `#${[channel(r), channel(g), channel(b)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;
  return normalizeHex(hex);
}

/** One palette entry: a theme KEY (resolved at pick time) or a literal. */
export interface ColorPickerEntry {
  /** data attribute value / identity ('transparent' marks the None swatch). */
  value: string;
  label: string;
  /** CSS value for the swatch face — may be a var() (theme-following). */
  swatch: string;
  /** Resolves the entry to the concrete color onPick reports. */
  resolve: () => string;
}

export interface ColorPickerOptions {
  ariaLabel: string;
  /** The mode attribute kept on swatches — the e2e + click hooks. */
  modeAttr: 'data-rich-color' | 'data-rich-highlight';
  palette: ReadonlyArray<ColorPickerEntry>;
  /** Called for every committed pick (palette, recent, None or Apply). */
  onPick: (value: string) => void;
  /** The custom picker's initial hue when nothing was ever picked. */
  initialHue?: number;
}

export interface ColorPickerHandle {
  /** Re-marks the palette against the caret's color (null = nothing). */
  refresh: (currentHex: string | null) => void;
}

const RECENTS_LIMIT = 7;

export function mountColorPicker(
  host: HTMLElement,
  options: ColorPickerOptions,
): ColorPickerHandle {
  const { palette, onPick, ariaLabel, modeAttr } = options;

  // --- state -------------------------------------------------------------
  const hsv: Hsv = { h: options.initialHue ?? 217, s: 0.65, v: 0.95 };
  const recents: string[] = [];
  let committed = true; // palette picks commit; pad drags preview until Apply

  // --- skeleton ----------------------------------------------------------
  host.classList.add('rich-cp');
  host.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'rich-cp-grid';
  host.appendChild(grid);

  const swatchFor = (entry: ColorPickerEntry, cls: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cls;
    button.setAttribute('role', 'menuitem');
    button.style.setProperty('--swatch', entry.swatch);
    button.dataset.cpValue = entry.value;
    button.setAttribute(modeAttr, entry.value);
    button.setAttribute('aria-label', `${ariaLabel} ${entry.label}`);
    return button;
  };

  palette.forEach((entry) =>
    grid.appendChild(
      swatchFor(
        entry,
        entry.value === 'transparent'
          ? 'rich-swatch rich-swatch-none'
          : 'rich-swatch',
      ),
    ),
  );

  const recentsRow = document.createElement('div');
  recentsRow.className = 'rich-cp-recent';
  recentsRow.hidden = true;
  host.appendChild(recentsRow);

  const recentTitle = document.createElement('div');
  recentTitle.className = 'rich-cp-title';
  recentTitle.textContent = 'Recent';
  recentsRow.appendChild(recentTitle);

  const recentGrid = document.createElement('div');
  recentGrid.className = 'rich-cp-grid rich-cp-grid-recent';
  recentsRow.appendChild(recentGrid);

  const paintRecents = (): void => {
    recentGrid.innerHTML = '';
    recentsRow.hidden = recents.length === 0;
    recents.forEach((hex) => {
      const button = swatchFor(
        { value: hex, label: hex, swatch: hex, resolve: () => hex },
        'rich-swatch rich-swatch-recent',
      );
      recentGrid.appendChild(button);
    });
  };

  const recordRecent = (hex: string): void => {
    const existing = recents.indexOf(hex);
    if (existing !== -1) {
      recents.splice(existing, 1);
    }
    recents.unshift(hex);
    if (recents.length > RECENTS_LIMIT) {
      recents.pop();
    }
    paintRecents();
  };

  // --- custom picker -----------------------------------------------------
  const custom = document.createElement('div');
  custom.className = 'rich-cp-custom';
  custom.innerHTML = `
    <div class="rich-cp-title">Custom</div>
    <div class="rich-cp-row">
      <div class="rich-cp-pad" aria-hidden="true">
        <div class="rich-cp-cursor"></div>
      </div>
      <div class="rich-cp-side">
        <div class="rich-cp-preview" aria-hidden="true"></div>
        <input type="text" class="rich-cp-hex" maxlength="7" spellcheck="false"
               aria-label="Hex color, applied with Enter" placeholder="#1a1a1a" />
        <button type="button" class="rich-cp-apply">Apply</button>
      </div>
    </div>
    <input type="range" class="rich-cp-hue" min="0" max="360" step="1" aria-label="Hue" />
  `;
  host.appendChild(custom);

  const pad = custom.querySelector<HTMLElement>('.rich-cp-pad')!;
  const cursor = custom.querySelector<HTMLElement>('.rich-cp-cursor')!;
  const preview = custom.querySelector<HTMLElement>('.rich-cp-preview')!;
  const hexInput = custom.querySelector<HTMLInputElement>('.rich-cp-hex')!;
  const apply = custom.querySelector<HTMLButtonElement>('.rich-cp-apply')!;
  const hue = custom.querySelector<HTMLInputElement>('.rich-cp-hue')!;

  // --- rendering ---------------------------------------------------------
  const render = (): void => {
    const hex = hsvToHex(hsv);
    pad.style.background = `hsl(${hsv.h}, 100%, 50%)`;
    cursor.style.left = `${hsv.s * 100}%`;
    cursor.style.top = `${(1 - hsv.v) * 100}%`;
    preview.style.background = hex;
    hue.value = String(Math.round(hsv.h));
    // While typing, don't fight the user's half-typed text.
    if (document.activeElement !== hexInput) {
      hexInput.value = hex;
    }
  };

  const setHsv = (next: Partial<Hsv>): void => {
    Object.assign(hsv, {
      h: Math.min(360, Math.max(0, next.h ?? hsv.h)),
      s: clamp01(next.s ?? hsv.s),
      v: clamp01(next.v ?? hsv.v),
    });
    committed = false;
    render();
  };

  /** The color currently shown by the custom picker (valid hex). */
  const currentHex = (): string => hsvToHex(hsv);

  const commitCustom = (): void => {
    // Empty field = the picker's own state; a half-typed invalid value
    // commits nothing (the field already shows the bad state).
    const typed = hexInput.value.trim();
    if (typed !== '' && normalizeHex(typed) === null) {
      return;
    }
    const hex = normalizeHex(typed) ?? currentHex();
    recordRecent(hex);
    onPick(hex);
    committed = true;
  };

  // --- palette / recents clicks -------------------------------------------
  const pickEntry = (value: string): void => {
    const entry = palette.find((candidate) => candidate.value === value);
    const resolved = entry ? entry.resolve() : value; // recents are literal hex
    if (resolved !== 'transparent') {
      recordRecent(resolved);
    }
    onPick(resolved);
  };

  host.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cp-value]');
    if (target) {
      pickEntry(target.dataset.cpValue!);
    }
  });

  // --- pad / hue / hex -----------------------------------------------------
  const pointToSv = (event: PointerEvent): void => {
    const rect = pad.getBoundingClientRect();
    setHsv({
      s: clamp01((event.clientX - rect.left) / rect.width),
      v: 1 - clamp01((event.clientY - rect.top) / rect.height),
    });
  };

  pad.addEventListener('pointerdown', (event) => {
    pad.setPointerCapture(event.pointerId);
    pointToSv(event);
  });
  pad.addEventListener('pointermove', (event) => {
    if (pad.hasPointerCapture(event.pointerId)) {
      pointToSv(event);
    }
  });

  hue.addEventListener('input', () => setHsv({ h: Number(hue.value) }));

  hexInput.addEventListener('input', () => {
    const hex = normalizeHex(hexInput.value);
    hexInput.classList.toggle('rich-cp-hex-bad', hex === null && hexInput.value.trim() !== '');
    if (hex) {
      committed = false;
      Object.assign(hsv, hexToHsv(hex));
      render();
    }
  });
  hexInput.addEventListener('blur', () => {
    // Don't leave a half-typed value in the field.
    hexInput.value = currentHex();
    hexInput.classList.remove('rich-cp-hex-bad');
  });
  hexInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitCustom();
    }
    // Keep the menu's arrow roving out of the text field.
    event.stopPropagation();
  });

  apply.addEventListener('click', (event) => {
    event.stopPropagation();
    commitCustom();
  });

  // The panel pointerdown-prevention keeps caret/selection for swatches;
  // the picker's own controls must behave like normal form controls.
  [pad, hue, hexInput, apply, preview].forEach((element) => {
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
  });

  render();

  // --- refresh (current color marking) -------------------------------------
  return {
    refresh(currentHexOrNull: string | null): void {
      let matched = false;
      const entries = [
        ...grid.querySelectorAll<HTMLButtonElement>('[data-cp-value]'),
        ...recentGrid.querySelectorAll<HTMLButtonElement>('[data-cp-value]'),
      ];
      entries.forEach((button) => {
        const entry = [...palette].find((candidate) => candidate.value === button.dataset.cpValue);
        const resolved = entry ? entry.resolve() : button.dataset.cpValue!;
        const matches =
          !!currentHexOrNull && resolved.toLowerCase() === currentHexOrNull.toLowerCase();
        button.setAttribute('aria-checked', String(matches));
        button.classList.toggle('rich-menu-current', matches);
        if (matches) {
          matched = true;
        }
      });
      // No palette match: aim the custom picker at the caret's color so the
      // next Apply is a one-step adjust, not a re-pick from scratch.
      if (currentHexOrNull && !matched) {
        Object.assign(hsv, hexToHsv(currentHexOrNull));
      }
      if (committed) {
        hexInput.value = currentHex();
      }
      render();
    },
  };
}
