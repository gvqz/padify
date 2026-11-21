/**
 * Canvas images — the drawing canvas's half of the attachment store.
 *
 * THE SCOPE (owner's call, 2026-11-21): images live in DRAWINGS, never in
 * standard notes. An Excalidraw image element carries a `fileId` — a
 * reference, never pixels — and the scene JSON stays text-sized (a fileId
 * is ~40 characters; the 2 MB wire cap never notices). The BYTES live in
 * the attachment store: IndexedDB locally (offline-first, written at flush
 * time), the server in the background (the same cloud flush voice notes
 * built; other devices pull on demand — see the resolver's shape in
 * editor/note-images.ts, which this module mirrors for fileIds).
 *
 * CAPTURE IS THE VENDOR'S. canvas.ts turns the image tool on and passes
 * `imageOptions` — master resizes at insert (1920-px long edge) and
 * refuses an over-cap file (the 5 MB ceiling the server enforces), so the
 * vendor's paste/drop/tool path lands ready-to-store BinaryFileData with
 * content-hashed file ids (the same image pasted twice is ONE store row).
 * This module never touches a File: it flushes what the vendor inserted.
 *
 * THE FLUSH. The vendor's files map (onChange's third argument, kept by
 * canvas.ts's handle) is diffed against the ids this device already
 * persists; new ids decode (data URL → bytes) and land in the store
 * offline-first, then ride the existing upload flush. Idempotent by id:
 * a re-flush of a known id is a no-op.
 *
 * THE HYDRATION. Opening a scene collects its fileIds and loads each:
 * the local store first, the cloud's lazy pull when the bytes are another
 * device's (cached back into the store on arrival — an offline reopen
 * reads them there). What loads feeds the vendor through handle.addFiles;
 * what does not yet load renders as the vendor's own loading placeholder,
 * never a broken image.
 *
 * VENDOR-FREE BY DESIGN. This module is app-level (the storage and cloud
 * layers live there); the BinaryFileData shape is mirrored structurally —
 * importing the vendor here would drag React + Excalidraw out of the lazy
 * chunk and into every boot.
 */

import { fetchAttachment } from '../../cloud/attachments';
import { getAttachmentBlob, putAttachment, type AttachmentMeta } from '../../storage/attachments';

/**
 * The vendor's BinaryFileData, mirrored structurally (see the module
 * docstring). `dataURL` is a `data:` URL — the only string form the
 * vendor renders and the .excalidraw/.padify bridges embed.
 */
export interface CanvasImageFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  lastRetrieved?: number;
  version?: number;
}

/** The vendor's files map: fileId → the file's bytes as a data URL. */
export type CanvasImageFiles = Record<string, CanvasImageFile>;

/**
 * The one shape a fileId may take — the store's id contract and the
 * envelope's pattern, one gate. The vendor's content-hashed ids (40 hex)
 * pass; anything else an element might carry is junk this build ignores.
 */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The data-URL shape this module decodes: an image (or binary) mime and
 * base64 payload. Anything else is not a file the vendor inserted. */
const DATA_URL_PATTERN =
  /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]*={0,2})$/;

/** The byte ceiling one stored image honors — the server's own cap, and
 * the envelope's. The vendor refuses bigger files at insert; the import
 * bridges enforce it here before anything reaches the store. */
export const MAX_CANVAS_IMAGE_BYTES = 5_000_000;

/** The per-scene file ceiling — the envelope's own count cap, mirrored. */
export const MAX_CANVAS_IMAGE_FILES = 500;

/**
 * Every fileId the scene's image elements reference — the flush's diff
 * base (via the handle's live map), the hydration's shopping list, the
 * .padify export's embedding pass and any future garbage collection.
 * Deleted ghosts (the undo trail) never count — the capture path filters
 * them before anything downstream reads the ids.
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
      if (FILE_ID_PATTERN.test(record.fileId)) {
        ids.add(record.fileId);
      }
    }
  }
  return [...ids];
}

/** True when the string is a base64 data URL this module will decode. */
export function isImageDataURL(value: string): boolean {
  return DATA_URL_PATTERN.test(value);
}

/** The mime inside a data URL this module will decode, or null. */
export function dataURLMime(value: string): string | null {
  const match = DATA_URL_PATTERN.exec(value);
  return match ? (match[1] ?? null) : null;
}

/** Base64 → bytes (the envelope's chunked discipline — a multi-megabyte
 * payload must not blow the call stack). Null when the string is junk. */
