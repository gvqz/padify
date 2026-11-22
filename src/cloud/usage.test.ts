import { describe, expect, it } from 'vitest';
import { formatBytes, storageSegments } from './usage';
import type { UsageReport } from '../../shared/wire';

// The storage card's pure half: the segment builder (live types largest
// first, the trash appended when it holds bytes) and the byte formatter
// the card and its legend speak. The DOM wiring is boot's to exercise;
// these pin the arithmetic the card renders — a bar segment ordered by
// hope instead of size, or a "1048576 B" leaking into the legend, would
// both read as bugs through this file.

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    limits: {
      notes_bytes: 25 * 1024 * 1024,
      attachments_bytes: 200 * 1024 * 1024,
      attachments_count: 500,
    },
    notes: { bytes: 0, live_count: 0, trash: { bytes: 0, count: 0 }, by_type: [] },
    attachments: { bytes: 0, count: 0 },
    ...overrides,
  };
}

describe('storageSegments — the bar reads largest-first, trash last', () => {
  it('orders the live slices by bytes and appends a trash that holds bytes', () => {
    const slices = storageSegments(
      report({
        notes: {
          bytes: 60,
          live_count: 3,
          trash: { bytes: 10, count: 1 },
          by_type: [
            { type: 'standard', bytes: 5, count: 1 },
            { type: 'markdown', bytes: 40, count: 1 },
            { type: 'rich', bytes: 5, count: 1 },
          ],
        },
      }),
    );

    expect(slices.map((segment) => [segment.kind, segment.type, segment.bytes])).toEqual([
      ['type', 'markdown', 40],
      ['type', 'standard', 5],
      ['type', 'rich', 5],
      ['trash', 'trash', 10],
    ]);
  });

  it('an empty trash never becomes a segment', () => {
    const slices = storageSegments(
      report({
        notes: {
          bytes: 8,
          live_count: 1,
          trash: { bytes: 0, count: 0 },
          by_type: [{ type: 'standard', bytes: 8, count: 1 }],
        },
      }),
    );

    expect(slices).toHaveLength(1);
    expect(slices[0]?.kind).toBe('type');
  });

  it('an account with nothing at all builds no segments', () => {
    expect(storageSegments(report())).toEqual([]);
  });
});

describe('formatBytes — the legend speaks human', () => {
  it('bytes stay bytes below one kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('kilobytes with one decimal under 10, whole from there', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1.5 * 1024)).toBe('1.5 KB');
    expect(formatBytes(9.8 * 1024)).toBe('9.8 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('megabytes and gigabytes follow the same rule', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});
