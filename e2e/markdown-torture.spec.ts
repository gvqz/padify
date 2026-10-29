/**
 * Markdown — the torture act, end-to-end: the hostile corpus goes through
 * the REAL editor (source pane → debounced preview) in a real Chromium,
 * and the security model holds at the DOM level — no dialogs fire, no
 * live foreign markup appears, no unsafe href survives, and the rendered
 * checkboxes still round-trip through the source. The torture document's
 * render is screenshotted for the eyeball pass.
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

async function bootSource(page: Page, source: string): Promise<void> {
  await page.goto('/');
  await newMarkdownNote(page);
  await page.locator('[data-md-view="source"]').click();
  const textarea = page.locator('#note .markdown-source');
  await textarea.click();
  await textarea.fill(source);
  await page.waitForTimeout(400);
}

/** The hostile corpus — every classic smuggle, one per line. */
const HOSTILE_LINES = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="jav&#x09;ascript:alert(1)">click</a>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '[x](javascript:alert(1))',
  '[x](JAVASCRIPT:alert(1))',
  '[x](java&Tab;script:alert(1))',
  '[x](jav&#x61;script:alert(1))',
  '[x](jAvAsCrIpT&colon;alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](vbscript:msgbox)',
  '[x](file:///etc/passwd)',
  '![x](javascript:alert(1))',
  '![y](data:image/svg+xml,<svg onload=alert(1)>)',
  '<javascript:alert(1)>',
  '[x](https://e.co"onmouseover="alert(1))',
  '[x](u "onmouseover=alert(1)")',
  '[" onmouseover="x](u)',
  '```"><img src=x onerror=alert(1)>\ncode\n```',
  '[^"><img src=x onerror=alert(1)>]\n\n[^"><img src=x onerror=alert(1)>]: body',
  '$"><img src=x onerror=alert(1)>$',
  'a <b c=d> b <script x> y',
  '<!ELEMENT br E&amp;MPTY>',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<?php echo "<script>alert(1)</script>" ?>',
  '&amp;#106;avascript:alert(1)',
  '&#0000106avascript:alert(1)',
  '[x][ref]\n\n[ref]: javascript:alert(1)',
];

const TORTURE_DOC = [
  '# Torture Suite',
  '',
  'Entities &amp; entities &copy; &#169; &#x2713; and AT&T — 5 < 6 > 4 "quoted".',
  '',
  '**bold** *italic* ***both*** ~~struck~~ ~one~ `code | pipe` and \\*escaped\\*.',
  '',
  'Autolinks: https://e.co/x?a=1&b=2, www.example.com, <https://e.co/angle> and mail@e.co.',
  '',
  '```js',
  'const x = "</script>"; // hostile info string below',
  '```',
  '',
  '    indented code &amp; stays literal',
  '',
  '> A quote with **bold**',
  '> > and a nested one',
  '',
  '- [ ] open task',
  '- [x] done task',
  '  - nested plain',
  '    - [ ] deep task',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '| left | center | right |',
  '| :--- | :---: | ---: |',
  '| a \\| b | `c\\|d` | **e** |',
  '| 1 | 2 | 3 |',
  '',
  'Footnotes[^1] and refs[^long-label] — duplicated[^1] again.',
  '',
  '[^1]: the first note',
  '[^long-label]: with **markup** and',
  '    a continuation line',
  '',
  '[ref-link][ref] and [collapsed][] and [ref].',
  '',
  '[ref]: https://e.co/ref "the title"',
  '[collapsed]: /local/path',
  '',
  '$E = mc^2$ inline and a display block:',
  '',
  '$$',
  '\\frac{1}{2}',
  '$$',
  '',
  'a *b **c** d* e and ***deep*** emphasis.',
  '',
  '---',
  '',
  'The end. ñ 中文 😀 नमस्ते',
].join('\n');

