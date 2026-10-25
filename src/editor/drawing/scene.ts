/**
 * Drawing note scenes — the content model for noteType 'drawing'.
 *
 * The persistence contract is the retired Drawingpad's Generation-2 format
 * (legacyfeatures/drawingpad.md), lifted verbatim into the typed content
 * model: a scene is a versioned JSON payload of
 *
 *   { version: 1, savedAt: <epoch ms>, elements: [...], appState: {...} }
 *
 * This module owns ONLY the envelope discipline — versioning, the elements
 * array's presence, the appState whitelist and the byte budget. The
 * ELEMENTS are the canvas's schema (Excalidraw's, from phase 2 on): this
 * build stores and round-trips them verbatim and never interprets them,
 * exactly the way 'opaque' types ride the wire byte-exact. A scene this
 * module cannot parse is a newer build's payload — it renders as the
 * placeholder card and syncs untouched.
 *
 * Storage: the serialized scene IS the note's `content`
 * (contentKind 'json', see editor/note-types.ts) — one string per row in
 * the local store and the cloud's notes table, no schema additions, riding
 * the same tombstones/last-write-wins/seq pipeline as every other note.
 */

/** The scene format this build writes and understands. Bump WITH a
 * migration case in parseDrawingScene (unknown versions pass through
 * verbatim — see below) — never one without the other. */
export const DRAWING_SCENE_VERSION = 1;

/** One canvas element, kept verbatim: the shape data belongs to the
 * canvas (Excalidraw) and is not this module's to interpret. */
export type DrawingSceneElement = Record<string, unknown>;

/**
 * The appState keys worth persisting between sessions — the Generation-2
 * "tool defaults" whitelist (stroke/background colors, fill style, stroke
 * width/style, roughness, opacity, font family/size, text align, start
 * and end arrowheads, roundness, canvas background, grid size, grid
 * mode). Values stay verbatim; keys outside the whitelist are dropped at
 * parse time so the scene stays a curated payload instead of a dump of
 * whatever appState happened to carry (selection state, scroll offsets,
 * collaborators — none of that is content).
 */
export const DRAWING_APP_STATE_KEYS: readonly string[] = [
  'viewBackgroundColor',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemStrokeStyle',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'currentItemStartArrowhead',
  'currentItemEndArrowhead',
  'currentItemRoundness',
  'gridSize',
  'gridModeEnabled',
] as const;

/** The whitelisted appState subset (values verbatim). */
export type DrawingPersistedAppState = Record<string, unknown>;

/** A parsed scene. Elements and appState values are verbatim payloads. */
export interface DrawingScene {
  version: number;
  /** When this scene was last saved (epoch ms) — rides along for
   * migrations, never user-visible content. */
  savedAt: number;
  elements: DrawingSceneElement[];
  appState: DrawingPersistedAppState;
}

/**
 * The soft size budget for one scene, in UTF-8 bytes. The wire's hard
 * ceiling is MAX_BODY_BYTES (shared/wire.ts, 2 MB) and the sync batcher
 * isolates any single row that cannot share a body — a scene over budget
 * therefore never blocks other notes' sync, but it also never ships. The
 * canvas's autosave (phase 2) warns past this line instead of letting a
 * scene silently go sync-less; vector-only scenes sit at 1–100 KB, three
 * orders of magnitude below it. (Byte budget against the 25 MB per-user
 * note quota on the server — 25 average scenes to the megabyte.)
 */
export const DRAWING_SCENE_SOFT_BUDGET_BYTES = 1_000_000;

/** A fresh, empty scene — what "clear canvas" and a brand-new drawing
 * note serialize (the note's content stays '' until the first real edit;
 * parseDrawingScene reads that as this same empty state). */
export function emptyDrawingScene(): DrawingScene {
  return {
    version: DRAWING_SCENE_VERSION,
    savedAt: 0,
    elements: [],
    appState: {},
  };
}

/**
 * The note-content string for a scene: the Gen-2 envelope with a fixed key
 * order (deterministic bytes — identical scenes serialize identically, so
 * content-diff checks and snapshot equality stay honest).
 */
export function serializeDrawingScene(scene: DrawingScene): string {
  const appState: DrawingPersistedAppState = {};
  for (const key of DRAWING_APP_STATE_KEYS) {
    if (key in scene.appState) {
      appState[key] = scene.appState[key];
    }
  }
  return JSON.stringify({
    version: scene.version > 0 ? scene.version : DRAWING_SCENE_VERSION,
    savedAt: scene.savedAt,
    elements: scene.elements,
    appState,
  });
}

