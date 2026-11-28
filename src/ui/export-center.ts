/**
 * The export center — the ONE export dialog, every note type, one face.
 *
 * THE OWNER'S FOURTH VERDICT (the restart): "visually I want ONE popup for
 * ALL note/types. The current visuals for both of them aren't good — have
 * to restart the ui. remember — 1 unified ui for all note/note types."
 * The two faces that stood were the vendor's own ImageExportDialog (the
 * drawingpad's, restored for "100% of features, done in the exact same
 * way") and this center's first build (file-type exports only). Both died
 * visually; ONE dialog rises here for everything — and the drawingpad's
 * rows inside it keep the built-in feature set on the built-in pipeline
 * (the vendor dialogs' own engine, delegated through surface.ts's
 * session seam): only-selected, background, dark mode, embed scene, the
 * 1×/2×/3× scale, the live canvas preview, the PNG/SVG/clipboard
 * presses, the .excalidraw scene save.
 *
 * THE SECOND RESTART (the measured audit of the first face, 5.5/10):
 *   - the chips ride ONE full-width band under the head — never a
 *     wrapped orphan row in a cramped column; every format a peer at
 *     6px radii, the selected chip FILLED with the accent, one state
 *   - the body is two columns with the preview DOMINANT: the stage
 *     fills its column's height (no dead band under it), the options
 *     rail keeps the switches, and the file-name group rides the rail's
 *     foot — aligned with the stage's bottom edge
 *   - a format with no options folds to ONE column (stage over the name
 *     group) — the compact face is the fold the narrow viewport already
 *     knew, so every note kind wears the same design language
 *   - the stage's empty answer is a quiet ghost glyph + its note, never
 *     a blank box; a render in flight pulses the ghost
 *   - switches are pill toggles (white knob, primary when on), the
 *     scale is a segmented control, ONE radius language (6px controls,
 *     12px dialog), the entry is one 160ms scale-in
 *   - a close × rides the header at a 32px hit target; the footer's
 *     import door sits under a hairline, clearly tertiary, never a peer
 *     of Copy/Export
 *
 * THE CONTRACT (kept from the proven build): the center is pure UI —
 * the host hands in one ExportCenterType per format the ACTIVE note can
 * become, each with its own preview()/run(stem, values) and, where a
 * format can copy, copy(). The drawing rows' previews render from the
 * vendor's own exportScene through the surface seam; no vendor code rides
 * this module.
 *
 * THE BINDING DISCIPLINE (kept): the face is built ONCE, every listener
 * binds ONCE at build and reads the LIVE host through `activeHost` —
 * per-open closures were the consolidation's accumulation bug, and they
 * never come back.
 *
 * HONESTY RULES (kept): preview() answers for an ungated state with a
 * note; run() answers false when it did not export (a toast has already
 * explained why) and the dialog stays open. The dialog closes only on a
 * reported success or on the ×/Escape — except a keepOpen type (the
 * drawing's image presses, the native dialogs' own behavior: an export
 * is not a dismissal).
 *
 * KEYBOARD (kept, widened): ArrowUp/Down/Left/Right walk the chips,
 * selection follows focus; Enter in the name field is an Export; Escape
 * and × close.
 *
 * THE OUTSIDE (the app's one rule, finally everywhere): a click on the
 * dark outside closes, like every bootstrap modal, panel and menu here.
 * The dismiss is exact — the press must begin on the backdrop and land
 * outside the box, so a text-selection drag from the stage never throws
 * the user out of a render they are inspecting.
 */

import './export-center.css';
import { attachBackdropDismiss } from './backdrop-dismiss';
import { sanitizeFileStem, stripExtension } from './file-name';

