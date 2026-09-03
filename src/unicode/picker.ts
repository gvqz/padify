import $ from 'jquery';
import type { NotepadUI } from '../selector';
import type { UnicodeSymbol } from './types';
import { showToast } from '../utils';

export interface UnicodePickerHandle {
  /** Opens the character picker modal and focuses the search input. */
  open(): void;
  /** Inserts the given symbol at the caret in the note textarea. */
  insertSymbol(symbol: UnicodeSymbol, keepOpen?: boolean): void;
}

const RECENT_KEY = 'recentUnicodeSymbols'; // key used by the original picker
const FAVORITES_KEY = 'unicodeFavorites';
const RECENT_LIMIT = 24;
const CATEGORY_ALL = 'all';
const CATEGORY_FAVORITES = 'favorites';
const CATEGORY_RECENT = 'recent';
const OVERSCAN_ROWS = 3;
const GRID_PAD = 12;
const SEARCH_DEBOUNCE_MS = 60;

interface CategoryInfo {
  label: string;
  glyph: string;
  count: number;
}

interface LoadedData {
  symbols: UnicodeSymbol[];
  categories: CategoryInfo[];
  byChar: Map<string, UnicodeSymbol>;
  haystacks: string[];
  totalCount: number;
}

let dataPromise: Promise<LoadedData> | null = null;

function loadData(): Promise<LoadedData> {
  if (!dataPromise) {
    dataPromise = import('./symbols-data').then((mod) => {
      const symbols = mod.UNICODE_SYMBOLS;
      const byChar = new Map<string, UnicodeSymbol>();
      const categoryLabels: string[] = [];
      const categoryGlyphs = new Map<string, string>();
      const categoryCounts = new Map<string, number>();

      for (const symbol of symbols) {
        byChar.set(symbol.char, symbol);
        if (!categoryCounts.has(symbol.category)) {
          categoryLabels.push(symbol.category);
          categoryGlyphs.set(symbol.category, symbol.char);
          categoryCounts.set(symbol.category, 0);
        }
        categoryCounts.set(
          symbol.category,
          (categoryCounts.get(symbol.category) ?? 0) + 1
        );
      }

      const categories: CategoryInfo[] = categoryLabels.map((label) => ({
        label,
        glyph: categoryGlyphs.get(label) ?? '•',
        count: categoryCounts.get(label) ?? 0
      }));

      const haystacks = symbols.map(
        (symbol) =>
          `${symbol.char} ${symbol.name} ${symbol.category} u+${symbol.codepoint.toString(16)}`
      );

      return { symbols, categories, byChar, haystacks, totalCount: symbols.length };
    });
  }
  return dataPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightName(name: string, tokens: string[]): string {
  let html = escapeHtml(name);
  for (const token of tokens) {
    if (!token) continue;
    const escaped = escapeHtml(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(
      new RegExp(`(${escaped})`, 'i'),
      '<mark>$1</mark>'
    );
  }
  return html;
}

function codepointHex(symbol: UnicodeSymbol): string {
  return symbol.codepoint.toString(16).toUpperCase().padStart(4, '0');
}

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string') : []);
  } catch {
    return new Set();
  }
}

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A virtualized, searchable character picker backed by the generated
 * Unicode dataset. Lazily loads the dataset the first time the modal is
 * opened so the initial app payload stays small.
 */
