/**
 * The attachment reference grammar — one spelling, three readers.
 *
 * An attachment's bytes are never in a note; a note carries a tiny
 * reference to them (`padify-att:<id>` in markdown content, the vendor's
 * `fileId` in a drawing scene's image elements). Knowing WHICH bytes a
 * note references is a shared question with three consumers that must
 * never disagree:
 *
 *  • the .padify export's embedding pass (app.ts) — what rides in the file;
 *  • the local GC (cloud/attachment-gc.ts) — what this device may sweep;
 *  • the server GC (server/attachments.ts) — what the server may sweep.
 *
 * A reference the renderer resolves is a reference every reader sees; a
 * scanner may over-count (one extra kept blob) but must never
 * under-count (a silently lost image). This module is pure on purpose:
 * both the app and the server import it, so it touches nothing platform
 * specific — no storage, no DOM, no fetch.
 *
 * THE GATE. The scheme, the strict id shape and the collectors live
 * here; the capture/resolution vocabulary stays in editor/note-images.ts
 * and the vendor's files-map plumbing in editor/drawing/canvas-images.ts
 * — those modules import this one, never the reverse.
 */

import { ATTACHMENT_ID_PATTERN, ATTACHMENT_ID_SOURCE } from './wire';

// ---------------------------------------------------------------------------
// The reference scheme
// ---------------------------------------------------------------------------

/** The URL scheme a note's image reference speaks. */
export const PADIFY_ATT_SCHEME = 'padify-att:';

/**
 * The one shape a reference may take: the scheme plus the store's id
 * (client ids are `att-` + 24 hex; the wire's ATTACHMENT_ID_SOURCE is
 * the single source — this gate accepts exactly that shape, so a
 * hand-written ref the store could never answer renders as text).
 */
const PADIFY_ATT_PATTERN = new RegExp(`^${PADIFY_ATT_SCHEME}${ATTACHMENT_ID_SOURCE}$`);

/** True when the string is a well-formed attachment reference. */
export function isPadifyAttRef(value: string): boolean {
  return PADIFY_ATT_PATTERN.test(value);
}

/** The id inside a reference, or null when the string isn't one. */
export function padifyAttId(ref: string): string | null {
  return isPadifyAttRef(ref) ? ref.slice(PADIFY_ATT_SCHEME.length) : null;
}

/** The reference for an id (the caller's id must be the store's shape). */
export function padifyAttRef(id: string): string {
  return PADIFY_ATT_SCHEME + id;
}

// ---------------------------------------------------------------------------
// The collectors
// ---------------------------------------------------------------------------

/**
 * Every attachment id a note's markdown content references. Three
 * shapes, the ones the renderer actually resolves: inline images
 * `![alt](padify-att:id)`, image definitions `[ref]: padify-att:id`, and
 * raw-HTML `<img src="padify-att:id">` (both quote styles). The scan is
 * deliberately generous — a ref inside a code span collects too, which
 * only ever over-counts (one extra embedded blob), never under-counts
 * (a silently lost image).
 */