/** What a type's preview() answers with. */
export interface ExportPreview {
  /** A rendered canvas ELEMENT (the drawing rows' live render — the
   * vendor's own exportScene output, placed and CSS-scaled by the
   * stage). */
  canvas?: HTMLCanvasElement;
  /** An image URL (object URL or data URL) — the stage shows an <img>. */
  image?: string;
  /** Plain-text preview — the stage shows the text itself. */
  text?: string;
  /** Pre-rendered HTML body — the stage shows a mini document. */
  html?: string;
  /** A file-card flavor (glyph + title + meta lines) for envelope types. */
  card?: { title: string; meta: string[] };
  /** A muted status line under the stage (rendering notes, honest gates). */
  note?: string;
  /** True when the render is transparent (Background off) — the stage
   * paints the checkerboard behind it, so the transparency is SEEN. */
  transparent?: boolean;
}

/** One switch row (the drawing's only-selected / background / dark /
 * embed — the native dialog's own controls, restyled). */
export interface ExportOptionToggle {
  kind: 'toggle';
  id: string;
  label: string;
  /** The one-line explanation beside the label. */
  hint?: string;
  /** The ⓘ tooltip's text (the embed-scene help — the vendor's own words
   * ride the row the adapter builds). */
  tooltip?: string;
  value: boolean;
  /** Fires after the flip (the drawing rows' write-through — the native
   * dialog's switch actions persisting the same appState keys). */
  onFlip?(value: boolean): void;
}

/** One segmented row (the drawing's scale — 1× / 2× / 3×). */
export interface ExportOptionSegment {
  kind: 'segment';
  id: string;
  label: string;
  values: { id: string; label: string; title?: string }[];
  value: string;
  onPick?(value: string): void;
}

export type ExportOption = ExportOptionToggle | ExportOptionSegment;

/** The live option readings a type's preview()/run() receive. */
export type ExportOptionValues = Record<string, boolean | string>;

/** One export format the active note can become. */
export interface ExportCenterType {
  id: string;
  label: string;
  /** The suffix chip and the appended extension at the option's
   * current values (the base extension when the type has none). */
  extension: string;
  /** The extension as the live option values shape it — the embed
   * double extension (.excalidraw.png). Recomputed on every option
   * flip, so the suffix chip never lies. */
  extensionFor?(values: ExportOptionValues): string;
  /** The prefilled file name, WITHOUT the extension. */
  defaultStem: string;
  /** The selected format's description — the ONE line under the chips. */
  hint?: string;
  /** The option model this type shows (shared instances share live
   * state across formats — the native image dialog's own discipline:
   * one set of switches for PNG and SVG). */
  options?: ExportOption[];
  /** True = a successful export does NOT close the dialog (the native
   * image dialogs' own behavior — an export is not a dismissal; the
   * PNG press leaves the dialog standing for the SVG press). */
  keepOpen?: boolean;
  /** Renders what the export will carry. `stage` is the measured box
   * the render must fit (the drawing preview passes it as the native
   * dialog's own maxWidthOrHeight). */
  preview(
    values: ExportOptionValues,
    stage: { width: number; height: number },
  ): Promise<ExportPreview>;
  /** Exports with the (already sanitized + suffixed) file name. True =
   * done (and the dialog closes unless keepOpen). */
  run(fileName: string, values: ExportOptionValues): Promise<boolean>;
  /** Copies instead of saving (the PNG row's clipboard press). True =
   * copied — the press flashes "Copied" and the dialog stays open. */
  copy?(values: ExportOptionValues): Promise<boolean>;
  /** The clipboard capability gate — false hides the copy press. */
  copySupported?(): boolean;
  /** Fires on every keystroke in the name field (the drawing rows write
   * the scene name through — the native dialog's own
   * actionChangeProjectName parity). */
  onNameChange?(stem: string): void;
}

export interface ExportCenterHost {
  /** The dialog's heading — the note's live title. */
  heading: string;
  subheading?: string;
  types: ExportCenterType[];
  initialTypeId?: string;
  /** The footer's open door (null hides it). */
  door?: { label: string; onOpen: () => void } | null;
}

