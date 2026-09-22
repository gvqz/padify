#!/usr/bin/env node
/**
 * gen-unicode-data.mjs
 *
 * Generates src/unicode/symbols-data.ts (the Unicode character dataset backing
 * the notepad's character picker) from the Unicode Character Database.
 *
 * Usage:
 *   node scripts/gen-unicode-data.mjs            # uses cache when present
 *   node scripts/gen-unicode-data.mjs --refresh  # forces re-download
 *
 * Data source: UnicodeData.txt (UCD). Downloaded to
 * scripts/.unicode-cache/UnicodeData.txt (gitignored) with a fallback mirror.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.unicode-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'UnicodeData.txt');
const OUT_FILE = path.join(ROOT, 'src', 'unicode', 'symbols-data.ts');

const SOURCES = [
  'https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt',
  'https://raw.githubusercontent.com/unicode-org/unicode-data/main/UCD/latest/ucd/UnicodeData.txt',
];

/**
 * Inclusive hex ranges -> category label. Order matters: the first appearance
 * of each label in this table defines the category order of the output.
 */
const RANGE_TABLE = [
  ['00A0', '00FF', 'Latin-1'],
  ['0100', '017F', 'Latin Extended-A'],
  ['0180', '024F', 'Latin Extended-B'],
  ['0250', '02AF', 'IPA (Phonetic)'],
  ['02B0', '02FF', 'Modifier Letters'],
  ['0300', '036F', 'Combining Accents'],
  ['0370', '03FF', 'Greek & Coptic'],
  ['0400', '04FF', 'Cyrillic'],
  ['2000', '206F', 'Punctuation'],
  ['2070', '209F', 'Superscripts & Subscripts'],
  ['20A0', '20CF', 'Currency'],
  ['2100', '214F', 'Letterlike'],
  ['2150', '218F', 'Numbers & Roman Numerals'],
  ['2190', '21FF', 'Arrows'],
  ['27F0', '27FF', 'Arrows'],
  ['2900', '297F', 'Arrows'],
  ['2200', '22FF', 'Math'],
  ['27C0', '27EF', 'Math'],
  ['2980', '29FF', 'Math'],
  ['2A00', '2AFF', 'Math'],
  ['2300', '23FF', 'Technical'],
  ['2400', '243F', 'Control Pictures'],
  ['2460', '24FF', 'Enclosed Alphanumerics'],
  ['2500', '257F', 'Box Drawing'],
  ['2580', '259F', 'Block Elements'],
  ['25A0', '25FF', 'Geometric Shapes'],
  ['2600', '26FF', 'Misc Symbols'],
  ['2700', '27BF', 'Dingbats'],
  ['2B00', '2BFF', 'Misc Symbols & Arrows'],
  ['2800', '28FF', 'Braille'],
  ['3000', '303F', 'CJK Punctuation'],
  ['1F300', '1F5FF', 'Emoji — Nature & Objects'],
  ['1F600', '1F64F', 'Emoji — Smileys & People'],
  ['1F680', '1F6FF', 'Emoji — Travel'],
  ['1F900', '1F9FF', 'Emoji — Supplemental'],
  ['1FA70', '1FAFF', 'Emoji — Extended'],
];

const RANGES = RANGE_TABLE.map(([lo, hi, label]) => ({
  lo: parseInt(lo, 16),
  hi: parseInt(hi, 16),
  label,
}));

/** Category order = first appearance in RANGE_TABLE. */
const CATEGORY_ORDER = [...new Set(RANGE_TABLE.map((r) => r[2]))];

/** Find the category for a code point, or null when outside all ranges. */
function categoryFor(cp) {
  for (const r of RANGES) {
    if (cp >= r.lo && cp <= r.hi) return r.label;
  }
  return null;
}

/** "RIGHTWARDS ARROW" -> "Rightwards arrow". Commas/hyphens kept as-is. */
function prettifyName(name) {
  const lower = name.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Build a safe single-quoted JS string literal (escapes ' \ and line-ish chars). */
function jsSingleQuoted(s) {
  let out = "'";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "'") out += "\\'";
    else if (ch === '\\') out += '\\\\';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x0d) out += '\\r';
    else if (cp === 0x2028) out += '\\u2028';
    else if (cp === 0x2029) out += '\\u2029';
    else out += ch;
  }
  return out + "'";
}

