import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorageForTests, storageReady } from '../storage';
import { selector } from '../selector';
import {
  DEFAULT_EDITOR_CONFIG,
  SETTING_KEYS,
  getSetting,
  isSettingKey,
  onChangeSetting,
  removeSetting,
  setSetting,
} from './settings';

describe('settings schema', () => {
  it('enumerates every persisted key without duplicates', () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    // The editor's note is persisted state too — it must never drop out.
    expect(SETTING_KEYS).toContain('note');
  });

  it('isSettingKey guards the union', () => {
    expect(isSettingKey('mode')).toBe(true);
    expect(isSettingKey('made-up-key')).toBe(false);
  });
});

describe('settings read/write', () => {
  beforeEach(async () => {
    resetStorageForTests();
    await storageReady();
  });

  afterEach(() => {
    resetStorageForTests();
  });

  it('round-trips values through the storage layer unchanged', () => {
    setSetting('mode', 'dark');
    expect(getSetting('mode')).toBe('dark');
    removeSetting('mode');
    expect(getSetting('mode')).toBe(null);
  });

  it('selector.setState notifies through the choke point', async () => {
    const listener = vi.fn();
    const off = onChangeSetting('userChosenFontSize', listener);
    // The legacy write path — used all over the app — must notify.
    const { setState, removeState } = selector();
    setState('userChosenFontSize', '22');
    removeState('userChosenFontSize');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, { key: 'userChosenFontSize', value: '22' });
    expect(listener).toHaveBeenNthCalledWith(2, { key: 'userChosenFontSize', value: null });
    off();
    setState('userChosenFontSize', '24');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('supports wildcard and multi-key subscriptions', () => {
    const seen: string[] = [];
    const offAll = onChangeSetting('*', ({ key }) => seen.push(`*:${key}`));
    const offTwo = onChangeSetting(['mode', 'selectedFont'], ({ key }) => seen.push(`sub:${key}`));
    setSetting('mode', 'light');
    setSetting('selectedFont', 'serif');
    setSetting('userChosenTexture', 'paper'); // only the wildcard sees this
    expect(seen).toEqual(['*:mode', 'sub:mode', '*:selectedFont', 'sub:selectedFont', '*:userChosenTexture']);
    offAll();
    offTwo();
  });

  it('keeps the editor defaults as the single source', () => {
    // selector().defaultConfig is now a reference to the settings module's
    // table — resetting preferences and new code cannot drift apart.
    expect(selector().defaultConfig).toBe(DEFAULT_EDITOR_CONFIG);
  });
});
