/**
 * Note content helpers — the format-level functions that live above any one
 * consumer: title derivation, the plain-text projection of stored HTML, the
 * legacy single-note migration, and the welcome note.
 *
 * These grew up inside tabs.ts (the only note consumer there was) and moved
 * out when the cross-domain imports started: white-noise-player reached into
 * tabs.ts for escapeHtml, snapshots for htmlToText, the share layers for
 * deriveTabTitle — every one a thread pulling the tab MODEL into features
 * that only wanted a content projection. The functions are pure (DOM probing
 * only), depend on nothing but the note-types registry and lib/escape, and
 * deliberately take a structural note shape (below) so importing them can
 * never cycle back into tabs.ts.
 */

import { escapeHtml } from '../lib/escape';
import {
  contentKindFor,
  DEFAULT_NOTE_TYPE,
  isHtmlContent,
  noteTypeLabel,
  type NoteType,
} from './note-types';

export { escapeHtml };

/**
 * The note fields the content helpers read. `NoteTab` (tabs.ts) satisfies
 * this structurally — the shape is local on purpose so this module never
 * imports the tab model (that would be a cycle: tabs imports this).
 */
export interface TitledNote {
  /** User-provided name; null derives the title from the content. */
  name: string | null;
  /** The note's content, in its type's format. */
  content: string;
  /** The note kind — absent means the default (standard). */
  noteType?: NoteType;
}

const MAX_TITLE_LENGTH = 42;

/** Welcome note shown for brand-new installs (rich HTML). */
export const WELCOME_HTML = [
  'Welcome! Padify is an offline-capable notepad which is a Progressive Web App.',
  '',
  'The app serves the following features:',
  '',
  '- Your notes are saved in real-time as you type.',
  '- Multiple notes live in the sidebar on the left — plus bold, italic,',
  '  underline and strikethrough formatting that renders right inside the',
  '  editor (right-click to try it).',
  '- Note types: use the arrow beside "New note" to create rich text',
  '  notes with headings, lists, quotes, code blocks and links.',
  '- Voice typing: click the mic in the top bar (or press alt/option + v)',
  '  and just talk.',
  '- Optional cloud sync: click the cloud icon in the top bar to back up',
  '  your notes and pick them up on any other device.',
  '- Signed in? Share any note with a read-only link that expires on its',
  '  own and can be cancelled any time (share icon in the top bar).',
  '- Installable on supported browsers for offline usage.',
  '- "Add To Home Screen" feature on Android-supported devices to launch the app from the home screen.',
  '- Dark mode.',
  '- Privacy-focused - Never collects your precious data.',
  '- Light-weight - Loads almost instantly.',
  '- Writing sessions with a pick-a-duration timer.',
  '- View Note Statistics.',
  '- Snapshots.',
  '- Ability to mimic typewriter sound when typing.',
  '- Optional break reminders after long writing sessions.',
  '- Keyboard shortcuts for common actions.',
  '- Full-screen mode for a distraction-free writing experience.',
  '- Floating window (in supported browsers) to effectively take notes across other apps.',
  '- Download notes as plain text, PDF, HTML, and DOCX file.',
  '- Play music while you write — free song search with no account, or connect your Spotify — and mix 12 ambience sounds to help you focus.',
  '',
  "CAUTION: Since the app stores your notes on your own device, it's",
  'recommended that you take a backup of your notes more often using the',
  '"Download Notes" button or by pressing the "ctrl/command + s" keys.',
  '',
  '<b>Delete this text and start writing your notes</b>',
].join('\n');

/**
 * Converts the legacy plain-text note (with markdown-style formatting
 * wrappers) into the rich HTML subset the editor stores. Newlines stay as
 * literal \n characters — the editor renders with white-space: pre-wrap.
 */
