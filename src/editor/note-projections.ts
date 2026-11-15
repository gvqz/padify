/**
 * Note content projections — how the SHELL reads a note's content.
 *
 * note-types.ts says what a note's content IS (its content kind);
 * surface.ts says what the user SEES in the editor host; this module is
 * the third leg: the read-only projections shell consumers need —
 * emptiness gates (the share refusal, the snapshot eligibility), the
 * plain-text projection (previews, titles, close prompts), unit counting
 * (the snapshot change badges), content identity (snapshot dedup), the
 * tab-strip badge and the HTML export body. Before this seam, every
 * shell file that needed one of those readings imported the kind's
 * content model directly and re-implemented the dispatch — the exact
 * accretion that made "who may interpret a note kind's bytes?" unanswerable.
 *
 * Adapters register PER NOTE TYPE, exactly like the surface registry:
 * a kind whose model lives outside editor/ (the tasks model lives in
 * the tasks feature) calls registerNoteProjection() from its own module
 * at import time, so editor/ never imports feature code. Editor-native
 * models (drawing's scene) are imported statically below. Unknown and
 * unregistered types fall to the kind defaults — html kinds read through
 * the tag stripper, everything else is its raw bytes — which is also the
 * entire projection story for kinds this build has never heard of:
 * unknown never means damaged, and never means unreadable-as-bytes.
 *
 * Behavior note (preserved deliberately): the two emptiness readings
 * differ for drawings, and always have. The share gate counts the
 * elements array (deleted or not — the recipient's viewer decides what
 * a newer build's scene means); the substance gate counts only
 * non-deleted elements (a safety copy of a fully-undone canvas adds
 * nothing). One question, two honest answers — kept as two methods so
 * neither call site has to know that history.
 */

import {
  drawingSceneContentIdentity,
  drawingScenePlainText,
  parseDrawingScene,
} from './drawing/scene';
import { htmlToText } from './note-content';
import { sanitizeNoteHtml } from './storage-subset';
import { renderMarkdownToHtml } from './markdown/render';
import { isHtmlContent } from './note-types';
import { escapeHtml } from '../lib/escape';

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/** What one note type's content counts as, for the snapshot badges. */
export interface NoteUnitCount {
  count: number;
  /** Singular, lowercase — 'word', 'task', 'shape'. */
  unit: string;
}

/** The badge a note's tab-strip button wears because of its CONTENT
 *  (not its type): a task list's colored circle. */
export interface NoteStripBadge {
  kind: 'list-dot';
  /** The list palette color (the tasks model's ListColor, as a string —
   *  the seam cannot import the model to name the type). */
  color: string;
}

/**
 * The per-type readings. Every method is optional: an answer that is
 * absent falls to the kind defaults (see the module docs). Registered
 * once per type; the last registration wins, like the surface registry.
 */
