/**
 * Modal markup lives as verbatim HTML partials next to this file and is
 * mounted once at boot, before any feature wiring queries a modal by id.
 *
 * Why partials: index.html carried ~1.3k lines of inline modal markup for
 * eight dialogs — every modal edit meant scrolling a monolith, and the
 * markup had no home of its own. Partials give each dialog a file while
 * keeping the DOM byte-identical (same ids, classes, indentation, relative
 * order). Nothing is re-rendered or templated: the .html files ARE the
 * markup that ships.
 *
 * Why this works without extra wiring: bootstrap's modal plugin handles
 * data-toggle="modal" via delegated document-level events, so markup
 * mounted after parse time still opens from trigger attributes; feature
 * code only touches modals after boot calls mountModals() (all
 * selector()/$('#…') captures are lazy — verified — no module grabs modal
 * elements at import time).
 */

import aboutModalHtml from './about-modal.html?raw';
import snapshotsModalHtml from './snapshots-modal.html?raw';
import keyboardShortcutsModalHtml from './keyboard-shortcuts-modal.html?raw';
import unicodePickerModalHtml from './unicode-picker-modal.html?raw';
import cloudModalHtml from './cloud-modal.html?raw';
import shareModalHtml from './share-modal.html?raw';
import preferencesModalHtml from './preferences-modal.html?raw';
import statisticsModalHtml from './statistics-modal.html?raw';

/** Modal markup in the original document order (relative to each other). */
const MODAL_PARTIALS: string[] = [
  aboutModalHtml,
  snapshotsModalHtml,
  keyboardShortcutsModalHtml,
  unicodePickerModalHtml,
  cloudModalHtml,
  shareModalHtml,
  preferencesModalHtml,
  statisticsModalHtml,
];

let mounted = false;

/** Mount all modal markup at the end of <body>, preserving document order. */
export function mountModals(): void {
  if (mounted) return;
  mounted = true;
  document.body.insertAdjacentHTML('beforeend', MODAL_PARTIALS.join('\n'));
}
