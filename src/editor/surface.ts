/**
 * Note surfaces — the presentation seam for note kinds.
 *
 * The registry in note-types.ts says what a note's content IS (its
 * contentKind); this module says what the user SEES for it. Every kind
 * maps to one NoteSurface which owns the editor host while a note of that
 * kind is open: it paints the note (display — the RENDER half that never
 * persists), reads the live surface back (capture), projects it to plain
 * text (visibleText), replaces it wholesale (commit — the COMMIT half),
 * and empties it (clear).
 *
 * TabManager delegates here instead of branching on note types itself, so
 * a new kind is one surface + one registry entry — the manager, the strip,
 * the persistence and the sync layer never learn about it. Today the
 * registry carries two entries: the HTML surface (the contenteditable +
 * EditorPort pipeline — the only editing surface this build has) and the
 * opaque fallback (the read-only "this Padify can't open it yet" card for
 * unknown types and not-yet-shipped kinds). 'text' and 'json' notes
 * currently render through the opaque fallback; when the Markdown or
 * Kanban surface ships it calls registerNoteSurface('text'/'json', …) and
 * every consumer follows without a single call site changing.
 *
 * Architecture notes:
 *  - Surfaces are STATELESS singletons: the host element is a parameter,
 *    not constructor state, so the same surface serves any host (the main
 *    editor, tests' jsdom hosts) and nothing can capture a stale element.
 *  - The HTML surface speaks ONLY through EditorPort (editor/port.ts) —
 *    never the engine, never execCommand; the bare-DOM fallbacks mirror
 *    the pre-port code paths for tests and pre-boot moments exactly.
 *  - commit() returns true when the change was applied AND persisted
 *    through the surface's own channel (the port's onDocumentReplaced
 *    wiring); false means the caller owns the persist — either the bare
 *    fallback painted and the manager must save, or nothing was applied.
 */

import { renderMathIn } from './math';
import { getEditorPort } from './port';
import { sanitizeNoteHtml } from './storage-subset';
import { noteRenderedForTheme } from './theme-colors';
import { contentKindFor, DEFAULT_NOTE_TYPE, noteTypeLabel, type ContentKind } from './note-types';

/**
 * The note data a surface presents. `NoteTab` (tabs.ts) satisfies this
 * structurally; the shape is declared here so surfaces never import the
 * tab model (tabs imports this module — a cycle otherwise).
 */
export interface SurfaceNote {
  /** The note's content, in its type's format. */
  content: string;
  /** The note kind — absent means the default (standard). */
  noteType?: string;
  /** The theme the note's inline colors were last written under. */
  colorTheme?: 'light' | 'dark';
}

/** What one note kind shows in the editor host. */
export interface NoteSurface {
  /** The content kind this surface serves (the registry key). */
  readonly kind: ContentKind;
  /**
   * True when edits flow from this surface back into the note — i.e. the
   * note is editable in this build. False means display-only; capture()
   * answers null and the manager never writes from the host.
   */
  readonly editable: boolean;
  /**
   * Paints a note into the host for DISPLAY ONLY — the render half of the
   * port discipline: nothing persists, no autosave is announced, the
   * caller owns when (and whether) the note is written. `note` null means
   * "no note open" (the empty-editor paint).
   */
  display(host: HTMLElement, note: SurfaceNote | null): void;
  /**
   * The note's live content from the surface — what a save should write.
   * Null when this surface holds nothing worth saving (a display-only
   * card; the note's content never entered the host).
   */
  capture(host: HTMLElement | null): string | null;
  /**
   * Plain-text projection of the note as currently presented — what the
   * word count, statistics, exports and the close-tab prompt read. The
   * host matters for editing surfaces (they read the live DOM); a
   * display-only surface reads the model's content and may ignore it.
   */
  visibleText(host: HTMLElement | null, note: SurfaceNote): string;
  /**
   * Replaces the note wholesale (snapshot restore, external edits) — the
   * commit half of the port discipline. Returns true when the surface
   * applied it AND the change was persisted through its own channel (the
   * port fires onDocumentReplaced, which the shell wires to the manager's
   * save); false when the caller must persist (the bare fallback painted
   * the sanitized content) or nothing was applied at all.
   */
  commit(host: HTMLElement | null, content: string): boolean;
  /** Empties the surface (the clear-note flow). */
  clear(host: HTMLElement): void;
}

// ---------------------------------------------------------------------------
// The HTML surface — the contenteditable + EditorPort pipeline
// ---------------------------------------------------------------------------

/**
 * The surface for 'html' notes (the classic and rich types): the
 * contenteditable host driven through EditorPort. This is the only
 * EDITING surface this build ships; it is the template for future kinds.
 *
 * Exported as a CLASS type (not the interface) for the one consumer that
 * reads it without going through the registry: its capture() never
 * answers null, and tabs.ts's getEditorHtml wants that in the type.
 */
export class HtmlNoteSurface implements NoteSurface {
  readonly kind = 'html' as const;
  readonly editable = true;

  display(host: HTMLElement, note: SurfaceNote | null): void {
    // html notes own an editable surface — restore it in case a
    // display-only card parked here before.
    host.setAttribute('contenteditable', 'true');

    const port = getEditorPort();
    if (port) {
      // The port's display-only entry: sanitized, math rendered, empty
      // state collapsed — and nothing persists, because opening a note
      // must not write on its own.
      port.renderHtml(note ? note.content : '');
    } else {
      // Bare fallback (tests, pre-boot): the same paint, by hand. The
      // empty-state normalization is a port capability — without a port
      // it is skipped, exactly like the pre-split code did.
      host.innerHTML = note ? note.content : '';
      renderMathIn(host);
    }
    host.scrollTop = 0;
    // A note whose stored colors were written under the other theme is
    // re-inked for display right away (visual only — storage catches up on
    // the next edit, so opening a note never writes on its own).
    noteRenderedForTheme(host, note?.colorTheme);
  }

