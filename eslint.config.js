// ESLint 9 flat config. Scope is the TypeScript app source, the build
// configs and the API server. public/ stays excluded — it holds the
// design-system sheets and the GENERATED share island (its sources are
// src/editor/markdown/*, compiled by scripts/build-share.mjs). The
// vendored Excalidraw tree (vendor/) stays excluded too — it is upstream's
// code at a pinned baseline with the fork's own deltas; upstream's own
// toolchain owns its style, and the fork's deltas must not churn under the
// app's linter (the delta against the baseline is the review surface).
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      'scripts/**',
      'vendor/**',
      'server/local.db',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Keep ESLint out of formatting — Prettier owns that.
  prettier,
  {
    files: ['src/**/*.ts', 'vite.config.ts', 'vitest.config.ts', 'server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // The codebase intentionally writes `catch (e) { /* … */ }` for
      // expected, commented failures (private mode, clipboard blocks), and
      // prefixing unused params with `_` marks them as deliberately unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
);