interface CenterFace {
  dialog: HTMLDialogElement;
  heading: HTMLElement;
  subheading: HTMLElement;
  close: HTMLButtonElement;
  stage: HTMLElement;
  stageBody: HTMLElement;
  stageNote: HTMLElement;
  chips: HTMLElement;
  desc: HTMLElement;
  optionsHost: HTMLElement;
  stem: HTMLInputElement;
  suffix: HTMLElement;
  door: HTMLButtonElement;
  doorLabel: HTMLElement;
  copy: HTMLButtonElement;
  exportButton: HTMLButtonElement;
}

let face: CenterFace | null = null;
/** The LIVE open's host — the single source every binding reads. */
let activeHost: ExportCenterHost | null = null;
let activeType: ExportCenterType | null = null;
let previewToken = 0;
let previewTimer: number | null = null;
/** The object URL the image preview currently shows — revoked on replace. */
let previewUrl: string | null = null;
/** The copy press's 2s "Copied" flash — the native useCopyStatus's own
 * TIMEOUT verbatim. */
const COPY_FLASH_MS = 2_000;
let copyFlashTimer: number | null = null;
/** Whether the user has edited the file-name field this session. Until
 * they do, every format switch adopts the type's own default stem;
 * after an edit the user's stem survives the switches, minus the
 * formats' extensions. */
let stemDirty = false;

/** Strips characters the download family never allowed into file names. */
function sanitizeStem(raw: string): string {
  return sanitizeFileStem(raw);
}

/** Drops a trailing extension equal to the type's own. */
function stripOwnExtension(stem: string, extension: string): string {
  return stripExtension(stem, extension);
}

function optionValues(type: ExportCenterType): ExportOptionValues {
  const values: ExportOptionValues = {};
  for (const option of type.options ?? []) {
    values[option.id] = option.value;
  }
  return values;
}

/** The extension the type's current option values shape — the suffix
 * chip and the export's file name both answer this. */
function extensionFor(type: ExportCenterType): string {
  const values = optionValues(type);
  return type.extensionFor?.(values) ?? type.extension;
}

function revokePreviewUrl(): void {
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

/** Cancels any pending/in-flight preview render (a close). */
function cancelPendingPreview(): void {
  previewToken++;
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
}

/** Closes the dialog through the one path the environment has — a real
 * <dialog> closes (its close event runs the cleanup); a jsdom-grade
 * embed stands the open attribute down and speaks the event itself. */
function closeCenterDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
  }
}

/** Builds (once) the one dialog the app exports through — every
 * listener bound ONCE, reading the live host at event time. */
