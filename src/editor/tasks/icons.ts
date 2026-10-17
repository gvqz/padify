/**
 * Task list notes — the icon set (inline, currentColor — the same stroke
 * language as the music player and the retired modal's icons).
 *
 * Shared by the note surface (editor/tasks), the right rail, the hub
 * pages and the reminder sweep, so every tasks-flavored pixel speaks the
 * same iconography.
 */

const icon = (paths: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = {
  // The feature mark (rail head, topbar, empty states)
  done: icon('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>', 18),
  // Smart destinations
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
  calendar: icon(
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    17,
  ),
  // Composer + chips
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 17),
  plus: icon('<path d="M12 5v14M5 12h14"/>', 15),
  bell: icon(
    '<path d="M6 9a6 6 0 0 1 12 0c0 5 1.8 6 1.8 6H4.2S6 14 6 9"/><path d="M10.3 19.5a2 2 0 0 0 3.4 0"/>',
    14,
  ),
  flag: icon('<path d="M5 21V4.5C7 3 9 3 11 4.5s4 1.5 6 0V14c-2 1.5-4 1.5-6 0s-4-1.5-6 0"/>', 14),
  flagFilled: icon(
    '<path fill="currentColor" stroke="none" d="M5.6 3.4C7.4 2.2 9.3 2.4 11 4c1.8 1.6 3.7 1.7 5.4.4V14c-1.8 1.3-3.7 1.2-5.4-.4-1.7-1.6-3.6-1.8-5.4-.6z"/><path d="M5 21V4"/>',
    14,
  ),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>', 16),
  chevron: icon('<path d="m9 6 6 6-6 6"/>', 13),
  chevronLeft: icon('<path d="m15 6-6 6 6 6"/>', 15),
  chevronRight: icon('<path d="m9 6 6 6-6 6"/>', 15),
  // The composer's "add" affordance — Apple's hollow circle with a plus.
  addCircle: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>', 17),
  trash: icon(
    '<path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7"/><path d="M10 11v6M14 11v6"/>',
    14,
  ),
  // The page header's affordances
  palette: icon(
    '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-1.6 1.2-2.4 2.5-2.4H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z"/><circle cx="7.8" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.6" cy="7.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="7.6" r="1.1" fill="currentColor" stroke="none"/>',
    15,
  ),
  // The rail's pin (keep the rail expanded)
  pin: icon('<path d="M9 4h6l-.7 5.2 2.9 2.9v1.4H6.8v-1.4l2.9-2.9z"/><path d="M12 13.5V21"/>', 14),
  // The hub's back-to-note affordance
  arrowLeft: icon('<path d="M19 12H5M11 18l-6-6 6-6"/>', 16),
  // The move-between-lists chip
  moveTo: icon('<path d="M5 9h10a3.5 3.5 0 0 1 0 7h-3"/><path d="m8 6-3 3 3 3"/>', 14),
};
