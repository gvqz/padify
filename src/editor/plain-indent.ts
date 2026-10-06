/**
 * The plain note's indent migration — margin steps in, tab characters
 * out.
 *
 * The Tab key on a plain note now indents with TEXT (a literal tab per
 * line — see shiftLineTabs in model/ops.ts), because the selection
 * highlight paints text runs only and a margin indent never lit up in it
 * ("not all tabs are selected"). Notes indented under the old gesture
 * carry `margin-left` steps on their blocks; left as they are, the two
 * indent systems would mix (Tab adds a tab on top of a margin, Shift+Tab
 * unwinds only one of them), so every display of a STANDARD note walks
 * its blocks once and rewrites each margin step into the equivalent run
 * of leading tabs. Idempotent by construction — a migrated block has no
 * margin left to migrate. Rich notes keep their margins: the Docs-style
 * block property is the right model there, and their toolbar buttons
 * still manage it.
 */

import { INDENTABLE_TAGS, INDENT_STEP_PX, setStyleProp } from './model/document';
import { insertLeadingTab } from './model/ops';

/** Reads a block's margin-left step in px, or 0 when it carries none. */
function marginLeftPx(block: HTMLElement): number {
  return (
    parseInt(
      block.getAttribute('style')?.match(/margin-left:\s*(\d+(?:\.\d+)?)px/)?.[1] ?? '0',
      10,
    ) || 0
  );
}

/** True when the block itself steps a margin. */
function hasMargin(block: HTMLElement): boolean {
  return marginLeftPx(block) > 0;
}

/**
 * Rewrites margin-left indents into leading tab characters. Returns the
 * migrated markup — or the input untouched when nothing carried a margin
 * (the common case, and the reason this is cheap to run on every paint).
 */
export function migrateMarginIndentsToTabs(html: string): string {
  if (!html) {
    return html;
  }
  const holder = document.createElement('div');
  holder.innerHTML = html;

  const selector = Array.from(INDENTABLE_TAGS)
    .map((tag) => tag.toLowerCase())
    .join(',');
  const candidates = Array.from(holder.querySelectorAll<HTMLElement>(selector)).filter(hasMargin);
  if (candidates.length === 0) {
    return html;
  }

  // Every margin-bearing block takes its steps' worth of tabs at its own
  // stream start. For the rare nested pair, both wrappers' tabs collapse
  // onto the innermost text start — the visual indent comes out the same
  // (40px per step, one tab per step), with no margin left to fight the
  // tab gesture. Lists never carried the margin gesture; their LI blocks
  // are not INDENTABLE and do not match the selector.
  for (const block of candidates) {
    const steps = Math.max(1, Math.round(marginLeftPx(block) / INDENT_STEP_PX));
    for (let step = 0; step < steps; step += 1) {
      insertLeadingTab(block);
    }
    setStyleProp(block, 'margin-left', null, 'block');
  }
  return holder.innerHTML;
}