function centerFace(): CenterFace {
  if (face) {
    return face;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'vz-dialog export-center';
  dialog.setAttribute('aria-label', 'Export');

  // ---- the head: the title block on the left, the × on the right -----
  const head = document.createElement('div');
  head.className = 'export-center-head';
  const headText = document.createElement('div');
  headText.className = 'export-center-head-text';
  const heading = document.createElement('h2');
  heading.className = 'export-center-heading';
  const subheading = document.createElement('p');
  subheading.className = 'export-center-subheading';
  headText.append(heading, subheading);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'export-center-close';
  close.setAttribute('aria-label', 'Close export dialog');
  close.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 6 6 18M6 6l12 12"/></svg>';
  head.append(headText, close);
  dialog.append(head);

  // ---- the format band: ONE full-width chip row + the one description
  // line under it (the audit's orphaned-wrap cure — the whole dialog's
  // width carries the formats, so they never wrap alone in a corner).
  const band = document.createElement('div');
  band.className = 'export-center-band';
  const chips = document.createElement('div');
  chips.className = 'export-center-chips';
  chips.setAttribute('role', 'radiogroup');
  chips.setAttribute('aria-label', 'File type');

  // The selected format's one description line.
  const desc = document.createElement('p');
  desc.className = 'export-center-desc';
  band.append(chips, desc);
  dialog.append(band);

  // ---- the body: the preview stage dominant, the options rail on the
  // right (a format with no options folds the body to one column — the
  // compact face is the narrow-viewport fold the CSS already knew).
  const body = document.createElement('div');
  body.className = 'export-center-body';

  const preview = document.createElement('div');
  preview.className = 'export-center-preview';
  const stage = document.createElement('div');
  stage.className = 'export-center-stage';
  const stageBody = document.createElement('div');
  stageBody.style.display = 'contents';
  stage.append(stageBody);
  // The caption line rides UNDER the stage (a caption, not a child the
  // stage would have to center against its content).
  const stageNote = document.createElement('p');
  stageNote.className = 'export-center-stage-note';
  preview.append(stage, stageNote);

  const settings = document.createElement('div');
  settings.className = 'export-center-settings';

  // The options section — the drawing's switches, one even rhythm.
  const optionsHost = document.createElement('div');
  optionsHost.className = 'export-center-options';
  optionsHost.hidden = true;

  // The file name row — the input with the live suffix attached, riding
  // the rail's foot (the input's own aria-label speaks the group).
  const nameRow = document.createElement('div');
  nameRow.className = 'export-center-name-row';
  const stem = document.createElement('input');
  stem.type = 'text';
  stem.className = 'vz-dialog-input export-center-stem';
  stem.setAttribute('aria-label', 'File name');
  stem.spellcheck = false;
  const suffix = document.createElement('span');
  suffix.className = 'export-center-name-suffix';
  nameRow.append(stem, suffix);

  settings.append(optionsHost, nameRow);
  body.append(preview, settings);
  dialog.append(body);

  // ---- the footer: the open door (tertiary, left) + the actions -------
  const foot = document.createElement('div');
  foot.className = 'export-center-foot';
  const door = document.createElement('button');
  door.type = 'button';
  door.className = 'export-center-door';
  const doorGlyph = document.createElement('span');
  doorGlyph.className = 'export-center-door-glyph';
  doorGlyph.setAttribute('aria-hidden', 'true');
  doorGlyph.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
    '<path d="M3 9h18"/></svg>';
  const doorLabel = document.createElement('span');
  doorLabel.className = 'export-center-door-label';
  door.append(doorGlyph, doorLabel);
  const actions = document.createElement('div');
  actions.className = 'vz-dialog-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'vz-dialog-cancel export-center-copy';
  copy.textContent = 'Copy to clipboard';
  copy.hidden = true;
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'vz-dialog-confirm export-center-export';
  exportButton.textContent = 'Export';
  actions.append(copy, exportButton);
  foot.append(door, actions);
  dialog.append(foot);

  document.body.append(dialog);
  face = {
    dialog,
    heading,
    subheading,
    close,
    stage,
    stageBody,
    stageNote,
    chips,
    desc,
    optionsHost,
    stem,
    suffix,
    door,
    doorLabel,
    copy,
    exportButton,
  };

  // ONE binding each, for the dialog's whole life — reading the LIVE
  // host at event time (the accumulation bug's cure, kept from the
  // proven build).
  //
  // The dialog OWNS Escape while it is on stage: a native <dialog> would
  // close itself on the keydown's cancel, but the drawingpad's vendor
  // binds its own global key handler at the document — over a live
  // canvas its actionManager matches the Escape and preventDefaults it,
  // killing the UA's cancel before it fires. So the close happens here,
  // on the dialog's own node, before the bubble ever reaches the
  // vendor — and with stopPropagation the canvas behind never
  // deselects on a key that was aimed at the dialog.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeCenterDialog(dialog);
  });

  // The backdrop click — the app's one close rule (bootstrap modals,
  // panels, menus: a click on the dark outside is a dismissal). The
  // close rides the dialog's own close event, so the cleanup below runs
  // once, on the one path.
  attachBackdropDismiss(dialog, () => closeCenterDialog(dialog));

  close.addEventListener('click', () => {
    closeCenterDialog(dialog);
  });

  // The dialog going away (×, Escape, a success that closes) kills the
  // pending preview, the object URL it left on the table, and the copy
  // press's flash.
  dialog.addEventListener('close', () => {
    cancelPendingPreview();
    revokePreviewUrl();
    if (copyFlashTimer !== null) {
      window.clearTimeout(copyFlashTimer);
      copyFlashTimer = null;
    }
    copy.textContent = 'Copy to clipboard';
    activeHost = null;
    activeType = null;
    face?.stageBody.replaceChildren();
    face?.stageNote.replaceChildren();
  });

  // The first edit makes the file name the user's — format switches stop
  // adopting defaults from that point on. The active type may write the
  // name through (the drawing rows' scene-name parity).
  stem.addEventListener('input', () => {
    stemDirty = true;
    activeType?.onNameChange?.(stem.value);
  });

  // Enter in the name field is an Export.
  stem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      exportButton.click();
    }
  });

  // ONE chips binding: a chip press selects its type.
  chips.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.export-center-chip');
    if (!button?.dataset.typeId) return;
    const host = activeHost;
    if (!host) return;
    const type = host.types.find((item) => item.id === button.dataset.typeId);
    if (!type || type === activeType) return;
    selectType(type, activeType);
  });

  // ONE arrow-key binding: the radiogroup's native walk — the arrows
  // move focus and the selection follows (all four arrows; the chips
  // wrap, so up/down and left/right both walk the same order).
  chips.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const host = activeHost;
    if (!host) return;
    const buttons = Array.from(chips.querySelectorAll<HTMLButtonElement>('.export-center-chip'));
    if (buttons.length < 2) return;
    event.preventDefault();
    const fromIndex = buttons.findIndex((chip) => chip === document.activeElement);
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const next = buttons[(fromIndex + step + buttons.length) % buttons.length] ?? buttons[0];
    next.focus();
    next.click();
  });

  // ONE export binding.
  exportButton.addEventListener('click', () => {
    const type = activeType;
    if (!type) return;
    const ext = extensionFor(type);
    const stemValue = sanitizeStem(stripOwnExtension(stem.value, ext));
    if (stem.value.trim() === '') stem.value = stemValue;
    exportButton.disabled = true;
    void (async () => {
      let done: boolean;
      try {
        done = await type.run(`${stemValue}.${ext}`, optionValues(type));
      } catch {
        done = false;
      }
      exportButton.disabled = false;
      // keepOpen — the native image dialogs' own behavior: the PNG
      // press leaves the dialog standing for the SVG press. An export
      // is not a dismissal.
      if (done && !type.keepOpen) closeCenterDialog(dialog);
    })();
  });

  // ONE copy binding — the clipboard press: the dialog STAYS OPEN (the
  // native behavior — a copy is not a save), a true answer flashes
  // "Copied" for the native's own 2s, and the surface's toast explains
  // either way.
  copy.addEventListener('click', () => {
    const type = activeType;
    const copyRun = type?.copy;
    if (!type || !copyRun) return;
    copy.disabled = true;
    void (async () => {
      let done: boolean;
      try {
        done = await copyRun(optionValues(type));
      } catch {
        done = false;
      }
      copy.disabled = false;
      if (!done) return;
      if (copyFlashTimer !== null) window.clearTimeout(copyFlashTimer);
      copy.textContent = 'Copied';
      copyFlashTimer = window.setTimeout(() => {
        copyFlashTimer = null;
        copy.textContent = 'Copy to clipboard';
      }, COPY_FLASH_MS);
    })();
  });

  return face;
}

