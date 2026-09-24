import $ from 'jquery';

/**
 * Brand menu + Help tour.
 *
 * The "padify" wordmark in the navbar toggles a small dropdown menu with
 * three entries — About, Keyboard shortcuts and Help. Help opens an
 * onboarding-style tour of the app's features: one card per capability with
 * an icon, a short description and shortcut hints where they exist. Navigate
 * with the Back/Next buttons, the dots or the arrow keys.
 */

type Accent = 'blue' | 'violet' | 'rose' | 'amber' | 'teal' | 'emerald' | 'sky' | 'indigo';

interface HelpHint {
  keys: string;
  label: string;
}

interface HelpStep {
  accent: Accent;
  icon: string;
  title: string;
  text: string;
  hints: HelpHint[];
}

const svg = (content: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;

const ICONS = {
  book: svg(
    '<path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>',
  ),
  pencil: svg(
    '<path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 1 1 3.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>',
  ),
  type: svg('<path d="M5 6.5h14M12 6.5V19M9.5 19h5"/>'),
  target: svg(
    '<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.75" /><path d="M12 12h.01" />',
  ),
  music: svg(
    '<path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/>',
  ),
  clock: svg('<path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>'),
  cloud: svg(
    '<path d="M7 16a4 4 0 0 1-.88-7.903A5 5 0 1 1 15.9 6L16 6a5 5 0 0 1 1 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>',
  ),
  sliders: svg(
    '<path d="M12 6V4m0 2a2 2 0 1 0 0 4m0-4a2 2 0 1 1 0 4m-6 8a2 2 0 1 0 0-4m0 4a2 2 0 1 1 0-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 1 0 0-4m0 4a2 2 0 1 1 0-4m0 4v2m0-6V4"/>',
  ),
};

const steps: HelpStep[] = [
  {
    accent: 'blue',
    icon: ICONS.book,
    title: 'Welcome to Padify',
    text: 'A fast, private notepad that lives entirely in your browser. Notes autosave to your device the instant you type them, nothing is ever collected, and the app keeps working with no internet at all.',
    hints: [],
  },
  {
    accent: 'violet',
    icon: ICONS.pencil,
    title: 'Write and organize',
    text: 'Keep as many notes as you like and switch between them from the tabs in the sidebar. Everything you type is stored locally — right in your browser — the moment you type it.',
    hints: [{ keys: 'ctrl + alt + ← →', label: 'switch notes' }],
  },
  {
    accent: 'rose',
    icon: ICONS.type,
    title: 'Format as you write',
    text: 'Bold, italic, underline and strikethrough render right inside the editor. Right-click your text for the full formatting menu, or open the symbol picker for arrows, math and emoji.',
    hints: [
      { keys: 'ctrl + B', label: 'bold' },
      { keys: 'ctrl + shift + O', label: 'symbols' },
    ],
  },
  {
    accent: 'amber',
    icon: ICONS.target,
    title: 'Find your focus',
    text: 'Focus mode strips the interface down to just you and the page, full screen hides everything else, and a session timer tracks your writing. Optional break reminders nudge you to rest.',
    hints: [{ keys: 'alt + F', label: 'focus mode' }],
  },
  {
    accent: 'teal',
    icon: ICONS.music,
    title: 'Set the atmosphere',
    text: 'The built-in music player generates calm ambient tracks on the fly, a 25-sound ambience mixer blends rain, fireside, crickets and more, and typewriter sounds make every keypress feel wonderful.',
    hints: [],
  },
  {
    accent: 'emerald',
    icon: ICONS.clock,
    title: 'Never lose your work',
    text: 'Snapshots capture versions of a note that you can restore anytime, live statistics track words, pages and speaking time, and notes export to plain text, PDF, HTML or DOCX.',
    hints: [],
  },
  {
    accent: 'sky',
    icon: ICONS.cloud,
    title: 'Sync and share',
    text: 'Create a free account to sync notes across your devices through the cloud, and share any note with a read-only link that expires on its own — and can be cancelled anytime.',
    hints: [],
  },
  {
    accent: 'indigo',
    icon: ICONS.sliders,
    title: 'Make it yours',
    text: 'Dark mode, dyslexic-friendly and monospaced fonts, paper textures, and a floating window for taking notes over other apps. Padify also installs as an app for full offline use.',
    hints: [],
  },
];

const MODAL_MARKUP = `
<div id="helpModal" class="modal fade" role="dialog" aria-labelledby="helpModalTitle">
  <div class="modal-dialog help-dialog">
    <div class="modal-content help-content">
      <button type="button" class="close help-close" data-dismiss="modal" aria-label="Close">&times;</button>
      <div class="help-header">
        <span class="help-eyebrow" id="helpModalTitle">Padify help</span>
        <span class="help-counter" id="helpStepCounter"></span>
      </div>
      <div class="modal-body help-body">
        <div class="help-stage" id="helpStage" data-direction="forward"></div>
      </div>
      <div class="help-footer">
        <div class="help-dots" id="helpDots"></div>
        <div class="help-nav">
          <button type="button" class="btn btn-default help-btn" id="helpPrev">Back</button>
          <button type="button" class="btn btn-primary help-btn" id="helpNext">Next</button>
        </div>
      </div>
    </div>
  </div>
</div>`;

$('body').append(MODAL_MARKUP);

const helpModal = $('#helpModal');
const stage = $('#helpStage');
const dots = $('#helpDots');
const counter = $('#helpStepCounter');
const prevButton = $('#helpPrev');
const nextButton = $('#helpNext');
let current = 0;

dots.html(
  steps
    .map(
      (step, index) =>
        `<button type="button" class="help-dot" data-i="${index}" aria-label="Step ${index + 1}: ${step.title}"></button>`,
    )
    .join(''),
);

function hintsMarkup(hints: HelpHint[]): string {
  if (hints.length === 0) return '';
  const chips = hints
    .map(
      (hint) => `<span class="help-hint"><kbd>${hint.keys}</kbd><span>${hint.label}</span></span>`,
    )
    .join('');
  return `<div class="help-hints">${chips}</div>`;
}

function stepMarkup(step: HelpStep, isLast: boolean): string {
  const more = isLast
    ? '<a href="#keyboard-shortcuts" class="help-more" id="helpShortcutsLink">Browse all keyboard shortcuts</a>'
    : '';
  return `<div class="help-step" data-accent="${step.accent}">
  <span class="help-icon">${step.icon}</span>
  <h3 class="help-title">${step.title}</h3>
  <p class="help-text">${step.text}</p>
  ${hintsMarkup(step.hints)}
  ${more}
</div>`;
}

function render(index: number, direction: 1 | -1): void {
  current = index;
  const isLast = index === steps.length - 1;
  stage.attr('data-direction', direction > 0 ? 'forward' : 'backward');
  stage.html(stepMarkup(steps[index], isLast));
  dots.children().removeClass('active');
  dots.children().eq(index).addClass('active');
  counter.text(`${index + 1} / ${steps.length}`);
  prevButton.prop('disabled', index === 0);
  nextButton.text(isLast ? 'Get started' : 'Next');
}

function go(direction: 1 | -1): void {
  const target = current + direction;
  if (target < 0 || target >= steps.length) return;
  render(target, direction);
}

// Every open starts the tour from the beginning.
helpModal.on('show.bs.modal', () => render(0, 1));

prevButton.on('click', () => go(-1));

nextButton.on('click', () => {
  if (current === steps.length - 1) {
    helpModal.modal('hide');
    return;
  }
  go(1);
});

dots.on('click', '.help-dot', (event) => {
  const index = Number($(event.currentTarget).data('i'));
  if (Number.isNaN(index)) return;
  render(index, index > current ? 1 : -1);
});

// Arrow keys navigate the tour while the modal is open. Guard against
// keypresses landing in editable surfaces (should not happen behind the
// backdrop, but it is cheap to be safe).
$(document).on('keydown', (event) => {
  if (!helpModal.hasClass('in')) return;
  const target = event.target as unknown as HTMLElement | null;
  const tag = target?.tagName ?? '';
  if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return;
  }
  if (event.key === 'ArrowRight') {
    go(1);
  } else if (event.key === 'ArrowLeft') {
    go(-1);
  } else {
    return;
  }
  event.preventDefault();
});

