interface Window {
  ClipboardItem: any;
  __EXCALIDRAW_SHA__: string | undefined;
  EXCALIDRAW_ASSET_PATH: string | string[] | undefined;
  EXCALIDRAW_THROTTLE_RENDER: boolean | undefined;
  DEBUG_FRACTIONAL_INDICES: boolean | undefined;
  EXCALIDRAW_EXPORT_SOURCE: string;
  gtag: Function;
  sa_event: Function;
  fathom: { trackEvent: Function };
}

interface CanvasRenderingContext2D {
  // https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/roundRect
  roundRect?: (
    x: number,
    y: number,
    width: number,
    height: number,
    radii:
      | number // [all-corners]
      | [number] // [all-corners]
      | [number, number] // [top-left-and-bottom-right, top-right-and-bottom-left]
      | [number, number, number] // [top-left, top-right-and-bottom-left, bottom-right]
      | [number, number, number, number], // [top-left, top-right, bottom-right, bottom-left]
  ) => void;
}

interface Clipboard extends EventTarget {
  write(data: any[]): Promise<void>;
}

// PNG encoding/decoding
// -----------------------------------------------------------------------------
type TEXtChunk = { name: "tEXt"; data: Uint8Array };

declare module "png-chunk-text" {
  function encode(
    name: string,
    value: string,
  ): { name: "tEXt"; data: Uint8Array };
  function decode(data: Uint8Array): { keyword: string; text: string };
}
declare module "png-chunks-encode" {
  function encode(chunks: TEXtChunk[]): Uint8Array<ArrayBuffer>;
  export = encode;
}
declare module "png-chunks-extract" {
  function extract(buffer: Uint8Array): TEXtChunk[];
  export = extract;
}
// -----------------------------------------------------------------------------

interface Blob {
  handle?: FileSystemFileHandle;
  name?: string;
}

declare module "*.scss";

// --------------------------------------------------------------------------—
// ensure Uint8Array isn't assignable to ArrayBuffer
// (due to TS structural typing)
// https://github.com/microsoft/TypeScript/issues/31311#issuecomment-490690695
interface ArrayBuffer {
  _brand?: "ArrayBuffer";
}
interface Uint8Array {
  _brand?: "Uint8Array";
}
// --------------------------------------------------------------------------—

// https://github.com/nodeca/image-blob-reduce/issues/23#issuecomment-783271848
declare module "image-blob-reduce" {
  import type { PicaResizeOptions, Pica } from "pica";
  namespace ImageBlobReduce {
    interface ImageBlobReduce {
      toBlob(file: File, options: ImageBlobReduceOptions): Promise<Blob>;
      _create_blob(
        this: { pica: Pica },
        env: {
          out_canvas: HTMLCanvasElement;
          out_blob: Blob;
        },
      ): Promise<any>;
    }

    interface ImageBlobReduceStatic {
      new (options?: any): ImageBlobReduce;

      (options?: any): ImageBlobReduce;
    }

    // PADIFY FORK — `alpha` is not in upstream's own declaration, but the
    // vendored call site (data/blob.ts resizeImageFile) passes it: pica's
    // toBlob option set, through image-blob-reduce.
    interface ImageBlobReduceOptions extends PicaResizeOptions {
      max: number;
      alpha?: boolean;
    }
  }
  const reduce: ImageBlobReduce.ImageBlobReduceStatic;
  export = reduce;
}

interface CustomMatchers {
  toBeNonNaNNumber(): void;
  toCloselyEqualPoints(
    points: readonly [number, number][],
    precision?: number,
  ): void;
}

declare namespace jest {
  interface Expect extends CustomMatchers {}
  interface Matchers extends CustomMatchers {}
}

// PADIFY FORK — the third-party modules upstream left untyped (their
// monorepo never typechecked these paths against strict tsc). The fork's
// program typechecks the whole vendored tree, so the surface the app's
// graph actually reaches gets minimal declarations here — deliberately
// loose: the runtime modules are pinned in the app's package.json, the
// vendored call sites are the upstream code verbatim, and these stubs
// exist only to keep tsc honest about what crosses the boundary.

// pako ships no bundled types at the pinned 2.0.3. The signatures are the
// ones the vendored call sites speak (data/encode.ts deflates strings and
// inflates-to-string) — pako accepts both, the declares keep tsc honest
// about the boundary without over-constraining.
declare module "pako" {
  export function deflate(data: string | Uint8Array): Uint8Array;
  export function inflate(data: Uint8Array): Uint8Array;
  export function inflate(data: Uint8Array, options: { to: "string" }): string;
}
