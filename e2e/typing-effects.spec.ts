import { expect, test, type Page } from '@playwright/test';

/**
 * Typing effects — the "exploding keys" burst at the caret.
 *
 * Two regression classes live here, both seen in the wild:
 *
 *  1. THE BURST MUST LAND AT THE CARET. The markdown surface edits through
 *     a <textarea>, and a textarea's caret is invisible to the document
 *     Selection — the old code read window.getSelection() and bursts fired
 *     at whatever stale selection the last click had left (hundreds of
 *     pixels away, e.g. inside the tab rail). The caret position here is
 *     computed INDEPENDENTLY of the app (a mirror-div measurement in the
 *     spec) so the assertion can't tautologically pass.
 *
 *  2. THE BURST MUST NOT HOLD THE TEXT HOSTAGE. The layer is an overlay;
 *     it drains (every particle removes itself on animationend) and it
 *     stays off entirely when the effect is disabled or the OS asks for
 *     reduced motion.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

/** Preset the typing-effect preferences before the app boots. */
async function presetEffects(page: Page, style: string, enabled = 'Yes'): Promise<void> {
  await page.addInitScript(
    ([on, s]) => {
      localStorage.setItem('userChosenExplodingEffect', on ?? 'Yes');
      localStorage.setItem('userChosenExplodingEffectStyle', s ?? 'classic');
    },
    [enabled, style],
  );
}

/** Live particles' SPAWN positions (the inline left/top the app set). */
function particleSpawns(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#keyburstLayer > *')).map((el) => {
      const box = el as HTMLElement;
      return {
        x: parseFloat(box.style.left),
        y: parseFloat(box.style.top),
      };
    }),
  );
}

/**
 * Mirror-div caret measurement for the markdown textarea — computed here
 * with its own implementation so the app's math is verified, not echoed.
 */
function textareaCaretBox(page: Page) {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.markdown-source');
    if (!ta) return null;
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const p of [
      'boxSizing',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'letterSpacing',
      'wordSpacing',
      'textIndent',
      'textTransform',
      'lineHeight',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
    ] as const) {
      div.style[p] = cs[p];
    }
    div.style.position = 'absolute';
    div.style.left = '-9999px';
    div.style.top = '0';
    div.style.whiteSpace = 'pre-wrap';
    div.style.width = `${ta.clientWidth}px`;
    div.textContent = ta.value.slice(0, ta.selectionStart);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    div.appendChild(mark);
    document.body.appendChild(div);
    // Measure while attached — a removed element's rect is all zeros.
    const divRect = div.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    div.remove();
    const tr = ta.getBoundingClientRect();
    return {
      x: tr.left + parseFloat(cs.borderLeftWidth) + (markRect.left - divRect.left) - ta.scrollLeft,
      y: tr.top + parseFloat(cs.borderTopWidth) + (markRect.top - divRect.top) - ta.scrollTop,
    };
  });
}

async function burstNearCaret(
  page: Page,
  editor: ReturnType<Page['locator']>,
  caret: { x: number; y: number } | null,
): Promise<void> {
  expect(caret, 'caret measurable').not.toBeNull();
  // Only the FRESH burst is under test: older bursts from the previous
  // keystrokes legitimately spawn at their own (earlier) caret positions
  // and can still be mid-animation when this keystroke lands.
  await page.evaluate(() => {
    document
      .querySelectorAll('#keyburstLayer > *')
      .forEach((el) => el.setAttribute('data-fx-old', '1'));
  });
  await editor.pressSequentially('Q', { delay: 30 });
  await page.waitForTimeout(60);
  const spawns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#keyburstLayer > *'))
      .filter((el) => !el.hasAttribute('data-fx-old'))
      .map((el) => ({
        x: parseFloat((el as HTMLElement).style.left),
        y: parseFloat((el as HTMLElement).style.top),
      })),
  );
  expect(spawns.length, 'burst particles spawned').toBeGreaterThan(0);
  for (const s of spawns) {
    // Every fresh particle must be born within a line's reach of the
    // caret — the old bug placed them hundreds of pixels away.
    const dx = Math.abs(s.x - caret!.x);
    const dy = Math.abs(s.y - caret!.y);
    expect(dx, `particle spawns within 60px of caret x (dx=${dx})`).toBeLessThan(60);
    expect(dy, `particle spawns within 80px of caret y (dy=${dy})`).toBeLessThan(80);
  }
}

test.describe('typing effects', () => {
  test('markdown note: the burst fires at the textarea caret', async ({ page }) => {
    await presetEffects(page, 'classic');
    await page.goto('/');

    await page.locator('#addTabTypeMenu').click();
    await page.locator('[data-note-type="markdown"]').click();
    const editor = page.locator('textarea.markdown-source');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Sphinx of black quartz judge my vow', { delay: 40 });

    await burstNearCaret(page, editor, await textareaCaretBox(page));
  });

  test('standard note: the burst fires at the contenteditable caret', async ({ page }) => {
    await presetEffects(page, 'classic');
    await page.goto('/');

    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type('Sphinx of black quartz', { delay: 40 });

    const caret = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      return Number.isNaN(r.top) ? null : { x: r.left, y: r.top };
    });
    await burstNearCaret(page, editor, caret);
  });

  test('the layer drains — no particles outlive their animation', async ({ page }) => {
    await presetEffects(page, 'confetti');
    await page.goto('/');

    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('drain check 123', { delay: 60 });

    // Confetti is the longest burst (900ms); after it plus the 2s failsafe
    // the layer must be empty — stuck particles would snowball while
    // typing.
    await page.waitForTimeout(2_400);
    const spawns = await particleSpawns(page);
    expect(spawns.length, 'layer fully drained').toBe(0);
  });

  test('the effect can be turned off — no particles at all', async ({ page }) => {
    await presetEffects(page, 'classic', 'No');
    await page.goto('/');

    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('quiet typing 123', { delay: 40 });
    await page.waitForTimeout(150);

    const spawns = await particleSpawns(page);
    expect(spawns.length, 'no burst while disabled').toBe(0);
  });

  test('prefers-reduced-motion keeps the editor calm', async ({ page }) => {
    await presetEffects(page, 'fireworks');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    await page.locator('#addTab').click();
    const editor = page.locator('#note');
    await editor.click();
    await page.keyboard.type('calm typing 123', { delay: 40 });
    await page.waitForTimeout(150);

    const hidden = await page.evaluate(() => {
      const layer = document.getElementById('keyburstLayer');
      return layer ? getComputedStyle(layer).display === 'none' : true;
    });
    expect(hidden, 'keyburst layer hidden under reduced motion').toBe(true);
    const spawns = await particleSpawns(page);
    expect(spawns.length, 'no particles spawned under reduced motion').toBe(0);
  });
});