/** One switch row, bound live to its model. */
function renderToggle(
  host: HTMLElement,
  option: Extract<ExportOption, { kind: 'toggle' }>,
  refreshSelection: () => void,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'export-center-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `export-option-${option.id}`;
  input.className = 'export-center-check';
  input.checked = option.value;
  input.addEventListener('change', () => {
    option.value = input.checked;
    option.onFlip?.(input.checked);
    refreshSelection();
  });
  const text = document.createElement('span');
  text.className = 'export-center-option-text';
  const label = document.createElement('span');
  label.className = 'export-center-option-label';
  label.setAttribute('for', input.id);
  label.textContent = option.label;
  if (option.tooltip) {
    // The ⓘ rides the label line's tail — the embed-scene help, the
    // vendor's own words (a title tooltip: the app's tooltip kit rides
    // modals, this is one word of help beside a switch, not a popover
    // surface).
    const info = document.createElement('span');
    info.className = 'export-center-option-info';
    info.setAttribute('role', 'img');
    info.setAttribute('aria-label', option.tooltip);
    info.title = option.tooltip;
    info.textContent = 'i';
    label.append(info);
  }
  text.append(label);
  if (option.hint) {
    const hint = document.createElement('span');
    hint.className = 'export-center-option-hint';
    hint.textContent = option.hint;
    text.append(hint);
  }
  row.append(input, text);
  host.append(row);
  return row;
}