export function collectAttachmentRefs(content: string): string[] {
  const ids = new Set<string>();
  const take = (raw: string): void => {
    const id = padifyAttId(raw);
    if (id !== null) {
      ids.add(id);
    }
  };
  // Inline images: `![…](padify-att:id)` — the alt may itself contain
  // brackets' escaped forms; the generous reading keeps this a scan, not
  // a second markdown parser.
  for (const m of content.matchAll(/!\[[^\]]*\]\((padify-att:[A-Za-z0-9_-]+)\)/g)) {
    take(m[1]!);
  }
  // Reference definitions: a line whose definition is a padify ref.
  for (const m of content.matchAll(/^\s*\[[^\]]+\]:\s*(padify-att:[A-Za-z0-9_-]+)\s*$/gm)) {
    take(m[1]!);
  }
  // Raw HTML: `<img … src="padify-att:id" …>` (both quote styles).
  for (const m of content.matchAll(/<img[^>]*\ssrc=["'](padify-att:[A-Za-z0-9_-]+)["']/gi)) {
    take(m[1]!);
  }
  // Voice recordings: `<audio … src="padify-att:id" …>` (the rich note's
  // recording card — editor/voice-notes.ts writes it, the storage subset
  // admits it with this exact src gate). Same generosity as the img scan.
  for (const m of content.matchAll(/<audio[^>]*\ssrc=["'](padify-att:[A-Za-z0-9_-]+)["']/gi)) {
    take(m[1]!);
  }
  return [...ids];
}

/**
 * True when the content carries a voice-recording card (`<audio>` with a
 * well-formed attachment ref) — the rail badge's cheap read. One test, no
 * match-all iteration: the strip re-renders on every keystroke. The shape
 * mirrors the collector's audio branch above; the storage subset strips a
 * malformed src before it ever stores, so the two never disagree on
 * stored content.
 */
export function hasVoiceRecording(content: string): boolean {
  return /<audio[^>]*\ssrc=["']padify-att:[A-Za-z0-9_-]+["']/i.test(content);
}

/**
 * Every fileId the scene's image elements reference — the flush's diff
 * base (via the handle's live map), the hydration's shopping list, the
 * .padify export's embedding pass and the garbage collection. Deleted
 * ghosts (the undo trail) never count — the capture path filters them
 * before anything downstream reads the ids.
 */
export function collectSceneFileIds(elements: Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const element of elements) {
    if (!element || typeof element !== 'object') {
      continue;
    }
    const record = element as Record<string, unknown>;
    if (record.isDeleted === true) {
      continue;
    }
    if (record.type === 'image' && typeof record.fileId === 'string') {
      if (ATTACHMENT_ID_PATTERN.test(record.fileId)) {
        ids.add(record.fileId);
      }
    }
  }
  return [...ids];
}

/**
 * The fileIds a drawing note's content carries — a minimal read of the
 * scene envelope ({ version, savedAt, elements, appState }; the strict
 * parser lives in editor/drawing/scene.ts, which the server cannot
 * import). When the envelope reads (elements present), the elements
 * walk answers; when it does not — corrupt bytes, a future format that
 * moved the array — the honest stance is generosity: every id-shaped
 * quoted token in the raw content counts, which can only over-keep
 * (phantom ids match no stored row) and never under-keep. A note this
 * build cannot read never costs a live image its bytes.
 */
export function sceneFileIdsFromSceneContent(content: string): string[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { elements?: unknown }).elements)
    ) {
      const elements = (parsed as { elements: Record<string, unknown>[] }).elements;
      return collectSceneFileIds(elements);
    }
  } catch {
    // fall through to the generous read
  }
  const ids = new Set<string>();
  for (const m of content.matchAll(/"([A-Za-z0-9_-]{8,64})"/g)) {
    if (ATTACHMENT_ID_PATTERN.test(m[1]!)) {
      ids.add(m[1]!);
    }
  }
  return [...ids];
}

/** The note-type id that carries a scene as its content. */
const DRAWING_NOTE_TYPE = 'drawing';

/**
 * Every attachment id one note references — the one dispatch every
 * reader asks (the export pass, both GCs): a drawing note answers
 * through the scene envelope, everything else through the content scan.
 * A plain note's text may mention a ref as text; the generous scan
 * counts it (over-keep, never loss).
 */
export function collectNoteAttachmentIds(note: {
  content: string;
  noteType?: string | null;
}): string[] {
  return note.noteType === DRAWING_NOTE_TYPE
    ? sceneFileIdsFromSceneContent(note.content)
    : collectAttachmentRefs(note.content);
}

// ---------------------------------------------------------------------------
// The garbage verdict — the rule both GCs run
// ---------------------------------------------------------------------------

/**
 * The grace window an attachment survives unreferenced before either
 * GC may delete it. THE PROMISE (the design's whole point): a file
 * referenced only by an unsynced second device must not die under the
 * first device's broom. The clock starts when a sweep FIRST sees the
 * reference gone — so a device that reconnects within the window and
 * pushes its older (referencing) copy resets the clock on the next
 * sweep, and its lazy pull finds the bytes still there. Seven days
 * matches the share links' dead-link grace (server/shares.ts): two
 * policies, one honest duration.
 */
export const ATTACHMENT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** What a sweep should do, per attachment — the executor's whole menu. */
export interface OrphanVerdicts {
  /** Referenced again (or still): forget any clock. */
  clearClock: string[];
  /** Newly unreferenced: the grace clock starts now. Never deleted this sweep. */
  stampClock: string[];
  /** Unreferenced past the grace window: garbage, safe to delete. */
  garbage: string[];
}

/**
 * The verdict for one scope's attachments against one scope's
 * references (the caller owns the scoping — per user on the server, the
 * whole device on the client). Pure: every GC runs the same judgment,
 * so a bug in the rule is fixed — and tested — once.
 */
export function orphanVerdicts(
  entries: ReadonlyArray<{ id: string; orphanSince: number | null }>,
  referenced: ReadonlySet<string>,
  now: number,
  graceMs: number = ATTACHMENT_ORPHAN_GRACE_MS,
): OrphanVerdicts {
  const clearClock: string[] = [];
  const stampClock: string[] = [];
  const garbage: string[] = [];
  for (const { id, orphanSince } of entries) {
    if (referenced.has(id)) {
      if (orphanSince !== null) {
        clearClock.push(id);
      }
      continue;
    }
    if (orphanSince === null) {
      stampClock.push(id);
    } else if (now - orphanSince >= graceMs) {
      garbage.push(id);
    }
  }
  return { clearClock, stampClock, garbage };
}
