import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeNoteHtml, type SanitizeOptions } from './editor/storage-subset';
import { ATTACHMENT_ID_PATTERN } from '../shared/wire';

// Behavioral twin of share-sanitizer.test.ts (the drift guard): the
// GENERATED module the browser downloads (public/share/sanitize-note.js,
// imported here natively, no transform) and the canonical TypeScript source
// must answer identically across a hostile corpus, in BOTH dialects — the
// storage default the editor round-trips and the read-only one the share
// viewer renders with. A policy change on either side that the other
// doesn't mirror fails here even when the bytes still match.

const GENERATED_PATH = resolve(process.cwd(), 'public/share/sanitize-note.js');

/** The read-only dialect the share page renders with (public/share/share.js). */
const SHARE_OPTIONS: SanitizeOptions = { hardenLinks: true, mathToText: true };

type Sanitizer = (html: string, options?: SanitizeOptions) => string;

async function loadGeneratedSanitizer(): Promise<Sanitizer> {
  // Native import of the checked-in plain-ESM file — exactly the bytes the
  // browser downloads, no transform on the way in.
  const mod = (await import(pathToFileURL(GENERATED_PATH).href)) as {
    sanitizeNoteHtml: Sanitizer;
  };
  return mod.sanitizeNoteHtml;
}