function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return null;
  }
  try {
    const binary = atob(value);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * A data URL → Blob, or null when the string is not one this build
 * trusts (the vendor hands real data URLs; the import bridges validate
 * before calling).
 */
export function blobFromDataURL(dataURL: string): Blob | null {
  const match = DATA_URL_PATTERN.exec(dataURL);
  if (!match) {
    return null;
  }
  const mime = match[1]!;
  const bytes = bytesFromBase64(match[2]!);
  if (bytes === null || bytes.byteLength === 0) {
    return null;
  }
  return new Blob([bytes], { type: mime });
}

/** A Blob → data URL (the hydration's last step — FileReader's own
 * event, promisified). Null when the read fails or the blob is empty. */
export function blobToDataURL(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** The pluggable store write (tests inject a spy). */
export type CanvasImageStore = (
  meta: Omit<AttachmentMeta, 'uploaded' | 'createdAt'>,
  blob: Blob,
) => Promise<boolean>;

/**
 * Flushes the vendor's files map into the attachment store — the ids this
 * device does not already persist (the caller's set is the diff base:
 * hydrated ids, previously flushed ids). Each file stands alone: one that
 * decodes to nothing (never expected from the vendor; honest anyway) is
 * skipped, the rest still land. Returns the ids persisted by this call.
 */
export async function flushSceneFiles(
  files: CanvasImageFiles,
  persisted: Set<string>,
  deps: { store?: CanvasImageStore } = {},
): Promise<string[]> {
  const store = deps.store ?? putAttachment;
  const flushed: string[] = [];
  for (const [id, file] of Object.entries(files)) {
    if (persisted.has(id) || !FILE_ID_PATTERN.test(id)) {
      continue;
    }
    const blob = blobFromDataURL(file.dataURL);
    if (blob === null || blob.size > MAX_CANVAS_IMAGE_BYTES) {
      // Over the ceiling or undecodable: the vendor's insert gate should
      // have kept this from ever existing. Skip it — a scene that carries
      // it still renders THIS session (the vendor holds the bytes), it
      // just never persists.
      continue;
    }
    const stored = await store(
      {
        id,
        name: `${id}.img`,
        mime: blob.type || file.mimeType || 'application/octet-stream',
        size: blob.size,
      },
      blob,
    );
    if (stored) {
      persisted.add(id);
      flushed.push(id);
    }
  }
  return flushed;
}

/** The loader seam (tests inject; production reads the local store). */
export type LocalFileLoader = (id: string) => Promise<Blob | null>;

/** The remote seam (tests inject; production is the cloud's lazy pull). */
export type RemoteFileLoader = (id: string) => Promise<Blob | null>;

export interface LoadSceneFilesDeps {
  loadLocal?: LocalFileLoader;
  loadRemote?: RemoteFileLoader;
  store?: CanvasImageStore;
  toDataURL?: (blob: Blob) => Promise<string | null>;
  now?: () => number;
}

/**
 * Loads the files a scene's image elements reference, ready for
 * handle.addFiles. Local store first; a miss goes to the cloud's lazy
 * pull and caches into the store on arrival (best-effort — a degraded
 * store still gets this session's data URL). A file neither source can
 * answer is simply absent — the vendor renders its own loading
 * placeholder, and the next open tries again.
 */
export async function loadSceneFiles(
  ids: string[],
  deps: LoadSceneFilesDeps = {},
): Promise<CanvasImageFile[]> {
  const loadLocal = deps.loadLocal ?? getAttachmentBlob;
  const loadRemote = deps.loadRemote ?? fetchAttachment;
  const store = deps.store ?? putAttachment;
  const toDataURL = deps.toDataURL ?? blobToDataURL;
  const now = deps.now ?? (() => Date.now());

  const files: CanvasImageFile[] = [];
  for (const id of ids) {
    if (!FILE_ID_PATTERN.test(id)) {
      continue;
    }
    let blob = await loadLocal(id);
    let fromRemote = false;
    if (!blob) {
      blob = await loadRemote(id);
      fromRemote = blob !== null;
    }
    if (!blob) {
      continue;
    }
    const dataURL = await toDataURL(blob);
    if (dataURL === null) {
      continue;
    }
    if (fromRemote) {
      // Another device's bytes: cache them locally so the next open (and
      // offline) reads them there. The mime rides the blob (the data URL
      // said image/*), the size from the read.
      void store(
        { id, name: `${id}.img`, mime: blob.type || 'application/octet-stream', size: blob.size },
        blob,
      );
    }
    files.push({
      id,
      mimeType: blob.type || dataURLMime(dataURL) || 'application/octet-stream',
      dataURL,
      created: now(),
      lastRetrieved: now(),
    });
  }
  return files;
}

/**
 * The ids a scene needs minus the ids this device already persists — the
 * hydration's actual workload (an unchanged reopen loads nothing).
 */
export function idsNeedingHydration(
  elements: Record<string, unknown>[],
  persisted: Set<string>,
): string[] {
  return collectSceneFileIds(elements).filter((id) => !persisted.has(id));
}
