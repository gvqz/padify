/**
 * The Account pane's storage card — usage made visible.
 *
 * The server enforced 25 MB of notes and 200 MB of attachments long before
 * the app could show either; the only symptom of a full account was a 413
 * on the next push. This module renders the answer of GET /api/usage
 * (shared/wire.ts UsageReport) Apple's-storage-page style: one stacked bar
 * per quota, a legend naming each note type's slice largest-first, and the
 * trash as its own segment — it keeps its content on purpose, so it
 * occupies exactly the storage it looks like and gets named, not buried.
 *
 * Refresh discipline: the fetch rides the settings modal's open event and
 * the sync engine's settle transitions (signed-in, idle), gated by a
 * minimum interval so a flapping status can never hammer the endpoint.
 * The last report is cached per account — an open re-renders instantly
 * from cache, and a different account's stale bytes never flash.
 */

import { $ } from '../lib/q';
import { api } from './api';
import { getCloudSync, type CloudStatus } from './sync';
import { noteTypeLabel } from '../editor/note-types';
import type { UsageReport } from '../../shared/wire';

/** One segment of the notes bar — a live type's slice, or the trash. */
export interface StorageSegment {
  /** 'type' renders with the registry label; 'trash' names itself. */
  kind: 'type' | 'trash';
  type: string;
  bytes: number;
  count: number;
}

/** The known segment class names — anything else renders as 'other'. */
const SEGMENT_CLASSES = new Set(['standard', 'rich', 'markdown', 'tasks', 'drawing']);

/** How long one successful fetch stands before the next trigger may refetch. */
const MIN_REFRESH_MS = 20_000;

let cache: { email: string; report: UsageReport } | null = null;
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;

export function initStorageCard(): void {
  const sync = getCloudSync();

  // Settings opens → refresh (share-ui rides the same event for the links
  // list; the two fetches race, neither blocks the other).
  $('#preferencesModal').on('show.bs.modal', () => {
    void refresh();
  });

  sync.subscribe((status: CloudStatus) => {
    if (status.state === 'signed-in') {
      // A fresh session (sign-in, or a different account after a switch)
      // must not inherit the previous report — the cache is keyed by
      // email and only a fetch may fill the card.
      const fresh = cache?.email !== status.email;
      if (fresh || status.sync === 'idle') {
        void refresh();
      }
      return;
    }
    if (status.state === 'signed-out') {
      cache = null;
      $('#storageCard').attr('hidden', 'hidden');
    }
  });
}

async function refresh(): Promise<void> {
  const status = getCloudSync().getStatus();
  if (status.state !== 'signed-in' || inFlight) {
    return;
  }
  if (Date.now() - lastFetchAt < MIN_REFRESH_MS) {
    // Inside the stand-down window: render the cached report if it is
    // this account's, then stop. A cache from another account is dropped,
    // never shown.
    if (cache && cache.email === status.email) {
      render(cache.report);
    } else {
      cache = null;
    }
    return;
  }

  inFlight = (async () => {
    try {
      const report = await api<UsageReport>('/api/usage');
      cache = { email: status.email, report };
      lastFetchAt = Date.now();
      render(report);
    } catch {
      // Unreachable server: keep whatever is on screen (a stale report is
      // still this account's truth as of its fetch) and wait for the next
      // trigger. The card staying hidden until a first fetch lands is the
      // honest state for a never-fetched account.
    } finally {
      inFlight = null;
    }
  })();
  await inFlight;
}

// ---- rendering ---------------------------------------------------------------

