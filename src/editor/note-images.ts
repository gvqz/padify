/**
 * Note images — the RENDER half of the attachment-reference scheme, riding
 * the blob store the voice-notes foundation shipped (server half:
 * server/attachments.ts; local store: storage/attachments.ts; cloud flush:
 * cloud/attachments.ts).
 *
 * THE SHAPE. A note's content never carries pixels — it carries a tiny
 * reference, `padify-att:<id>`, as the destination of a normal markdown
 * image or a raw-HTML `<img src>`. The bytes live in the attachment store:
 * IndexedDB locally, the server in the background. Note sync, merge and
 * the 2 MB wire cap stay untouched — a reference is ~40 characters.
 *
 * THE SCOPE (owner's call, 2026-11-21). Standard notes are TEXT-ONLY: the
 * markdown surface stopped capturing images (paste/drop/picker came out).
 * This module stays as graceful degradation — notes that already carry a
 * reference (from the one day capture lived there, or from an imported
 * .padify file) keep rendering, and a missing one reads as a dashed
 * placeholder, never a broken glyph or a mangled construct. The capture
 * tenant is the DRAWING CANVAS (see editor/drawing/canvas-images.ts),
 * whose image elements carry fileIds — this scheme's note-content form is
 * legacy-shaped and nothing new writes it.
 *
 * RESOLUTION. The preview renders `<img src="padify-att:…">` because the
 * renderer's URL gate admits the scheme; this module then swaps the srcs
 * to blob URLs — the local store first, the server's lazy pull when the
 * bytes are another device's — and marks what it could not load. One blob
 * URL per id for the surface's lifetime, revoked at teardown.
 *
 * THE GATE STAYS PURE. This module is app-only (it imports the storage
 * and cloud layers); the share viewer's generated bundle inherits only
 * the html-policy gate, where `padify-att:` is an inert scheme that
 * renders as an unresolved image — the honest degradation until share
 * links learn to carry attachments.
 */

import { getAttachmentBlob, putAttachment, type AttachmentMeta } from '../storage/attachments';
import { fetchAttachment } from '../cloud/attachments';

// ---------------------------------------------------------------------------
// The reference scheme
// ---------------------------------------------------------------------------

/** The URL scheme a note's image reference speaks. */
export const PADIFY_ATT_SCHEME = 'padify-att:';

/**
 * The one shape a reference may take: the scheme plus the store's id
 * (client ids are `att-` + 24 hex; the server's pattern admits
 * `[A-Za-z0-9_-]{8,64}` — this gate accepts exactly that shape, so a
 * hand-written ref that the store could never answer renders as text).
 */
const PADIFY_ATT_PATTERN = /^padify-att:[A-Za-z0-9_-]{8,64}$/;

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

/**
 * Every attachment id a note's content references — the .padify export's
 * embedding pass (app.ts) and any future garbage collection.
 *
 * Three shapes, the ones the renderer actually resolves: inline images
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
  return [...ids];
}

// ---------------------------------------------------------------------------
// Resolution — the preview's blob-URL pass
// ---------------------------------------------------------------------------

/** The pluggable store write (a remote pull caches into the local store). */
export type AttachmentStore = (
  meta: Omit<AttachmentMeta, 'uploaded' | 'createdAt'>,
  blob: Blob,
) => Promise<boolean>;

/** The loader seam (tests inject; production reads the local store). */
export type LocalImageLoader = (id: string) => Promise<Blob | null>;

/** The remote seam (tests inject; production is the cloud's lazy pull). */
export type RemoteImageLoader = (id: string) => Promise<Blob | null>;

export interface NoteImageResolverDeps {
  loadLocal?: LocalImageLoader;
  loadRemote?: RemoteImageLoader;
  store?: AttachmentStore;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

export interface NoteImageResolver {
  /** Swaps every resolvable `padify-att:` src in the container to its
   * blob URL; marks the rest as missing. Idempotent per render pass. */
  resolve(container: Element): void;
  /** Revokes every blob URL this resolver created (the surface's teardown). */
  release(): void;
}

/**
 * Builds the preview's image resolver. One instance lives per mounted
 * surface: the URL cache spans re-renders (a 250 ms typing debounce
 * must not refetch or flicker), misses are remembered for the surface's
 * lifetime (an offline pull must not hammer the API on every render),
 * and release() reclaims everything on teardown.
 */
export function createNoteImageResolver(deps: NoteImageResolverDeps = {}): NoteImageResolver {
  const loadLocal = deps.loadLocal ?? getAttachmentBlob;
  const loadRemote = deps.loadRemote ?? fetchAttachment;
  const store = deps.store ?? putAttachment;
  const createUrl = deps.createUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));

  const urls = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  const failed = new Set<string>();

  const load = (id: string): Promise<string | null> => {
    const pending = inflight.get(id);
    if (pending) {
      return pending;
    }
    const task = (async (): Promise<string | null> => {
      const local = await loadLocal(id);
      const blob = local ?? (await loadRemote(id));
      if (!blob) {
        return null;
      }
      if (!local) {
        // Another device's bytes: cache them into the local store so the
        // next open (and offline) reads them there. Best-effort — a
        // degraded store still gets this session's URL.
        await store(
          {
            id,
            name: `${id}.img`,
            mime: blob.type || 'application/octet-stream',
            size: blob.size,
          },
          blob,
        );
      }
      return createUrl(blob);
    })().finally(() => inflight.delete(id));
    inflight.set(id, task);
    return task;
  };

  return {
    resolve(container: Element): void {
      const images = container.querySelectorAll('img[src^="padify-att:"]');
      images.forEach((img) => {
        const ref = img.getAttribute('src') ?? '';
        const id = padifyAttId(ref);
        if (id === null) {
          return; // the gate let it through malformed — leave it visible as text src
        }
        const cached = urls.get(id);
        if (cached) {
          img.setAttribute('src', cached);
          img.removeAttribute('data-padify-missing');
          return;
        }
        if (failed.has(id)) {
          img.setAttribute('data-padify-missing', '');
          img.setAttribute('data-padify-ref', ref);
          return;
        }
        void load(id).then((url) => {
          if (url) {
            urls.set(id, url);
            // The element may have been re-rendered away — the next
            // resolve() pass picks the URL up from the cache.
            if (img.isConnected) {
              img.setAttribute('src', url);
              img.removeAttribute('data-padify-missing');
            }
          } else {
            failed.add(id);
            if (img.isConnected) {
              img.setAttribute('data-padify-missing', '');
              img.setAttribute('data-padify-ref', ref);
            }
          }
        });
      });
    },
    release(): void {
      for (const url of urls.values()) {
        revokeUrl(url);
      }
      urls.clear();
      inflight.clear();
      failed.clear();
    },
  };
}
