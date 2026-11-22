/**
 * The tab strip's badges under the Note-badges preference.
 *
 * The strip sits directly under the note list — the one surface where a
 * per-note decoration either helps or accumulates into noise. This pins
 * the preference's exact reach:
 *  - ON (the default, nothing stored): the voice mic, the type icons
 *    (drawing, markdown, rich…), the task-list dot all show, exactly as
 *    before the preference existed;
 *  - OFF: the tabs are just their name and their close button — no
 *    identification badges of any kind;
 *  - the conflict badge is NOT part of the deal: it is an actionable
 *    alert (its click opens the review sheet), so it shows even with the
 *    preference off;
 *  - flipping the preference at runtime re-renders the live strip — the
 *    view subscribes to the setting itself, no reboot needed.
 *
 * Direct view construction with a stub host: the badge logic is the
 * view's, and the manager+storage path is already covered by the
 * characterization suite in tabs.characterization.test.ts.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { $, type Q } from '../lib/q';
import { resetStorageForTests, storageReady } from '../storage';
import { setSetting } from '../state/settings';
import { TabStripView, type TabStripHost } from './strip-view';
import type { NoteTab } from './domain';
// Side-effect import: registers the tasks kind's projection, whose
// stripBadge is the colored list dot the rail shows for task lists.
import '../features/tasks/note/projection';

function makeTab(overrides: Partial<NoteTab> & { id: string }): NoteTab {
  return {
    name: null,
    content: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function stubHost(tabs: NoteTab[], conflictedIds: string[] = []): TabStripHost {
  return {
    modelTabs: () => tabs,
    activeTabId: () => tabs[0]?.id ?? null,
    isConflicted: (tabId) => conflictedIds.includes(tabId),
    onConflictReview: () => {},
    switchTo: () => {},
    requestCloseTab: () => {},
    addTab: () => {},
    focusEditor: () => {},
    commitRename: () => true,
  };
}

function mountStrip(): Q {
  document.body.innerHTML = '<div id="tabStrip"></div>';
  return $('#tabStrip');
}

const badgesIn = (strip: Q): number => strip.find('.tab-strip-type').length;

describe('the Note-badges preference (tab-strip badges)', () => {
  beforeEach(async () => {
    resetStorageForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
    localStorage.clear();
    await storageReady();
  });

  const sampleTabs = (): NoteTab[] => [
    makeTab({ id: 't-rich', content: '<b>rich</b>', noteType: 'rich' }),
    makeTab({ id: 't-drawing', content: '', noteType: 'drawing' }),
    makeTab({ id: 't-voice', content: '<audio controls src="padify-att:abc123"></audio>' }),
    makeTab({ id: 't-tasks', content: '', noteType: 'tasks' }),
    makeTab({ id: 't-plain', content: 'plain' }),
  ];

  it('with nothing stored the badges show exactly as before', () => {
    const view = new TabStripView(mountStrip(), stubHost(sampleTabs()));

    view.render();

    const strip = $('#tabStrip');
    // One badge per non-plain tab: type icon (rich), type icon (drawing),
    // voice mic, list dot — the plain note carries none.
    expect(badgesIn(strip)).toBe(4);
    expect(strip.find('[data-tab-id="t-rich"] .tab-strip-type svg').length).toBeGreaterThan(0);
    expect(strip.find('[data-tab-id="t-drawing"] .tab-strip-type svg').length).toBeGreaterThan(0);
    expect(strip.find('[data-tab-id="t-voice"] .tab-strip-type').length).toBe(1);
    expect(strip.find('[data-tab-id="t-tasks"] .tab-strip-list-dot').length).toBe(1);
    expect(strip.find('[data-tab-id="t-plain"] .tab-strip-type').length).toBe(0);
  });

  it('with the preference stored No the tabs are name + close only', () => {
    setSetting('userChosenNoteBadges', 'No');
    const view = new TabStripView(mountStrip(), stubHost(sampleTabs()));

    view.render();

    expect(badgesIn($('#tabStrip'))).toBe(0);
    // The parts that ARE the tab survive: title and close button.
    expect($('#tabStrip').find('.tab-strip-title').length).toBe(5);
    expect($('#tabStrip').find('.tab-strip-close').length).toBe(5);
  });

  it('the conflict badge survives the preference — it is an alert, not identification', () => {
    setSetting('userChosenNoteBadges', 'No');
    const view = new TabStripView(
      mountStrip(),
      stubHost([makeTab({ id: 't-c', content: 'x' })], ['t-c']),
    );

    view.render();

    expect($('#tabStrip').find('.tab-strip-conflict').length).toBe(1);
    expect($('#tabStrip').find('.tab-strip-type').length).toBe(1); // only the conflict badge
  });

  it('flipping the preference re-renders the live strip without a reboot', () => {
    const view = new TabStripView(mountStrip(), stubHost(sampleTabs()));
    view.render();
    expect(badgesIn($('#tabStrip'))).toBe(4);

    setSetting('userChosenNoteBadges', 'No');
    expect(badgesIn($('#tabStrip'))).toBe(0);

    setSetting('userChosenNoteBadges', 'Yes');
    expect(badgesIn($('#tabStrip'))).toBe(4);
  });
});
