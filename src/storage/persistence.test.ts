import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkQuotaOnce,
  estimateStorage,
  onStorageSaveHealth,
  quotaWarningMessage,
  reportSaveFailure,
  reportSaveRecovered,
  requestPersistentStorage,
  resetPersistenceForTests,
  resetQuotaWarningForTests,
  storageSaveHealth,
} from './persistence';

/**
 * The durable-storage stewardship module, pinned: failure classification
 * (quota vs other), health transitions fire once per change of state (a
 * keystroke storm of failed saves is ONE warning), recovery closes the
 * warning, and every navigator.storage probe degrades to a no-op answer
 * when the browser does not offer it (jsdom offers nothing here).
 */

beforeEach(() => {
  resetPersistenceForTests();
  resetQuotaWarningForTests();
});

afterEach(() => {
  resetPersistenceForTests();
  resetQuotaWarningForTests();
  vi.restoreAllMocks();
});

function quotaError(): Error {
  // jsdom's DOMException constructor does not populate `message` from its
  // first argument — a plain Error with the quota name is the portable
  // spelling of the same failure.
  const error = new Error('The quota has been exceeded');
  error.name = 'QuotaExceededError';
  return error;
}

describe('failure classification', () => {
  it('recognizes a QuotaExceededError as storage pressure', () => {
    reportSaveFailure(quotaError());
    expect(storageSaveHealth()).toEqual({
      state: 'failing',
      cause: 'quota',
      detail: 'The quota has been exceeded',
    });
  });

  it('anything else is an honest "other"', () => {
    reportSaveFailure(new Error('VersionError'));
    const health = storageSaveHealth();
    expect(health.state).toBe('failing');
    if (health.state === 'failing') {
      expect(health.cause).toBe('other');
    }
  });
});

describe('health transitions — one warning per change, not per keystroke', () => {
  it('notifies subscribers once for a burst of same-cause failures', () => {
    const events: string[] = [];
    onStorageSaveHealth((health) =>
      events.push(health.state + ':' + (health as { cause?: string }).cause),
    );

    reportSaveFailure(quotaError());
    reportSaveFailure(quotaError()); // the retry also failed — same story
    reportSaveFailure(quotaError());

    expect(events).toEqual(['failing:quota']);
  });

  it('a cause change re-notifies (quota became something else)', () => {
    const events: string[] = [];
    onStorageSaveHealth((health) =>
      events.push(health.state + ':' + (health as { cause?: string }).cause),
    );

    reportSaveFailure(quotaError());
    reportSaveFailure(new Error('corrupted'));

    expect(events).toEqual(['failing:quota', 'failing:other']);
  });

  it('recovery notifies once, and stays quiet while healthy', () => {
    const events: string[] = [];
    onStorageSaveHealth((health) => events.push(health.state));

    reportSaveFailure(quotaError());
    reportSaveRecovered();
    reportSaveRecovered(); // already healthy — silence

    expect(events).toEqual(['failing', 'healthy']);
  });

  it('the unsubscriber stops delivery', () => {
    const events: string[] = [];
    const unsubscribe = onStorageSaveHealth((health) => events.push(health.state));

    unsubscribe();
    reportSaveFailure(quotaError());

    expect(events).toEqual([]);
  });
});

describe('navigator.storage probes — no-ops, never throws', () => {
  it('requestPersistentStorage answers unavailable without the API', async () => {
    await expect(requestPersistentStorage()).resolves.toBe('unavailable');
  });

  it('estimateStorage answers null without the API', async () => {
    await expect(estimateStorage()).resolves.toBeNull();
  });

  it('a failing persist() promise resolves denied, not rejected', async () => {
    const persist = vi.fn(() => Promise.reject(new Error('no')));
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist, estimate: vi.fn() },
    });
    await expect(requestPersistentStorage()).resolves.toBe('denied');
  });
});

describe('the quota warning message', () => {
  it('stays quiet below 90% of the quota', () => {
    expect(quotaWarningMessage(10, 100)).toBeNull();
    expect(quotaWarningMessage(89, 100)).toBeNull();
  });

  it('names the numbers at 90% and above', () => {
    const message = quotaWarningMessage(95 * 1024 * 1024, 100 * 1024 * 1024);
    expect(message).toContain('almost full');
    expect(message).toContain('95');
    expect(message).toContain('100');
  });

  it('a zero quota is not a warning', () => {
    expect(quotaWarningMessage(5, 0)).toBeNull();
  });

  it('checkQuotaOnce warns only once per session', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persist: vi.fn(() => Promise.resolve(true)),
        estimate: vi.fn(() => Promise.resolve({ usage: 95, quota: 100 })),
      },
    });
    expect(await checkQuotaOnce()).toContain('almost full');
    expect(await checkQuotaOnce()).toBeNull();
  });
});
