/**
 * The markup contract — the ids Padify's boot sequence dereferences,
 * declared once and enforced twice:
 *
 *   1. at boot — assertMarkupContract() fails loudly, naming the missing
 *      elements, instead of letting features die one by one on
 *      "Cannot read properties of null"
 *   2. in CI — architecture.test.ts re-checks this list against the actual
 *      markup files AND cross-checks every id referenced from TypeScript
 *      against the markup (the monospaced/whiteNoiseModal class of silent
 *      dead-selector drift cannot come back)
 *
 * Where markup lives:
 *  - index.html: head + two include comments + page overlays
 *  - src/ui/*.html: parse-time includes (topbar, editor shell) — expanded
 *    by the padify-html-includes vite plugin before the document parses
 *  - src/ui/modals/*.html: mounted at boot by mountModals()
 *  - feature templates (music player, white noise): JS-mounted strings
 *    inside their modules
 */

export interface MarkupContractGroup {
  /** Where the markup lives — shown in the failure message. */
  source: string;
  /** Ids that MUST exist before features initialize. */
  ids: string[];
}

export const MARKUP_CONTRACT: MarkupContractGroup[] = [
  {
    source: 'index.html + src/ui/topbar.html',
    ids: [
      'navbar',
      'brandMenuButton',
      'brandMenu',
      'tabRailToggle',
      'pipContainer',
      'copyToClipboard',
      'downloadNotes',
      'fullScreenButton',
      'shareNotes',
      'preferences',
      'cloudNavButton',
      'tabRailCalendar',
    ],
  },
  {
    source: 'src/ui/editor-shell.html',
    ids: [
      'mainContainer',
      'editorShell',
      'tabRail',
      'tabStrip',
      'tabStripTabs',
      'addTab',
      'addTabTypeMenu',
      'addTabTypeMenuPopover',
      'richToolbar',
      'richLinkButton',
      'richLinkPopover',
      'richLinkInput',
      'markdownToolbar',
      'markdownLinkPopover',
      'markdownLinkInput',
      'markdownLinkOpen',
      'markdownLinkCopy',
      'markdownLinkEdit',
      'markdownLinkHrefLabel',
      'markdownMathPopover',
      'markdownMathPalette',
      'markdownMathInput',
      'markdownMathInsert',
      'markdownMathPreview',
      'textareaContainer',
      'note',
      'saveState',
      'wordCount',
      'taskRail',
      'taskRailBackdrop',
      'taskRailPin',
      'taskRailSearchInput',
      'taskRailSearchClear',
    ],
  },
  {
    source: 'src/ui/modals/*.html (mounted by mountModals)',
    ids: [
      'aboutModal',
      'snapshotsModal',
      'keyboardShortcutsModal',
      'unicodePickerModal',
      'cloudModal',
      'shareModal',
      'preferencesModal',
      'statisticsModal',
    ],
  },
  {
    source: 'index.html (page overlays)',
    ids: ['breakVeil', 'voiceBar'],
  },
];

/**
 * Throws when any contracted element is missing from the document. Call
 * after mountModals() and before the first feature init.
 */
export function assertMarkupContract(root: Document = document): void {
  const missing: string[] = [];
  for (const group of MARKUP_CONTRACT) {
    for (const id of group.ids) {
      if (!root.getElementById(id)) {
        missing.push(`#${id}  (expected in ${group.source})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Padify boot: markup contract violated — ${missing.length} expected element(s) missing:\n  ` +
        missing.join('\n  ') +
        `\nCheck that the include partials are expanding and that mountModals() ran.`,
    );
  }
}
