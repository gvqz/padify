/**
 * Visual verification of note-type conversion — the full matrix, in the
 * real app against the dev server.
 *
 * For each conversion: create the source note via the rail's type menu,
 * give it representative content, convert through the note context menu's
 * Change type submenu, and screenshot BEFORE + AFTER (+ any confirm
 * dialog). Also captures the lossy arm: the confirm dialog, accepting it,
 * the toast, and the strip badge following the type.
 *
 * Output: /tmp/convert/<n>-<label>.png — review every frame by eye.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5199/';
const OUT = '/tmp/convert';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let frame = 0;

async function shot(label) {
  frame += 1;
  const path = `${OUT}/${String(frame).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path });
  console.log(`  shot ${path}`);
}

async function newNoteOfType(type) {
  await page.locator('#addTab').click();
  await page.locator('#addTabTypeMenu').click();
  await page.locator(`#addTabTypeMenuPopover [data-note-type="${type}"]`).click();
  await page.waitForTimeout(600);
}

async function convertTo(type) {
  await page.locator('.tab-strip-tab.active').click({ button: 'right' });
  await page.locator('#noteCtxMenu').waitFor({ state: 'visible' });
  await page.locator('#noteCtxMenu [data-action="type-menu"] .padify-ctx-trigger').hover();
  await page.locator(`#noteCtxMenu [data-action="set-type"][data-type="${type}"]`).click();
  await page.waitForTimeout(500);
}

async function typeIntoEditor(text) {
  await page.locator('#note').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await page.waitForTimeout(400);
}

const dialog = page.locator('dialog.vz-dialog');
const dialogVisible = () => dialog.isVisible().catch(() => false);

async function acceptDialogIfAny(label) {
  if (await dialogVisible()) {
    await shot(label);
    await page.locator('.vz-dialog-confirm').click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

// ---- 1. rich content → markdown (the HTML-soup fix) ------------------------
console.log('1. standard (formatted) → markdown');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.tab-strip-tab.active').dblclick();
await page.locator('.tab-strip-rename').fill('Trip plan');
await page.locator('.tab-strip-rename').press('Enter');
await page.waitForTimeout(300);
await typeIntoEditor('Pack lists and bold plans');
await page.keyboard.press('Home');
await page.keyboard.press('Shift+End');
await page.keyboard.press('Control+b');
await page.waitForTimeout(200);
await shot('standard-formatted-before');
await convertTo('markdown');
await acceptDialogIfAny('UNEXPECTED-CONFIRM-lossless-arm-must-not-ask');
await shot('markdown-after');
await page.reload({ waitUntil: 'networkidle' });
await shot('markdown-after-reload');

// ---- 2. markdown → standard (the literal-# fix) -----------------------------
console.log('2. markdown → standard');
await newNoteOfType('markdown');
await typeIntoEditor('# Heading here\n\nSome **bold** words\n\n- one\n- two');
await shot('markdown-source-before');
await convertTo('standard');
await shot('standard-after');
await page.reload({ waitUntil: 'networkidle' });
await shot('standard-after-reload');

// ---- 3. standard → tasks (checklist becomes real tasks) ---------------------
console.log('3. rich (checklist) → tasks');
await newNoteOfType('rich');
await typeIntoEditor('Errands below');
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.locator('#richToolbar [data-rich-list="checklist"]').click();
await page.keyboard.type('milk');
await page.keyboard.press('Enter');
await page.keyboard.type('eggs');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await shot('checklist-before');
await convertTo('tasks');
await acceptDialogIfAny('tasks-confirm');
await shot('tasks-after');
await page.reload({ waitUntil: 'networkidle' });
await shot('tasks-after-reload');

// ---- 4. prose → tasks (the lossy arm: confirm + snapshot) -------------------
console.log('4. standard (prose) → tasks (lossy confirm)');
await newNoteOfType('standard');
await typeIntoEditor('Just some prose, no checklist here.');
await shot('prose-before');
await convertTo('tasks');
await acceptDialogIfAny('prose-tasks-confirm');
await shot('prose-tasks-fresh-after');
await page.reload({ waitUntil: 'networkidle' });
await shot('prose-tasks-fresh-after-reload');

// ---- 5. tasks → markdown (list walks out as checklist text) -----------------
console.log('5. tasks → markdown');
await newNoteOfType('tasks');
await page.waitForTimeout(600);
const composer = page.locator('.tkp [data-composer-input]').first();
await composer.fill('Ship the fix');
await composer.press('Enter');
await page.waitForTimeout(700);
await shot('tasks-note-before');
await convertTo('markdown');
await shot('markdown-checklist-after');
await page.reload({ waitUntil: 'networkidle' });
await shot('markdown-checklist-after-reload');

// ---- 6. prose → drawing (lossy arm), then the strip badge follows back ------
console.log('6. standard (prose) → drawing (lossy confirm)');
await newNoteOfType('standard');
await typeIntoEditor('This will not survive as pixels.');
await convertTo('drawing');
await acceptDialogIfAny('drawing-confirm');
await page.waitForTimeout(600);
await shot('drawing-after');
await convertTo('standard');
await acceptDialogIfAny('drawing-back-confirm');
await page.waitForTimeout(400);
await shot('back-to-standard-badge-check');

await browser.close();
console.log('DONE');
