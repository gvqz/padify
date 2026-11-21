/**
 * Note images — the attachment-reference scheme on markdown notes, riding
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
 * THE SCOPE (owner's call, 2026-11-21, restated). PLAIN notes are
 * text-only — their surface wires none of this. Rich/gfm (markdown)
 * notes capture and render: paste, drop and the toolbar's image row
 * compress into the store (offline-first) and insert a reference; the
 * preview resolves references to blob URLs. The DRAWING CANVAS is the
 * store's other tenant and owns its own module
 * (editor/drawing/canvas-images.ts — scene fileIds, not note refs).
 *
 * RESOLUTION. The preview renders `<img src="padify-att:…">` because the
 * renderer's URL gate admits the scheme; the resolver pass then swaps
 * the srcs to blob URLs — the local store first, the server's lazy pull
 * when the bytes are another device's — and marks what it could not
 * load: a dashed placeholder with its alt text, never a broken glyph.
 * One blob URL per id for the surface's lifetime, revoked at teardown.
 *
 * THE GATE STAYS PURE. This module is app-only (it imports the storage
 * and cloud layers); the share viewer's generated bundle inherits only
 * the html-policy gate, where `padify-att:` is an inert scheme that
 * renders as an unresolved image — the honest degradation until share
 * links learn to carry attachments.
 */

import {
  getAttachmentBlob,
  newAttachmentId,
  putAttachment,
  type AttachmentMeta,
} from '../storage/attachments';
import { fetchAttachment } from '../cloud/attachments';
// The per-file byte ceiling — the wire contract's one number (the
// server's upload cap, the envelope's, the canvas gates'), so an
// over-cap capture fails HERE with an honest message instead of
// poisoning the upload flush for the session.
import { MAX_ATTACHMENT_BYTES } from '../../shared/wire';

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
// Capture — paste, drop and the toolbar's image row
// ---------------------------------------------------------------------------

/**
 * The capture-side byte ceiling — the wire contract's MAX_ATTACHMENT_BYTES
 * (the server's own cap), mirrored here so an over-cap image fails at
 * capture time with an honest message instead of poisoning the upload
 * flush for the session.
 */
export const MAX_IMAGE_BYTES = MAX_ATTACHMENT_BYTES;

/** The long edge a captured image keeps — beyond it, WebP stops paying. */
export const MAX_IMAGE_EDGE_PX = 1920;

/** WebP quality for the re-encode (the sweet spot for screenshots). */
export const IMAGE_WEBP_QUALITY = 0.82;

/** JPEG fallback quality (Safari's canvas has no WebP encoder). */
export const IMAGE_JPEG_QUALITY = 0.85;

/** The input types capture accepts; anything else refuses honestly. */
export const IMAGE_INPUT_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A stored image: the store's meta shape plus the encoded bytes. */
export interface PreparedImage {
  id: string;
  name: string;
  mime: string;
  blob: Blob;
}

/** Why a capture failed — the toast's vocabulary. */
export type PrepareImageFailure = 'unsupported' | 'too-large' | 'no-storage' | 'failed';

export type PrepareImageResult =
  { ok: true; image: PreparedImage } | { ok: false; reason: PrepareImageFailure };

/** The pluggable re-encode step (jsdom has no canvas; tests inject). */
export type ImageCompressor = (file: Blob, mime: string) => Promise<Blob | null>;

/** The pluggable store write (tests inject a spy). */
export type AttachmentStore = (
  meta: Omit<AttachmentMeta, 'uploaded' | 'createdAt'>,
  blob: Blob,
) => Promise<boolean>;

/**
 * Captures one image file into the attachment store. Order of business:
 * the type gate (unknown types refuse before any decode), GIFs pass
 * through byte-exact under the cap (animation is the content), everything
 * else downscales + re-encodes, the result lands in the store offline-
 * first (uploaded=0; the cloud flush pushes it after the next sync cycle).
 */
