/**
 * Padify share viewer — /share/?t=<token>
 *
 * Loads one active share row anonymously from the padify API (the server
 * only returns rows that are neither revoked nor expired) and renders it
 * read-only with the same formatting subset the editor produces. Any
 * problem — bad token, cancelled link, expired link, network failure —
 * lands in the same calm "this link isn't available" state.
 *
 * ES module: the sanitizer comes from ./sanitize-note.js, GENERATED from
 * src/editor/storage-subset.ts by scripts/build-share.mjs, so the viewer's
 * policy and the app's are one policy. The hand-copied twin this replaced
 * had drifted (it dropped math shells, so shared notes lost their
 * equations) and nothing in CI could see it.
 */

import { sanitizeNoteHtml } from './sanitize-note.js';
import { renderMarkdownToHtml } from './markdown-render.js';

const params = new URLSearchParams(window.location.search);
const token = params.get('t');
const config = window.PADIFY_SHARE_CONFIG || {};

const stateBox = document.getElementById('shareState');
const article = document.getElementById('shareArticle');

function showState(iconSvg, title, copy) {
  clearLoading();
  article.hidden = true;
  stateBox.hidden = false;
  document.getElementById('shareStateIcon').innerHTML = iconSvg;
  document.getElementById('shareStateTitle').textContent = title;
  document.getElementById('shareStateCopy').textContent = copy;
}

const NOTE_ICON =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
const OFF_ICON =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>';
const ALERT_ICON =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
const LOADING_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';

// Immediate feedback while the share row is being fetched.
function showLoading() {
  article.hidden = true;
  stateBox.hidden = false;
  stateBox.classList.add('loading');
  document.getElementById('shareStateIcon').innerHTML = LOADING_ICON;
  document.getElementById('shareStateTitle').textContent = 'Loading note\u2026';
  document.getElementById('shareStateCopy').textContent = 'Fetching the shared note.';
}

function clearLoading() {
  stateBox.classList.remove('loading');
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch (e) {
    return '';
  }
}

/**
 * The note types whose content is the app's sanitized-HTML subset. Only
 * these render as markup — and always through the shared sanitizer. Absent
 * type = the classic note = html (links created before types existed).
 *
 * Every OTHER type renders as raw text, no exceptions: this page cannot
 * know what a future type's markup means, and unknown never means
 * executable. When a new html-flavored type ships, add its id here.
 */
const HTML_TYPES = ['standard', 'rich'];

function isHtmlNote(type) {
  return !type || HTML_TYPES.indexOf(String(type)) !== -1;
}

function render(row) {
  clearLoading();
  stateBox.hidden = true;
  article.hidden = false;

  const title = row.title && row.title.trim() ? row.title : 'Shared note';
  document.title = title + ' — Padify';
  document.getElementById('shareTitle').textContent = title;

  let meta = 'Shared on ' + formatDate(new Date(Number(row.created_at)).toISOString());
  if (row.expires_at) {
    meta += ' · available until ' + formatDate(row.expires_at);
  }
  document.getElementById('shareMeta').textContent = meta;

  const content = document.getElementById('shareContent');
  content.innerHTML = '';
  // The rendered-markdown branch flips the container's white-space (the
  // renderer's pretty-printed HTML must not meet pre-wrap — see the
  // markdown-content rule in share.css); rich notes keep it.
  content.classList.remove('markdown-content');

  if (isHtmlNote(row.note_type)) {
    // The rename transition: rows from a newer server say `content`,
    // older ones say `html` — read either, prefer `content`.
    const body = row.content == null ? row.html : row.content;
    // The app's own sanitizer, generated from the canonical source: same
    // tag/attribute/style policy as the editor, plus the read-only
    // dialect — links hardened to noopener new-tabs, math shells shown
    // as their LaTeX source (this page runs no KaTeX).
    content.innerHTML = sanitizeNoteHtml(String(body == null ? '' : body), {
      hardenLinks: true,
      mathToText: true,
    });
    return;
  }

  if (String(row.note_type) === 'markdown') {
    // Markdown notes render through the OWNED renderer, generated from
    // src/editor/markdown/render.ts by the same build script — a module
    // that only ever emits tags it wrote itself, with every href past
    // the safe-href gate (hostile URLs render as their literal text).
    // No sanitizer pass on top: the renderer's output IS the policy, and
    // the sanitizer's allowlist would strip the subset it doesn't know
    // (inline <code>, task checkboxes, h4-h6).
    const body = row.content == null ? row.html : row.content;
    content.innerHTML = renderMarkdownToHtml(String(body == null ? '' : body));
    content.classList.add('markdown-content');
    // The one read-only adaptation: this island runs no KaTeX, so the
    // equation shells show their LaTeX source — the same answer the
    // html-note path gives through mathToText.
    content.querySelectorAll('.padify-math').forEach((shell) => {
      shell.textContent = shell.getAttribute('data-latex') ?? '';
    });
    return;
  }

  if (String(row.note_type) === 'tasks') {
    // A shared task list renders as the checklist it is — not the JSON
    // that stores it. Every user string goes through textContent; the
    // only markup here is built by this branch itself.
    const body = row.content == null ? row.html : row.content;
    try {
      const model = JSON.parse(String(body == null ? '' : body));
      renderTaskList(content, model);
      return;
    } catch {
      /* damaged payload — the raw fallback below is the honest answer */
    }
  }

  // Any other non-html note (a board's JSON, a newer type): honest raw
  // text, never markup. The <pre> keeps structure readable.
  const pre = document.createElement('pre');
  pre.className = 'share-raw-content';
  const raw = row.content == null ? row.html : row.content;
  pre.textContent = String(raw == null ? '' : raw);
  content.appendChild(pre);
}