export function legacyTextToHtml(text: string): string {
  const escaped = escapeHtml(text);

  const unwrap = (pattern: RegExp, tag: string): string =>
    escaped.replace(pattern, (_match, inner: string) => `<${tag}>${inner}</${tag}>`);

  // Order matters: the longer asterisk run (bold) before the single-star
  // italic, underline's `__` before nothing else that clashes.
  return unwrap(/\*\*([^*\n]+?)\*\*/g, 'b')
    .replace(/__([^_\n]+?)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
}

/** Plain text of a stored HTML snippet (newlines preserved). */
export function htmlToText(html: string): string {
  const probe = document.createElement('div');
  probe.innerHTML = html;

  const parts: string[] = [];

  /** Block tags read as line boundaries, like innerText would report them. */
  const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'LI', 'HR']);

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    if (element.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    // A math shell reads as its LaTeX source (titles/previews/exports get
    // the equation, not KaTeX's markup or nothing).
    if (element.classList && element.classList.contains('padify-math')) {
      parts.push(element.getAttribute('data-latex') ?? '');
      return;
    }
    // Checklist items read with their box state — the plain-text twin of
    // the rendered checkbox.
    if (element.tagName === 'LI') {
      const list = element.parentElement;
      if (list instanceof HTMLElement && list.hasAttribute('data-rich-checklist')) {
        if (parts.length > 0) {
          parts.push('\n');
        }
        parts.push(element.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ');
        element.childNodes.forEach(walk);
        return;
      }
    }
    // Table rows read as lines, cells tab-separated (Docs' export shape).
    if (element.tagName === 'TR') {
      if (parts.length > 0) {
        parts.push('\n');
      }
      let cells = 0;
      element.childNodes.forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = (child as HTMLElement).tagName;
          if (tag === 'TD' || tag === 'TH') {
            if (cells > 0) {
              parts.push('\t');
            }
            cells += 1;
            child.childNodes.forEach(walk);
          }
        }
      });
      return;
    }
    if (BLOCK_TAGS.has(element.tagName)) {
      // Block boundaries read as newlines, like innerText would report them.
      if ((element.textContent ?? '') === '') {
        parts.push('\n');
        return;
      }
      if (parts.length > 0) {
        parts.push('\n');
      }
      element.childNodes.forEach(walk);
      return;
    }
    element.childNodes.forEach(walk);
  };

  probe.childNodes.forEach(walk);
  // The styled-caret marker (U+200B) is editor plumbing, not content.
  return parts.join('').replace(/\u200B/g, '');
}

/** Derives the tab label: user name, else the format's own first line. */
export function deriveTabTitle(tab: TitledNote): string {
  if (tab.name && tab.name.trim()) {
    return tab.name.trim();
  }

  // Non-html formats title from their raw content — never from the HTML
  // reading of it (htmlToText would eat the markup-shaped data whole).
  if (!isHtmlContent(tab.noteType)) {
    const kind = contentKindFor(tab.noteType);
    if (kind === 'text') {
      const title = titleFromLines(tab.content.split('\n'));
      if (title) {
        return title;
      }
    }
    return noteTypeLabel(tab.noteType ?? DEFAULT_NOTE_TYPE);
  }

  const title = titleFromLines(htmlToText(tab.content).split('\n'));
  if (title) {
    return title;
  }

  return 'Untitled';
}

/**
 * The first line that can carry a title, cleaned for display — the note
 * naming algorithm the tab strip and the browser tab both ride.
 *
 * Versus the old "first non-empty line, truncated at 42" this skips the
 * furniture a first line so often carries, so notes name themselves the
 * way their author thinks of them:
 *  - markdown scaffolding comes off (`# Heading` → `Heading`, `> quote`
 *    → `quote`, `- item` / `1. item` → `item`, `[x] task` → `task`);
 *  - separator-only lines (`---`, `***`) are skipped, not named after;
 *  - internal whitespace collapses to single spaces;
 *  - a line with no letters or digits (a stray dash, a lone ellipsis)
 *    counts as empty instead of becoming the title;
 *  - long titles cut at a word boundary — no more names ending in half
 *    a word before the ellipsis.
 */
function titleFromLines(lines: string[]): string | null {
  for (const raw of lines) {
    let line = raw.trim();
    if (line === '') {
      continue;
    }

    // Markdown furniture, repeatedly so nested shapes (`> - item`) peel.
    for (;;) {
      const peeled = line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^\[[ xX]\]\s*/, '');
      if (peeled === line) {
        break;
      }
      line = peeled.trim();
    }
    if (line === '') {
      continue;
    }

    // Separator rules (---, ***, ___) and anything without a word
    // character: a title of dashes helps nobody.
    if (/^[-*_\s]+$/.test(line)) {
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(line)) {
      continue;
    }

    // Every whitespace run — tabs and stray breaks included — becomes one
    // space: a title carrying a raw tab renders as a hole in the chip.
    line = line.replace(/\s+/g, ' ');
    return truncateTitle(line);
  }
  return null;
}

/** Truncates at MAX_TITLE_LENGTH on a word boundary, ellipsis-terminated. */
function truncateTitle(line: string): string {
  if (line.length <= MAX_TITLE_LENGTH) {
    return line;
  }
  const cut = line.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > MAX_TITLE_LENGTH * 0.5 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[\s,;:.\-–—!?]+$/, '') + '…';
}
