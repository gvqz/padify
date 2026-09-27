/**
 * Padify share viewer — /share/?t=<token>
 *
 * Loads one active share row anonymously from the padify API (the server
 * only returns rows that are neither revoked nor expired) and renders it
 * read-only with the same formatting subset the editor produces. Any
 * problem — bad token, cancelled link, expired link, network failure —
 * lands in the same calm "this link isn't available" state.
 */

(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('t');
  var config = window.PADIFY_SHARE_CONFIG || {};

  var stateBox = document.getElementById('shareState');
  var article = document.getElementById('shareArticle');

  function showState(iconSvg, title, copy) {
    clearLoading();
    article.hidden = true;
    stateBox.hidden = false;
    document.getElementById('shareStateIcon').innerHTML = iconSvg;
    document.getElementById('shareStateTitle').textContent = title;
    document.getElementById('shareStateCopy').textContent = copy;
  }

  var NOTE_ICON =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  var OFF_ICON =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>';
  var ALERT_ICON =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  var LOADING_ICON =
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
        year: 'numeric'
      });
    } catch (e) {
      return '';
    }
  }

  /**
   * Strips the stored note HTML down to the same formatting subset the
   * editor produces (b/strong/i/em/u/s/strike/del/br/div/span/p + the rich
   * text vocabulary h1/h2/h3/ul/ol/li/blockquote/pre + sup/sub/hr) so a
   * crafted share payload cannot inject markup. `a[href]` is kept only for
   * safe schemes, `style` only for the app sanitizer's property allowlist —
   * identical policy to sanitizeNoteHtml in src/tabs.ts. Keep the two in
   * sync.
   */
  function sanitizeShareHtml(html) {
    var parsed = new DOMParser().parseFromString('<body>' + String(html == null ? '' : html) + '</body>', 'text/html');
    var allowed = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, BR: 1, DIV: 1, SPAN: 1, P: 1, H1: 1, H2: 1, H3: 1, UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, SUP: 1, SUB: 1, HR: 1, A: 1 };
    var safeHref = /^(https?:|mailto:|#|\/)/i;
    var colorValue = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*(0?\.\d+|1)\s*)?\)|[a-z]+)$/i;
    var fontFamilyValue = /^[-a-z0-9\s,'’]{1,120}$/i;
    var inlineStyles = { 'color': colorValue, 'background-color': colorValue, 'font-size': /^\d+(\.\d+)?(px|pt)$/, 'font-family': fontFamilyValue };
    var blockStyles = { 'text-align': /^(left|center|right|justify)$/i, 'margin-left': /^\d+(\.\d+)?px$/ };

    function sanitizeStyle(raw, inline) {
      var allowedProps = inline ? inlineStyles : blockStyles;
      var kept = [];
      raw.split(';').forEach(function (declaration) {
        var colon = declaration.indexOf(':');
        if (colon <= 0) return;
        var prop = declaration.slice(0, colon).trim().toLowerCase();
        var value = declaration.slice(colon + 1).trim();
        var pattern = allowedProps[prop];
        if (pattern && pattern.test(value)) kept.push(prop + ': ' + value);
      });
      return kept.length ? kept.join('; ') : null;
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return [document.createTextNode(node.nodeValue || '')];
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return [];
      }
      var element = node;
      var children = [];
      for (var i = 0; i < element.childNodes.length; i += 1) {
        children = children.concat(walk(element.childNodes[i]));
      }
      if (!allowed[element.tagName]) {
        return children;
      }
      var clone = document.createElement(element.tagName);
      if (element.tagName === 'A') {
        var href = (element.getAttribute('href') || '').trim();
        if (href && safeHref.test(href)) {
          clone.setAttribute('href', href);
          clone.setAttribute('rel', 'noopener noreferrer nofollow');
          clone.setAttribute('target', '_blank');
        }
      } else if (element.tagName === 'SPAN' || element.tagName === 'DIV' || element.tagName === 'P' || element.tagName === 'H1' || element.tagName === 'H2' || element.tagName === 'H3' || element.tagName === 'LI' || element.tagName === 'BLOCKQUOTE' || element.tagName === 'PRE') {
        var rawStyle = element.getAttribute('style');
        if (rawStyle) {
          var safeStyle = sanitizeStyle(rawStyle, element.tagName === 'SPAN');
          if (safeStyle) clone.setAttribute('style', safeStyle);
        }
      }
      // Checklists ride the same fixed vocabularies as the app sanitizer:
      // the list keeps its boolean mark, items their boolean box state.
      if (element.tagName === 'UL' && element.getAttribute('data-rich-checklist') === 'true') {
        clone.setAttribute('data-rich-checklist', 'true');
      } else if (element.tagName === 'LI' && /^(true|false)$/.test(element.getAttribute('data-checked') || '')) {
        clone.setAttribute('data-checked', element.getAttribute('data-checked'));
      }
      children.forEach(function (child) {
        clone.appendChild(child);
      });
      return [clone];
    }

    var out = [];
    for (var i = 0; i < parsed.body.childNodes.length; i += 1) {
      out = out.concat(walk(parsed.body.childNodes[i]));
    }

    var fragment = document.createElement('div');
    out.forEach(function (node) {
      fragment.appendChild(node);
    });
    return fragment;
  }

  function render(row) {
    clearLoading();
    stateBox.hidden = true;
    article.hidden = false;

    var title = (row.title && row.title.trim()) ? row.title : 'Shared note';
    document.title = title + ' — Padify';
    document.getElementById('shareTitle').textContent = title;

    var meta = 'Shared on ' + formatDate(new Date(Number(row.created_at)).toISOString());
    if (row.expires_at) {
      meta += ' · available until ' + formatDate(row.expires_at);
    }
    document.getElementById('shareMeta').textContent = meta;

    var content = document.getElementById('shareContent');
    content.innerHTML = '';
    content.appendChild(sanitizeShareHtml(row.html));
  }

  function fail(kind) {
    if (kind === 'setup') {
      showState(
        ALERT_ICON,
        'Sharing isn\u2019t set up yet',
        'This Padify deployment is missing its share configuration. If you own this site, fill in public/share/config.js \u2014 see docs/CLOUD_SETUP.md.'
      );
      return;
    }
    if (kind === 'badlink') {
      showState(
        OFF_ICON,
        'This link is incomplete',
        'The address doesn\u2019t contain a share token, so there\u2019s nothing to show here.'
      );
      return;
    }
    if (kind === 'network') {
      showState(
        ALERT_ICON,
        'Couldn\u2019t load this note',
        'The sharing service didn\u2019t respond. Check your connection and refresh the page.'
      );
      return;
    }
    showState(
      OFF_ICON,
      'This link isn\u2019t available',
      'The note isn\u2019t shared anymore \u2014 the link was cancelled by its owner or it has expired.'
    );
  }

  if (!token) {
    fail('badlink');
    return;
  }

  var apiBase = String(config.apiBase || '').replace(/\/+$/, '');

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
})();
