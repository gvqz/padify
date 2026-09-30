import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Parse-time `<!--#include <path-relative-to-repo-root> -->` expansion for
 * index.html (works in dev and build).
 *
 * Why includes instead of JS-mounting chrome: the topbar is visible chrome
 * and the theme pre-paint script inside index.html toggles .navbar classes
 * while the document is still parsing — the markup has to be there at parse
 * time or the theme flashes and the script throws. Includes keep the DOM
 * byte-identical while giving the markup a real home (src/ui/topbar.html).
 * Only use it for markup that must exist before boot; feature markup mounts
 * through boot.ts, dialogs through src/ui/modals.
 */
function htmlIncludes(): Plugin {
  const repoRoot = fileURLToPath(new URL('./', import.meta.url));
  return {
    name: 'padify-html-includes',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<!--#include\s+(.+?)\s*-->/g, (_match, file: string) =>
          readFileSync(repoRoot + file.trim(), 'utf-8'),
        );
      },
    },
  };
}

export default defineConfig({
  plugins: [htmlIncludes()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      // The cloud API (server/) runs separately; in dev every /api call is
      // proxied to it so the app talks same-origin, exactly like production.
      '/api': {
        target: 'http://localhost:3041',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3000,
    host: true,
  },
});