export async function prepareImageAttachment(
  file: File,
  deps: { compress?: ImageCompressor; store?: AttachmentStore } = {},
): Promise<PrepareImageResult> {
  const mime = (file.type ?? '').toLowerCase();
  if (!IMAGE_INPUT_MIMES.has(mime)) {
    return { ok: false, reason: 'unsupported' };
  }
  const compress = deps.compress ?? compressImageFile;
  const store = deps.store ?? putAttachment;

  let blob: Blob;
  if (mime === 'image/gif') {
    // Canvas re-encoding strips animation — the bytes ARE the image.
    if (file.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    blob = file;
  } else {
    const encoded = await compress(file, mime);
    if (encoded === null || encoded.size === 0) {
      return { ok: false, reason: 'failed' };
    }
    if (encoded.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    blob = encoded;
  }

  const id = newAttachmentId();
  const storedMime = mime === 'image/gif' ? mime : blob.type || mime;
  const stored = await store(
    { id, name: file.name.slice(0, 200), mime: storedMime, size: blob.size },
    blob,
  );
  if (!stored) {
    // The storage layer fell back to localStorage, which cannot hold
    // bytes — the capture contract says surface this here, not at sync.
    return { ok: false, reason: 'no-storage' };
  }
  return { ok: true, image: { id, name: file.name, mime: storedMime, blob } };
}

/**
 * The markdown image line for a stored image: the alt is the file name
 * minus its extension, with the characters that would break the inline
 * construct (`[]()` and newlines) flattened — an honest alt beats a
 * mangled construct.
 */
export function imageMarkdownFor(image: PreparedImage): string {
  const alt =
    (image.name ?? '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[[\]()\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'image';
  return `![${alt}](${padifyAttRef(image.id)})`;
}

/**
 * The image files out of a paste/drop `FileList` — the ones capture
 * accepts, in order. Non-image files stay untouched (a text drop keeps
 * the textarea's native behavior).
 */
export function imageFilesFrom(files: FileList | undefined | null): File[] {
  if (!files) {
    return [];
  }
  return [...files].filter((file) => IMAGE_INPUT_MIMES.has((file.type ?? '').toLowerCase()));
}

/**
 * The canvas re-encode: decode → scale to the 1920-px long edge → WebP,
 * falling back to JPEG when the browser's canvas cannot answer WebP
 * (Safari). Null when the decode fails (a corrupt file) — the caller
 * turns that into the honest refusal.
 */
export const compressImageFile: ImageCompressor = async (file) => {
  const source = await decodeImage(file);
  if (!source) {
    return null;
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(source.image, 0, 0, width, height);
    const webp = await canvasToBlob(canvas, 'image/webp', IMAGE_WEBP_QUALITY);
    if (webp && webp.type === 'image/webp') {
      return webp;
    }
    // No WebP encoder (Safari) — the canvas fell back to PNG, which is
    // a size trap; re-ask for JPEG before giving up.
    return await canvasToBlob(canvas, 'image/jpeg', IMAGE_JPEG_QUALITY);
  } finally {
    source.release();
  }
};

/** A decoded image plus how to free it. */
interface DecodedImage {
  image: CanvasImageSource & { width: number; height: number };
  width: number;
  height: number;
  release(): void;
}

/** Decodes a blob to a drawable — ImageBitmap where it exists, `<img>`
 * decode as the fallback (same-origin object URL, revoked on release). */
async function decodeImage(file: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // fall through to the <img> path
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('decode failed'));
      image.src = url;
    });
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

// ---------------------------------------------------------------------------
// Resolution — the preview's blob-URL pass
// ---------------------------------------------------------------------------

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

/** The hidden file input the toolbar's image row opens — one per document,
 * created on first use (createElement, per the markup↔JS contract). */
export function pickImageFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = [...IMAGE_INPUT_MIMES].join(',');
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', () => {
      const picked = [...(input.files ?? [])];
      input.value = '';
      input.remove();
      resolve(picked);
    });
    // A picker that never fires change (Escape) must not leak the promise.
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}
