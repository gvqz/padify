/**
 * Markdown note type — the feature act, end-to-end: live equations, task
 * lists, table operations, the slash menu, clear formatting, Tab list
 * nesting, markdown-aware paste, the context menu's markdown rows, and
 * the .md export row. (Creation/autosave/preview live in markdown.spec.ts.)
 */
import { expect, test, type Page } from '@playwright/test';

async function newMarkdownNote(page: Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Markdown note' })
    .click();
  await expect(page.locator('#markdownToolbar')).toBeVisible();
}

test.describe('markdown notes — the feature act', () => {
  test('typing $…$ renders a live equation; the bubble inserts block math', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('the area of a circle is $\\pi r^2$ exactly');
    // The input rule converted the closing dollar: live KaTeX inline.
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);

    // The block equation, through the bubble (the toolbar button defaults
    // to inline — the segmented control picks the placement).
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.locator('#markdownToolbar [data-md-action="math"]').click();
    const bubble = page.locator('#markdownMathPopover');
    await expect(bubble).toBeVisible();
    await page.locator('[data-md-math-kind="block"]').click();
    await page.locator('#markdownMathInput').fill('\\frac{1}{2}');
    await page.locator('#markdownMathInsert').click();
    await expect(editor.locator('.md-math-block .katex')).toHaveCount(1);

    // The preview shows the same equations through the owned renderer.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.katex')).toHaveCount(2);
  });

  test('the equation bubble edits a clicked equation in place', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('energy $E=mc^2$');
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);

    // Click the rendered equation: the bubble opens in edit mode.
    await editor.locator('.md-math-inline').click();
    const bubble = page.locator('#markdownMathPopover');
    await expect(bubble).toBeVisible();
    await expect(page.locator('#markdownMathInsert')).toHaveText('Apply');
    await expect(page.locator('#markdownMathInput')).toHaveValue('E=mc^2');

    await page.locator('#markdownMathInput').fill('E=mc^{3}');
    await page.locator('#markdownMathInsert').click();
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(1);
    // The source reflects the edit (autosave debounce).
    await page.waitForTimeout(700);
  });

  test('footnotes: reference + definition survive every mode, and the preview renders them', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    // Set the document in one shot through the source pane.
    await page.locator('#markdownToolbar [data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await expect(source).toBeVisible();
    await source.fill(
      'A note with a footnote[^1] inside.\n\n[^1]: The definition, **bold** included.',
    );
    await page.waitForTimeout(600);

    // The WYSIWYG parses both into their GFM nodes.
    await page.locator('#markdownToolbar [data-md-view="edit"]').click();
    const editor = page.locator('#note .ProseMirror');
    await expect(editor.locator('sup[data-type="footnote_reference"]')).toHaveCount(1);
    await expect(editor.locator('dl[data-type="footnote_definition"]')).toHaveCount(1);

    // The preview renders the owned renderer's face: a superscript link
    // into a definitions section.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.md-footnote-ref')).toHaveCount(1);
    await expect(preview.locator('.md-footnote-ref a')).toHaveAttribute('href', '#md-fn-1');
    await expect(preview.locator('section.md-footnotes')).toHaveCount(1);
    await expect(preview.locator('.md-footnote-item')).toHaveCount(1);
    // The definition's markup resolves through the inline pass.
    await expect(preview.locator('.md-footnote-item b')).toHaveText('bold');

    // Back in source: both halves are still markdown.
    await page.locator('#markdownToolbar [data-md-view="source"]').click();
    const roundTrip = await source.inputValue();
    expect(roundTrip).toContain('[^1]');
    expect(roundTrip).toContain('[^1]:');
  });

  test('a single-line $$…$$ paragraph is display math in every mode (no silent inline downgrade)', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('#markdownToolbar [data-md-view="source"]').click();
    const source = page.locator('#note .markdown-source');
    await expect(source).toBeVisible();
    await source.fill('Intro text.\n\n$$\\frac{1}{2}$$\n\nOutro text.');
    await page.waitForTimeout(600);

    // The WYSIWYG's display-math bridge: the compact single-line form is a
    // BLOCK node, not inline math in a paragraph.
    await page.locator('#markdownToolbar [data-md-view="edit"]').click();
    const editor = page.locator('#note .ProseMirror');
    await expect(editor.locator('.md-math-block .katex')).toHaveCount(1);
    await expect(editor.locator('.md-math-inline')).toHaveCount(0);

    // The preview agrees — the owned renderer's display wrapper.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('.md-math-block .padify-math')).toHaveCount(1);

    // And the round-trip keeps the compact form the user typed.
    await page.locator('#markdownToolbar [data-md-view="source"]').click();
    const roundTrip = await source.inputValue();
    expect(roundTrip).toContain('$$\\frac{1}{2}$$');
  });

  test('task lists: the button arms checkboxes and clicks toggle them', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('ship the feature');
    await page.locator('#markdownToolbar [data-md-action="task"]').click();

    const item = editor.locator('li[data-item-type="task"]');
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-checked', 'false');
    await expect(page.locator('#markdownToolbar [data-md-action="task"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Click the checkbox (the marker zone at the item's left edge).
    await item.click({ position: { x: 6, y: 10 } });
    await expect(item).toHaveAttribute('data-checked', 'true');

    // The preview shows a checked, disabled checkbox — the same truth.
    await page.locator('#markdownToolbar [data-md-view="preview"]').click();
    await expect(page.locator('#note .markdown-preview input[type="checkbox"]')).toHaveCount(1);
  });

  test('table operations from the in-table menu', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.locator('#markdownToolbar [data-md-action="table"]').click();
    await expect(editor.locator('table')).toHaveCount(1);

    // The caret sits inside the fresh table: the ops menu appears.
    const opsButton = page.locator('[data-md-menu="table"]');
    await expect(opsButton).toBeVisible();
    await opsButton.click();
    await page.locator('[data-md-table="row-below"]').click();
    await expect(editor.locator('tr')).toHaveCount(3);

    await opsButton.click();
    await page.locator('[data-md-table="col-right"]').click();
    await expect(editor.locator('tr').first().locator('th, td')).toHaveCount(4);

    await opsButton.click();
    await page.locator('[data-md-table="table-delete"]').click();
    await expect(editor.locator('table')).toHaveCount(0);
  });

  test('the slash menu: / filters and Enter inserts the block', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('/');
    const panel = page.locator('.markdown-slash');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.markdown-slash-item')).toHaveCount(11);

    await page.keyboard.type('quo');
    await expect(panel.locator('.markdown-slash-item')).toHaveCount(1);

    await page.keyboard.press('Enter');
    await expect(panel).toBeHidden();
    await expect(editor.locator('blockquote')).toHaveCount(1);
    // The "/quo" query was consumed by the insert.
    await expect(editor).not.toContainText('/quo');
  });

  test('clear formatting strips the marks from the selection', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('very ');
    await page.keyboard.press('Control+B');
    await page.keyboard.type('bold');
    await page.keyboard.press('Control+B');
    await page.keyboard.type(' words');
    await expect(editor.locator('strong')).toHaveText('bold');

    await page.keyboard.press('Control+A');
    await page.locator('#markdownToolbar [data-md-action="clear"]').click();
    await expect(editor.locator('strong')).toHaveCount(0);
    await expect(editor).toContainText('very bold words');
  });

  test('Tab nests list items; Shift-Tab lifts them', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('- outer');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- inner');
    await page.keyboard.press('Tab');
    await expect(editor.locator('ul ul li')).toHaveCount(1);

    await page.keyboard.press('Shift+Tab');
    await expect(editor.locator('ul ul')).toHaveCount(0);
    await expect(editor.locator('ul > li')).toHaveCount(2);
  });

  test('pasting PLAIN text keeps it literal (markdown syntax never mangles it)', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const markdown = '![logo](https://example.com/logo.png)\n\nand $\\sqrt{2}$ too';
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, markdown);
    await page.keyboard.press('Control+V');

    // A plain-text clip is CONTENT: the syntax rides in as typed — the
    // image syntax is text (never a chip, never an <img>), the math
    // syntax is text (never a live equation). Pasting code or prose from
    // a plain-text source must not restructure it.
    await expect(editor.locator('.md-image-chip')).toHaveCount(0);
    await expect(editor.locator('img[src]')).toHaveCount(0);
    await expect(editor.locator('.md-math-inline .katex')).toHaveCount(0);
    await expect(editor).toContainText('![logo](https://example.com/logo.png)');
    await expect(editor).toContainText('and $\\sqrt{2}$ too');
  });

  test('pasting a RICH (text/html) markdown copy still renders it', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    // The copy a rendered markdown source writes (Obsidian reading view,
    // GitHub, preview panes): text/html with the real elements.
    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob(['<img src="https://example.com/logo.png"><p>and a logo</p>'], {
            type: 'text/html',
          }),
        }),
      ]);
    });
    await page.keyboard.press('Control+V');

    // The rich path parses: the image is a chip (never an <img>).
    await expect(editor.locator('.md-image-chip')).toHaveCount(1);
    await expect(editor.locator('img[src]')).toHaveCount(0);
    await expect(editor).toContainText('and a logo');
  });

  test('pasting code from an editor clip becomes a code block with the language', async ({
    page,
  }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    // A VS Code clip carries text/plain + the private vscode-editor-data
    // flavor. Chromium never populated a constructed ClipboardEvent's
    // clipboardData from the init dict, so the transfer is attached as an
    // own property — the only shim, the dispatch itself is the real one.
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'const x = 1;\nconst y = 2;');
      transfer.setData('vscode-editor-data', JSON.stringify({ mode: 'typescript' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      document.querySelector('#note .ProseMirror')?.dispatchEvent(event);
    });

    // The node view wraps the block: div.md-code-block[data-language] >
    // (language row + pre>code).
    const code = editor.locator('.md-code-block[data-language="typescript"] pre');
    await expect(code).toHaveCount(1);
    await expect(code).toContainText('const x = 1;');
    await expect(code).toContainText('const y = 2;');
    // The code never leaks into a paragraph.
    expect(await editor.locator('p').allTextContents()).not.toContain('const x = 1;');
  });

  test('the context menu speaks markdown', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('menu words');
    await page.keyboard.press('Control+A');

    await editor.click({ button: 'right' });
    const menu = page.locator('#padifyCtxMenu');
    await expect(menu).toBeVisible();
    // Markdown rows in, rich rows out.
    await expect(menu.locator('.padify-ctx-md .padify-ctx-fmt[data-format="bold"]')).toBeVisible();
    await expect(menu.locator('.padify-ctx-formats.padify-ctx-rich')).toBeHidden();

    await menu.locator('.padify-ctx-md .padify-ctx-fmt[data-format="bold"]').click();
    await expect(editor.locator('strong')).toHaveText('menu words');
  });

  test('the download menu offers the .md export only for markdown notes', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesMarkdown')).toBeVisible();

    // A plain note: the row stands down.
    await page.locator('#addTab').click();
    await page.locator('#downloadNotes').click();
    await expect(page.locator('#downloadNotesMarkdown')).toBeHidden();
  });
});

