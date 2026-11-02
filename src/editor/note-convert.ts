/**
 * Note type conversion — the content transforms behind "Change type".
 *
 * A type flip used to re-land the content string VERBATIM under the new
 * kind, which manufactured every wrong pairing: HTML soup in the markdown
 * source, JSON bristle in the text editor, text no task list or canvas
 * would ever parse (the surfaces read those as empty and the note looked
 * wiped). This module owns the pair matrix instead:
 *
 *   • html ↔ html (standard ↔ rich) — one storage subset, verbatim.
 *   • html → markdown — the sanitized subset walked back out as
 *     GitHub-flavored text (bold, italic, underline, strike, links,
 *     headings, lists, checklists, quotes, code fences, rules, tables,
 *     math shells; literal text is escape-aware).
 *   • markdown → html — the GitHub-parity renderer in, the storage
 *     subset's sanitizer out: task-list checkboxes become the rich
 *     checklist the editor edits, h4–h6 fold to h3 (the subset tops out
 *     at h3), images cannot survive the subset (flagged lossy).
 *   • tasks → text/html — the list as a GFM checklist (the same shape the
 *     rest of the app already projects; reminders/flags/priorities are
 *     metadata the text cannot hold — flagged lossy when present).
 *   • drawing → text/html — the scene's own text elements; a shapes-only
 *     scene has no text form (flagged lossy).
 *   • → tasks / → drawing — a checklist-shaped source becomes real tasks;
 *     anything else starts the target FRESH and says so. The caller
 *     confirms lossy conversions and snapshots the original first.
 *
 * Pure functions over the content string: DOM probing, the renderer and
 * the per-kind parsers — no storage, no TabManager, no dialogs.
 */

import { htmlToText } from './note-content';
import { contentKindFor, type ContentKind, type NoteType } from './note-types';
import { renderMarkdownToHtml } from './markdown/render';
import { sanitizeNoteHtml } from './storage-subset';
import {
  drawingSceneHasContent,
  emptyDrawingScene,
  parseDrawingScene,
  serializeDrawingScene,
} from './drawing/scene';
import {
  emptyTaskNoteContent,
  newTaskId,
  parseTaskNoteContent,
  serializeTaskNoteContent,
  taskNotePlainText,
  type Task,
} from './tasks/content';

/** What a type change should store under the new kind. */
export interface NoteConversion {
  /** The content to land under the new type ('' when the target starts fresh). */
  content: string;
  /** True when the conversion cannot carry everything over — the caller
   *  confirms with the user and snapshots the original before applying. */
  lossy: boolean;
  /** The one sentence the confirm dialog shows about what stays behind. */
  lossNote?: string;
  /** False only when the source type is unknown to this build — its
   *  content belongs to a newer Padify and must not be touched. */
  convertible: boolean;
}

// ---------------------------------------------------------------------------
// html → markdown
// ---------------------------------------------------------------------------

/** Characters that would read as markdown structure if left bare. */
const MD_SPECIALS = /[\\`*_[\]<>~]/g;

function escapeMarkdown(text: string): string {
  return text.replace(MD_SPECIALS, (ch) => `\\${ch}`);
}

/** A safe inline link target: () and spaces break the (…) form. */
function markdownHref(href: string): string {
  return /[\s()]/.test(href) ? `<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : href;
}

/** True when a paragraph carries nothing visible (an empty editor line). */
function isBlankMarkdown(markup: string): boolean {
  return markup.replace(/\\\n/g, '').trim() === '';
}

/**
 * The sanitized HTML subset walked back out as GitHub-flavored markdown.
 * Block structure comes from the subset's own tags; literal newlines in
 * text become hard breaks (a trailing backslash) so the lines the editor
 * showed survive the round trip; literal markdown punctuation in text is
 * escaped so it still reads literally after rendering.
 */