  capture(host: HTMLElement | null): string {
    // Through the port: sanitized, and math shells stored as their LaTeX
    // source (the rendered KaTeX markup lives only in the editing DOM).
    return getEditorPort()?.getHtml() ?? (host ? host.innerHTML : '');
  }

  visibleText(host: HTMLElement | null): string {
    if (!host) {
      return '';
    }
    const text = host.innerText
      .replace(/\u00a0/g, ' ')
      // The styled-caret run (U+200B) is formatting, not content.
      .replace(/\u200B/g, '');
    // A bare <br> — the empty state a delete-all leaves — reports "\n"
    // through innerText, which read as a phantom character on an empty
    // note ("1 character • 0 words"). Whitespace-only means empty for
    // every consumer of this text (count pill, statistics, share cards).
    return text.trim() === '' ? '' : text;
  }

  commit(host: HTMLElement | null, content: string): boolean {
    const port = getEditorPort();
    if (port) {
      // Sanitized on entry inside the port, persisted exactly once via the
      // onDocumentReplaced callback the shell wired to the manager.
      port.setHtml(content);
      return true;
    }
    // Bare-DOM fallback (pre-boot paths): same write, by hand — the caller
    // persists (the manager's save reads the capture right back).
    if (host) {
      host.innerHTML = sanitizeNoteHtml(content);
    }
    return false;
  }

  clear(host: HTMLElement): void {
    host.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// The opaque surface — kinds this build cannot edit
// ---------------------------------------------------------------------------

/**
 * The display-only surface: a note whose type this build doesn't edit (a
 * non-html format, or a type from a newer Padify) gets a read-only
 * explanation instead of a surface. The content itself never enters the
 * editor DOM — it is kept byte-exact in the model and syncs untouched.
 *
 * Serves 'opaque' and, until they ship their own surfaces, the known
 * 'text'/'json' kinds too — the fallback is what makes an unregistered
 * kind degrade safely instead of crashing.
 */
export class OpaqueNoteSurface implements NoteSurface {
  readonly kind = 'opaque' as const;
  readonly editable = false;

  display(host: HTMLElement, note: SurfaceNote | null): void {
    host.setAttribute('contenteditable', 'false');
    // Non-editable: no input events can fire, so nothing can dirty the
    // note through the host.
    host.textContent = '';

    if (note) {
      host.append(this.buildUnsupportedCard(note));
    }
    host.scrollTop = 0;
  }

  capture(): null {
    // Nothing on this surface belongs to the note — the note's real
    // content lives in the model, byte-exact.
    return null;
  }

  visibleText(_host: HTMLElement | null, note: SurfaceNote): string {
    // Non-html formats read as their raw content — statistics and exports
    // must never report the placeholder card's copy as the note's text.
    return note.content.trim() === '' ? '' : note.content;
  }

  commit(): false {
    // No surface to write through — the manager writes the model directly.
    return false;
  }

  clear(host: HTMLElement): void {
    // The note is empty now; the honest presentation of an empty note this
    // build can't edit is the card itself, not a void.
    this.display(host, { content: '' });
  }

  private buildUnsupportedCard(note: SurfaceNote): HTMLElement {
    const card = document.createElement('div');
    card.className = 'unsupported-note';
    card.dataset.noteType = note.noteType ?? DEFAULT_NOTE_TYPE;

    const title = document.createElement('p');
    title.className = 'unsupported-note-title';
    title.textContent = `${noteTypeLabel(note.noteType ?? DEFAULT_NOTE_TYPE)} — this Padify can't open it yet`;

    const body = document.createElement('p');
    body.className = 'unsupported-note-body';
    body.textContent =
      'The note is stored safely and syncs untouched. Open it on a device with a newer Padify to edit it.';

    card.append(title, body);
    return card;
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The one HTML surface instance (stateless — see the module docs). */
export const htmlNoteSurface: HtmlNoteSurface = new HtmlNoteSurface();

/** The display-only fallback for everything this build cannot edit. */
export const opaqueNoteSurface: OpaqueNoteSurface = new OpaqueNoteSurface();

const surfaces = new Map<ContentKind, NoteSurface>([
  ['html', htmlNoteSurface],
  ['opaque', opaqueNoteSurface],
]);

/**
 * Registers the surface for a note kind. New kinds (Markdown's 'text',
 * a board's 'json') call this from their feature module at import time;
 * unregistered kinds keep rendering through the opaque fallback, so an
 * old build meeting a new kind degrades safely.
 */
export function registerNoteSurface(
  kind: Exclude<ContentKind, 'opaque'>,
  surface: NoteSurface,
): void {
  surfaces.set(kind, surface);
}

/** The surface serving a content kind (unknown/unregistered → opaque). */
export function noteSurfaceForKind(kind: ContentKind): NoteSurface {
  return surfaces.get(kind) ?? opaqueNoteSurface;
}

/** The surface for the note a tab holds (absent type = the html default). */
export function noteSurfaceFor(note: SurfaceNote | null | undefined): NoteSurface {
  return noteSurfaceForKind(contentKindFor(note?.noteType));
}