export function initUnicodePicker(notepad: NotepadUI): UnicodePickerHandle {
  const $modal = $('#unicodePickerModal');
  const searchInput = document.getElementById('unicodeSearch') as HTMLInputElement;
  const searchClear = document.getElementById('unicodeSearchClear') as HTMLButtonElement;
  const categoriesEl = document.getElementById('unicodeCategories') as HTMLElement;
  const gridEl = document.getElementById('unicodeGrid') as HTMLElement;
  const gridInnerEl = document.getElementById('unicodeGridInner') as HTMLElement;
  const detailEl = document.getElementById('unicodeDetail') as HTMLElement;
  const statusEl = document.getElementById('unicodeStatus') as HTMLElement;

  if (
    !searchInput ||
    !searchClear ||
    !categoriesEl ||
    !gridEl ||
    !gridInnerEl ||
    !detailEl ||
    !statusEl
  ) {
    return {
      open() {
        /* markup missing — no-op */
      },
      insertSymbol() {
        /* no-op */
      }
    };
  }

  let data: LoadedData | null = null;
  let ready = false;

  const state = {
    query: '',
    tokens: [] as string[],
    category: CATEGORY_ALL as string,
    filtered: [] as UnicodeSymbol[],
    activeIndex: 0,
    favorites: loadFavorites(),
    recents: loadRecents()
  };

  // Virtualization metrics
  let cardSize = 86;
  let gapSize = 8;
  let columns = 1;
  let rowHeight = 94;
  let renderQueued = false;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------- helpers

  function symbolOfChar(char: string): UnicodeSymbol | undefined {
    return data?.byChar.get(char);
  }

  function getFavoritesSymbols(): UnicodeSymbol[] {
    return [...state.favorites]
      .map((char) => symbolOfChar(char))
      .filter((symbol): symbol is UnicodeSymbol => Boolean(symbol));
  }

  function getRecentSymbols(): UnicodeSymbol[] {
    return state.recents
      .map((char) => symbolOfChar(char))
      .filter((symbol): symbol is UnicodeSymbol => Boolean(symbol));
  }

  function getBaseSymbols(): UnicodeSymbol[] {
    switch (state.category) {
      case CATEGORY_FAVORITES:
        return getFavoritesSymbols();
      case CATEGORY_RECENT:
        return getRecentSymbols();
      case CATEGORY_ALL:
        return data ? data.symbols : [];
      default:
        return data ? data.symbols.filter((s) => s.category === state.category) : [];
    }
  }

  function matches(symbol: UnicodeSymbol, index: number): boolean {
    if (state.tokens.length === 0) return true;
    const haystack = data?.haystacks[index];
    if (haystack === undefined) return false;
    return state.tokens.every((token) => haystack.includes(token));
  }

  function applyFilters(): void {
    const base = getBaseSymbols();
    const isBaseAll = state.category === CATEGORY_ALL;
    const searching = state.tokens.length > 0;

    if (isBaseAll && !searching) {
      state.filtered = base;
    } else {
      state.filtered = base.filter((symbol) => {
        const index = data ? data.symbols.indexOf(symbol) : -1;
        return index >= 0 && matches(symbol, index);
      });
    }

    state.activeIndex = 0;
  }

  /**
   * Filters, then — when a search comes up empty inside the current
   * category but has matches across all characters — automatically widens
   * the scope to "All characters" so the user never hits a dead end.
   */
  function applyFiltersWithFallback(): void {
    applyFilters();
    if (
      state.tokens.length > 0 &&
      state.filtered.length === 0 &&
      state.category !== CATEGORY_ALL &&
      data &&
      data.symbols.some((symbol, index) => matches(symbol, index))
    ) {
      state.category = CATEGORY_ALL;
      renderCategories();
      applyFilters();
    }
  }

  // ------------------------------------------------------------ rendering

  function measure(): void {
    const styles = window.getComputedStyle(gridEl);
    cardSize = parseFloat(styles.getPropertyValue('--ucp-card')) || 86;
    gapSize = parseFloat(styles.getPropertyValue('--ucp-gap')) || 8;
    rowHeight = cardSize + gapSize;
    const available = gridInnerEl.clientWidth || gridEl.clientWidth - GRID_PAD * 2;
    columns = Math.max(1, Math.floor((available + gapSize) / (cardSize + gapSize)));
  }

  function totalRows(): number {
    return Math.ceil(state.filtered.length / columns);
  }

  function setGridHeight(): void {
    const rows = Math.max(1, totalRows());
    gridInnerEl.style.height = `${rows * rowHeight - gapSize}px`;
  }

  function cardMarkup(symbol: UnicodeSymbol, flatIndex: number): string {
    const row = Math.floor(flatIndex / columns);
    const column = flatIndex % columns;
    const x = column * (cardSize + gapSize);
    const y = row * rowHeight;
    const isActive = flatIndex === state.activeIndex;
    const isFav = state.favorites.has(symbol.char);
    const id = `ucp-opt-${symbol.codepoint}`;

    return (
      `<button type="button" class="ucp-card${isActive ? ' is-active' : ''}${isFav ? ' is-fav' : ''}" ` +
      `id="${id}" role="option" aria-selected="${isActive}" ` +
      `style="transform: translate(${x}px, ${y}px);" ` +
      `data-cp="${symbol.codepoint}" ` +
      `title="${escapeHtml(symbol.name)} · U+${codepointHex(symbol)}" ` +
      `aria-label="${escapeHtml(symbol.name)}">` +
      `<span class="ucp-glyph">${escapeHtml(symbol.char)}</span>` +
      `<span class="ucp-name">${highlightName(symbol.name, state.tokens)}</span>` +
      `<span class="ucp-star" aria-hidden="true">★</span>` +
      `</button>`
    );
  }

  function renderWindow(): void {
    if (!ready || !data) {
      renderSkeleton();
      return;
    }

    if (state.filtered.length === 0) {
      gridInnerEl.innerHTML = '';
      renderEmptyState();
      return;
    }

    removeEmptyState();

    const rows = totalRows();
    const scrollTop = gridEl.scrollTop;
    const viewportHeight = gridEl.clientHeight;
    const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
    const endRow = Math.min(
      rows,
      Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS
    );

    const chunks: string[] = [];
    for (let row = startRow; row < endRow; row++) {
      for (let column = 0; column < columns; column++) {
        const flatIndex = row * columns + column;
        if (flatIndex >= state.filtered.length) break;
        chunks.push(cardMarkup(state.filtered[flatIndex], flatIndex));
      }
    }
    gridInnerEl.innerHTML = chunks.join('');
    gridEl.setAttribute('aria-activedescendant', activeOptionId());
  }

  function renderSkeleton(): void {
    const skeletonCount = Math.max(24, columns * 5);
    const chunks: string[] = [];
    for (let i = 0; i < skeletonCount; i++) {
      const row = Math.floor(i / columns);
      const column = i % columns;
      chunks.push(
        `<div class="ucp-card is-skeleton" aria-hidden="true" style="transform: translate(${column * (cardSize + gapSize)}px, ${row * rowHeight}px);">` +
        `<span class="ucp-glyph"></span><span class="ucp-name"></span></div>`
      );
    }
    gridInnerEl.innerHTML = chunks.join('');
  }

  function emptyStateMarkup(): string {
    if (state.tokens.length > 0) {
      return (
        `<div class="ucp-empty">` +
        `<div class="ucp-empty-title">No characters match “${escapeHtml(state.query)}”</div>` +
        `<div class="ucp-empty-hint">Try shorter words, or browse categories like Math, Arrows, Currency or Emoji.</div>` +
        `</div>`
      );
    }
    if (state.category === CATEGORY_FAVORITES) {
      return (
        `<div class="ucp-empty">` +
        `<div class="ucp-empty-title">No favorites yet</div>` +
        `<div class="ucp-empty-hint">Hover a character and press <b>F</b> (or click ★) to pin it here.</div>` +
        `</div>`
      );
    }
    if (state.category === CATEGORY_RECENT) {
      return (
        `<div class="ucp-empty">` +
        `<div class="ucp-empty-title">No recently used characters</div>` +
        `<div class="ucp-empty-hint">Characters you insert are collected here for quick reuse.</div>` +
        `</div>`
      );
    }
    return `<div class="ucp-empty"><div class="ucp-empty-title">Nothing here</div></div>`;
  }

  function renderEmptyState(): void {
    if (gridEl.querySelector('.ucp-empty')) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = emptyStateMarkup();
    gridEl.appendChild(wrapper.firstElementChild as HTMLElement);
    gridEl.removeAttribute('aria-activedescendant');
  }

  function removeEmptyState(): void {
    gridEl.querySelectorAll('.ucp-empty').forEach((el) => el.remove());
  }

  function renderCategories(): void {
    if (!data) return;
    const chips: string[] = [];

    const special: Array<[string, string, string, number]> = [
      [CATEGORY_FAVORITES, '★', 'Favorites', state.favorites.size],
      [CATEGORY_RECENT, '↺', 'Recent', state.recents.length]
    ];
    for (const [key, glyph, label, count] of special) {
      chips.push(catMarkup(key, glyph, label, count));
    }
    chips.push(
      `<div class="ucp-cats-divider" role="separator"></div>`
    );
    chips.push(catMarkup(CATEGORY_ALL, '☰', 'All characters', data.totalCount));
    chips.push(`<div class="ucp-cats-divider" role="separator"></div>`);

    for (const category of data.categories) {
      chips.push(catMarkup(category.label, category.glyph, category.label, category.count));
    }

    categoriesEl.innerHTML = chips.join('');
  }

  function catMarkup(key: string, glyph: string, label: string, count: number): string {
    const isActive = state.category === key;
    return (
      `<button type="button" class="ucp-cat${isActive ? ' is-active' : ''}" data-cat="${escapeHtml(key)}" ` +
      `aria-pressed="${isActive}">` +
      `<span class="ucp-cat-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>` +
      `<span class="ucp-cat-name">${escapeHtml(label)}</span>` +
      `<span class="ucp-cat-count">${count}</span>` +
      `</button>`
    );
  }

  function renderDetail(): void {
    if (!data) return;
    const symbol = state.filtered[state.activeIndex];

    if (!symbol) {
      detailEl.innerHTML =
        `<div class="ucp-detail-placeholder">Select a character to preview it here.<br>Press <b>/</b> to jump to search.</div>`;
      return;
    }

    const isFav = state.favorites.has(symbol.char);
    detailEl.innerHTML =
      `<div class="ucp-detail-glyph" aria-hidden="true">${escapeHtml(symbol.char)}</div>` +
      `<div class="ucp-detail-name">${highlightName(symbol.name, state.tokens)}</div>` +
      `<div class="ucp-detail-chips">` +
      `<button type="button" class="ucp-chip" data-copy="U+${codepointHex(symbol)}" title="Copy code point">U+${codepointHex(symbol)}</button>` +
      `<button type="button" class="ucp-chip" data-copy="&#${symbol.codepoint};" title="Copy HTML entity">&amp;#${symbol.codepoint};</button>` +
      `<button type="button" class="ucp-chip is-cat" data-cat="${escapeHtml(symbol.category)}">${escapeHtml(symbol.category)}</button>` +
      `</div>` +
      `<div class="ucp-detail-actions">` +
      `<button type="button" class="ucp-btn ucp-btn-primary" data-action="insert">Insert</button>` +
      `<button type="button" class="ucp-btn" data-action="copy">Copy character</button>` +
      `<button type="button" class="ucp-btn ucp-btn-star${isFav ? ' is-fav' : ''}" data-action="star">` +
      `<span class="ucp-btn-star-icon" aria-hidden="true">${isFav ? '★' : '☆'}</span>` +
      `<span class="ucp-btn-star-label">${isFav ? 'Favorited' : 'Favorite'}</span>` +
      `</button>` +
      `</div>`;
  }

  function renderStatus(): void {
    if (!data) {
      statusEl.textContent = 'Loading characters…';
      return;
    }
    const symbol = state.filtered[state.activeIndex];
    const activeInfo = symbol
      ? ` · <span class="ucp-status-active">${escapeHtml(symbol.char)} U+${codepointHex(symbol)}</span>`
      : '';

    if (state.tokens.length > 0) {
      statusEl.innerHTML =
        `${state.filtered.length.toLocaleString()} match${state.filtered.length === 1 ? '' : 'es'} for “${escapeHtml(state.query)}”` +
        ` of ${data.totalCount.toLocaleString()}${activeInfo}`;
    } else {
      statusEl.innerHTML =
        `${state.filtered.length.toLocaleString()} of ${data.totalCount.toLocaleString()} characters${activeInfo}`;
    }
  }

  function renderAll(): void {
    applyFilters();
    measure();
    setGridHeight();
    renderWindow();
    renderDetail();
    renderStatus();
  }

  function refreshDynamicCounts(): void {
    // Update favorite/recent chips in place without a full nav rebuild.
    const favCount = categoriesEl.querySelector('[data-cat="favorites"] .ucp-cat-count');
    if (favCount) favCount.textContent = String(state.favorites.size);
    const recentCount = categoriesEl.querySelector('[data-cat="recent"] .ucp-cat-count');
    if (recentCount) recentCount.textContent = String(state.recents.length);
  }

  // ------------------------------------------------------------- navigation

  function activeOptionId(): string {
    const symbol = state.filtered[state.activeIndex];
    return symbol ? `ucp-opt-${symbol.codepoint}` : '';
  }

  function getActiveSymbol(): UnicodeSymbol | undefined {
    return state.filtered[state.activeIndex];
  }

  function setActive(index: number, options?: { scroll?: boolean }): void {
    const count = state.filtered.length;
    if (count === 0) {
      state.activeIndex = 0;
      renderDetail();
      renderStatus();
      return;
    }
    const wrapped = ((index % count) + count) % count;
    if (wrapped === state.activeIndex && options?.scroll !== true) {
      renderDetail();
      return;
    }
    state.activeIndex = wrapped;

    // Update classes on the (virtual) cards without a full re-render.
    gridInnerEl.querySelectorAll('.ucp-card.is-active').forEach((el) => {
      el.classList.remove('is-active');
      el.setAttribute('aria-selected', 'false');
    });
    const activeEl = gridInnerEl.querySelector(`#${activeOptionId()}`);
    if (activeEl) {
      activeEl.classList.add('is-active');
      activeEl.setAttribute('aria-selected', 'true');
    }
    gridEl.setAttribute('aria-activedescendant', activeOptionId());

    if (options?.scroll !== false) {
      scrollActiveIntoView();
    }
    renderDetail();
    renderStatus();
  }

  function scrollActiveIntoView(): void {
    const count = state.filtered.length;
    if (count === 0) return;
    const row = Math.floor(state.activeIndex / columns);
    const cardTop = row * rowHeight;
    const cardBottom = cardTop + rowHeight;
    const viewTop = gridEl.scrollTop;
    const viewBottom = viewTop + gridEl.clientHeight;

    if (cardTop < viewTop) {
      gridEl.scrollTop = cardTop;
      scheduleRender();
    } else if (cardBottom > viewBottom) {
      gridEl.scrollTop = cardBottom - gridEl.clientHeight;
      scheduleRender();
    }
  }

  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(() => {
      renderQueued = false;
      renderWindow();
    });
  }

  function moveActive(delta: number): void {
    if (state.filtered.length === 0) return;
    setActive(state.activeIndex + delta);
  }

  function pageDelta(): number {
    const visibleRows = Math.max(1, Math.floor(gridEl.clientHeight / rowHeight));
    return visibleRows * columns;
  }

  // ------------------------------------------------------------ insert/copy

  function insertSymbol(symbol: UnicodeSymbol, keepOpen = false): void {
    const editor = notepad.note.get(0) as HTMLElement | undefined;
    if (!editor) return;

    editor.focus();

    const selection = window.getSelection();
    const selectionLivesInEditor =
      !!selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).commonAncestorContainer);

    if (!selectionLivesInEditor) {
      // Park the caret at the end so the symbol lands in the note.
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    let inserted = false;
    if (typeof document.execCommand === 'function') {
      inserted = document.execCommand('insertText', false, symbol.char);
    }
    if (!inserted && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(symbol.char));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    pushRecent(symbol.char);

    if (!keepOpen) {
      close();
    } else if (state.category === CATEGORY_RECENT) {
      applyFilters();
      setGridHeight();
      renderWindow();
      renderStatus();
    }
  }

  function close(): void {
    $modal.modal('hide');
  }

  function pushRecent(char: string): void {
    state.recents = [char, ...state.recents.filter((c) => c !== char)].slice(0, RECENT_LIMIT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(state.recents));
    } catch {
      /* storage unavailable — keep in-memory state */
    }
    refreshDynamicCounts();
  }

  function toggleFavorite(char: string): void {
    if (state.favorites.has(char)) {
      state.favorites.delete(char);
    } else {
      state.favorites.add(char);
    }
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
    } catch {
      /* storage unavailable — keep in-memory state */
    }

    const isFav = state.favorites.has(char);
    gridInnerEl.querySelectorAll(`.ucp-card[data-cp]`).forEach((el) => {
      if ((el as HTMLElement).dataset.cp === String(symbolOfChar(char)?.codepoint)) {
        el.classList.toggle('is-fav', isFav);
      }
    });
    renderDetail();
    refreshDynamicCounts();

    if (state.category === CATEGORY_FAVORITES) {
      renderAll();
    }
  }

  function copyText(text: string, label: string): void {
    const fallbackCopy = (): boolean => {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', 'true');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      let succeeded = false;
      try {
        succeeded = document.execCommand('copy');
      } catch {
        succeeded = false;
      }
      scratch.remove();
      return succeeded;
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast(`Copied ${label}`))
        .catch(() => {
          showToast(fallbackCopy() ? `Copied ${label}` : 'Copy failed');
        });
    } else {
      showToast(fallbackCopy() ? `Copied ${label}` : 'Copy failed');
    }
  }

  // ---------------------------------------------------------------- search

  function syncSearchClear(): void {
    searchClear.hidden = searchInput.value.length === 0;
  }

  function onSearchInput(): void {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.query = searchInput.value;
      const normalized = normalizeQuery(state.query);
      state.tokens = normalized ? normalized.split(' ') : [];
      state.activeIndex = 0;
      applyFiltersWithFallback();
      setGridHeight();
      gridEl.scrollTop = 0;
      renderWindow();
      renderDetail();
      renderStatus();
    }, SEARCH_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- events

  function bindEvents(): void {
    $('#unicodePickerTrigger').on('click', (event) => {
      event.preventDefault();
      open();
    });

    $modal.on('shown.bs.modal', () => {
      searchInput.focus();
      void ensureReady();
    });

    $modal.on('hidden.bs.modal', () => {
      searchInput.value = '';
      state.query = '';
      state.tokens = [];
      syncSearchClear();
      applyFilters();
      setGridHeight();
      gridEl.scrollTop = 0;
      renderWindow();
      renderStatus();
    });

    searchInput.addEventListener('input', () => {
      syncSearchClear();
      onSearchInput();
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      state.query = '';
      state.tokens = [];
      syncSearchClear();
      searchInput.focus();
      applyFilters();
      setGridHeight();
      gridEl.scrollTop = 0;
      renderWindow();
      renderDetail();
      renderStatus();
    });

    categoriesEl.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-cat]') as HTMLElement | null;
      if (!target) return;
      state.category = target.dataset.cat ?? CATEGORY_ALL;
      state.activeIndex = 0;
      renderCategories();
      applyFilters();
      setGridHeight();
      gridEl.scrollTop = 0;
      renderWindow();
      renderDetail();
      renderStatus();
    });

    gridEl.addEventListener('scroll', scheduleRender);

    gridInnerEl.addEventListener('click', (event) => {
      const star = (event.target as HTMLElement).closest('.ucp-star') as HTMLElement | null;
      const card = (event.target as HTMLElement).closest('.ucp-card') as HTMLElement | null;
      if (!card) return;
      const symbol = resolveCardSymbol(card);
      if (!symbol) return;

      if (star) {
        toggleFavorite(symbol.char);
        return;
      }
      insertSymbol(symbol, (event as MouseEvent).shiftKey);
    });

    gridInnerEl.addEventListener('mouseover', (event) => {
      const card = (event.target as HTMLElement).closest('.ucp-card') as HTMLElement | null;
      if (!card || card.classList.contains('is-skeleton')) return;
      const symbol = resolveCardSymbol(card);
      if (!symbol) return;
      const index = state.filtered.indexOf(symbol);
      if (index >= 0 && index !== state.activeIndex) {
        setActive(index, { scroll: false });
      }
    });

    detailEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      const copyChip = target.closest('[data-copy]') as HTMLElement | null;
      if (copyChip) {
        copyText(copyChip.dataset.copy ?? '', copyChip.dataset.copy ?? '');
        return;
      }

      const catChip = target.closest('[data-cat]') as HTMLElement | null;
      if (catChip) {
        state.category = catChip.dataset.cat ?? CATEGORY_ALL;
        state.activeIndex = 0;
        renderCategories();
        applyFilters();
        setGridHeight();
        gridEl.scrollTop = 0;
        renderWindow();
        renderDetail();
        renderStatus();
        return;
      }

      const actionButton = target.closest('[data-action]') as HTMLElement | null;
      if (actionButton) {
        const symbol = getActiveSymbol();
        if (!symbol) return;
        switch (actionButton.dataset.action) {
          case 'insert':
            insertSymbol(symbol, (event as MouseEvent).shiftKey);
            break;
          case 'copy':
            copyText(symbol.char, `${symbol.char} (${symbol.name})`);
            break;
          case 'star':
            toggleFavorite(symbol.char);
            break;
        }
      }
    });

    function handleNavigation(event: KeyboardEvent): boolean {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveActive(columns);
          return true;
        case 'ArrowUp':
          event.preventDefault();
          moveActive(-columns);
          return true;
        case 'ArrowRight':
          event.preventDefault();
          moveActive(1);
          return true;
        case 'ArrowLeft':
          event.preventDefault();
          moveActive(-1);
          return true;
        case 'PageDown':
          event.preventDefault();
          moveActive(pageDelta());
          return true;
        case 'PageUp':
          event.preventDefault();
          moveActive(-pageDelta());
          return true;
        case 'Home':
          event.preventDefault();
          setActive(0);
          gridEl.scrollTop = 0;
          return true;
        case 'End':
          event.preventDefault();
          setActive(state.filtered.length - 1);
          return true;
        case 'Enter':
          event.preventDefault();
          {
            const symbol = getActiveSymbol();
            if (symbol) insertSymbol(symbol, event.shiftKey);
          }
          return true;
        case 'f':
        case 'F': {
          const symbol = getActiveSymbol();
          if (symbol) {
            event.preventDefault();
            toggleFavorite(symbol.char);
          }
          return true;
        }
        case 'c':
        case 'C': {
          const symbol = getActiveSymbol();
          if (symbol) {
            event.preventDefault();
            copyText(symbol.char, `${symbol.char} (${symbol.name})`);
          }
          return true;
        }
        default:
          return false;
      }
    }

    searchInput.addEventListener('keydown', (event) => {
      // While typing in search, arrows navigate the grid; Enter inserts.
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Enter'].includes(event.key)) {
        handleNavigation(event);
      }
    });

    gridEl.addEventListener('keydown', (event) => {
      handleNavigation(event);
    });

    // "/" anywhere inside the modal jumps to search.
    $modal.on('keydown', (event) => {
      const keyEvent = event.originalEvent as KeyboardEvent | undefined;
      if (!keyEvent) return;
      if (keyEvent.key === '/' && keyEvent.target !== searchInput) {
        keyEvent.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!ready || !gridEl.offsetParent) return;
      measure();
      setGridHeight();
      scheduleRender();
    });
    resizeObserver.observe(gridEl);
  }

  function resolveCardSymbol(card: HTMLElement): UnicodeSymbol | undefined {
    const codepoint = Number(card.dataset.cp);
    const symbol = state.filtered.find((s) => s.codepoint === codepoint);
    return symbol ?? symbolOfChar(String.fromCodePoint(codepoint));
  }

  // ------------------------------------------------------------------ init

  function ensureReady(): Promise<void> {
    if (ready) return Promise.resolve();
    return loadData().then((loaded) => {
      data = loaded;
      ready = true;
      renderCategories();
      renderAll();
    });
  }

  bindEvents();
  renderDetail();
  renderStatus();

  let hasOpenedOnce = false;

  function open(): void {
    $modal.modal('show');
    void ensureReady().then(() => {
      // On the first open of a session, land the user on their recently
      // used characters (their most likely intent) when any exist.
      if (!hasOpenedOnce) {
        hasOpenedOnce = true;
        if (state.category === CATEGORY_ALL && getRecentSymbols().length > 0) {
          state.category = CATEGORY_RECENT;
          renderCategories();
          renderAll();
        }
      }
    });
  }

  return {
    open,
    insertSymbol
  };
}

export default initUnicodePicker;
