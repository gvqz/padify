/**
 * The "changed while you were away" peek — the sibling of the review sheet.
 *
 * When a note's words arrived from another device while it sat unopened (a
 * sync merge repainted a background tab), the manager parks what this device
 * last had on the note (NoteTab.unseenChange) and, on the next open, hands
 * it to this sheet. The question it answers is purely informational —
 * "what changed since I last looked?" — so unlike the review sheet there is
 * nothing to decide: the note already carries the new version, no words were
 * lost, and one Close button is the whole footer.
 *
 * The rendering is the review sheet's tracked-changes view reused verbatim
 * (renderTrackedDiff): words no longer there struck through and dimmed,
 * words added since the last open tinted green. The legend rows name
 * only the marks the diff shows; the copy is this sheet's own — the
 * marks mean "then → now", not "mine → theirs".
 */

import { openModal } from './ui/behavior/modal';
import { getTabManager, type NoteTab } from './tabs';
import { renderDiffLegend, renderTrackedDiff } from './conflicts';

/** Opens the peek over a note that just switched to. */
export function openUnseenPeek(
  tab: NoteTab,
  baseline: { from: string; fromName: string | null },
): void {
  const diffHost = document.getElementById('unseenDiff');
  const meta = document.getElementById('unseenMeta');
  const legend = document.getElementById('unseenLegend');
  const modal = document.getElementById('unseenModal');
  if (!diffHost || !meta || !legend || !modal) {
    return;
  }

  // The peek renders the same "then → now" the review sheet renders
  // "mine → theirs": what this device last had stands in for mine, the
  // note's current bytes for theirs. The name-differs note at the bottom
  // of the rendering reads correctly for both.
  const diffHtml = renderTrackedDiff(
    {
      kind: 'edit',
      detectedAt: Date.now(),
      mine: { name: baseline.fromName, content: baseline.from },
      theirs: { name: tab.name, content: tab.content, updatedAt: tab.updatedAt },
    },
    tab.noteType,
  );
  diffHost.innerHTML = diffHtml;
  // The legend names only the marks present — a peek that only added
  // words never mentions strikes.
  legend.innerHTML = renderDiffLegend(diffHtml, {
    del: 'words that are no longer there',
    ins: 'words that arrived since you last opened it',
  });

  const when = new Date(tab.updatedAt || Date.now());
  meta.textContent = `Their edit landed ${when.toLocaleString()}.`;
  openModal(modal);
}

/** Wires the peek to the manager's hook (app.ts calls this after boot). */
export function initUnseenChange(): void {
  const manager = getTabManager();
  if (manager) {
    manager.onUnseenPeek = openUnseenPeek;
  }
}
