// Test the user's markdown torture document against padify's renderer.
// Usage: bun run scripts/md-torture.mjs
import { readFileSync } from 'node:fs';
import { renderMarkdownToHtml } from '../src/editor/markdown/render.ts';

const doc = readFileSync(new URL('./md-torture-doc.md', import.meta.url), 'utf8');
const html = renderMarkdownToHtml(doc);
console.log(html);

// --- quick assertions on what SHOULD be there ---
const checks = [
  ['h1', /<h1[^>]*>Header 1/],
  ['h2', /<h2[^>]*>Header 2/],
  ['h4', /<h4[^>]*>Header 4/],
  ['bold', /<b>bold text<\/b>/],
  ['italic', /<i>italic text<\/i>/],
  ['bold+italic', /<b><i>bold and italic text<\/i><\/b>/],
  ['code span', /<code>inline code<\/code>/],
  ['strike', /<s>strikethrough text<\/s>/],
  ['nested blockquote', /<blockquote>[\s\S]*<blockquote>/],
  ['blockquote cite line', /— <i>Famous Author<\/i>/],
  ['task checked', /<input[^>]*checked/],
  ['task unchecked', /<input(?![^>]*checked)/],
  ['table', /<table>/],
  ['table align center', /text-align:\s*center|class="[^"]*center/],
  ['table align right', /text-align:\s*right|class="[^"]*right/],
  ['fence info kept', /typescript|python/],
  ['code content', /interface User/],
  ['py content', /def fibonacci/],
  ['inline math shell', /padify-math/],
  ['block math separate blocks', /padify-math[\s\S]{0,200}int_\{0\}|\\int/],
  ['link external', /href="https:\/\/www\.example\.com"/],
  ['footnote ref', /footnote-ref|<sup>/],
  ['footnote def section', /footnotes|footnote-def/],
  ['thematic break', /<hr/],
  ['ordered list numbering (1,2,3)', /<ol[^>]*>[\s\S]*<li>First item/],
];
console.log('\n=== FEATURE CHECKS ===');
for (const [name, re] of checks) {
  console.log(`${re.test(html) ? 'PASS' : 'FAIL'}  ${name}`);
}