/** A shared task list: colored circles, titles, chips — read-only. */
function renderTaskList(content, model) {
  var tasks = Array.isArray(model.tasks) ? model.tasks : [];
  var color = ['blue', 'red', 'orange', 'green', 'purple', 'teal'].indexOf(model.color) >= 0
    ? model.color
    : 'blue';
  var list = document.createElement('div');
  list.className = 'share-task-list tk-c-' + color;
  if (tasks.length === 0) {
    var empty = document.createElement('p');
    empty.className = 'share-task-empty';
    empty.textContent = 'This list is empty.';
    list.appendChild(empty);
  }
  tasks.forEach(function (task) {
    var row = document.createElement('div');
    row.className = 'share-task' + (task.completed ? ' is-done' : '');
    var check = document.createElement('span');
    check.className = 'share-task-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = task.completed ? '\u2713' : '';
    var words = document.createElement('span');
    words.className = 'share-task-words';
    var title = document.createElement('span');
    title.className = 'share-task-title';
    title.textContent = String(task.title || '');
    words.appendChild(title);
    if (task.notes) {
      var notes = document.createElement('span');
      notes.className = 'share-task-notes';
      notes.textContent = String(task.notes);
      words.appendChild(notes);
    }
    var meta = [];
    if (task.dueDate) meta.push('due ' + shortDate(task.dueDate));
    if (task.reminderAt) meta.push('reminds ' + shortDate(task.reminderAt));
    if (task.flagged) meta.push('flagged');
    if (task.priority && task.priority !== 'none') meta.push(task.priority + ' priority');
    if (meta.length > 0) {
      var chips = document.createElement('span');
      chips.className = 'share-task-chips';
      chips.textContent = meta.join(' · ');
      words.appendChild(chips);
    }
    row.appendChild(check);
    row.appendChild(words);
    list.appendChild(row);
  });
  content.appendChild(list);
}

/** ISO → "Mar 3" / "Mar 3, 5:00 PM" — the chips' compression. */
function shortDate(iso) {
  var date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  var out = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (date.getHours() !== 0 || date.getMinutes() !== 0) {
    out += ', ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return out;
}

function fail(kind) {
  if (kind === 'setup') {
    showState(
      ALERT_ICON,
      'Sharing isn\u2019t set up yet',
      'This Padify deployment is missing its share configuration. If you own this site, rebuild with VITE_API_BASE set to your API origin \u2014 see docs/CLOUD_SETUP.md.',
    );
    return;
  }
  if (kind === 'badlink') {
    showState(
      OFF_ICON,
      'This link is incomplete',
      'The address doesn\u2019t contain a share token, so there\u2019s nothing to show here.',
    );
    return;
  }
  if (kind === 'network') {
    showState(
      ALERT_ICON,
      'Couldn\u2019t load this note',
      'The sharing service didn\u2019t respond. Check your connection and refresh the page.',
    );
    return;
  }
  showState(
    OFF_ICON,
    'This link isn\u2019t available',
    'The note isn\u2019t shared anymore \u2014 the link was cancelled by its owner or it has expired.',
  );
}

if (!token) {
  fail('badlink');
} else {
  const apiBase = String(config.apiBase || '').replace(/\/+$/, '');

  showLoading();

  fetch(apiBase + '/api/share/' + encodeURIComponent(token))
    .then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { ok: response.ok, data: data };
      });
    })
    .then(function (result) {
      if (!result.ok) {
        // The API answers 404 for cancelled, expired and never-existed links
        // alike — on purpose, so a dead link can't be probed for status.
        fail('unavailable');
        return;
      }
      render(result.data.row);
    })
    .catch(function (error) {
      console.error('[share] load failed', error);
      fail('network');
    });
}