function render(report: UsageReport): void {
  $('#storageCard').removeAttr('hidden');

  const totalBytes = report.notes.bytes + report.attachments.bytes;
  $('#storageSummary').text(
    totalBytes === 0
      ? 'Nothing stored yet — notes and attachments land here as you sync.'
      : `${formatBytes(totalBytes)} stored across notes and attachments.`,
  );

  // The notes bar: the live types' slices, largest first, the trash
  // appended. The bar's track is the unspent quota — the segment widths
  // are shares of the QUOTA, not of the used bytes, so a half-full
  // account reads as half full.
  const segments = storageSegments(report);
  const $notesBar = $('#storageNotesBar').empty();
  for (const segment of segments) {
    $notesBar.append(
      `<span class="storage-seg ${segmentClass(segment)}" style="width:${percentOf(segment.bytes, report.limits.notes_bytes)}%" aria-hidden="true"></span>`,
    );
  }
  $('#storageNotesBar').attr(
    'aria-label',
    `Notes: ${formatBytes(report.notes.bytes)} of ${formatBytes(report.limits.notes_bytes)} used`,
  );
  $('#storageNotesUsage').text(
    `${formatBytes(report.notes.bytes)} of ${formatBytes(report.limits.notes_bytes)}`,
  );

  renderLegend(segments, report);

  // The attachments bar: one segment against its own quota; the file
  // count is the second ceiling, so it names both.
  $('#storageAttachmentsBar').empty().append(
    `<span class="storage-seg seg-attachments" style="width:${percentOf(report.attachments.bytes, report.limits.attachments_bytes)}%" aria-hidden="true"></span>`,
  );
  $('#storageAttachmentsBar').attr(
    'aria-label',
    `Attachments: ${formatBytes(report.attachments.bytes)} of ${formatBytes(report.limits.attachments_bytes)} used`,
  );
  $('#storageAttachmentsUsage').text(
    `${formatBytes(report.attachments.bytes)} of ${formatBytes(report.limits.attachments_bytes)}`,
  );
  $('#storageAttachmentsHint').text(
    `${report.attachments.count} of ${report.limits.attachments_count} files`,
  );
}

function renderLegend(segments: StorageSegment[], report: UsageReport): void {
  const $legend = $('#storageLegend').empty();
  if (segments.length === 0) {
    // An account with no notes at all: no slices, no fake rows.
    $legend.attr('hidden', 'hidden');
    return;
  }
  $legend.removeAttr('hidden');
  for (const segment of segments) {
    const row = $('<div class="storage-legend-row"></div>');
    row.append(`<span class="storage-dot ${segmentClass(segment)}" aria-hidden="true"></span>`);
    row.append(
      $('<span class="storage-legend-name"></span>').text(
        segment.kind === 'trash' ? 'Trash' : noteTypeLabel(segment.type),
      ),
    );
    row.append(
      $('<span class="storage-legend-meta"></span>').text(
        `${segment.count} ${segment.count === 1 ? 'note' : 'notes'}`,
      ),
    );
    row.append(
      $('<span class="storage-legend-bytes"></span>').text(formatBytes(segment.bytes)),
    );
    $legend.append(row);
  }
  // The bar's total, named once under the legend it breaks down —
  // trashed bytes included, because they are what the quota counts.
  if (report.notes.trash.bytes > 0) {
    $legend.append(
      $('<p class="storage-legend-total"></p>').text(
        `${formatBytes(report.notes.bytes)} counted toward the notes quota, trash included.`,
      ),
    );
  }
}

/** The bar segments: live types largest-first, then the trash when it holds bytes. */
export function storageSegments(report: UsageReport): StorageSegment[] {
  const segments: StorageSegment[] = report.notes.by_type
    .map((slice) => ({ kind: 'type' as const, ...slice }))
    .sort((a, b) => b.bytes - a.bytes);
  if (report.notes.trash.bytes > 0) {
    segments.push({
      kind: 'trash',
      type: 'trash',
      bytes: report.notes.trash.bytes,
      count: report.notes.trash.count,
    });
  }
  return segments;
}

function segmentClass(segment: StorageSegment): string {
  if (segment.kind === 'trash') {
    return 'seg-trash';
  }
  return SEGMENT_CLASSES.has(segment.type) ? `seg-${segment.type}` : 'seg-other';
}

/** A share of the quota, clamped for the bounded race overshoot the server accepts. */
function percentOf(bytes: number, limit: number): number {
  if (limit <= 0 || bytes <= 0) {
    return 0;
  }
  return Math.min(100, (bytes / limit) * 100);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${stripTrailingZero(bytes / 1024)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${stripTrailingZero(bytes / (1024 * 1024))} MB`;
  }
  return `${stripTrailingZero(bytes / (1024 * 1024 * 1024))} GB`;
}

/** One decimal below 10, trailing ".0" stripped — "9.8 KB", "2 KB", "12 MB". */
function stripTrailingZero(value: number): string {
  const text = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}
