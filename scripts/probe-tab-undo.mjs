#!/usr/bin/env node
/**
 * probe-tab-undo.mjs — live repro for the tab/undo/redo caret bugs.
 *
 * Serves dist/ on :4174 (refuses a stale server, like css-shot.mjs) and
 * drives the REAL keyboard: type → Tab → Ctrl+Z → Ctrl+Y → type, then
 * reports the surface text and the caret's stream offset after every
 * step. Fresh browser context per scenario (the PWA's storage must not
 * leak between scenarios).
 *
 * Usage: node scripts/probe-tab-undo.mjs [--shots <dir>]
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
)('@playwright/test');
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = process.argv[2] ?? null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

try {
  await fetch('http://localhost:4174/');
  console.error('REFUSED: port 4174 already answers — kill the stale server first.');
  process.exit(2);
} catch {
  /* port free */
}
const server = spawn('python3', ['-m', 'http.server', '4174', '--directory', join(repo, 'dist')], {
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();

/** The caret's stream offset (visible chars before it; \u200B excluded). */
async function caretOffset(page) {
  return page.evaluate(() => {
    const host = document.getElementById('note');
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(host);
    range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return range.toString().replace(/\u200B/g, '').length;
  });
}

/** Whether the caret is collapsed, and the selected text when not. */
async function selectionText(page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

async function newNote(page, typeId) {
  await page.locator('#addTabTypeMenu').click();
  await page.locator(`#addTabTypeMenuPopover [data-note-type="${typeId}"]`).click();
  await page.locator('#note').focus();
}

async function step(page, label) {
  const text = await page.evaluate(() =>
    (document.getElementById('note')?.textContent ?? '').replace(/\u200B/g, ''),
  );
  const caret = await caretOffset(page);
  const sel = await selectionText(page);
  console.log(
    `  ${label.padEnd(26)} caret=${String(caret).padStart(3)}  sel=${JSON.stringify(sel).slice(0, 30)}  text=${JSON.stringify(text.slice(-40))}`,
  );
}

async function scenario(name, fn) {
  console.log(`\n== ${name} ==`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:4174/');
  await page.locator('#note').waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  try {
    await fn(page);
  } catch (e) {
    console.log(`  FAILED: ${e.message.split('\n')[0]}`);
  }
  if (errors.length) console.log(`  PAGE ERRORS: ${errors.join(' | ')}`);
  await context.close();
}

// ---------------------------------------------------------------------------
// A. The reported bug: type → Tab → Ctrl+Z → Ctrl+Y → type. After the redo
//    the caret must sit AFTER the re-inserted tab (end of the line), or the
//    next keystroke splits the last word.
// ---------------------------------------------------------------------------
await scenario('A plain: type, Tab, ^Z, ^Y, type', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('hello');
  await step(page, 'after type "hello"');
  await page.keyboard.press('Tab');
  await step(page, 'after Tab');
  await page.keyboard.press('Control+z');
  await step(page, 'after Ctrl+Z');
  await page.keyboard.press('Control+y');
  await step(page, 'after Ctrl+Y (redo)');
  await page.keyboard.type('Z');
  await step(page, 'after typing "Z"');
});

// ---------------------------------------------------------------------------
// B. Tab at line start, then Ctrl+Z: the caret must return to offset 0
//    (where it was before the Tab), not drift into the word.
// ---------------------------------------------------------------------------
await scenario('B plain: Tab at line start, ^Z', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('hello');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await step(page, 'after Tab (caret 1)');
  await page.keyboard.press('Control+z');
  await step(page, 'after Ctrl+Z (want 0)');
  await page.keyboard.press('Control+y');
  await step(page, 'after Ctrl+Y (want 1)');
});

// ---------------------------------------------------------------------------
// C. Rich note: block-indent Tab (margin step), undo, redo.
// ---------------------------------------------------------------------------
await scenario('C rich: block Tab, ^Z, ^Y', async (page) => {
  await newNote(page, 'rich');
  await page.keyboard.type('first block');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second block');
  await page.keyboard.press('Tab');
  await step(page, 'after Tab (indent)');
  const indented = await page.evaluate(
    () => document.querySelectorAll('#note div[style*="margin-left"]').length,
  );
  console.log(`  margin blocks: ${indented}`);
  await page.keyboard.press('Control+z');
  await step(page, 'after Ctrl+Z (want caret at block start)');
  console.log(
    `  margin blocks after undo: ${await page.evaluate(
      () => document.querySelectorAll('#note div[style*="margin-left"]').length,
    )}`,
  );
  await page.keyboard.press('Control+y');
  await step(page, 'after Ctrl+Y (redo)');
  console.log(
    `  margin blocks after redo: ${await page.evaluate(
      () => document.querySelectorAll('#note div[style*="margin-left"]').length,
    )}`,
  );
});

// ---------------------------------------------------------------------------
// D. List nest: Tab nests the item, undo lifts it, redo nests again.
// ---------------------------------------------------------------------------
await scenario('D list: nest, ^Z, ^Y', async (page) => {
  await newNote(page, 'rich');
  await page.keyboard.type('parent');
  await page.keyboard.press('Control+Shift+7');
  await page.keyboard.press('Enter');
  await page.keyboard.type('child');
  await page.keyboard.press('Tab');
  const nested = await page.evaluate(() => document.querySelectorAll('#note li ul li').length);
  await step(page, `after Tab (nested=${nested})`);
  await page.keyboard.press('Control+z');
  const nestedAfterUndo = await page.evaluate(
    () => document.querySelectorAll('#note li ul li').length,
  );
  await step(page, `after ^Z (nested=${nestedAfterUndo})`);
  await page.keyboard.press('Control+y');
  const nestedAfterRedo = await page.evaluate(
    () => document.querySelectorAll('#note li ul li').length,
  );
  await step(page, `after ^Y (nested=${nestedAfterRedo})`);
});

// ---------------------------------------------------------------------------
// E. Multi-line selection tab (the shiftLineTabs / tabStream gesture):
//    select three lines, Tab, undo, redo — selection and carets.
// ---------------------------------------------------------------------------
await scenario('E plain: 3-line select Tab, ^Z, ^Y', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('l1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('l2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('l3');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await step(page, '3 lines selected');
  await page.keyboard.press('Tab');
  await step(page, 'after Tab (all indented)');
  await page.keyboard.press('Control+z');
  await step(page, 'after Ctrl+Z');
  await page.keyboard.press('Control+y');
  await step(page, 'after Ctrl+Y (redo)');
  await page.keyboard.press('Shift+Tab');
  await step(page, 'after Shift+Tab repeat');
});

// ---------------------------------------------------------------------------
// F. Paste at line start, undo, redo — the same caret family.
// ---------------------------------------------------------------------------
await scenario('F paste at start, ^Z, ^Y', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('hello');
  await page.keyboard.press('Home');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'PASTED ');
    document
      .getElementById('note')
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  });
  await step(page, 'after paste');
  await page.keyboard.press('Control+z');
  await step(page, 'after Ctrl+Z (want 0)');
  await page.keyboard.press('Control+y');
  await step(page, 'after Ctrl+Y (want 7)');
});

