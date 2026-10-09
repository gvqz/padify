/**
 * Unit suite for the settings navigation (src/ui/settings-nav.ts) — the
 * rebuilt two-pane preferences modal.
 *
 * What this pins, and why it matters:
 *  - the section nav is a real tablist: one pane visible at a time, the
 *    active tab marked with aria-selected and the roving tabindex, and
 *    the arrow/Home/End keys move between the sections the user can
 *    actually reach (the cloud section is skipped while its pane is
 *    hidden, reachable the moment the backend reveals it);
 *  - the first section is the landing pane — the e2e pair (theme flip
 *    through the real preferences UI) depends on the theme segmented
 *    control being on screen the moment the modal opens;
 *  - search flattens the panes: a query shows every pane with a matching
 *    row (rows that don't match are filtered out), a section-name match
 *    shows the whole section, an all-miss query shows the empty state,
 *    and the nav itself steps aside until the query clears;
 *  - Escape over a live query clears the search and STAYS in the modal
 *    (the keydown stops propagating before the modal controller's
 *    document-level Escape listener can close the dialog), while over an
 *    empty search it bubbles on — the modal closes as before.
 *
 * The markup under test is the shipped partial itself (mounted verbatim),
 * so the pane/tab/row structure the module walks can never drift from
 * what index.html serves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initSettingsNav, resetSettingsNavForTests } from './settings-nav';

const preferencesHtml = readFileSync(
  resolve(process.cwd(), 'src/ui/modals/preferences-modal.html'),
  'utf-8',
);

function mountPreferences(): void {
  document.body.innerHTML = preferencesHtml;
  resetSettingsNavForTests();
  initSettingsNav();
}

function pane(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing #${id} in mounted preferences markup`);
  }
  return el;
}

function search(): HTMLInputElement {
  return pane('prefSearch') as HTMLInputElement;
}

function type(query: string): void {
  search().value = query;
  search().dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  mountPreferences();
});

describe('settings navigation', () => {
  it('lands on the Appearance pane with its tab marked active', () => {
    expect(pane('prefPaneAppearance').classList.contains('is-active')).toBe(true);
    expect(pane('prefPaneText').classList.contains('is-active')).toBe(false);

    const appearanceTab = pane('prefNavAppearance');
    expect(appearanceTab.getAttribute('aria-selected')).toBe('true');
    expect(appearanceTab.tabIndex).toBe(0);
    expect(pane('prefNavText').getAttribute('aria-selected')).toBe('false');
    expect(pane('prefNavText').tabIndex).toBe(-1);
  });

  it('clicking a nav tab shows exactly that pane', () => {
    pane('prefNavText').click();
    expect(pane('prefPaneText').classList.contains('is-active')).toBe(true);
    expect(pane('prefPaneAppearance').classList.contains('is-active')).toBe(false);
    expect(pane('prefNavText').getAttribute('aria-selected')).toBe('true');

    pane('prefNavEffects').click();
    expect(pane('prefPaneEffects').classList.contains('is-active')).toBe(true);
    expect(pane('prefPaneText').classList.contains('is-active')).toBe(false);
  });

  it('arrow keys walk the visible sections, Home/End jump the rails', () => {
    const nav = pane('prefNav');

    pressKey(nav, 'ArrowRight');
    expect(pane('prefPaneText').classList.contains('is-active')).toBe(true);

    pressKey(nav, 'ArrowDown');
    expect(pane('prefPaneWriting').classList.contains('is-active')).toBe(true);

    pressKey(nav, 'ArrowLeft');
    expect(pane('prefPaneText').classList.contains('is-active')).toBe(true);

    pressKey(nav, 'End');
    expect(pane('prefPaneEffects').classList.contains('is-active')).toBe(true);

    pressKey(nav, 'Home');
    expect(pane('prefPaneAppearance').classList.contains('is-active')).toBe(true);
  });

  it('skips the hidden cloud section — and reaches it once revealed', () => {
    const nav = pane('prefNav');
    const cloudTab = pane('cloudSettingsNav');

    // Hidden at boot: the wrap from the last visible section must land on
    // the first, never on the hidden cloud tab.
    pressKey(nav, 'End');
    expect(pane('prefPaneEffects').classList.contains('is-active')).toBe(true);
    pressKey(nav, 'ArrowRight');
    expect(pane('prefPaneAppearance').classList.contains('is-active')).toBe(true);
    expect(pane('cloudSettingsSection').classList.contains('is-active')).toBe(false);

    // The backend revealing the pane + tab (cloud/ui.ts) puts it in play.
    pane('cloudSettingsSection').removeAttribute('hidden');
    cloudTab.removeAttribute('hidden');

    cloudTab.click();
    expect(pane('cloudSettingsSection').classList.contains('is-active')).toBe(true);

    pressKey(nav, 'ArrowRight');
    expect(pane('prefPaneAppearance').classList.contains('is-active')).toBe(true);
  });
});

describe('settings search', () => {
  it('a row query shows only the panes with matching rows, filtered to those rows', () => {
    type('font');

    const layout = pane('prefLayout');
    expect(layout.classList.contains('is-searching')).toBe(true);
    expect(pane('prefNav').hasAttribute('hidden')).toBe(true);

    expect(pane('prefPaneText').classList.contains('is-match')).toBe(true);
    expect(pane('prefPaneAppearance').classList.contains('is-match')).toBe(false);
    expect(pane('prefPaneWriting').classList.contains('is-match')).toBe(false);

    const rows = Array.from(pane('prefPaneText').querySelectorAll('.pref-row'));
    const visibleTitles = rows
      .filter((row) => !row.classList.contains('is-filtered'))
      .map((row) => row.querySelector('.pref-row-title')?.textContent?.trim());
    expect(visibleTitles).toEqual(['Font', 'Font size']);
  });

  it('a section-name query shows that whole section', () => {
    type('effects');

    expect(pane('prefPaneEffects').classList.contains('is-match')).toBe(true);
    const filtered = Array.from(pane('prefPaneEffects').querySelectorAll('.pref-row')).filter(
      (row) => row.classList.contains('is-filtered'),
    );
    expect(filtered).toEqual([]);
    expect(pane('prefPaneAppearance').classList.contains('is-match')).toBe(false);
    expect(pane('prefPaneText').classList.contains('is-match')).toBe(false);
  });

  it('the badge does not make its row searchable ("new" matches nothing)', () => {
    type('new');
    expect(pane('prefPaneWriting').classList.contains('is-match')).toBe(false);
    expect(pane('prefSearchEmpty').hidden).toBe(false);
  });

  it('an all-miss query shows the empty state with the query echoed', () => {
    type('zzz');
    expect(pane('prefSearchEmpty').hidden).toBe(false);
    expect(pane('prefSearchEmptyQuery').textContent).toBe('zzz');
    expect(pane('prefPaneText').classList.contains('is-match')).toBe(false);
  });

  it('clearing the query restores the remembered pane and unfilters rows', () => {
    pane('prefNavWriting').click();
    type('font');
    type('');

    const layout = pane('prefLayout');
    expect(layout.classList.contains('is-searching')).toBe(false);
    expect(pane('prefNav').hasAttribute('hidden')).toBe(false);
    // The pane the user was on before the search comes back.
    expect(pane('prefPaneWriting').classList.contains('is-active')).toBe(true);
    expect(pane('prefPaneText').classList.contains('is-match')).toBe(false);
    const stillFiltered = Array.from(pane('prefPaneText').querySelectorAll('.pref-row')).filter(
      (row) => row.classList.contains('is-filtered'),
    );
    expect(stillFiltered).toEqual([]);
    expect(pane('prefSearchEmpty').hidden).toBe(true);
  });

  it('a hidden cloud pane never matches a search that would otherwise hit it', () => {
    type('backup');
    expect(pane('cloudSettingsSection').classList.contains('is-match')).toBe(false);

    pane('cloudSettingsSection').removeAttribute('hidden');
    type('backup');
    expect(pane('cloudSettingsSection').classList.contains('is-match')).toBe(true);
  });

  it('Escape over a live query clears the search and does not reach the document', () => {
    const documentEscape = vi.fn();
    document.addEventListener('keydown', documentEscape);

    type('font');
    pressKey(search(), 'Escape');

    expect(search().value).toBe('');
    expect(pane('prefLayout').classList.contains('is-searching')).toBe(false);
    expect(documentEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', documentEscape);
  });

  it('Escape over an empty search bubbles on (the modal stays closable)', () => {
    const documentEscape = vi.fn();
    document.addEventListener('keydown', documentEscape);

    pressKey(search(), 'Escape');

    expect(documentEscape).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', documentEscape);
  });
});
