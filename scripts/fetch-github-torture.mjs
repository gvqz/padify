// Fetch GitHub's own rendering of the giellalt torture doc — the app's
// parity target — exactly as github.com renders the file blob the user
// pointed at (giellalt/giellalt.github.io, infra/MarkdownTestReference.md).
//
// The blob page embeds the fully rendered markdown (post cmark-gfm, post
// html-pipeline, post syntax-highlight) in its react payload under
// payload.codeViewBlobRoute.richText — that string IS what the user sees
// on github.com. This script extracts it and saves it as the fixture the
// GitHub-parity suite diffs against.
//
// Usage: GITHUB_TOKEN=ghp_… node scripts/fetch-github-torture.mjs
//   (any token with public-repo read access suffices — the blob page and
//   the comment-mode API both rate-limit harder without one); also
//   refreshes the comment-mode API rendering alongside, for reference.
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN env is required (public-repo read access suffices)');
  process.exit(1);
}
const OUT_DIR = new URL('../src/editor/markdown/__fixtures__/', import.meta.url);

// --- 1. The blob page — the rendering github.com actually shows ----------
const page = await fetch(
  'https://github.com/giellalt/giellalt.github.io/blob/main/infra/MarkdownTestReference.md',
  { headers: { Authorization: `Bearer ${TOKEN}` } },
);
if (!page.ok) {
  console.error(`blob page ${page.status}`);
  process.exit(1);
}
const html = await page.text();
const payloads = [
  ...html.matchAll(
    /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/g,
  ),
];
let rich = '';
for (const m of payloads) {
  try {
    const data = JSON.parse(m[1]);
    const candidate = data?.payload?.codeViewBlobRoute?.richText;
    if (typeof candidate === 'string' && candidate.length > rich.length) {
      rich = candidate;
    }
  } catch {
    // a payload we don't care about — skip
  }
}
if (!rich) {
  console.error('no codeViewBlobRoute.richText found on the blob page');
  process.exit(1);
}
writeFileSync(new URL('github-torture.html', OUT_DIR), rich);
console.log(`saved ${rich.length} bytes of blob-rendered HTML -> github-torture.html`);

// --- 2. The comment-mode API rendering, for reference ---------------------
const doc = readFileSync(new URL('gfm-torture.md', OUT_DIR), 'utf-8');
const api = await fetch('https://api.github.com/markdown', {
  method: 'POST',
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    text: doc,
    mode: 'gfm',
    context: 'giellalt/giellalt.github.io',
  }),
});
if (api.ok) {
  const apiHtml = await api.text();
  writeFileSync(new URL('github-comment-mode-torture.html', OUT_DIR), apiHtml);
  console.log(`saved ${apiHtml.length} bytes of comment-mode HTML -> github-comment-mode-torture.html`);
} else {
  console.warn(`comment-mode API ${api.status} — kept going, blob fixture is the parity target`);
}