export interface NoteContentProjection {
  /** The share gate: nothing a recipient would read. Content this
   *  build cannot parse answers FALSE — a newer build's real note must
   *  never become unshareable because we refuse to understand it. */
  isEmptyForShare?(content: string): boolean;
  /** The substance gate: nothing a safety copy adds. Unparseable bytes
   *  answer by their bytes — keeping exactly those bytes is the point. */
  hasSubstance?(content: string): boolean;
  /** The readable plain-text projection (snapshot previews, derived
   *  titles, the trash rows). Corrupt model bytes answer as raw bytes
   *  rather than an empty panel. */
  plainText?(content: string): string;
  /** The unit + count a snapshot change badge shows for this content. */
  unitCount?(content: string): NoteUnitCount;
  /** The content identity two "same" captures compare (default: the
   *  bytes). Drawings canonicalize — their envelope carries a volatile
   *  savedAt stamp that must never make a drawing look "new". */
  contentIdentity?(content: string): string;
  /** The tab-strip badge this content paints (default: none — the type
   *  badge takes over). */
  stripBadge?(content: string): NoteStripBadge | null;
  /** The HTML export body for this content (default: none — the export
   *  flow's html/pre fallbacks apply). */
  exportHtmlBody?(content: string): string;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Type id → its projection. Keyed by the note TYPE (not kind): two
 *  types can share a kind and still project differently, the same
 *  type-keyed-claim rule the surface registry follows. */
const projections = new Map<string, NoteContentProjection>();

/**
 * Registers the projection for a note type — called from the kind's own
 * module at import time (the surface registry's pattern), so a model
 * that lives outside editor/ wires itself in without editor/ ever
 * importing it.
 */
export function registerNoteProjection(type: string, projection: NoteContentProjection): void {
  projections.set(type, projection);
}

/** The registered projection for a type, when there is one. */
function projectionFor(noteType?: string | null): NoteContentProjection | undefined {
  if (typeof noteType !== 'string' || noteType === '') return undefined;
  return projections.get(noteType);
}

/** The default text a kind reads as: html kinds through the tag
 *  stripper (a bare <p></p> or <br> is emptiness wearing markup),
 *  everything else as its raw bytes. NOT trimmed — callers trim when
 *  the question is emptiness, not when the question is projection. */
function baseText(content: string, noteType?: string | null): string {
  return isHtmlContent(noteType) ? htmlToText(content) : content;
}

// ---------------------------------------------------------------------------
// The questions — one function per reading, no kind branching in callers
// ---------------------------------------------------------------------------

/**
 * True when a note carries nothing worth sharing. Html kinds read their
 * text projection; registered kinds read their model (an empty task
 * list is JSON bytes with zero reminders — not a share); unparseable
 * registered content stays shareable. The blank note a fresh tab or a
 * delete-all leaves behind must never become a link — the recipient
 * would get an empty page and the owner a "share" of nothing.
 */
export function noteContentIsEmpty(content: string, noteType?: string | null): boolean {
  const projection = projectionFor(noteType)?.isEmptyForShare;
  if (projection) {
    return projection(content);
  }
  return baseText(content, noteType).trim() === '';
}

/**
 * True when a note's content is worth a safety copy, judged by its
 * kind: html notes read their text projection (the storage subset holds
 * words and formatting only, so an html note without words is empty,
 * full stop); structured kinds read their meaning — a scene with no
 * visible elements (a stroke undone away) and a list with no rows are
 * nothing a snapshot adds. Unparseable structured bytes stay real
 * content — the app refuses to edit them but keeps them, and a safety
 * copy of exactly those bytes is the point.
 */
export function noteContentHasSubstance(content: string, noteType?: string | null): boolean {
  const projection = projectionFor(noteType)?.hasSubstance;
  if (projection) {
    return projection(content);
  }
  return baseText(content, noteType).trim() !== '';
}

/**
 * What a row's expandable panel and the readable previews show: html
 * kinds read their text projection; structured kinds read their plain
 * projection; markdown and unknown kinds are their raw bytes — a
 * markdown note's source IS its text.
 */
export function notePlainText(content: string, noteType?: string | null): string {
  const projection = projectionFor(noteType)?.plainText;
  if (projection) {
    return projection(content);
  }
  return baseText(content, noteType);
}

/** The content identity of a capture — what "the same snapshot twice"
 *  compares. A content/type pair is the identity; callers normalize
 *  types themselves. */
export function noteContentIdentity(content: string, noteType?: string | null): string {
  const projection = projectionFor(noteType)?.contentIdentity;
  if (projection) {
    return projection(content);
  }
  return content;
}

/** Words for text kinds, tasks for task lists, shapes for drawings —
 *  the unit each kind counts, not a byte size a person cannot read. */
export function noteUnitCount(content: string, noteType?: string | null): NoteUnitCount {
  const projection = projectionFor(noteType)?.unitCount;
  if (projection) {
    return projection(content);
  }
  const words = notePlainText(content, noteType).trim();
  return { count: words === '' ? 0 : words.split(/\s+/).length, unit: 'word' };
}

/** The tab-strip badge this content paints, when it paints one. */
export function noteStripBadge(content: string, noteType?: string | null): NoteStripBadge | null {
  const projection = projectionFor(noteType)?.stripBadge;
  return projection ? projection(content) : null;
}

/**
 * The HTML export body for a note's content: markdown renders through
 * the owned renderer (its source IS meant to become markup, and the
 * renderer's output is exactly what the preview and a share link show,
 * safe by construction); registered kinds answer their own body (a task
 * list exports as the checklist it is); html kinds re-sanitize into the
 * storage subset; everything else is escaped text in a <pre>.
 */
export function noteExportHtmlBody(content: string, noteType?: string | null): string {
  if (noteType === 'markdown') {
    return renderMarkdownToHtml(content);
  }
  const projection = projectionFor(noteType)?.exportHtmlBody;
  if (projection) {
    return projection(content);
  }
  if (isHtmlContent(noteType)) {
    return sanitizeNoteHtml(content);
  }
  return `<pre>${escapeHtml(content)}</pre>`;
}

// ---------------------------------------------------------------------------
// The drawing projection — editor-native, registered statically
// ---------------------------------------------------------------------------

/** A scene's visible element count, for the substance reading. */
function drawingVisibleElementCount(content: string): number {
  const scene = parseDrawingScene(content);
  const elements = scene?.elements.filter(
    (element) => (element as { isDeleted?: boolean } | null)?.isDeleted !== true,
  );
  return elements?.length ?? 0;
}

registerNoteProjection('drawing', {
  // '' = a drawing note never drawn on; a parsed scene with zero
  // elements = the cleared-canvas envelope the canvas phase writes.
  // Both are emptiness wearing JSON, the same rule as the empty task
  // list. Content this build cannot parse is a NEWER build's real
  // scene — it stays shareable (the viewer shows non-html kinds as raw
  // text), so refusing to understand can never block sharing.
  isEmptyForShare: (content) => {
    if (content.trim() === '') {
      return true;
    }
    const scene = parseDrawingScene(content);
    return scene !== null && scene.elements.length === 0;
  },
  // A stroke undone away is nothing a safety copy adds; unparseable
  // bytes are kept — a safety copy of exactly those bytes is the point.
  hasSubstance: (content) => {
    const scene = parseDrawingScene(content);
    if (scene !== null) {
      return scene.elements.some(
        (element) => (element as { isDeleted?: boolean } | null)?.isDeleted !== true,
      );
    }
    return content.trim() !== '';
  },
  plainText: (content) => drawingScenePlainText(content),
  unitCount: (content) => ({ count: drawingVisibleElementCount(content), unit: 'shape' }),
  // The stored envelope carries a volatile savedAt stamp that refreshes
  // on every save — byte-comparing two saves of the SAME drawing would
  // answer "different". The identity is the canonical scene.
  contentIdentity: (content) => drawingSceneContentIdentity(content),
});