test.describe('markdown notes — the Crepe playground parity act', () => {
  test('the split view: the top bar icon and the segmented control agree', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Split me\n\nSome **bold**.');

    // The top bar icon is a Markdown-only toggle.
    const splitIcon = page.locator('#splitViewButton');
    await expect(splitIcon).toBeVisible();
    await splitIcon.click();

    const surface = page.locator('#note .markdown-surface');
    const preview = page.locator('#note .markdown-preview');
    const source = page.locator('#note .markdown-source');
    await expect(surface).toHaveClass(/markdown-split-mode/);
    // The split edits the SOURCE: the textarea owns the left half, the
    // owned renderer's output the right.
    await expect(source).toBeVisible();
    await expect(source).toHaveValue(/# Split me/);
    await expect(preview).toBeVisible();
    await expect(preview.locator('h1')).toHaveText('Split me');
    await expect(preview.locator('b')).toHaveText('bold');
    // The chrome agrees: the icon reads pressed, the segmented control too.
    await expect(splitIcon).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-md-view="split"]')).toHaveAttribute('aria-pressed', 'true');

    // The icon toggles back off; the segmented control follows the same truth.
    await splitIcon.click();
    await expect(surface).not.toHaveClass(/markdown-split-mode/);
    await expect(preview).toBeHidden();
    await expect(splitIcon).toHaveAttribute('aria-pressed', 'false');
  });

  test('the split preview follows the typing, a beat behind', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('# Draft');
    await page.locator('[data-md-view="split"]').click();

    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('h1')).toHaveText('Draft');

    // The split's editing pane is the SOURCE textarea — click ON the
    // heading's line (a bare click parks the caret past the trailing
    // newline), caret to the line's end, then type.
    const source = page.locator('#note .markdown-source');
    await source.click({ position: { x: 100, y: 30 } });
    await page.keyboard.press('End');
    await page.keyboard.type(' updated');
    // The debounce chain (listener 200ms + pane 250ms) settles.
    await expect(preview.locator('h1')).toHaveText('Draft updated', { timeout: 3000 });
  });

  test('the split icon stands down for plain notes', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);
    await expect(page.locator('#splitViewContainer')).toBeVisible();

    // A plain note: the icon hides with the markdown chrome.
    await page.locator('#addTab').click();
    await expect(page.locator('#splitViewContainer')).toBeHidden();
  });

  test('selecting text floats the selection bubble; Bold applies from it', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('select these words');

    // Double-click ON the text (the line's start, over "these"): a real
    // word selection floats the bubble above it.
    await editor
      .locator('p')
      .first()
      .dblclick({ position: { x: 60, y: 12 } });
    const bubble = page.locator('.markdown-bubble');
    await expect(bubble).toBeVisible();
    await expect(bubble.locator('[data-bubble-id="bold"]')).toBeVisible();
    await expect(bubble.locator('[data-bubble-id="equation"]')).toBeVisible();

    await bubble.locator('[data-bubble-id="bold"]').click();
    await expect(editor.locator('strong')).toHaveText('these');

    // Collapse the selection — a click past the line's text (clicking
    // INSIDE the kept selection would start a drag, not a collapse):
    // the bubble stands down.
    await editor
      .locator('p')
      .first()
      .click({ position: { x: 300, y: 12 } });
    await expect(bubble).toBeHidden();
  });

  test('the block handle: hover shows the grip, mousedown selects the block', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('first block to drag');

    // Move the mouse over the text: the grip appears in the gutter.
    const paragraph = editor.locator('p').first();
    await paragraph.hover();
    const handle = page.locator('.md-block-handle');
    await expect(handle).toHaveAttribute('data-show', 'true');
    // The grip is armed for the drag the kit's BlockService drives.
    await expect(handle).toHaveAttribute('draggable', 'true');

    // Mousedown node-selects the block it would carry.
    await handle.click({ trial: true });
    const selected = editor.locator('.ProseMirror-selectednode');
    await handle.dispatchEvent('mousedown');
    await expect(selected).toHaveText('first block to drag');
    await handle.dispatchEvent('mouseup');
  });

  test('the code block carries its language: chip in, fence out', async ({ page }) => {
    await page.goto('/');
    await newMarkdownNote(page);

    const editor = page.locator('#note .ProseMirror');
    await editor.click();
    await page.keyboard.type('```python');
    await page.keyboard.press('Enter');
    await page.keyboard.type('print("hi")');

    // The fence rendered: the language chip names the block.
    const chip = editor.locator('.md-code-lang-chip');
    await expect(chip).toHaveText('python');

    // Click the chip, retype the language, Enter commits.
    await chip.click();
    const input = editor.locator('.md-code-lang-input');
    await expect(input).toBeVisible();
    await input.fill('typescript');
    await input.press('Enter');
    await expect(chip).toHaveText('typescript');

    // The fence round-trips: the preview's code block carries the class.
    await page.locator('[data-md-view="preview"]').click();
    const preview = page.locator('#note .markdown-preview');
    await expect(preview.locator('pre code')).toHaveClass(/language-typescript/);
  });
});
