import { defineConfig } from 'vitest/config';

// Test setup for the Padify client. Kept separate from vite.config.ts on
// purpose: the build config carries SW/deploy concerns tests don't need.
//
// jsdom is required because some "survivor" modules (tabs.ts sanitization,
// htmlToText) operate on real DOM APIs (DOMParser, document.createElement).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    reporters: 'default',
    // The Excalidraw island is the one dependency that ships bare JSON
    // imports (open-color) without Node's import attributes — inlining it
    // routes those through Vite's transform, which handles JSON natively.
    // Only the scene-format pin (editor/drawing/scene-pin.test.ts) imports
    // the package; every other test meets it behind the './canvas' mock.
    server: {
      deps: {
        inline: ['@excalidraw/excalidraw'],
      },
    },
  },
});
