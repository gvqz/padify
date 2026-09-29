/**
 * Doctype visual-audit harness — captures padify's screenshot matrix
 * (light/dark, menus, modals, mobile) into a directory, deterministically.
 *
 * Usage: node doctype-audit.mjs <output-dir> [port]
 * The diff pass lives in diff-audit.py.
 *
 * Determinism measures (identical across passes):
 *  - fresh browser context per shot = clean storage
 *  - animations + transitions disabled, #toast hidden
 *  - fonts awaited, fixed typed content, fixed waits
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
const port = process.argv[3] ?? '5173';
/** --quirks: strip the doctype at the network level so one build serves
 *  both passes — the diff then isolates the rendering mode alone. */
const QUIRKS = process.argv.includes('--quirks');
if (!outDir) {
  console.error('usage: node doctype-audit.mjs <output-dir> [port]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const BASE = `http://localhost:${port}/`;

const STILL = `*, *::before, *::after { animation: none !important; transition: none !important; }
#toast { display: none !important; }
.caret-blink, .cursor { animation: none !important; }`;

async function newPage(browser, { width = 1280, height = 800 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  if (QUIRKS) await stripDoctype(page);
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; }
      #toast { display: none !important; }`;
    const install = () => document.head?.append(style);
    if (document.head) install();
    else document.addEventListener('DOMContentLoaded', install);
  });
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  return { context, page };
}

/** Serves the app without its doctype (quirks mode), same build. */
async function stripDoctype(page) {
  await page.route('**/*', async (route) => {
    const response = await route.fetch();
    const type = response.headers()['content-type'] ?? '';
    if (!type.includes('text/html')) {
      await route.continue();
      return;
    }
    let body = await response.text();
    body = body.replace(/^\s*<!DOCTYPE html>[^\n]*\n/i, '\n');
    await route.fulfill({ response, body });
  });
}

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log('shot', name);
}

async function newStandardNote(page) {
  await page.getByRole('button', { name: 'Add a new note' }).click();
  await page.waitForTimeout(400);
}

async function newRichNote(page) {
  await page.getByRole('button', { name: 'Choose a note type' }).click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: /Rich text note/ }).click();
  await page.waitForTimeout(500);
}

async function typeInto(page, text) {
  await page.locator('#note').focus();
  await page.evaluate((t) => {
    document.getElementById('note').focus();
    document.execCommand('insertText', false, t);
  }, text);
}

async function closeModals(page) {
  await page.evaluate(() => {
    document
      .querySelectorAll('.modal.in [data-dismiss="modal"]')
      .forEach((b) => b.dispatchEvent(new Event('click', { bubbles: true })));
  });
  await page.waitForTimeout(450);
}

