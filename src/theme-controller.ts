import $ from 'jquery';
import {
  enableDarkMode,
  enableLightMode,
  enableDeviceTheme,
} from './utils';
import { stateSet } from './storage';
import { selector } from './selector';

interface ThemeConfig {
  lightmodeText: string;
  darkmodeText: string;
  lightMetaColor: string;
  darkMetaColor: string;
  metaThemeColor: HTMLElement | null;
}

/**
 * Theme controller — applies the stored light/dark/device preference on
 * boot, wires the preference radios, follows the OS scheme while in
 * "device" mode, and exposes the reset used by "Reset to defaults".
 */
export function initThemeController(themeConfig: ThemeConfig): {
  resetToDevice: () => void;
} {
  const { state } = selector();

  if (!state.isUserPreferredTheme) {
    stateSet('isUserPreferredTheme', 'false');
  }

  if (state.mode && state.mode === 'dark') {
    enableDarkMode(themeConfig.lightmodeText, themeConfig.darkMetaColor, themeConfig.metaThemeColor);

    $('input[name="themes"][value="dark"]').prop('checked', true);
  } else if (state.mode && state.mode === 'light') {
    enableLightMode(themeConfig.darkmodeText, themeConfig.lightMetaColor, themeConfig.metaThemeColor);

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
          enableDarkMode(themeConfig.lightmodeText, themeConfig.darkMetaColor, themeConfig.metaThemeColor);
          break;
        case 'light':
          enableLightMode(themeConfig.darkmodeText, themeConfig.lightMetaColor, themeConfig.metaThemeColor);
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