// The About modal links into the tour.
$('#aboutTourLink').on('click', (event) => {
  event.preventDefault();
  $('.modal').modal('hide');
  helpModal.modal('show');
});

// The last tour step links out to the shortcuts list.
stage.on('click', '#helpShortcutsLink', (event) => {
  event.preventDefault();
  helpModal.modal('hide');
  $('#keyboardShortcutsModal').modal('show');
});

// ---- brand menu -------------------------------------------------------------

const menu = $('#brandMenu');
const brandButton = $('#brandMenuButton');

function closeBrandMenu(): void {
  menu.removeClass('show');
  brandButton.attr('aria-expanded', 'false');
}

brandButton.on('click', (event) => {
  event.stopPropagation();
  const open = menu.toggleClass('show').hasClass('show');
  brandButton.attr('aria-expanded', open ? 'true' : 'false');
});

// The three entries open their modals through Bootstrap's delegated
// click.bs.modal.data-api handler on the document, so the click must keep
// bubbling — only close the menu (the document-level close handler re-runs
// this, which is harmless).
menu.on('click', 'a.brand-menu-item', () => {
  closeBrandMenu();
});

$(document).on('click', closeBrandMenu);
$(document).on('keydown', (event) => {
  if (event.key === 'Escape') closeBrandMenu();
});