const run = async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ---------------------------------------------------------------- light
  {
    const { context, page } = await newPage(browser);
    page.on('pageerror', (e) => errors.push(`light: ${e}`));

    await shot(page, '01-boot-standard');

    // typed standard note
    await newStandardNote(page);
    await typeInto(page, 'Plain notes stay plain.\nSecond line for measure.');
    await page.keyboard.press('Escape');
    await shot(page, '02-standard-typed');

    // rich note with features
    await newRichNote(page);
    await page.evaluate(() => {
      const note = document.getElementById('note');
      note.focus();
      document.execCommand('insertText', false, 'Quarterly report');
      document.execCommand('selectAll');
    });
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.locator('[data-rich-block="h1"]').click();
    await page.evaluate(() => {
      document.getElementById('note').focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('note'));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, '\nAction items below.\n');
      document.execCommand('insertUnorderedList');
    });
    await shot(page, '03-rich-toolbar');

    // styles menu open
    await page.locator('#richToolbar [data-rich-menu="block"]').click();
    await page.waitForTimeout(250);
    await shot(page, '05-styles-menu');
    await page.keyboard.press('Escape');

    // size menu open
    await page.locator('#richToolbar [data-rich-menu="size"]').click();
    await page.waitForTimeout(250);
    await shot(page, '06-size-menu');
    await page.keyboard.press('Escape');

    // color menu open
    await page.locator('#richToolbar [data-rich-menu="color"]').click();
    await page.waitForTimeout(250);
    await shot(page, '07-color-menu');
    await page.keyboard.press('Escape');

    // highlight menu open
    await page.locator('#richToolbar [data-rich-menu="highlight"]').click();
    await page.waitForTimeout(250);
    await shot(page, '08-highlight-menu');
    await page.keyboard.press('Escape');

    // link bubble
    await page.locator('#richToolbar #richLinkButton').click();
    await page.waitForTimeout(250);
    await shot(page, '09-link-bubble');
    await page.keyboard.press('Escape');

    // equation bubble with palette
    await page.locator('#richToolbar [data-rich-action="math"]').click();
    await page.waitForTimeout(400);
    await shot(page, '10-equation-bubble');
    await page.keyboard.press('Escape');

    // table grid
    await page.locator('#richToolbar [data-rich-menu="table"]').click();
    await page.waitForTimeout(250);
    await shot(page, '11-table-grid');
    await page.keyboard.press('Escape');

    // context menu on rich note
    await page.locator('#note').click({ button: 'right' });
    await page.waitForTimeout(300);
    await shot(page, '12-ctx-rich');
    await page.keyboard.press('Escape');

    // context menu on plain note (switch to boot tab)
    await page.locator('#tabStripTabs .tab-strip-tab').first().click();
    await page.waitForTimeout(350);
    await page.locator('#note').click({ button: 'right' });
    await page.waitForTimeout(300);
    await shot(page, '13-ctx-plain');
    await page.keyboard.press('Escape');

    // modals — light
    const modalTriggers = [
      ['14-modal-preferences', '[data-target="#preferencesModal"]', false],
      ['15-modal-shortcuts', '[data-target="#keyboardShortcutsModal"]', true],
      ['16-modal-statistics', '[data-target="#statisticsModal"]', false],
      ['19-modal-music', '[data-target="#musicPlayerModal"]', false],
      ['22-modal-about', '[data-target="#aboutModal"]', true],
      ['23-modal-timer', '[data-target="#timerModal"]', false],
    ];
    for (const [name, sel, inBrandMenu] of modalTriggers) {
      if (inBrandMenu) {
        await page.locator('#brandMenuButton').click();
        await page.waitForTimeout(250);
      }
      const trigger = page.locator(sel).first();
      if ((await trigger.count()) === 0) {
        console.log('MISSING trigger', sel);
        continue;
      }
      await trigger.click();
      await page.waitForTimeout(500);
      await shot(page, name);
      await closeModals(page);
    }

    // feature-owned modals (custom handlers on topbar links)
    const customModals = [
      ['17-modal-snapshots', 'View Snapshots'],
      ['18-modal-unicode', 'Insert Unicode Symbol'],
      ['20-modal-share', 'Share this note'],
      ['21-modal-cloud', 'Cloud sync'],
    ];
    for (const [name, label] of customModals) {
      const trigger = page.getByRole('link', { name: new RegExp(label) }).first();
      if ((await trigger.count()) === 0) {
        console.log('MISSING custom trigger', label);
        continue;
      }
      await trigger.click();
      await page.waitForTimeout(500);
      await shot(page, name);
      await closeModals(page);
    }

    // mobile
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await mobileContext.newPage();
    mobile.on('pageerror', (e) => errors.push(`mobile: ${e}`));
    if (QUIRKS) await stripDoctype(mobile);
    await mobile.goto(BASE);
    await mobile.waitForLoadState('networkidle');
    await mobile.waitForTimeout(700);
    await shot(mobile, '24-mobile-editor');
    // drawer
    const hamburger = mobile.locator('[data-toggle="collapse"][data-target="#navbar"], .navbar-toggle').first();
    if ((await hamburger.count()) > 0) {
      await hamburger.click();
      await mobile.waitForTimeout(350);
      await shot(mobile, '25-mobile-drawer');
    }
    await mobileContext.close();
    await context.close();
  }

  // ---------------------------------------------------------------- dark
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`dark: ${e}`));
    if (QUIRKS) await stripDoctype(page);
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; }
        #toast { display: none !important; }`;
      const install = () => document.head?.append(style);
      if (document.head) install();
      else document.addEventListener('DOMContentLoaded', install);
    });
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // flip theme through the real preferences UI (the radio is styled away
    // behind labels — a programmatic click on the input drives the same
    // change event the label click would)
    await page.locator('[data-target="#preferencesModal"]').first().click();
    await page.waitForTimeout(450);
    await page.evaluate(() => {
      document.getElementById('dark-theme')?.click();
    });
    await page.waitForTimeout(350);
    await closeModals(page);

    await shot(page, '26-dark-boot');

    await newRichNote(page);
    await page.evaluate(() => {
      const note = document.getElementById('note');
      note.focus();
      document.execCommand('insertText', false, 'Dark ink note');
    });
    await shot(page, '27-dark-rich-features');

    await page.locator('#note').click({ button: 'right' });
    await page.waitForTimeout(300);
    await shot(page, '28-dark-ctx-rich');
    await page.keyboard.press('Escape');

    await page.locator('[data-target="#preferencesModal"]').first().click();
    await page.waitForTimeout(450);
    await shot(page, '29-dark-preferences');
    await closeModals(page);

    await page.locator('#richToolbar [data-rich-action="math"]').click();
    await page.waitForTimeout(400);
    await shot(page, '30-dark-equation-bubble');

    await context.close();
  }

  await browser.close();
  if (errors.length) {
    console.log('PAGE ERRORS:\n' + errors.join('\n'));
    process.exit(2);
  }
  console.log('DONE');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
