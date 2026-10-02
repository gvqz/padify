import { $ } from './lib/q';
import { stateSet } from './storage';
import { setSetting } from './state/settings';
import { selector } from './selector';

export interface ThemeConfig {
  lightmodeText: string;
  darkmodeText: string;
  lightMetaColor: string;
  darkMetaColor: string;
  metaThemeColor: HTMLElement | null;
}

export function enableDarkMode(
  lightmodeText: string,
  darkMetaColor: string,
  metaThemeColor: HTMLElement | null,
): void {
  $(document.body).addClass('dark');
  $('.navbar').removeClass('navbar-default');
  metaThemeColor!.setAttribute('content', darkMetaColor);
  stateSet('mode', 'dark');
  announceTheme('dark');
}

export function enableLightMode(
  darkmodeText: string,
  lightMetaColor: string,
  metaThemeColor: HTMLElement | null,
): void {
  $(document.body).removeClass('dark');
  $('.navbar').addClass('navbar-default');
  metaThemeColor!.setAttribute('content', lightMetaColor);
  stateSet('mode', 'light');
  announceTheme('light');
}

/** Rich notes re-map their ink when this fires (editor/theme-colors.ts). */
function announceTheme(mode: 'light' | 'dark'): void {
  document.dispatchEvent(new CustomEvent('padify:theme', { detail: { mode } }));
}

export function enableDeviceTheme(themeConfig: ThemeConfig): void {
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    enableDarkMode(
      themeConfig.lightmodeText,
      themeConfig.darkMetaColor,
      themeConfig.metaThemeColor,
    );
  } else {
    enableLightMode(
      themeConfig.darkmodeText,
      themeConfig.lightMetaColor,
      themeConfig.metaThemeColor,
    );
  }

  stateSet('mode', 'device');
}

/**
 * Theme controller — owns every way the app changes skin: applies the
 * stored light/dark/device preference on boot, wires the preference
 * radios, follows the OS scheme while in "device" mode, and exposes the
 * reset used by "Reset to defaults". The enable* primitives below are the
 * only writers of the 'mode' setting; nothing outside this module flips
 * body classes or the meta theme color.
 */
export function initThemeController(themeConfig: ThemeConfig): {
  resetToDevice: () => void;
} {
  const { state } = selector();

  if (!state.isUserPreferredTheme) {
    // Through the settings choke point (src/state/settings.ts): the write
    // notifies like every other setting write, instead of bypassing.
    setSetting('isUserPreferredTheme', 'false');
  }

  if (state.mode && state.mode === 'dark') {
    enableDarkMode(
      themeConfig.lightmodeText,
      themeConfig.darkMetaColor,
      themeConfig.metaThemeColor,
    );

    $('input[name="themes"][value="dark"]').prop('checked', true);
  } else if (state.mode && state.mode === 'light') {
    enableLightMode(
      themeConfig.darkmodeText,
      themeConfig.lightMetaColor,
      themeConfig.metaThemeColor,
    );

    $('input[name="themes"][value="light"]').prop('checked', true);
  } else {
    enableDeviceTheme(themeConfig);

    $('input[name="themes"][value="device"]').prop('checked', true);
  }

  const themeRadios = document.querySelectorAll('input[name="themes"]');

  themeRadios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      switch ((event.target as HTMLInputElement).value) {
        case 'dark':
          enableDarkMode(
            themeConfig.lightmodeText,
            themeConfig.darkMetaColor,
            themeConfig.metaThemeColor,
          );
          break;
        case 'light':
          enableLightMode(
            themeConfig.darkmodeText,
            themeConfig.lightMetaColor,
            themeConfig.metaThemeColor,
          );
          break;
        case 'device':
          enableDeviceTheme(themeConfig);
          break;
      }
    });
  });

  // This changes the application's theme when
  // user toggles device's theme preference
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = selector().state;

    if (current.mode && current.mode === 'device') {
      enableDeviceTheme(themeConfig);
    }
  });

  return {
    /** Back to following the device scheme (preferences reset). */
    resetToDevice(): void {
      $('input[name="themes"][value="device"]').prop('checked', true);
      enableDeviceTheme(themeConfig);
    },
  };
}