async function download(url) {
  const opts = {};
  if (typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(120_000);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  // Sanity check: every line must look like `HEX;NAME;...`.
  if (!/^[0-9A-F]{4,6};/.test(text.split(/\r?\n/, 1)[0] ?? '')) {
    throw new Error('content does not look like UnicodeData.txt');
  }
  return text;
}

async function ensureUnicodeData(forceRefresh) {
  if (!forceRefresh && existsSync(CACHE_FILE)) {
    const cached = await readFile(CACHE_FILE, 'utf8');
    if (/^[0-9A-F]{4,6};/.test(cached.split(/\r?\n/, 1)[0] ?? '')) {
      console.log(`Using cached ${CACHE_FILE}`);
      return cached;
    }
    console.warn('Cache file present but invalid; re-downloading.');
  }
  const errors = [];
  for (const url of SOURCES) {
    try {
      console.log(`Downloading ${url} ...`);
      const text = await download(url);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(CACHE_FILE, text, 'utf8');
      console.log(`Cached at ${CACHE_FILE} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
      return text;
    } catch (err) {
      errors.push(`  ${url}: ${err.message}`);
    }
  }
  console.error('Failed to obtain UnicodeData.txt from all sources:');
  console.error(errors.join('\n'));
  console.error('Re-run with --refresh, or manually place the file at:');
  console.error(`  ${CACHE_FILE}`);
  process.exit(1);
}

function parseUnicodeData(text) {
  /** @type {Map<string, Array<{char: string, name: string, category: string, codepoint: number}>>} */
  const byCategory = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  const seen = new Set();
  let totalLines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    totalLines++;
    const fields = line.split(';');
    if (fields.length < 2) continue;

    const cp = parseInt(fields[0], 16);
    if (!Number.isFinite(cp)) continue;

    const name = fields[1];
    // Skip pseudo-names: <control>, <surrogate>, <unassigned>, <first>, <last>, ...
    if (name === '' || name.startsWith('<')) continue;

    // Skip characters that are invisible or behave as raw control codes when
    // inserted into a plain textarea: space separators (Zs: no-break space,
    // em/en spaces), format chars (Cf: soft hyphen, zero-width joiners, bidi
    // controls), line/paragraph separators (Zl/Zp) and remaining controls.
    // They render as blank cards and make poor first-class picker entries.
    const generalCategory = fields[2];
    if (/^(Zs|Cf|Zl|Zp|Cc|Cs|Co|Cn)$/.test(generalCategory)) continue;

    const category = categoryFor(cp);
    if (category === null) continue;

    // Dedupe identical codepoints.
    if (seen.has(cp)) continue;
    seen.add(cp);

    byCategory.get(category).push({
      char: String.fromCodePoint(cp),
      name: prettifyName(name),
      category,
      codepoint: cp,
    });
  }

  // Sort by codepoint within each category (UnicodeData.txt is already in
  // codepoint order, but sort defensively).
  for (const list of byCategory.values()) list.sort((a, b) => a.codepoint - b.codepoint);

  return { byCategory, totalLines };
}

function validate(byCategory) {
  const problems = [];
  const seen = new Set();
  const categorySet = new Set(CATEGORY_ORDER);

  for (const [category, list] of byCategory) {
    for (const sym of list) {
      if (sym.name === '')
        problems.push(`U+${sym.codepoint.toString(16).toUpperCase()}: empty name`);
      if (!categorySet.has(sym.category))
        problems.push(
          `U+${sym.codepoint.toString(16).toUpperCase()}: unknown category "${sym.category}"`,
        );
      if (category !== sym.category)
        problems.push(
          `U+${sym.codepoint.toString(16).toUpperCase()}: stored under "${category}" but says "${sym.category}"`,
        );
      const cps = [...sym.char].map((c) => c.codePointAt(0));
      if (cps.length !== 1 || cps[0] !== sym.codepoint) {
        problems.push(
          `U+${sym.codepoint.toString(16).toUpperCase()}: char is not a single matching code point`,
        );
      }
      if (seen.has(sym.codepoint)) problems.push(`duplicate codepoint ${sym.codepoint}`);
      seen.add(sym.codepoint);
    }
  }
  return problems;
}

/** Decode the escaped body of one of our single-quoted literals back to a string. */
function unescapeSingleQuoted(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      if (next === "'") out += "'";
      else if (next === '\\') out += '\\';
      else if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 'u') {
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      } else {
        out += next;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** Re-parse the written file (fixed one-entry-per-line shape) for a final check. */
async function reValidateWrittenFile(count) {
  const written = await readFile(OUT_FILE, 'utf8');
  const entryRe =
    /^  \{ char: '((?:[^'\\]|\\.)*)', name: '((?:[^'\\]|\\.)*)', category: '((?:[^'\\]|\\.)*)', codepoint: (\d+) \},$/gm;
  const problems = [];
  const seen = new Set();
  let parsed = 0;
  let m;
  while ((m = entryRe.exec(written)) !== null) {
    parsed++;
    const cp = Number(m[4]);
    if (seen.has(cp)) problems.push(`duplicate codepoint ${cp} in written file`);
    seen.add(cp);
    if (!CATEGORY_ORDER.includes(m[3])) problems.push(`unknown category "${m[3]}" in written file`);
    if (m[2] === '') problems.push(`empty name at ${cp} in written file`);
    const char = unescapeSingleQuoted(m[1]);
    if ([...char].length !== 1 || char.codePointAt(0) !== cp) {
      problems.push(`char/codepoint mismatch at ${cp} in written file`);
    }
  }
  if (parsed !== count)
    problems.push(`written file has ${parsed} parseable entries, expected ${count}`);
  return { problems, parsed };
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const text = await ensureUnicodeData(refresh);

  const { byCategory, totalLines } = parseUnicodeData(text);

  const problems = validate(byCategory);
  if (problems.length > 0) {
    console.error('Validation failed:');
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }

  const [output, total] = renderOutput(byCategory);

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, output, 'utf8');

  const { problems: writeProblems, parsed } = await reValidateWrittenFile(total);
  if (writeProblems.length > 0) {
    console.error('Post-write re-validation failed:');
    for (const p of writeProblems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }

  const sizeBytes = (await stat(OUT_FILE)).size;
  const sizeKB = (sizeBytes / 1024).toFixed(1);

  console.log('\n=== Summary ===');
  console.log(`UnicodeData.txt lines scanned: ${totalLines}`);
  console.log(`Total characters: ${total} (re-parsed ${parsed} from written file)`);
  for (const category of CATEGORY_ORDER) {
    console.log(`  ${category}: ${byCategory.get(category).length}`);
  }
  console.log(`Categories: ${CATEGORY_ORDER.length}`);
  console.log(`Wrote ${OUT_FILE} (${sizeKB} KB / ${sizeBytes} bytes)`);
  if (total < 4000) {
    console.warn('WARNING: fewer than 4000 entries — range table application may have a bug.');
  }
}

/** Render the final TypeScript source plus the entry count. */
function renderOutput(byCategory) {
  const lines = [];
  let count = 0;
  for (const category of CATEGORY_ORDER) {
    for (const sym of byCategory.get(category)) {
      count++;
      lines.push(
        `  { char: ${jsSingleQuoted(sym.char)}, name: ${jsSingleQuoted(sym.name)}, category: ${jsSingleQuoted(sym.category)}, codepoint: ${sym.codepoint} },`,
      );
    }
  }
  const categories = CATEGORY_ORDER.map(jsSingleQuoted).join(', ');
  const output =
    `// AUTO-GENERATED by scripts/gen-unicode-data.mjs — do not edit by hand.\n` +
    `// Source: UnicodeData.txt (Unicode Character Database). ${count} characters across ${CATEGORY_ORDER.length} categories.\n` +
    `import type { UnicodeSymbol } from './types';\n\n` +
    `export const UNICODE_SYMBOLS: UnicodeSymbol[] = [\n` +
    `${lines.join('\n')}\n` +
    `];\n\n` +
    `export const UNICODE_CATEGORIES: string[] = [${categories}];\n`;
  return [output, count];
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
