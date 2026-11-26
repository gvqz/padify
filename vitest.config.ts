import { defineConfig } from 'vitest/config';
import { EXCALIDRAW_VENDOR_ALIASES } from './vite.config';

// Test setup for the Padify client. Kept separate from vite.config.ts on
// purpose: the build config carries SW/deploy concerns tests don't need —
// but vitest REPLACES vite.config entirely when this file exists, so the
// one thing it must carry over is the vendored-vendor alias table: the
// scene-format pin (editor/drawing/scene-pin.test.ts) imports
// '@excalidraw/excalidraw' directly, and that name only resolves onto the
// vendored source tree (nothing installs it from npm anymore).
//
// jsdom is required because some "survivor" modules (tabs.ts sanitization,
// htmlToText) operate on real DOM APIs (DOMParser, document.createElement).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
    reporters: 'default',
  },
  resolve: {
    alias: EXCALIDRAW_VENDOR_ALIASES,
  },
});
