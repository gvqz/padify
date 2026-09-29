import { expect, test } from '@playwright/test';

/**
 * Superscript/subscript toggling. Chrome's execCommand path cannot turn a
 * live <sup>/<sub> off (re-running the command no-ops and the next typed
 * char lands in a NEW nested element), and queryCommandState answers false
 * inside one. The port therefore toggles by hand — these scenarios pin the
 * behaviors a user can feel: turn off, stop typing scripted, nested repair,
 * pressed states, and the Ctrl+. shortcut.
 */

/** User-visible text with the port's zero-width caret guards stripped. */
function visibleText(value: string | null): string {
  return (value ?? '').replace(/\u200B/g, '');
}

async function newRichNote(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#addTabTypeMenu').click();
  await page
    .locator('#addTabTypeMenuPopover .tab-type-menu-item', { hasText: 'Rich text note' })
    .click();
  await expect
    .poll(async () => page.locator('#richToolbar').isHidden())
    .toBe(false);
  await page.locator('#note').focus();
}

test.describe('scripts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('a selected run toggles superscript off again and typing stays plain', async ({
    page,
  }) => {
    await newRichNote(page);
    const note = page.locator('#note');
    await note.pressSequentially('hello world');
    // Select "world"
    await page.evaluate(() => {
      const note = document.getElementById('note')!;
      const text = note.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, 6);
      range.setEnd(text, 11);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const supButton = page.locator('#richToolbar [data-rich-action="sup"]');
    await supButton.click();
    await expect(note.locator('sup')).toHaveText('world');
    // The port re-selects the scripted run — the button reads pressed.
    await expect(supButton).toHaveAttribute('aria-pressed', 'true');
    // Second press must UNWRAP — the engine would silently nest instead.
    await supButton.click();
    await expect(note.locator('sup')).toHaveCount(0);
    await expect(note).toHaveText('hello world');
    // Typing at the caret continues plain — no new <sup> around it.
    await page.keyboard.press('End');
    await note.pressSequentially(' ok');
    await expect(note.locator('sup')).toHaveCount(0);
    await expect(note).toHaveText('hello world ok');
  });

  test('a collapsed caret inside superscript leaves it with one press', async ({
    page,
  }) => {
    await newRichNote(page);
    const note = page.locator('#note');
    await note.pressSequentially('ab');
    await page.keyboard.press('Control+Period'); // Ctrl+. arms superscript
    await note.pressSequentially('XY');
    await expect(note.locator('sup')).toHaveText('XY');
    const supButton = page.locator('#richToolbar [data-rich-action="sup"]');
    // The caret sits inside the live sup — the pressed state must say so.
    await expect(supButton).toHaveAttribute('aria-pressed', 'true');
    await supButton.click();
    // The caret splits out of the script; typing continues plain.
    await note.pressSequentially('Z');
    await expect(note.locator('sup')).toHaveText('XY');
    await expect
      .poll(async () => visibleText(await note.textContent()))
      .toBe('abXYZ');
  });

  test('the engine-nested superscript chain is repaired by toggling off', async ({
    page,
  }) => {
    await newRichNote(page);
    const note = page.locator('#note');
    // Seed the compounding damage the old engine path produced:
    // ab<sup>X<sup>Y</sup></sup>cd with the caret mid-chain.
    await page.evaluate(() => {
      const note = document.getElementById('note')!;
      note.innerHTML = 'ab<sup>X<sup>Y</sup>u</sup>cd';
      const outer = note.querySelector('sup')!;
      const inner = outer.querySelector('sup')!;
      const range = document.createRange();
      range.setStart(inner.firstChild as Text, 1);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const supButton = page.locator('#richToolbar [data-rich-action="sup"]');
    await supButton.click();
    await note.pressSequentially('Z');
    // The caret escaped every nested layer — the typed char is plain. The
    // already-scripted runs keep their ink; only the caret's position was
    // at stake here.
    await expect(note.locator('sup')).toHaveCount(2);
    // The seed caret sat between "Y" and "u" — the typed char lands exactly
    // there, plain (Docs types at the caret, scripted runs keep their ink).
    await expect
      .poll(async () => visibleText(await note.textContent()))
      .toBe('abXYZucd');
    const zInsideScript = await page.evaluate(() => {
      const note = document.getElementById('note')!;
      return [...note.querySelectorAll('sup, sub')].some((el) =>
        (el.textContent ?? '').includes('Z'),
      );
    });
    expect(zInsideScript).toBe(false);
  });

  test('subscript round-trips and sup→sub switches like Docs', async ({ page }) => {
    await newRichNote(page);
    const note = page.locator('#note');
    await note.pressSequentially('H2O and CO2');
    // Select both formulas' "2"s and subscript them.
    const subButton = page.locator('#richToolbar [data-rich-action="sub"]');
    await page.evaluate(() => {
      const note = document.getElementById('note')!;
      const text = note.firstChild as Text;
      const selection = window.getSelection()!;
      const first = document.createRange();
      first.setStart(text, 1);
      first.setEnd(text, 2);
      selection.removeAllRanges();
      selection.addRange(first);
    });
    await subButton.click();
    await expect(note.locator('sub').first()).toHaveText('2');
    await expect(subButton).toHaveAttribute('aria-pressed', 'true');
    // Toggle the first one off again.
    await subButton.click();
    await expect(note.locator('sub')).toHaveCount(0);
    await expect(note).toHaveText('H2O and CO2');
  });
});