describe('generated sanitizer ≡ canonical sanitizer', () => {
  // Hostile corpus: every construct the allowlist admits, plus the ones it
  // must refuse. Both implementations see the same input in the same
  // dialect and must agree byte-for-byte.
  const corpus: string[] = [
    'plain text',
    '<b>bold</b><strong>strong</strong><i>it</i><em>em</em><u>u</u><s>s</s><strike>strike</strike><del>del</del>',
    '<div>block</div><p>para</p><h1>one</h1><h2>two</h2><h3>three</h3>',
    '<br><hr><sup>sup</sup><sub>sub</sub><pre>code</pre><blockquote>quote</blockquote>',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="data:text/html,base64,evil">click</a>',
    '<a href="https://example.com/page">ok link</a>',
    '<a href="mailto:hi@example.com">mail</a>',
    '<a href="#anchor">anchor</a>',
    '<a href="/relative">rel</a>',
    '<a href="https://example.com" onclick="alert(1)" target="_self">attrs</a>',
    '<span style="color: #ff0000">red</span>',
    '<span style="color: red; background-color: rgba(255,0,255,0.5); font-size: 14px">styled</span>',
    '<span style="color: red; position: fixed; top: 0">mixed</span>',
    '<span style="font-family: Georgia, serif">font</span>',
    '<div style="text-align: center; margin-left: 40px">block style</div>',
    '<div style="margin-left: calc(100vh)">no calc</div>',
    '<ul data-rich-checklist="true"><li data-checked="true">done</li><li data-checked="false">todo</li></ul>',
    '<ul data-rich-checklist="true"><li data-checked="maybe">junk state</li></ul>',
    '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
    '<table background="javascript:alert(1)"><tr><td bgcolor="red">x</td></tr></table>',
    '<span class="padify-math" data-latex="e^{i\\pi} + 1 = 0"></span>',
    '<span class="padify-math" data-latex="x" style="color: red">already-rendered junk</span>',
    'text with <span class="padify-math" data-latex="\\frac{1}{2}"></span> inline math',
    '<div class="padify-math" data-latex="not a span"></div>',
    // Voice-recording cards: the admitted form plus the refusals — the
    // canonical card survives both dialects byte-exact, a foreign src
    // drops whole, junk attributes never ride along. The editor's live
    // wrapper dissolves to the bare card in both dialects.
    '<audio src="padify-att:att-0123456789abcdef" data-duration="42000"></audio>',
    '<audio src="padify-att:att-0123456789abcdef"></audio>',
    '<audio src="https://evil.example/track.mp3" onerror="alert(1)"></audio>',
    '<audio src="padify-att:short" data-duration="9">fallback text</audio>',
    '<audio data-duration="42000"></audio>',
    '<figure class="padify-voice" contenteditable="false"><audio src="padify-att:att-0123456789abcdef" data-duration="42000"></audio><span class="padify-voice-btn"></span><span class="padify-voice-time">0:00 / 0:42</span></figure>',
    '<figure class="padify-voice"><audio src="https://evil.example/a.mp3"></audio><span>chrome</span></figure>',
    '<p onclick="alert(1)" style="color: blue" id="x" class="y">multi-attr</p>',
    '<form action="https://evil.example"><input value="x"></form>',
    'unicode π text',
    '<b>unclosed',
    '">',
  ];

  const dialects: Array<[string, SanitizeOptions | undefined]> = [
    ['storage default (no options)', undefined],
    ['share viewer read-only', SHARE_OPTIONS],
  ];

  for (const [dialectName, options] of dialects) {
    it(`answers identically in the ${dialectName} dialect`, async () => {
      const generated = await loadGeneratedSanitizer();

      for (const input of corpus) {
        expect(generated(input, options)).toBe(sanitizeNoteHtml(input, options));
      }
    });
  }

  it('hardens links only when asked — the stored format stays presentation-free', async () => {
    const generated = await loadGeneratedSanitizer();
    const input = '<a href="https://example.com">link</a>';

    // Storage dialect: href only.
    expect(sanitizeNoteHtml(input)).toBe('<a href="https://example.com">link</a>');
    expect(generated(input)).toBe('<a href="https://example.com">link</a>');

    // Viewer dialect: the anchor also opens in its own tab, sandboxed.
    const hardened = generated(input, SHARE_OPTIONS);
    expect(hardened).toContain('target="_blank"');
    expect(hardened).toContain('rel="noopener noreferrer nofollow"');
  });

  it('renders math shells as their LaTeX source in the viewer dialect', async () => {
    const generated = await loadGeneratedSanitizer();
    const input = 'value <span class="padify-math" data-latex="e^{i\\pi}"></span> end';

    // Storage dialect: the empty shell round-trips verbatim.
    expect(sanitizeNoteHtml(input)).toContain('class="padify-math"');
    // Viewer dialect: the equation's SOURCE is the honest read-only form —
    // the old hand-copy dropped shells entirely, so shared notes silently
    // lost their equations.
    const rendered = generated(input, SHARE_OPTIONS);
    expect(rendered).toContain('e^{i\\pi}');
    expect(rendered).not.toContain('padify-math');
  });

  it("the voice src gate speaks the wire's one attachment id shape", () => {
    // storage-subset.ts inlines the id shape (it must stay import-free for
    // the generated share sanitizer); this is the drift guard for that
    // inline copy — every id the wire admits must pass the voice gate and
    // every id it refuses must fail it, with room to spare on both sides.
    const admitted = [
      'att-0123456789abcdef01234567', // the store's exact 24-hex shape
      'att-aaaaaaaaaaaaaaaa', // the corpus's short form
      'voice-2026-abcdef', // an underscore-dashed client id
      'a2345678', // the 8-char floor
      'x'.repeat(64), // the 64-char ceiling
    ];
    for (const id of admitted) {
      expect(sanitizeNoteHtml(`<audio src="padify-att:${id}"></audio>`), `admitted: ${id}`).toBe(
        `<audio src="padify-att:${id}"></audio>`,
      );
      expect(ATTACHMENT_ID_PATTERN.test(id), `wire admits: ${id}`).toBe(true);
    }
    const refused = ['short', 'x'.repeat(65), 'has:colon', '../../evil', ''];
    for (const id of refused) {
      expect(sanitizeNoteHtml(`<audio src="padify-att:${id}"></audio>`), `refused: ${id}`).toBe('');
      expect(ATTACHMENT_ID_PATTERN.test(id), `wire refuses: ${id}`).toBe(false);
    }
  });
});
