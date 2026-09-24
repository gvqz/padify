import $ from 'jquery';
import type { TabManager } from './tabs';

/**
 * Left note rail drawer — on phones the note rail slides in over the
 * editor behind a backdrop; picking a note, adding one, tapping the
 * backdrop or pressing Escape closes it.
 */
export function initTabRailDrawer(tabManager: TabManager): void {
  const rail = document.getElementById('tabRail');
  const railBackdrop = document.getElementById('tabRailBackdrop');
  const railToggle = document.getElementById('tabRailToggle');

  if (!rail || !railBackdrop || !railToggle) {
    return;
  }

  const setRailOpen = function (open: boolean) {
    rail.classList.toggle('open', open);
    railBackdrop.classList.toggle('show', open);
    railToggle.setAttribute('aria-expanded', String(open));
  };

  railToggle.addEventListener('click', function () {
    setRailOpen(!rail.classList.contains('open'));
  });
  railBackdrop.addEventListener('click', function () {
    setRailOpen(false);
  });

  // Picking a note (or adding one) closes the drawer on phones.
  tabManager.addPersistListener(function () {
    if (rail.classList.contains('open') && window.matchMedia('(max-width: 820px)').matches) {
      setRailOpen(false);
    }
  });
  $(document).on('keydown', function (event) {
    if (event.key === 'Escape' && rail.classList.contains('open')) {
      setRailOpen(false);
    }
  });
}