/** One segmented row, bound live to its model. */
function renderSegment(
  host: HTMLElement,
  option: Extract<ExportOption, { kind: 'segment' }>,
  refreshSelection: () => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'export-center-scale-row';
  const label = document.createElement('span');
  label.className = 'export-center-scale-label';
  label.textContent = option.label;
  const group = document.createElement('div');
  group.className = 'export-center-seg';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', option.label);
  const buttons = option.values.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'export-center-seg-btn';
    button.textContent = value.label;
    if (value.title) button.title = value.title;
    button.setAttribute('aria-checked', String(option.value === value.id));
    button.addEventListener('click', () => {
      option.value = value.id;
      option.onPick?.(value.id);
      for (const other of buttons) {
        other.setAttribute('aria-checked', 'false');
      }
      button.setAttribute('aria-checked', 'true');
      refreshSelection();
    });
    group.append(button);
    return button;
  });
  row.append(label, group);
  host.append(row);
  return row;
}

/** The stage's empty answer — a quiet ghost glyph carrying the note,
 * never a blank box (the audit's dead-preview verdict). A render in
 * flight pulses the same ghost; a still-empty ANSWER collapses the
 * stage to the ghost's own height (content-driven, never a slab of
 * nothing), while a loading ghost keeps the stage's full box so the
 * layout never jumps when the answer lands. */
function paintEmpty(f: CenterFace, text: string, loading = false): void {
  f.stage.classList.remove('export-center-stage--transparent');
  f.stage.classList.toggle('export-center-stage--empty', !loading);
  const empty = document.createElement('div');
  empty.className = 'export-center-stage-empty';
  if (loading) empty.classList.add('is-loading');
  const glyph = document.createElement('span');
  glyph.className = 'export-center-stage-empty-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML =
    '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>';
  const line = document.createElement('p');
  line.className = 'export-center-stage-empty-text';
  line.textContent = text;
  empty.append(glyph, line);
  f.stageBody.replaceChildren(empty);
}