/**
 * Reads note content into a scene. Null = "not a scene this build
 * understands": empty content (a brand-new drawing note — the canvas
 * starts empty, exactly like the Gen-2 pad's fresh-canvas rule), junk,
 * truncated JSON, or a NEWER format version whose elements array survived
 * as something this build should not touch structurally. Callers treat
 * null as "display the placeholder, keep the bytes verbatim" — parse
 * failures never rewrite the note (the placeholder surface's capture
 * answers null), so unknown can never mean damaged.
 */
export function parseDrawingScene(content: string): DrawingScene | null {
  if (typeof content !== 'string' || content.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  // The one structural demand of the Gen-2 contract: "a payload missing
  // a valid elements array is ignored (fresh canvas)". Everything else
  // about the elements is the canvas's business.
  if (!Array.isArray(record.elements)) {
    return null;
  }

  const version =
    typeof record.version === 'number' && Number.isFinite(record.version)
      ? record.version
      : DRAWING_SCENE_VERSION;
  const savedAt =
    typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0;
  const appState: DrawingPersistedAppState = {};
  if (record.appState && typeof record.appState === 'object' && !Array.isArray(record.appState)) {
    const source = record.appState as Record<string, unknown>;
    for (const key of DRAWING_APP_STATE_KEYS) {
      if (key in source) {
        appState[key] = source[key];
      }
    }
  }
  return {
    version,
    savedAt,
    elements: record.elements as DrawingSceneElement[],
    appState,
  };
}

/**
 * True when the scene parses AND carries at least one element — the
 * "is there anything to lose here" answer for close-tab prompts and
 * snapshot checks. An empty drawing note (content '' or a bare empty
 * scene) answers false, same as an empty text note.
 */
export function drawingSceneHasContent(content: string): boolean {
  const scene = parseDrawingScene(content);
  return scene !== null && scene.elements.length > 0;
}

/**
 * The plain-text projection of a scene — what the word-count pill, the
 * statistics modal, the close-tab prompt and the snapshots preview read
 * (via the surface's visibleText). Text elements count as words: a sketch
 * annotated "grocery list / call the dentist" reads as those words, the
 * same way a task list reads as its rows' titles. A scene with no text
 * answers a shape count, so a drawing with content is never mistaken for
 * an empty note by a delete-everything or close prompt. Content that does
 * not parse (a newer build's scene, junk) reads as its raw bytes — the
 * opaque discipline: never the placeholder card's copy, and never a
 * silent empty that a prompt would treat as safe-to-delete.
 */
export function drawingScenePlainText(content: string): string {
  const scene = parseDrawingScene(content);
  if (scene === null) {
    return content.trim() === '' ? '' : content;
  }
  const words: string[] = [];
  for (const element of scene.elements) {
    if (element && typeof element === 'object' && element.type === 'text') {
      const text = (element as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim() !== '') {
        words.push(text.trim());
      }
    }
  }
  if (words.length > 0) {
    return words.join('\n');
  }
  const count = scene.elements.length;
  return count === 0 ? '' : `Drawing — ${count} element${count === 1 ? '' : 's'}`;
}

/**
 * A scene's byte size measured the way the wire will measure it
 * (UTF-8, not UTF-16 — see cloud/sync.ts's row-size notes). Pure helper:
 * the autosave's budget check (phase 2) and any future statistics ride
 * it; the scaffold ships it so the budget contract has teeth from day
 * one.
 */
export function drawingSceneByteSize(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * The CONTENT identity of scene bytes — the "is this the same drawing?"
 * answer for snapshot duplicate detection and the snapshots menu's
 * Current chip. The stored envelope carries a volatile `savedAt` stamp
 * that refreshes on every save (the surface's "stamp at save" rule), so
 * two byte strings of the SAME drawing differ whenever their last saves
 * happened at different moments — undo back to a snapshotted state and
 * the re-stamped bytes would sail past a byte comparison. Identity
 * therefore compares the scene the way a person sees it: the elements
 * (with the undo trail's deleted ghosts filtered, exactly like the
 * surface's capture) and the whitelisted appState, with the stamp and
 * the serialization order normalized away. Content this build cannot
 * parse (a newer build's scene, junk) keeps its raw bytes — opaque stays
 * opaque, and two unparseable strings are only "the same" byte for byte.
 */
export function drawingSceneContentIdentity(content: string): string {
  const scene = parseDrawingScene(content);
  if (scene === null) {
    return content;
  }
  return JSON.stringify({
    version: scene.version,
    elements: scene.elements.filter(
      (element) => (element as { isDeleted?: boolean } | null)?.isDeleted !== true,
    ),
    appState: scene.appState,
  });
}
