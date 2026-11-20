import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initOfflineIndicator } from './offline-indicator';

/**
 * The offline chip's contract: visible exactly when the network is
 * gone, wired to both events, reading the state at boot (an app opened
 * inside airplane mode must not wait for an event that never fires),
 * and inert when the markup is absent (the markup contract owns the
 * chip's presence — this owns the behavior).
 */

const chip = () => document.getElementById('offlineChip')!;

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: online,
  });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

describe('the offline chip', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="bottom-line"><span id="offlineChip" class="offline-chip" hidden>' +
      '<span>Offline</span></span></div>';
  });

  afterEach(() => {
    setOnline(true);
  });

  it('stays hidden while the network is up', () => {
    setOnline(true);
    initOfflineIndicator();

    expect(chip().hidden).toBe(true);
  });

  it('shows when the network leaves and hides when it returns', () => {
    initOfflineIndicator();

    setOnline(false);
    expect(chip().hidden).toBe(false);

    setOnline(true);
    expect(chip().hidden).toBe(true);
  });

  it('reads the state at boot, not only on events', () => {
    setOnline(false);
    initOfflineIndicator();

    expect(chip().hidden).toBe(false);
  });

  it('is inert when the markup is absent', () => {
    document.body.innerHTML = '';

    expect(() => initOfflineIndicator()).not.toThrow();
  });
});
