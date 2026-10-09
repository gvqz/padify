/**
 * Padify boot — the composition root.
 *
 * This file is the ONE place that knows which features exist and in what
 * order they start. main.ts kicks storage hydration at module evaluation
 * (so IndexedDB opens while the bundle evaluates and the DOM parses), then
 * calls bootPadify(); everything else hangs off the explicit sequence
 * below.
 *
 * History: boot used to happen as import-order side effects — every module
 * appended its own markup, bound its own handlers and sometimes registered
 * $(document).ready callbacks, so the real startup order was an accident
 * of the import list in main.ts. The explicit sequence replaces that while
 * preserving the original ordering guarantees:
 *
 *   1. feature markup + DOM-only wiring (help, timer, music markup,
 *      snapshots, context menu) — everything that needs the DOM but no
 *      hydrated state
 *   2. initApp() — the shell: awaits storageReady(), builds the tab
 *      manager + editor port, wires cloud/voice/tabs/shortcuts
 *
 * The music/ambience ENGINES no longer boot at all: they load on demand
 * when the player is first opened (see initMusicSubsystem in app.ts).
 * Only their markup mounts here, from the pure-markup submodule — a
 * static import of the feature barrel would drag the whole engine into
 * the main bundle, which is exactly what the lazy seam removes.
 */

import { initApp } from './app';
import { initHelp } from './help';
import { initSnapshots } from './snapshots';
import { initTimer } from './timer';
import { mountMusicPlayer } from './features/music-player/markup';
import { initContextMenu } from './context-menu';
import { initBreakReminder } from './break-reminder';
import { mountModals } from './ui/modals';
import { assertMarkupContract } from './ui/contract';
import { initModalBehavior } from './ui/behavior/modal';
import { initCollapseBehavior } from './ui/behavior/collapse';
import { initSettingsNav } from './ui/settings-nav';
import { initTooltips } from './ui/behavior/tooltip';
import { hydratePlatformShortcuts } from './ui/platform-hints';

/** Resolves once the DOM is parsed (module scripts run before that). */
function domReady(): Promise<void> {
  if (document.readyState !== 'loading') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

export async function bootPadify(): Promise<void> {
  await domReady();

  // 0. Modal markup — verbatim partials under src/ui/modals/, mounted before
  //    anything queries a modal by id (selector(), help, snapshots, app…).
  mountModals();

  // 0.5 The owned UI behaviors (bootstrap-JS replacements): modals, the
  //     navbar hamburger collapse and tooltips. Document-level delegated
  //     listeners — installed once, before any feature can open a dialog.
  initModalBehavior();
  initCollapseBehavior();

  // Fail here — loudly, naming the missing elements — if the markup the
  // features are about to dereference is not in the document.
  assertMarkupContract();

  // 0.7 Platform shortcut hints — the static partials declare modifier
  //     intent (data-mod-key, data-shortcut-title); this pass resolves it
  //     for THIS device before any dialog can be seen (see ui/platform-
  //     hints.ts). Runs after mountModals() so modal partials are included.
  hydratePlatformShortcuts();

  // 1. Markup + DOM-only feature wiring. The music MARKUP mounts here
  //    (from the pure-markup module, not the feature barrel); its engines
  //    load on first open — app.ts's initMusicSubsystem.
  initHelp();
  initTimer();
  initTooltips(); // after initTimer so the timer modal's tooltip is covered
  mountMusicPlayer();
  initSnapshots();
  initContextMenu();
  // The break popup's controls live in a modal partial — they can only be
  // bound here, after mountModals() (import-time binding found no elements
  // and every button was dead — see break-reminder.ts).
  initBreakReminder();

  // The settings modal's two-pane navigation + search — DOM-only wiring
  // over the preferences partial (see ui/settings-nav.ts).
  initSettingsNav();

  // 2. The app shell (tabs, editor port, cloud, voice, shortcuts).
  await initApp();
}