/** Paints the stage from one preview answer. */
function paintPreview(f: CenterFace, preview: ExportPreview): void {
  f.stageBody.replaceChildren();
  // The checkerboard — transparency is SEEN, not guessed: a render
  // with its background off rides the transparency stage.
  f.stage.classList.remove('export-center-stage--empty');
  f.stage.classList.toggle('export-center-stage--transparent', preview.transparent === true);
  const hasText = preview.text !== undefined && preview.text.trim() !== '';
  const hasContent =
    Boolean(preview.canvas) ||
    Boolean(preview.image) ||
    Boolean(preview.html) ||
    Boolean(preview.card) ||
    hasText;
  if (!hasContent) {
    // Nothing to carry: the ghost answers (with the note's own words
    // when it has them), and the caption stands down — one voice, not
    // the same line twice.
    paintEmpty(f, preview.note ?? 'Nothing to preview yet.');
    f.stageNote.textContent = '';
    f.stageNote.hidden = true;
    return;
  }
  if (preview.canvas) {
    const canvas = preview.canvas;
    canvas.className = 'export-center-stage-canvas';
    f.stageBody.append(canvas);
  } else if (preview.image) {
    const img = document.createElement('img');
    img.className = 'export-center-stage-img';
    img.alt = 'Export preview';
    img.src = preview.image;
    f.stageBody.append(img);
  } else if (preview.html) {
    const doc = document.createElement('div');
    doc.className = 'export-center-stage-html';
    doc.innerHTML = preview.html;
    f.stageBody.append(doc);
  } else if (preview.text !== undefined) {
    const pre = document.createElement('pre');
    pre.className = 'export-center-stage-text';
    pre.textContent = preview.text;
    f.stageBody.append(pre);
  } else if (preview.card) {
    const card = document.createElement('div');
    card.className = 'export-center-stage-card';
    const glyph = document.createElement('span');
    glyph.className = 'export-center-card-glyph';
    glyph.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' +
      '</svg>';
    const title = document.createElement('p');
    title.className = 'export-center-card-title';
    title.textContent = preview.card.title;
    const meta = document.createElement('ul');
    meta.className = 'export-center-card-meta';
    for (const line of preview.card.meta) {
      const item = document.createElement('li');
      item.textContent = line;
      meta.append(item);
    }
    card.append(glyph, title, meta);
    f.stageBody.append(card);
  }
  f.stageNote.textContent = preview.note ?? '';
  f.stageNote.hidden = (preview.note ?? '') === '';
}

/** The debounced, token-guarded preview render. The stage's own box is
 * measured at render time and handed to the preview (the drawing rows
 * pass it as the native dialog's own maxWidthOrHeight). */
function schedulePreview(type: ExportCenterType): void {
  const f = face;
  if (!f) return;
  const token = ++previewToken;
  // A render in flight: the caption speaks under the stage, and a
  // still-empty stage carries the pulsing ghost — an already-painted
  // stage keeps its content until the answer lands (the live swap).
  f.stageNote.textContent = 'Rendering the preview…';
  f.stageNote.hidden = false;
  if (!f.stageBody.firstElementChild) paintEmpty(f, 'Rendering the preview…', true);
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
  }
  previewTimer = window.setTimeout(() => {
    void (async () => {
      const stage = {
        width: f.stage.offsetWidth,
        height: f.stage.offsetHeight,
      };
      let answer: ExportPreview;
      try {
        answer = await type.preview(optionValues(type), stage);
      } catch (error) {
        // The native preview's own honest answer for an unrenderable
        // canvas — the note explains and the export can still try.
        const message = error instanceof Error ? error.message : String(error);
        answer = {
          note: message.includes('canvas may be too big')
            ? 'The canvas may be too big — the export can still try.'
            : 'The preview failed — the export can still try.',
        };
      }
      if (token !== previewToken || activeType !== type) {
        // A stale render: discard, and release its object URL if it
        // made one.
        if (answer.image?.startsWith('blob:')) URL.revokeObjectURL(answer.image);
        return;
      }
      revokePreviewUrl();
      if (answer.image?.startsWith('blob:')) previewUrl = answer.image;
      paintPreview(f, answer);
    })();
  }, 150);
}

/** Selects one type: the chip radios, the description line, the name
 * suffix (the live option values' extension — the embed double
 * extension included), the copy press, the options section, preview. */
