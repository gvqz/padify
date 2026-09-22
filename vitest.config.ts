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
  },
});