export function htmlToMarkdown(html: string): string {
  const probe = document.createElement('div');
  probe.innerHTML = html;

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      // pre-wrap kept real newlines in the stored text; markdown needs an
      // explicit hard break for the same visual line.
      return escapeMarkdown(node.nodeValue ?? '').replace(/\n/g, '\\\n');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    const el = node as HTMLElement;
    const inner = (): string => [...el.childNodes].map(inline).join('');
    switch (el.tagName) {
      case 'BR':
        return '\\\n';
      case 'B':
      case 'STRONG':
        return `**${inner()}**`;
      case 'I':
      case 'EM':
        return `*${inner()}*`;
      case 'U':
        return `<u>${inner()}</u>`;
      case 'S':
      case 'STRIKE':
      case 'DEL':
        return `~~${inner()}~~`;
      case 'SUP':
        return `<sup>${inner()}</sup>`;
      case 'SUB':
        return `<sub>${inner()}</sub>`;
      case 'A': {
        const text = inner();
        const href = el.getAttribute('href') ?? '';
        return href ? `[${text}](${markdownHref(href)})` : text;
      }
      case 'SPAN':
        // The math shell reads as its LaTeX, matching htmlToText.
        if (el.classList.contains('padify-math')) {
          return `$${el.getAttribute('data-latex') ?? ''}$`;
        }
        return inner();
      default:
        return inner();
    }
  };

  /** Block-level emitter — one or more markdown blocks, '\n\n'-joined. */
  const block = (node: Node, depth: number): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = escapeMarkdown(node.nodeValue ?? '').replace(/\n/g, '\\\n');
      return isBlankMarkdown(text) ? '' : text;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    const el = node as HTMLElement;
    const children = [...el.childNodes];
    const blocks = (): string[] => children.map((child) => block(child, depth)).filter(Boolean);

    switch (el.tagName) {
      case 'DIV':
      case 'P': {
        const markup = children.map(inline).join('');
        return isBlankMarkdown(markup) ? '' : markup;
      }
      case 'H1':
      case 'H2':
      case 'H3': {
        const level = '#'.repeat(Number(el.tagName[1]));
        return `${level} ${children.map(inline).join('').trim()}`;
      }
      case 'BLOCKQUOTE':
        return blocks()
          .join('\n\n')
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n');
      case 'PRE': {
        // No language survives the subset — a bare fence round-trips.
        return `\`\`\`\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\``;
      }
      case 'HR':
        return '---';
      case 'UL':
      case 'OL':
        return list(el, depth);
      case 'TABLE':
        return table(el);
      default: {
        // Inline material (or an unknown tag) at the top level reads as a
        // paragraph — inline() walks its children either way.
        const markup = inline(el);
        return isBlankMarkdown(markup) ? '' : markup;
      }
    }
  };

  /** One list (possibly nested) at the given indent depth. */
  const list = (el: HTMLElement, depth: number): string => {
    const indent = '  '.repeat(depth);
    const checklist = el.tagName === 'UL' && el.hasAttribute('data-rich-checklist');
    const ordered = el.tagName === 'OL';
    const lines: string[] = [];
    let index = 1;
    for (const li of [...el.children]) {
      if (li.tagName !== 'LI') {
        continue;
      }
      const marker = checklist
        ? li.getAttribute('data-checked') === 'true'
          ? '- [x]'
          : '- [ ]'
        : ordered
          ? `${index}.`
          : '-';
      index += 1;
      // Nested lists come out at the deeper indent; everything else in the
      // item is one inline run.
      const nested: string[] = [];
      const parts: string[] = [];
      for (const child of [...li.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = (child as HTMLElement).tagName;
          if (tag === 'UL' || tag === 'OL') {
            nested.push(list(child as HTMLElement, depth + 1));
            continue;
          }
        }
        parts.push(inline(child));
      }
      const own = parts.join('').replace(/\n/g, ' ');
      lines.push(`${indent}${marker} ${own.trim()}`);
      lines.push(...nested);
    }
    return lines.filter((line, at) => line !== '' || at === lines.length - 1).join('\n');
  };

  /** A GFM pipe table; the first row (thead's, else the first tr) is the header. */
  const table = (el: HTMLElement): string => {
    const rows = [...el.querySelectorAll('tr')];
    if (rows.length === 0) {
      return '';
    }
    const cellsOf = (tr: Element): string[] =>
      [...tr.children]
        .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
        .map((cell) => [...cell.childNodes].map(inline).join('').replace(/\|/g, '\\|').trim());
    const header = cellsOf(rows[0]);
    if (header.length === 0) {
      return '';
    }
    const width = Math.max(header.length, ...rows.slice(1).map((tr) => cellsOf(tr).length));
    const pad = (cells: string[]): string[] => {
      const filled = [...cells];
      while (filled.length < width) {
        filled.push('');
      }
      return filled;
    };
    const lines = [
      `| ${pad(header).join(' | ')} |`,
      `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ];
    for (const tr of rows.slice(1)) {
      lines.push(`| ${pad(cellsOf(tr)).join(' | ')} |`);
    }
    return lines.join('\n');
  };

  return [...probe.childNodes]
    .map((child) => block(child, 0))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// markdown → html (the note subset)
// ---------------------------------------------------------------------------

/**
 * Markdown source rendered through the GitHub-parity renderer and folded
 * into the note storage subset: task-list checkboxes become the rich
 * checklist the editor edits, h4–h6 fold to h3, and the sanitizer strips
 * everything the subset cannot hold. Returns null only when the source
 * carried an image — the one construct the subset has no home for — along
 * with the sanitized markup; callers surface that as a lossy conversion.
 */
export function markdownToNoteHtml(source: string): { html: string; lostImages: boolean } {
  const probe = document.createElement('div');
  probe.innerHTML = renderMarkdownToHtml(source);

  // h4–h6 fold to h3: the subset tops out at h3, and unwrapping the text
  // into a bare paragraph would read as lost structure.
  for (const heading of probe.querySelectorAll('h4, h5, h6')) {
    const folded = document.createElement('h3');
    folded.innerHTML = heading.innerHTML;
    heading.replaceWith(folded);
  }

  // GFM task lists: the renderer's <li><input type=checkbox> …</li> becomes
  // the checklist shape the editor's model owns.
  for (const box of probe.querySelectorAll('input[type="checkbox"]')) {
    const item = box.closest('li');
    box.remove();
    if (item) {
      item.setAttribute(
        'data-checked',
        (box as HTMLInputElement).hasAttribute('checked') ? 'true' : 'false',
      );
      const list = item.parentElement;
      if (list && list.tagName === 'UL' && !list.hasAttribute('data-rich-checklist')) {
        list.setAttribute('data-rich-checklist', 'true');
      }
    }
  }

  const lostImages = probe.querySelector('img') !== null;

  return { html: sanitizeNoteHtml(probe.innerHTML), lostImages };
}

// ---------------------------------------------------------------------------
// Per-kind emptiness (the "is there anything to lose" test)
// ---------------------------------------------------------------------------

function noteContentIsEmpty(content: string, kind: ContentKind): boolean {
  switch (kind) {
    case 'html':
      return htmlToText(content).trim() === '';
    case 'text':
      return content.trim() === '';
    case 'json':
      // Either structured kind: no tasks / no scene elements.
      return !drawingSceneHasContent(content) && parseTaskNoteContent(content).tasks.length === 0;
    default:
      return content.trim() === '';
  }
}

// ---------------------------------------------------------------------------
// Task projections
// ---------------------------------------------------------------------------

function taskFromLine(title: string, completed: boolean, sortOrder: number): Task {
  const nowIso = new Date().toISOString();
  return {
    id: newTaskId(),
    title: title.trim().slice(0, 600),
    notes: '',
    completed,
    completedAt: completed ? nowIso : '',
    dueDate: '',
    reminderAt: '',
    reminderNotifiedAt: '',
    flagged: false,
    priority: 'none',
    createdAt: nowIso,
    updatedAt: nowIso,
    sortOrder,
  };
}

/** The GFM checklist a task list projects to (the app's own plain-text shape). */
function tasksToMarkdown(content: string): { content: string; lossy: boolean; lossNote?: string } {
  const data = parseTaskNoteContent(content);
  const metaLossy = data.tasks.some(
    (task) => task.reminderAt || task.flagged || task.priority !== 'none',
  );
  return {
    content: taskNotePlainText(data),
    lossy: metaLossy,
    lossNote: metaLossy ? 'Reminders, flags and priorities cannot ride along as text.' : undefined,
  };
}

/**
 * Checklist-shaped sources become real tasks. Anything else in the note
 * (prose around the checklist) cannot become a task — flagged lossy so
 * the caller confirms. Returns null when no checklist exists at all.
 */
function checklistToTasks(content: string, kind: ContentKind): Task[] | null {
  const tasks: Task[] = [];

  if (kind === 'html') {
    const probe = document.createElement('div');
    probe.innerHTML = content;
    // Top-level checklists only — a checklist nested inside another list
    // is reached through its own top-level ancestor, and walking the whole
    // tree would count its items twice (outer titles swallow inner text).
    for (const list of [...probe.children].filter(
      (child) => child.tagName === 'UL' && child.hasAttribute('data-rich-checklist'),
    )) {
      for (const item of [...list.children].filter((child) => child.tagName === 'LI')) {
        tasks.push(
          taskFromLine(
            item.textContent ?? '',
            item.getAttribute('data-checked') === 'true',
            tasks.length,
          ),
        );
      }
    }
    return tasks.length > 0 ? tasks : null;
  }

  // Markdown: GFM task-list lines, ordered or bulleted.
  const line = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/;
  for (const raw of content.split('\n')) {
    const match = line.exec(raw);
    if (match) {
      tasks.push(taskFromLine(match[2], match[1] !== ' ', tasks.length));
    }
  }
  return tasks.length > 0 ? tasks : null;
}

/** True when a markdown/html source is (or carries) prose beyond its checklists. */
function hasProseBeyondChecklists(content: string, kind: ContentKind): boolean {
  if (kind === 'html') {
    const probe = document.createElement('div');
    probe.innerHTML = content;
    let prose = false;
    for (const child of [...probe.children]) {
      if (child.tagName === 'UL' && child.hasAttribute('data-rich-checklist')) {
        continue;
      }
      if (htmlToText(child.outerHTML).trim() !== '') {
        prose = true;
      }
    }
    return prose;
  }
  const taskLine = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+.+$/;
  return content.split('\n').some((raw) => raw.trim() !== '' && !taskLine.test(raw));
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * Converts a note's content for a type change. Never mutates anything and
 * never throws — an unexpected shape reads as "starts fresh, say so".
 */
export function convertNoteContent(
  content: string,
  from: NoteType | null | undefined,
  to: NoteType,
): NoteConversion {
  const fromKind = contentKindFor(from);
  const toKind = contentKindFor(to);
  // Unknown on either side: the content belongs to a type this build
  // cannot interpret — the caller refuses instead of transforming bytes
  // it does not own.
  if (fromKind === 'opaque' || toKind === 'opaque') {
    return { convertible: false, content, lossy: false };
  }

  // Same storage kind — standard ↔ rich is one subset, verbatim.
  if (fromKind === toKind && fromKind !== 'json') {
    return { convertible: true, content, lossy: false };
  }

  // html ↔ markdown.
  if (fromKind === 'html' && toKind === 'text') {
    return { convertible: true, content: htmlToMarkdown(content), lossy: false };
  }
  if (fromKind === 'text' && toKind === 'html') {
    const { html, lostImages } = markdownToNoteHtml(content);
    return {
      convertible: true,
      content: html,
      lossy: lostImages,
      lossNote: lostImages
        ? 'Images have no place in a text note — they are left behind.'
        : undefined,
    };
  }

  // tasks → text/html: the GFM checklist projection.
  if (from === 'tasks' && (toKind === 'text' || toKind === 'html')) {
    const projection = tasksToMarkdown(content);
    if (toKind === 'text') {
      return { convertible: true, ...projection };
    }
    return {
      convertible: true,
      ...projection,
      content: markdownToNoteHtml(projection.content).html,
    };
  }

  // drawing → text/html: the scene's own text elements. A shapes-only
  // scene has no text to become — the plain-text projection's "Drawing —
  // N elements" line is a TITLE, not content, and must not masquerade as
  // a conversion. Lossy: the caller confirms, the snapshot keeps the art.
  if (from === 'drawing' && (toKind === 'text' || toKind === 'html')) {
    const scene = parseDrawingScene(content);
    const textElements =
      scene?.elements.filter(
        (element) =>
          element &&
          typeof element === 'object' &&
          (element as Record<string, unknown>).type === 'text' &&
          typeof (element as Record<string, unknown>).text === 'string' &&
          ((element as Record<string, unknown>).text as string).trim() !== '',
      ) ?? [];
    const text = textElements
      .map((element) => ((element as Record<string, unknown>).text as string).trim())
      .join('\n');
    const lossy = drawingSceneHasContent(content) && text.trim() === '';
    const base = {
      convertible: true,
      lossy,
      lossNote: lossy ? 'A shapes-only drawing has no text to become.' : undefined,
    };
    if (toKind === 'text') {
      return { ...base, content: text };
    }
    return { ...base, content: text.trim() === '' ? '' : markdownToNoteHtml(text).html };
  }

  // → tasks: a checklist-shaped source becomes real tasks; anything else
  // starts a fresh list and says so.
  if (to === 'tasks') {
    if (noteContentIsEmpty(content, fromKind)) {
      return {
        convertible: true,
        content: serializeTaskNoteContent(emptyTaskNoteContent()),
        lossy: false,
      };
    }
    const tasks = checklistToTasks(content, fromKind);
    if (tasks) {
      const lossy = hasProseBeyondChecklists(content, fromKind);
      return {
        convertible: true,
        content: serializeTaskNoteContent({ version: 1, color: 'blue', tasks }),
        lossy,
        lossNote: lossy
          ? 'Only the checklist items become tasks — the rest of the note stays behind.'
          : undefined,
      };
    }
    return {
      convertible: true,
      content: serializeTaskNoteContent(emptyTaskNoteContent()),
      lossy: true,
      lossNote: 'A task list cannot hold this note as tasks.',
    };
  }

  // → drawing: a canvas starts fresh — say so when something was there.
  if (to === 'drawing') {
    const lossy = !noteContentIsEmpty(content, fromKind);
    return {
      convertible: true,
      content: serializeDrawingScene(emptyDrawingScene()),
      lossy,
      lossNote: lossy ? "A drawing cannot carry this note's content." : undefined,
    };
  }

  // Unreachable over the known registry — the honest fallback is verbatim.
  return { convertible: true, content, lossy: false };
}
