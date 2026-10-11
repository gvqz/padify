import Swal from 'sweetalert2';
import { showToast } from './ui/toast';
import { selector } from './selector';

/** The display-mode queries an INSTALLED app can report. Matching
 *  `standalone` alone is not enough: the manifest declares
 *  `display_override: ["minimal-ui"]`, and override beats `display` —
 *  so an installed Edge/Chromium window reports minimal-ui, the old
 *  check answered "browser", and the document title grew a " - Padify"
 *  tail that the installed window's own chrome doubled (the title bar
 *  already carries the app name in front). The full set also covers
 *  Edge's tabbed windows and window-controls-overlay builds. */
const INSTALLED_DISPLAY_QUERIES: readonly string[] = [
  '(display-mode: standalone)',
  '(display-mode: minimal-ui)',
  '(display-mode: window-controls-overlay)',
  '(display-mode: fullscreen)',
  '(display-mode: tabbed)',
];

function matchesInstalledDisplayMode(): boolean {
  for (const query of INSTALLED_DISPLAY_QUERIES) {
    try {
      if (window.matchMedia(query).matches) {
        return true;
      }
    } catch {
      // matchMedia is missing in some embeds (and jsdom) — try the rest.
    }
  }
  return false;
}

/** How the app is currently framed: a Trusted Web Activity, an installed
 * app window (standalone or any of the installed-style modes — see
 * INSTALLED_DISPLAY_QUERIES), or a plain browser tab. Only this module
 * asks — it decides whether the install pitch makes sense at all. */
function getPWADisplayMode(): 'twa' | 'standalone' | 'browser' {
  if (document.referrer.startsWith('android-app://')) {
    return 'twa';
  }

  const iOSStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (iOSStandalone || matchesInstalledDisplayMode()) {
    return 'standalone';
  }

  return 'browser';
}

/** True when the app runs as an INSTALLED app (a standalone window or
 * TWA), not a browser tab. A guarded read: matchMedia is missing in some
 * embeds (and in jsdom), and the consumers of this answer (the document
 * title's suffix) must never be the thing that crashes a boot. */
export function isInstalledDisplayMode(): boolean {
  try {
    return getPWADisplayMode() !== 'browser';
  } catch {
    return false;
  }
}

// `beforeinstallprompt` is not part of lib.dom's WindowEventMap.
declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

/** Asked the user about THIS waiting worker already (see promptUpdate). */
let updatePrompted = false;

/**
 * Registers the offline service worker in production builds — and keeps
 * the registration LIVE: deploys are detected on focus and hourly, and a
 * waiting update is offered to the user instead of silently taking over
 * the running page (see build-sw.mjs for why the worker no longer calls
 * skipWaiting() on install).
 */
export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker
      .register('sw.js')
      .then((registration) => {
        // A new worker appeared on the network. Watch it to "installed":
        // that is the moment it CAN take over, and only the prompt decides
        // whether it does.
        registration.addEventListener('updatefound', () => {
          const incoming = registration.installing;
          if (!incoming) {
            return;
          }
          incoming.addEventListener('statechange', () => {
            // controller set = this is an UPDATE, not the first install:
            // the first install's worker activates without a prompt.
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              promptUpdate(incoming);
            }
          });
        });

        // Deploys otherwise wait for a fresh tab. Re-check when the page
        // returns to the foreground (cheap: one conditional request per
        // focus against a byte-compared sw.js) and once an hour.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            void registration.update();
          }
        });
        setInterval(
          () => {
            void registration.update();
          },
          60 * 60 * 1000,
        );
      })
      .catch((err: unknown) => {
        // Registration failed — warn (not log) so it shows in the console
        // without being filtered by default log-level filters.
        console.warn('ServiceWorker registration failed: ', err);
      });
  }
}

/**
 * The update prompt: consenting activates the waiting worker and reloads
 * into the new build; declining leaves it waiting — it applies on the
 * next fresh page load, and a LATER deploy (a different worker) prompts
 * again.
 */
function promptUpdate(waiting: ServiceWorker): void {
  if (updatePrompted) {
    return;
  }
  updatePrompted = true;

  void Swal.fire({
    title: 'Update available',
    text: 'A new version of Padify is ready. Reload to pick it up?',
    icon: 'info',
    showCancelButton: true,
    confirmButtonText: 'Reload now',
    cancelButtonText: 'Later',
  }).then((result) => {
    if (!result.value) {
      // A later deploy is a different worker and may prompt again; this
      // one stays silently waiting until the next fresh load.
      updatePrompted = false;
      return;
    }
    // Registered BEFORE the message: the takeover reload must never race
    // the listener that triggers it.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) {
        return;
      }
      reloading = true;
      window.location.reload();
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
  });
}

/**
 * Install flow — surfaces the "Install app" entry when the browser
 * fires beforeinstallprompt and handles the install button.
 */
export function initInstallPrompt(): void {
  // This hides the install app button
  // if the app is already installed
  if (getPWADisplayMode() === 'standalone') {
    selector().notepad.installApp.hide();
  }

  // Every installed-style mode counts — the manifest's display_override
  // makes Edge report minimal-ui, and an installed app must not pitch
  // itself. Each query flips independently; one listener per query.
  for (const query of INSTALLED_DISPLAY_QUERIES) {
    try {
      window.matchMedia(query).addEventListener('change', ({ matches }) => {
        if (matches) {
          selector().notepad.installApp.hide();
        } else {
          selector().notepad.installApp.show();
        }
      });
    } catch {
      // No matchMedia in this embed — the boot-time check above stands.
    }
  }

  let deferredPrompt: BeforeInstallPromptEvent | null;

  window.addEventListener('beforeinstallprompt', (e) => {
    selector().notepad.installAppButtonContainer.show();
    deferredPrompt = e;

    e.userChoice.then(function (choiceResult) {
      if (choiceResult.outcome === 'accepted') {
        deferredPrompt = null;
      }
    });
  });

  const installApp = document.getElementById('installApp')!;

  installApp.addEventListener('click', async () => {
    if (deferredPrompt !== null) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
      }
    } else {
      showToast('Padify is already installed.');
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
  });
}