test.describe('markdown torture — the hostile corpus in a real browser', () => {
  let dialogFired: string | null = null;

  test.beforeEach(async ({ page }) => {
    dialogFired = null;
    page.on('dialog', (dialog) => {
      dialogFired = dialog.message();
      void dialog.dismiss();
    });
  });

  test('no hostile line ever executes or injects live markup', async ({ page }) => {
    await bootSource(page, HOSTILE_LINES.join('\n\n'));
    await page.locator('[data-md-view="preview"]').click();

    const preview = page.locator('#note .markdown-preview');
    await expect(preview).toBeVisible();

    // Every anchor's href passes the safe gate — checked in the page itself.
    const badHrefs = await preview.evaluate((el) => {
      const bad: string[] = [];
      for (const a of Array.from(el.querySelectorAll('a[href]'))) {
        const href = (a.getAttribute('href') ?? '').trim();
        const colon = href.indexOf(':');
        const slash = href.indexOf('/');
        const schemeLess = colon === -1 || (slash !== -1 && slash < colon);
        if (!schemeLess && !/^(https?:|mailto:|#|\/)/i.test(href)) {
          bad.push(href);
        }
      }
      return bad;
    });
    expect(badHrefs).toEqual([]);

    // No foreign elements, no inline handlers, no script/iframe/svg. The
    // math pipeline's KaTeX output (its own MathML accessibility tree)
    // is the app's own rendering, not note markup — anything inside a
    // .katex subtree is exempt. Markdown images render as real <img>
    // (the safe-href gate + stripped handlers — the owned vocabulary's
    // newest member); the hostile-URL ones stay literal text.
    const foreign = await preview.evaluate((el) => {
      const owned = new Set([
        'p',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
        'pre',
        'code',
        'blockquote',
        'ul',
        'ol',
        'li',
        'input',
        'table',
        'thead',
        'tbody',
        'tr',
        'td',
        'th',
        'a',
        'b',
        'i',
        's',
        'br',
        'sup',
        'section',
        'span',
        'div',
        'img',
      ]);
      const issues: string[] = [];
      for (const node of Array.from(el.querySelectorAll('*'))) {
        if (node.closest('.katex')) {
          continue;
        }
        const name = node.tagName.toLowerCase();
        if (!owned.has(name)) {
          issues.push(`tag ${name}`);
        }
        for (const attr of Array.from(node.attributes)) {
          if (/^on/i.test(attr.name)) {
            issues.push(`${name}@${attr.name}`);
          }
        }
      }
      return issues;
    });
    expect(foreign).toEqual([]);
    expect(dialogFired).toBeNull();
  });

  test('the torture document renders whole and survives the round trips', async ({ page }) => {
    await bootSource(page, TORTURE_DOC);
    await page.locator('[data-md-view="preview"]').click();

    const preview = page.locator('#note .markdown-preview');
    // The structure survived: a table with its alignment, footnotes, tasks.
    await expect(
      preview.locator('table tbody tr:last-child td[style*="text-align:right"]'),
    ).toHaveText('3');
    await expect(preview.locator('section.md-footnotes li')).toHaveCount(2);
    await expect(preview.locator('input[type="checkbox"]')).toHaveCount(3);
    // Entities decoded in text, hostile fence content escaped.
    await expect(preview).toContainText('Entities & entities © © ✓ and AT&T');
    await expect(preview.locator('pre code.language-js')).toContainText('</script>');

    // The clicking round trip: the deep nested task flips the source.
    const textarea = page.locator('#note .markdown-source');
    const deepTask = preview.locator('li', { hasText: 'deep task' }).last();
    await deepTask.click();
    await expect(textarea).toHaveValue(/[-*] \[x\] deep task/);
    await deepTask.click();
    await expect(textarea).toHaveValue(/[-*] \[ \] deep task/);

    // The truth holds after a source round trip.
    await page.locator('[data-md-view="source"]').click();
    await page.locator('[data-md-view="preview"]').click();
    await expect(preview.locator('table')).toHaveCount(1);
    expect(dialogFired).toBeNull();
  });

  test('the torture document renders in dark mode without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await newMarkdownNote(page);
    await page.locator('[data-md-view="source"]').click();
    const textarea = page.locator('#note .markdown-source');
    await textarea.click();
    await textarea.fill(TORTURE_DOC);
    await page.waitForTimeout(400);
    await page.locator('[data-md-view="preview"]').click();

    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('table')).toHaveCount(1);
    await expect(preview.locator('section.md-footnotes')).toBeVisible();

    await page.screenshot({ path: 'shots/torture-dark.png', fullPage: false });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'shots/torture-light.png', fullPage: false });

    expect(errors).toEqual([]);
  });
});
