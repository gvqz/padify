import { showToast, getPWADisplayMode } from './utils';
import { selector } from './selector';

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

/** Registers the offline service worker in production builds. */
export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('sw.js').then(
      function (registration) {
        // Registration was successful
        console.log('ServiceWorker registration successful with scope: ', registration.scope);
      },
      function (err) {
        // registration failed :(
        console.log('ServiceWorker registration failed: ', err);
      },
    );
  }
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

  window.matchMedia('(display-mode: standalone)').addEventListener('change', ({ matches }) => {
    if (matches) {
      selector().notepad.installApp.hide();
    } else {
      selector().notepad.installApp.show();
    }
  });

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