function selectType(type: ExportCenterType, previousType: ExportCenterType | null): void {
  const f = face;
  if (!f) return;
  activeType = type;
  for (const chip of f.chips.querySelectorAll<HTMLButtonElement>('button[role="radio"]')) {
    chip.setAttribute('aria-checked', String(chip.dataset.typeId === type.id));
  }
  f.desc.textContent = type.hint ?? '';
  f.desc.hidden = !type.hint;
  // The copy press — a format with a copy in a clipboard-capable
  // environment speaks it; every other format hides it.
  f.copy.hidden = !(type.copy && (type.copySupported?.() ?? true));
  if (f.copy.hidden && copyFlashTimer !== null) {
    window.clearTimeout(copyFlashTimer);
    copyFlashTimer = null;
  }
  if (f.copy.hidden) f.copy.textContent = 'Copy to clipboard';
  // The stem survives a format switch once the user has edited it (the
  // user's naming is theirs, minus the formats' own extensions —
  // switching PNG→SVG must not export "note.png.svg"). Until the first
  // edit, each format adopts its own default.
  const previousExt = previousType ? extensionFor(previousType) : type.extension;
  let stem = f.stem.value;
  if (stemDirty) {
    if (previousType) stem = stripOwnExtension(stem, previousExt);
    stem = stripOwnExtension(stem, extensionFor(type));
  }
  f.stem.value = stem.trim() === '' || !stemDirty ? type.defaultStem : stem;
  f.suffix.textContent = `.${extensionFor(type)}`;

  f.optionsHost.replaceChildren();
  const options = type.options ?? [];
  for (const option of options) {
    if (option.kind === 'toggle') renderToggle(f.optionsHost, option, refreshSelection);
    else renderSegment(f.optionsHost, option, refreshSelection);
  }
  f.optionsHost.hidden = options.length === 0;
  // A format with no option rows is a COMPACT face: the body folds to
  // one column (the narrow-viewport fold, reused), the stage shrinks
  // with it — a text note's dialog never carries a drawing's height.
  f.dialog.classList.toggle('export-center--bare', options.length === 0);

  schedulePreview(type);
}

/** Re-reads the active type's option-dependent state — an option
 * flipped: the suffix chip (the embed double extension lands live),
 * then the preview. */
function refreshSelection(): void {
  const type = activeType;
  const f = face;
  if (!type || !f) return;
  f.suffix.textContent = `.${extensionFor(type)}`;
  schedulePreview(type);
}

/**
 * Opens the export center for the given host. Safe to call repeatedly:
 * the face is built once, every binding reads the LIVE host, and a
 * fresh open replaces the previous session's state wholesale.
 */
export function openExportCenter(host: ExportCenterHost): void {
  const f = centerFace();

  // A still-open center (a reopen without a close) is stood down first —
  // through the dialog's own close event, so its cleanup runs exactly
  // once, through the one path that knows how.
  if (document.body.contains(f.dialog) && f.dialog.open) {
    closeCenterDialog(f.dialog);
  }

  activeHost = host;
  f.heading.textContent = host.heading;
  f.subheading.textContent = host.subheading ?? '';
  f.subheading.hidden = !host.subheading;

  // The format chips — one full-width radio row, every format a peer.
  f.chips.replaceChildren();
  for (const type of host.types) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'export-center-chip';
    chip.dataset.typeId = type.id;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', 'false');
    chip.textContent = type.label;
    f.chips.append(chip);
  }

  if (host.door) {
    f.doorLabel.textContent = host.door.label;
    f.door.hidden = false;
    f.door.onclick = () => {
      closeCenterDialog(f.dialog);
      host.door?.onOpen();
    };
  } else {
    f.door.hidden = true;
    f.door.onclick = null;
  }

  f.exportButton.disabled = false;

  // Initial selection: the host's pick, or the first chip.
  stemDirty = false;
  const initial =
    host.types.find((type) => type.id === host.initialTypeId) ?? host.types[0] ?? null;
  f.stem.value = initial?.defaultStem ?? '';
  if (initial) {
    selectType(initial, null);
  } else {
    activeType = null;
    f.suffix.textContent = '';
    f.optionsHost.replaceChildren();
    f.optionsHost.hidden = true;
    f.stageBody.replaceChildren();
    f.stageNote.replaceChildren();
  }

  if (typeof f.dialog.showModal === 'function') {
    f.dialog.showModal();
  } else {
    // jsdom-grade embeds: no native <dialog> — the attribute keeps the
    // chips reachable without the top-layer promise.
    f.dialog.setAttribute('open', '');
  }
  // The selected chip takes the focus on open — the keyboard lands on
  // the primary control.
  f.chips.querySelector<HTMLButtonElement>('.export-center-chip[aria-checked="true"]')?.focus();
}
