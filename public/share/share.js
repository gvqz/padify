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
   * editor produces (b/strong/i/em/u/s/strike/del/br/div/span/p, no
   * attributes) so a crafted share payload cannot inject markup.
   */
  function sanitizeShareHtml(html) {
    var parsed = new DOMParser().parseFromString('<body>' + String(html == null ? '' : html) + '</body>', 'text/html');
    var allowed = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, BR: 1, DIV: 1, SPAN: 1, P: 1 };

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