// ---------------------------------------------------------------------------
// G. Enter: undo lands the caret at the pre-Enter line end; redo at the
//    undo-time caret (end of the second line).
// ---------------------------------------------------------------------------
await scenario('G type, Enter, type, ^Z, ^Y', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await page.keyboard.type('def');
  await step(page, 'after "abc<enter>def"');
  await page.keyboard.press('Control+z');
  await step(page, 'after Ctrl+Z (want 3)');
  await page.keyboard.press('Control+y');
  await step(page, 'after Ctrl+Y (want 7)');
});

// ---------------------------------------------------------------------------
// H. Ctrl+Y with nothing to redo: a silent no-op — no caret jump, no errors.
// ---------------------------------------------------------------------------
await scenario('H fresh note Ctrl+Y no-op', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('hi');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await step(page, 'after two stray ^Y');
});

// ---------------------------------------------------------------------------
// I. Undo then NEW typing: the redo branch must die (redo is a no-op) and
//    the new text must be undoable (the classic "second undo did nothing"
//    regression the code says it fixed — belt and braces).
// ---------------------------------------------------------------------------
await scenario('I type, ^Z, retype, ^Y-dead, ^Z', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('one');
  await page.keyboard.press('Control+z');
  await step(page, 'after ^Z');
  await page.keyboard.type('two');
  await step(page, 'after retype');
  await page.keyboard.press('Control+y');
  await step(page, 'after ^Y (must be no-op)');
  await page.keyboard.press('Control+z');
  await step(page, 'after ^Z (must drop "two")');
});

