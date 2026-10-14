/**
 * The Reminders markup — icons, the modal (sidebar + views + the composer
 * bar), and the mount that puts them in the DOM.
 *
 * The layout is the music player's, wearing Apple Reminders' clothes: a
 * left sidebar switches destinations (Today, Scheduled, All, Flagged,
 * Completed + custom lists), the content pane lists the tasks, and where
 * the player bar rides the bottom, the composer does — the "New
 * Reminder" row every Reminders app keeps pinned. Pure markup: the
 * controller (index.ts) owns behavior, rows are built in rows.ts.
 */

// ---------------------------------------------------------------------------
// Icons (inline, currentColor — same stroke language as the music player)
// ---------------------------------------------------------------------------

const icon = (paths: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = {
  // The header + empty states
  done: icon('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>', 18),
  // Sidebar destinations
  today: icon(
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="12" cy="14.6" r="1.3" fill="currentColor" stroke="none"/>',
    17,
  ),
  scheduled: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 17),
  all: icon(
    '<path d="M3.5 13h4l2 4.5h5l2-4.5h4"/><path d="M5.3 7.5 3.5 13v4.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V13l-1.8-5.5a2 2 0 0 0-1.9-1.4H7.2a2 2 0 0 0-1.9 1.4z"/>',
    17,
  ),
  flagged: icon(
    '<path d="M5 21V4.5C7 3 9 3 11 4.5s4 1.5 6 0V14c-2 1.5-4 1.5-6 0s-4-1.5-6 0"/>',
    17,
  ),
  completed: icon('<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.4 2.5 2.5 5-5.4"/>', 17),
  // Composer + chips
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 17),
  plus: icon('<path d="M12 5v14M5 12h14"/>', 15),
  calendar: icon(
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    14,
  ),
  bell: icon(
    '<path d="M6 9a6 6 0 0 1 12 0c0 5 1.8 6 1.8 6H4.2S6 14 6 9"/><path d="M10.3 19.5a2 2 0 0 0 3.4 0"/>',
    14,
  ),
  flag: icon('<path d="M5 21V4.5C7 3 9 3 11 4.5s4 1.5 6 0V14c-2 1.5-4 1.5-6 0s-4-1.5-6 0"/>', 14),
  flagFilled: icon(
    '<path fill="currentColor" stroke="none" d="M5.6 3.4C7.4 2.2 9.3 2.4 11 4c1.8 1.6 3.7 1.7 5.4.4V14c-1.8 1.3-3.7 1.2-5.4-.4-1.7-1.6-3.6-1.8-5.4-.6z"/><path d="M5 21V4"/>',
    14,
  ),
  info: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8h.01"/>', 15),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>', 16),
  chevron: icon('<path d="m9 6 6 6-6 6"/>', 13),
  // The composer's "add" affordance — Apple's hollow circle with a plus.
  addCircle: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>', 17),
  trash: icon(
    '<path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7"/><path d="M10 11v6M14 11v6"/>',
    14,
  ),
};

// ---------------------------------------------------------------------------
// Markup builders
// ---------------------------------------------------------------------------

const navItem = (id: string, view: string, iconSvg: string, label: string, extra = ''): string => `
                    <button type="button" class="tk-nav-item" id="${id}" role="tab" data-view="${view}" aria-selected="false" tabindex="-1">
                        <span class="tk-nav-icon">${iconSvg}</span>
                        <span class="tk-nav-label">${label}</span>
                        ${extra}
                    </button>`;

const countBadge = (id: string): string => `<span class="tk-nav-count" id="${id}" hidden></span>`;

const tasksModalHtml = `
<div class="modal fade tk-modal" id="tasksModal" tabindex="-1" role="dialog" aria-labelledby="tasksTitle">
    <div class="modal-dialog modal-lg tk-dialog" role="document">
        <div class="modal-content tk-content">
            <div class="modal-header tk-header">
                <h4 class="modal-title tk-title" id="tasksTitle">
                    ${ICONS.done}
                    <span>Reminders</span>
                </h4>
                <button type="button" class="close" data-dismiss="modal" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
            </div>

            <div class="modal-body tk-body">
                <nav class="tk-nav" aria-label="Reminders sections">
                    <div class="tk-search" id="tkSearch">
                        ${ICONS.search}
                        <input type="search" id="tkSearchInput" class="tk-search-input" placeholder="Search reminders…" autocomplete="off" spellcheck="false" aria-label="Search reminders">
                        <button type="button" class="tk-search-clear" id="tkSearchClear" aria-label="Clear search" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
                    </div>

                    <div class="tk-nav-scroll">
                        ${navItem('tkNavToday', 'today', ICONS.today, 'Today', countBadge('tkCountToday'))}
                        ${navItem('tkNavScheduled', 'scheduled', ICONS.scheduled, 'Scheduled', countBadge('tkCountScheduled'))}
                        ${navItem('tkNavAll', 'all', ICONS.all, 'All', countBadge('tkCountAll'))}
                        ${navItem('tkNavFlagged', 'flagged', ICONS.flagged, 'Flagged', countBadge('tkCountFlagged'))}
                        ${navItem('tkNavCompleted', 'completed', ICONS.completed, 'Completed', countBadge('tkCountCompleted'))}

                        <div class="tk-nav-group" id="tkListsGroup" hidden>
                            <span class="tk-nav-group-label">My Lists</span>
                            <div class="tk-nav-lists" id="tkListNav"></div>
                        </div>
                        <button type="button" class="tk-nav-add" id="tkAddList">
                            <span class="tk-nav-icon">${ICONS.plus}</span>
                            <span class="tk-nav-label">Add List</span>
                        </button>
                    </div>
                </nav>

                <div class="tk-main">
                    <header class="tk-list-head" id="tkViewHead">
                        <h4 class="tk-list-title" id="tkViewTitle">Today</h4>
                        <span class="tk-section-count" id="tkViewCount"></span>
                        <span class="tk-list-actions" id="tkViewActions"></span>
                    </header>

                    <div class="tk-scroll" id="tkScroll">
                        <div class="tk-lists" id="tkSections"></div>
                        <div class="tk-empty" id="tkEmpty" hidden></div>
                    </div>
                </div>
            </div>

            <div class="tk-composer" id="tkComposer">
                <div class="tk-composer-row">
                    <button type="button" class="tk-composer-add" id="tkComposerAdd" title="Add reminder" aria-label="Add reminder">${ICONS.addCircle}</button>
                    <input type="text" id="tkComposerInput" class="tk-composer-input" placeholder="New Reminder" autocomplete="off" aria-label="New reminder title">
                </div>
                <div class="tk-composer-details" id="tkComposerDetails" hidden>
                    <button type="button" class="tk-chip-btn" id="tkComposerDate">${ICONS.calendar}<span id="tkComposerDateLabel">Date</span></button>
                    <button type="button" class="tk-chip-btn" id="tkComposerRemind">${ICONS.bell}<span id="tkComposerRemindLabel">Remind</span></button>
                    <button type="button" class="tk-chip-btn" id="tkComposerFlag" aria-pressed="false">${ICONS.flag}<span>Flag</span></button>
                    <button type="button" class="tk-chip-btn" id="tkComposerPriority">${ICONS.chevron}<span id="tkComposerPriorityLabel">Priority</span></button>
                </div>
            </div>
        </div>
    </div>
</div>`;

/**
 * Mounts the Reminders modal markup. Called by boot.ts before the engine
 * loads (the controller arrives lazily on the first open — app.ts).
 */
export function mountTasks(): void {
  document.body.insertAdjacentHTML('beforeend', tasksModalHtml);
}
