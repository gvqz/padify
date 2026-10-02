/// <reference types="vite/client" />

// Document Picture-in-Picture API (behind a feature check at runtime).
interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
}

interface DocumentPictureInPictureEvent extends Event {
  window: Window;
}

interface DocumentPictureInPicture {
  window: Window | null;
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  addEventListener(
    type: 'enter',
    listener: (event: DocumentPictureInPictureEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
}

declare const documentPictureInPicture: DocumentPictureInPicture | undefined;

// Legacy global contract kept for modules that still read window state.
// (whiteNoisePlayer moved to the module accessor getWhiteNoisePlayer(); the
// snapshots pair stays until the snapshot rewrite lands.)
interface Window {
  snapshotsManager?: import('./snapshots').SnapshotsManager;
  createSnapshot?: (title?: string) => Promise<void> | void;
}