// ---------------------------------------------------------------------------
// J. Shift+Tab over a selection (dedent) and its undo.
// ---------------------------------------------------------------------------
await scenario('J 3-line select Shift+Tab, ^Z', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('\tl1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('\tl2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('\tl3');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+Tab');
  await step(page, 'after Shift+Tab (dedented)');
  await page.keyboard.press('Control+z');
  await step(page, 'after ^Z (tabs back, sel back)');
});

// ---------------------------------------------------------------------------
// K. Tab mid-burst: "hel" Tab "lo" — three groups; undo walks the carets
//    back (4 → 3 → 0), redo walks them forward (3 → 4 → 5).
// ---------------------------------------------------------------------------
await scenario('K mid-burst Tab, ^Z^Z^Z, ^Y^Y^Y', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('hel');
  await page.keyboard.press('Tab');
  await page.keyboard.type('lo');
  await step(page, 'after "hel<tab>lo"');
  await page.keyboard.press('Control+z');
  await step(page, '^Z 1 (want 4)');
  await page.keyboard.press('Control+z');
  await step(page, '^Z 2 (want 3)');
  await page.keyboard.press('Control+z');
  await step(page, '^Z 3 (want 0)');
  await page.keyboard.press('Control+y');
  await step(page, '^Y 1 (want 3)');
  await page.keyboard.press('Control+y');
  await step(page, '^Y 2 (want 4)');
  await page.keyboard.press('Control+y');
  await step(page, '^Y 3 (want 6 — the undo-time caret)');
});

// ---------------------------------------------------------------------------
// L. The mash: rapid alternating ^Z/^Y — every press must leave a state
//    whose caret belongs to it, no drift accumulates, no page errors.
// ---------------------------------------------------------------------------
await scenario('L mash ^Z/^Y alternating x6', async (page) => {
  await newNote(page, 'standard');
  await page.keyboard.type('abc');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await page.keyboard.type('def');
  // NOTE: Home + Tab leaves the caret BETWEEN the tab and "abc" — the
  // "def" burst types there ("\tdefabc", caret 4). The mash walks that
  // state and its caret back and forth; every press must land the pair.
  const expectSeq = [
    ['\tabc', 1],
    ['\tdefabc', 4],
    ['\tabc', 1],
    ['\tdefabc', 4],
    ['\tabc', 1],
    ['\tdefabc', 4],
    ['\tabc', 1],
  ];
  for (let i = 0; i < expectSeq.length; i += 1) {
    await page.keyboard.press(i % 2 === 0 ? 'Control+z' : 'Control+y');
    const text = await page.evaluate(() =>
      (document.getElementById('note')?.textContent ?? '').replace(/\u200B/g, ''),
    );
    const caret = await caretOffset(page);
    const ok =
      text === expectSeq[i][0] && caret === expectSeq[i][1]
        ? 'ok'
        : `MISMATCH (want ${JSON.stringify(expectSeq[i][0])} @${expectSeq[i][1]})`;
    console.log(`  press ${i + 1}: caret=${caret} text=${JSON.stringify(text)}  ${ok}`);
  }
});

await browser.close();
server.kill();
console.log('\ndone');
