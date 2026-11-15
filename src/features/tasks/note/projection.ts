/**
 * Task list notes — the shell's projection of the content model.
 *
 * editor/note-projections.ts is the seam the shell (tabs, snapshots,
 * share) reads note content through; this module is the tasks kind's
 * adapter, registered at import time exactly like the surface
 * registration in surface.ts. It carries the readings that live in the
 * model's vocabulary: an empty list is JSON bytes with zero rows (the
 * share gate refuses it, the substance gate skips it), the plain-text
 * projection is the GitHub-style checklist the word pill and previews
 * read, the unit a snapshot badge counts is the row, the tab-strip
 * badge is the list's colored circle, and the HTML export is the
 * checklist dressed for markup (all strings escaped).
 *
 * The surface module imports this file, so anywhere the tasks note kind
 * is present its projections are too — one import, both registrations.
 */

import { escapeHtml } from '../../../lib/escape';
import { registerNoteProjection } from '../../../editor/note-projections';
import { formatDueChip } from './dates';
import { parseTaskNoteContent, taskNotePlainText } from './content';

/** The tasks note's HTML export: a quiet checklist, list color included. */
function taskListExportHtmlBody(content: string): string {
  const model = parseTaskNoteContent(content);
  const items = model.tasks
    .map((task) => {
      const title = escapeHtml(task.title);
      let line = `<li class="padify-task${task.completed ? ' is-done' : ''}"><span class="padify-task-title">${title}</span>`;
      if (task.dueDate) {
        line += `<span class="padify-task-meta">due ${escapeHtml(formatDueChip(task.dueDate, new Date()))}</span>`;
      }
      if (task.notes) {
        line += `<span class="padify-task-meta">${escapeHtml(task.notes)}</span>`;
      }
      return `${line}</li>`;
    })
    .join('');
  return `<ul class="padify-task-list" data-color="${model.color}">${items}</ul>`;
}

// Every reading parses fresh — the same robustness contract as the
// model itself: corrupt or hostile bytes answer as the biggest honest
// subset, never a throw.
registerNoteProjection('tasks', {
  isEmptyForShare: (content) => parseTaskNoteContent(content).tasks.length === 0,
  hasSubstance: (content) => parseTaskNoteContent(content).tasks.length > 0,
  plainText: (content) => taskNotePlainText(parseTaskNoteContent(content)),
  unitCount: (content) => ({ count: parseTaskNoteContent(content).tasks.length, unit: 'task' }),
  stripBadge: (content) => ({ kind: 'list-dot', color: parseTaskNoteContent(content).color }),
  exportHtmlBody: taskListExportHtmlBody,
});
