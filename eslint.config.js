// ESLint 9 flat config. Scope is the TypeScript app source, the build
// configs and the API server — the static islands in public/ are legacy
// pages being folded into the main app (or deleted) and stay excluded.
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
