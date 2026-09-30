import { describe, expect, it } from 'vitest';
import {
  hexToHsv,
  hsvToHex,
  mountColorPicker,
  normalizeHex,
  rgbStringToHex,
  type ColorPickerEntry,
} from './color-picker';

describe('hex/hsv conversions', () => {
  it('round-trips the primaries', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#00ffff', '#ff00ff', '#ffff00']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('round-trips black, white and grays (zero saturation keeps hue 0)', () => {
    expect(hsvToHex(hexToHsv('#000000'))).toBe('#000000');
    expect(hsvToHex(hexToHsv('#ffffff'))).toBe('#ffffff');
    expect(hsvToHex(hexToHsv('#808080'))).toBe('#808080');
  });

  it('reads a mid tone back to within one step per channel', () => {
    const hex = '#4285f4';
    const round = hsvToHex(hexToHsv(hex));
    const channel = (value: string, at: number): number => parseInt(value.slice(at, at + 2), 16);
    for (const at of [1, 3, 5]) {
      expect(Math.abs(channel(round, at) - channel(hex, at))).toBeLessThanOrEqual(1);
    }
  });
});

describe('normalizeHex', () => {
  it('expands 3-digit hex and lowercases', () => {
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex(' #1A2b3C ')).toBe('#1a2b3c');
  });

  it('refuses non-hex and wrong lengths', () => {
    expect(normalizeHex('zzzzzz')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('#1234567')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('rgbStringToHex', () => {
  it('converts Chrome queryCommandValue dialect', () => {
    expect(rgbStringToHex('rgb(66, 133, 244)')).toBe('#4285f4');
    expect(rgbStringToHex('rgb(0, 0, 0)')).toBe('#000000');
    expect(rgbStringToHex('rgba(255, 255, 255, 1)')).toBe('#ffffff');
  });

  it('returns null for anything else', () => {
    expect(rgbStringToHex('')).toBeNull();
    expect(rgbStringToHex('rgb(1, 2)')).toBeNull();
    expect(rgbStringToHex('blue')).toBeNull();
  });
});

describe('mountColorPicker', () => {
  const palette: ReadonlyArray<ColorPickerEntry> = [
    {
      value: 'blue',
      label: 'Blue',
      swatch: '#4285f4',
      resolve: () => '#4285f4',
    },
    {
      value: 'ink',
      label: 'Black',
      swatch: '#1a1a1a',
      resolve: () => '#1a1a1a',
    },
    {
      value: 'transparent',
      label: 'None',
      swatch: 'transparent',
      resolve: () => 'transparent',
    },
  ];

  const mount = (): { host: HTMLElement; picks: string[] } => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const picks: string[] = [];
    mountColorPicker(host, {
      ariaLabel: 'Test color',
      modeAttr: 'data-rich-color',
      palette,
      onPick: (value) => picks.push(value),
    });
    return { host, picks };
  };

  it('renders the palette as menu items carrying the mode attribute', () => {
    const { host } = mount();
    const swatches = host.querySelectorAll<HTMLButtonElement>('[data-rich-color]');
    expect(swatches).toHaveLength(3);
    expect(swatches[0]?.dataset.richColor).toBe('blue');
    expect(swatches[0]?.getAttribute('role')).toBe('menuitem');
  });

  it('applies a palette pick instantly with the resolved value', () => {
    const { host, picks } = mount();
    host.querySelector<HTMLButtonElement>('[data-cp-value="blue"]')!.click();
    expect(picks).toEqual(['#4285f4']);
  });

  it('grows a recent row without recording the None swatch', () => {
    const { host, picks } = mount();
    host.querySelector<HTMLButtonElement>('[data-cp-value="blue"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-cp-value="transparent"]')!.click();
    expect(picks).toEqual(['#4285f4', 'transparent']);
    const recents = host.querySelectorAll('.rich-cp-grid-recent [data-cp-value]');
    expect(recents).toHaveLength(1);
  });

  it('applies the hex field on Enter and ignores invalid input', () => {
    const { host, picks } = mount();
    const input = host.querySelector<HTMLInputElement>('.rich-cp-hex')!;
    input.focus();
    input.value = '#a1b2c3';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picks).toEqual(['#a1b2c3']);

    input.value = 'not-a-color';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picks).toEqual(['#a1b2c3']);
  });

  it('refresh marks the swatch matching the caret color', () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const picks: string[] = [];
    const handle = mountColorPicker(host, {
      ariaLabel: 'Test color',
      modeAttr: 'data-rich-color',
      palette,
      onPick: (value) => picks.push(value),
    });

    handle.refresh('#1a1a1a');
    const blue = host.querySelector<HTMLButtonElement>('[data-cp-value="blue"]')!;
    const ink = host.querySelector<HTMLButtonElement>('[data-cp-value="ink"]')!;
    expect(ink.classList.contains('rich-menu-current')).toBe(true);
    expect(blue.classList.contains('rich-menu-current')).toBe(false);

    // A non-palette color matches nothing (and leaves the grid intact).
    handle.refresh('#123456');
    expect(ink.classList.contains('rich-menu-current')).toBe(false);
    expect(host.querySelectorAll('.rich-swatch')).toHaveLength(3);
  });
});
