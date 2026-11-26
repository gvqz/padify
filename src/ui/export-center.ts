/**
 * The export center — the app's ONE popup for the file-type exports.
 *
 * THE STORY AFTER THE CONSOLIDATION'S FALL (the one-menu answer): the
 * consolidation (9ba973e) replaced every export with a popup alone and
 * deleted the vendor's native dialog from the dist (e6a173b) — the
 * owner called it the model's worst mistake. Both were reverted, and
 * the center then earned a narrower contract (the launcher rows + the
 * drawing's own option-bearing dialog — TWO faces of ours for one
 * export, the owner's next verdict: "two separate menus that do the
 * same thing"). THIS pass is the one-menu answer:
 *
 *   - the drawing's image exports are INLINE rows here — PNG and SVG as
 *     full exporter types carrying the whole native option set
 *     (Background, Dark mode, Embed scene, 1×/2×/3× Scale), the live
 *     preview on the stage (the checkerboard when Background is off),
 *     the file name with the embed double extension (.excalidraw.png,
 *     live as the toggle flips), and a Copy-to-clipboard press beside
 *     the Export. No handoff, no second dialog — the standalone drawing
 *     export dialog is retired (its option vocabulary and its face's
 *     preview seam live in these rows).
 *   - the file-type exports (txt/md/pdf/docx/html), the .padify
 *     envelopes and the whole-pad save ride the same list — ONE menu,
 *     one muscle memory, every note type.
 *   - the vendor's own native dialog still answers behind the canvas
 *     menu and its chord (canvas.ts) — native parity, untouched.
 *
 * THE CONTRACT: the center is pure UI and vendor-free — the host hands in
 * one ExportCenterType per file type the ACTIVE NOTE can become, each
 * with its own preview() and run(stem, values) and, for the image rows,
 * copy(). The drawing's renderers arrive from surface.ts as delegates,
 * so the canvas chunk never rides this module.
 *
 * THE BINDING DISCIPLINE (the bug the consolidation shipped): the face is
 * built ONCE, so every listener binds ONCE at build and reads the LIVE
 * host through `activeHost` — the old build added a fresh typeList click
 * listener on every open, each closing over that open's host: the second
 * open double-fired selections, the third ran stale hosts' exporters
 * against the wrong note. One binding, one live host, no accumulation.
 *
 * HONESTY RULES: preview() answers for an ungated state with a note (an
 * empty drawing says so in the stage); run() answers false when it did
 * not export (a toast has already explained why) and the dialog stays
 * open. The dialog closes only on a reported success or on Cancel.
 * Object URLs die with the dialog that made them.
 *
 * THE REFINEMENT PASS (the visual audit's verdict, answered): the type
 * list speaks RADIO — a leading dot on the selected row, role=radio +
 * aria-checked, not a border inference; the groups are LABELED (Images /
 * File types / The pad itself) instead of a mystery hairline; the
 * keyboard is native — ArrowUp/ArrowDown walks the types (selection
 * follows focus), Enter in the name field is an Export, the selected row
 * takes focus on open; the footer's import door is a button that READS as
 * one (a folder glyph, an outline), not quiet text; and the dialog owns
 * its height — max-height, a scrolling body, a pinned footer, so a
 * short or narrow viewport never buries the Export press below the fold.
 */

import './export-center.css';
import { sanitizeFileStem, stripExtension } from './file-name';

/** What a type's preview() answers with. */
export interface ExportPreview {
  /** An image URL (object URL or data URL) — the stage shows an <img>. */
  image?: string;
  /** Plain-text preview — the stage shows a paper text card. */
  text?: string;
  /** Pre-rendered HTML body — the stage shows a mini document. */
  html?: string;
  /** A file-card flavor (glyph + title + meta lines) for envelope types. */
  card?: { title: string; meta: string[] };
  /** A muted status line under the stage (rendering notes, honest gates). */
  note?: string;
  /** True when the image was rendered with transparency (Background
   * off) — the stage paints the checkerboard behind it, so the
   * transparency is SEEN, not guessed. */
  imageTransparent?: boolean;
}

/** One toggle row (the drawing's background / dark / embed). */
export interface ExportOptionToggle {
  kind: 'toggle';
  id: string;
  label: string;
  hint: string;
  value: boolean;
  /** Show the row only for these type ids (default: every type sharing the model). */
  when?: readonly string[];
}

/** One segmented row (the drawing's scale). */
export interface ExportOptionSegment {
  kind: 'segment';
  id: string;
  label: string;
  values: { id: string; label: string; title?: string }[];
  value: string;
  when?: readonly string[];
}

export type ExportOption = ExportOptionToggle | ExportOptionSegment;

/** The live option readings a type's preview()/run() receive. */
export type ExportOptionValues = Record<string, boolean | string>;

/** One file type the active note can become — preview + run + (for
 * images) copy, all inline: selecting the row shows its options, its
 * preview, and its presses right here. No handoffs; no type opens
 * another face from this dialog. */
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
  /** A one-liner under the type's label. */
  hint?: string;
  /** The list's group: images (the drawing's PNG/SVG), note (the
   * file-type/envelope rows), pad (the whole-pad save). */
  section?: 'images' | 'note' | 'pad';
  /** The option model this type shows (shared instances share live state). */
  options?: ExportOption[];
  preview(values: ExportOptionValues): Promise<ExportPreview>;
  /** Exports with the (already sanitized + suffixed) file name. True = done. */
  run(fileName: string, values: ExportOptionValues): Promise<boolean>;
  /** Copies instead of saving (the image rows' clipboard press). True =
   * copied — the press flashes "Copied" and the dialog stays open, the
   * vendor's own behavior. Absent = no copy press for this type. */
  copy?(values: ExportOptionValues): Promise<boolean>;
  /** The clipboard capability gate — false hides the copy press (the
   * environment cannot hold this flavor). Absent = assumed supported. */
  copySupported?(): boolean;
}

export interface ExportCenterHost {
  /** The dialog's heading — the note's live title. */
  heading: string;
  subheading?: string;
  types: ExportCenterType[];
  initialTypeId?: string;
  /** The footer's open door (null hides it). */
  door?: { label: string; onOpen: () => void };
}

interface CenterFace {
  dialog: HTMLDialogElement;
  heading: HTMLElement;
  subheading: HTMLElement;
  stage: HTMLElement;
  stageBody: HTMLElement;
  stageNote: HTMLElement;
  typeList: HTMLElement;
  stem: HTMLInputElement;
  suffix: HTMLElement;
  optionsHost: HTMLElement;
  door: HTMLButtonElement;
  doorLabel: HTMLElement;
  cancel: HTMLButtonElement;
  /** The image rows' clipboard press — hidden for types without a copy
   * or when this environment cannot hold the flavor. */
  copy: HTMLButtonElement;
  exportButton: HTMLButtonElement;
}

let face: CenterFace | null = null;
/** The LIVE open's host — the single source every binding reads (the
 * listener-accumulation bug's cure: no per-open closures exist). */
let activeHost: ExportCenterHost | null = null;
let activeType: ExportCenterType | null = null;
let previewToken = 0;
let previewTimer: number | null = null;
/** The object URL the image preview currently shows — revoked on replace. */
let previewUrl: string | null = null;
/** The copy press's 2s "Copied" flash — the vendor's useCopyStatus. */
let copyFlashTimer: number | null = null;
/** Whether the user has edited the file-name field this session. Until
 * they do, every type switch adopts the type's own default stem (the old
 * dropdown named each row's file by its own rule — the workspace save was
 * always the dated pad stem, never the note's title); after an edit the
 * user's stem survives the switches, minus the types' extensions. */
let stemDirty = false;

/** Strips characters the download family never allowed into file names —
 * the one rule every export surface speaks (ui/file-name.ts). */
function sanitizeStem(raw: string): string {
  return sanitizeFileStem(raw);
}

/** Drops a trailing extension equal to the type's own (the user typing
 * "note.png" into the stem must not export "note.png.png"). */
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
 * chip and the export's file name both answer this, never the static
 * one when a dynamic voice speaks (the embed double extension). */
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

/** Builds (once) the one dialog the app exports through — with every
 * listener bound ONCE, reading the live host at event time. */
function centerFace(): CenterFace {
  if (face) {
    return face;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'vz-dialog export-center';
  dialog.setAttribute('aria-label', 'Export');

  const head = document.createElement('div');
  head.className = 'export-center-head';
  const heading = document.createElement('h2');
  heading.className = 'export-center-heading';
  const subheading = document.createElement('p');
  subheading.className = 'export-center-subheading';
  head.append(heading, subheading);
  dialog.append(head);

  const body = document.createElement('div');
  body.className = 'export-center-body';

  const preview = document.createElement('div');
  preview.className = 'export-center-preview';
  const label = document.createElement('p');
  label.className = 'export-center-label';
  label.textContent = 'Preview';
  const stage = document.createElement('div');
  stage.className = 'export-center-stage';
  const stageBody = document.createElement('div');
  stageBody.style.display = 'contents';
  const stageNote = document.createElement('p');
  stageNote.className = 'export-center-stage-note';
  stage.append(stageBody, stageNote);
  preview.append(label, stage);

  const settings = document.createElement('div');
  settings.className = 'export-center-settings';

  // The type list — its groups carry their own labels (Images / File
  // types / The pad itself), so no outer "File type" caption sits over
  // them: one hierarchy, not a label on a list of labels.
  const typeList = document.createElement('div');
  typeList.className = 'export-center-types';
  typeList.setAttribute('role', 'group');
  typeList.setAttribute('aria-label', 'File type');

  const nameLabel = document.createElement('p');
  nameLabel.className = 'export-center-label';
  nameLabel.textContent = 'File name';
  const nameRow = document.createElement('div');
  nameRow.className = 'export-center-name-row';
  const stem = document.createElement('input');
  stem.type = 'text';
  stem.className = 'vz-dialog-input';
  stem.setAttribute('aria-label', 'File name');
  stem.spellcheck = false;
  const suffix = document.createElement('span');
  suffix.className = 'export-center-name-suffix';
  nameRow.append(stem, suffix);

  const optionsHost = document.createElement('div');
  optionsHost.className = 'export-center-options';
  optionsHost.hidden = true;

  settings.append(typeList, nameLabel, nameRow, optionsHost);
  body.append(preview, settings);
  dialog.append(body);

  const foot = document.createElement('div');
  foot.className = 'export-center-foot';
  // The import door — a quiet ghost link with a folder glyph, clearly
  // tertiary to the actions: the round-trip door belongs here (open is
  // the other half of export), but never as a peer of Cancel/Export.
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
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'vz-dialog-cancel';
  cancel.textContent = 'Cancel';
  // The image rows' clipboard press — an outline button between Cancel
  // and Export, hidden unless the selected type speaks it.
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'vz-dialog-cancel export-center-copy';
  copy.textContent = 'Copy to clipboard';
  copy.hidden = true;
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'vz-dialog-confirm export-center-export';
  exportButton.textContent = 'Export';
  actions.append(cancel, copy, exportButton);
  foot.append(door, actions);
  dialog.append(foot);

  document.body.append(dialog);
  face = {
    dialog,
    heading,
    subheading,
    stage,
    stageBody,
    stageNote,
    typeList,
    stem,
    suffix,
    optionsHost,
    door,
    doorLabel,
    cancel,
    copy,
    exportButton,
  };

  cancel.addEventListener('click', () => {
    closeCenterDialog(dialog);
  });

  // The dialog going away (Escape, cancel, an export's success) kills
  // the pending preview, the object URL it left on the table, and the
  // copy press's flash — the old build let the first two leak until the
  // NEXT render replaced them.
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

  // The first edit makes the file name the user's — type switches stop
  // adopting defaults from that point on (see stemDirty).
  stem.addEventListener('input', () => {
    stemDirty = true;
  });

  // Enter in the name field is an Export — the native save-dialog
  // discipline (the audit: no user reaches for a button when the field
  // already has their hands on the keyboard).
  stem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      exportButton.click();
    }
  });

  // ONE typeList binding for the dialog's whole life (the consolidation
  // re-added this on every open — see the module docstring). It reads the
  // LIVE host, so a reopen can never fire a stale one.
  typeList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.export-center-type');
    if (!button?.dataset.typeId) return;
    const host = activeHost;
    if (!host) return;
    const type = host.types.find((item) => item.id === button.dataset.typeId);
    if (!type) return;
    if (type !== activeType) {
      selectType(type, activeType);
    }
  });

  // ONE arrow-key binding for the dialog's whole life: the native
  // save-dialog discipline — ArrowUp/ArrowDown walks the rows, the
  // selection follows the focus, and the list never scrolls under the
  // keypress.
  typeList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const host = activeHost;
    if (!host) return;
    const rows = Array.from(typeList.querySelectorAll<HTMLButtonElement>('.export-center-type'));
    if (rows.length < 2) return;
    const focusedIndex = rows.findIndex((row) => row === document.activeElement);
    const checked = typeList.querySelector('.export-center-type[aria-checked="true"]');
    const fromIndex = focusedIndex !== -1 ? focusedIndex : rows.findIndex((row) => row === checked);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = rows[(fromIndex + step + rows.length) % rows.length];
    event.preventDefault();
    next.focus();
    next.click();
  });

  // ONE export binding for the dialog's whole life.
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
      if (done) closeCenterDialog(dialog);
    })();
  });

  // ONE copy binding for the dialog's whole life — the image rows'
  // clipboard press: the dialog STAYS OPEN (the vendor's own behavior —
  // a copy is not a save), a true answer flashes "Copied" for 2s, and
  // the surface's toast explains either way.
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
      }, 2_000);
    })();
  });

  return face;
}

/** One toggle row, bound live to its model. */
function renderToggle(
  host: HTMLElement,
  option: Extract<ExportOption, { kind: 'toggle' }>,
  refreshSelection: () => void,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'export-center-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'export-center-check';
  input.checked = option.value;
  input.addEventListener('change', () => {
    option.value = input.checked;
    refreshSelection();
  });
  const text = document.createElement('span');
  text.className = 'export-center-option-text';
  // The label wears its own weight — the hint beside it stays a size
  // down and two shades quieter (the audit's hierarchy nit: a bare text
  // node and the hint read as one gray band).
  const label = document.createElement('span');
  label.className = 'export-center-option-label';
  label.textContent = option.label;
  const hint = document.createElement('span');
  hint.className = 'export-center-option-hint';
  hint.textContent = option.hint;
  text.append(label, hint);
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
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', option.label);
  const buttons = option.values.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'export-center-seg-btn';
    button.textContent = value.label;
    if (value.title) button.title = value.title;
    button.setAttribute('aria-pressed', String(option.value === value.id));
    button.addEventListener('click', () => {
      option.value = value.id;
      for (const other of buttons) {
        other.setAttribute('aria-pressed', 'false');
      }
      button.setAttribute('aria-pressed', 'true');
      refreshSelection();
    });
    group.append(button);
    return button;
  });
  row.append(label, group);
  host.append(row);
  return row;
}

/** Paints the stage from one preview answer. */
function paintPreview(f: CenterFace, preview: ExportPreview): void {
  f.stageBody.replaceChildren();
  // The checkerboard — transparency is SEEN, not guessed: an image
  // rendered with its background off rides the transparency stage.
  f.stage.classList.toggle('export-center-stage--transparent', preview.imageTransparent === true);
  if (preview.image) {
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
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
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

/** The debounced, token-guarded preview render. */
function schedulePreview(type: ExportCenterType): void {
  const f = face;
  if (!f) return;
  const token = ++previewToken;
  f.stageNote.textContent = 'Rendering the preview…';
  f.stageNote.hidden = false;
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
  }
  previewTimer = window.setTimeout(() => {
    void (async () => {
      let answer: ExportPreview;
      try {
        answer = await type.preview(optionValues(type));
      } catch {
        answer = { note: 'The preview failed — the export can still try.' };
      }
      if (token !== previewToken || activeType !== type) {
        // A stale render: discard, and release its object URL if it made one.
        if (answer.image?.startsWith('blob:')) URL.revokeObjectURL(answer.image);
        return;
      }
      revokePreviewUrl();
      if (answer.image?.startsWith('blob:')) previewUrl = answer.image;
      paintPreview(f, answer);
    })();
  }, 220);
}

/** Selects one type: the radio states, name suffix (the live option
 * values' extension — the embed double extension included), the copy
 * press, options section, preview. */
function selectType(type: ExportCenterType, previousType: ExportCenterType | null): void {
  const f = face;
  if (!f) return;
  activeType = type;
  // The radio states: the rows answer aria-checked (their dot is CSS,
  // the semantics are real).
  for (const button of f.typeList.querySelectorAll<HTMLButtonElement>('button[role="radio"]')) {
    button.setAttribute('aria-checked', String(button.dataset.typeId === type.id));
  }
  // The copy press — an image type in a clipboard-capable environment
  // speaks it; every other type hides it.
  f.copy.hidden = !(type.copy && (type.copySupported?.() ?? true));
  if (f.copy.hidden && copyFlashTimer !== null) {
    window.clearTimeout(copyFlashTimer);
    copyFlashTimer = null;
  }
  if (f.copy.hidden) f.copy.textContent = 'Copy to clipboard';
  // The stem survives a type switch once the user has edited it (their
  // naming is theirs, minus the types' own extensions — switching
  // PNG→SVG must not export "note.png.svg"). Until the first edit, each
  // type adopts its own default — the old dropdown named every row's file
  // by its own rule, and that discipline keeps the workspace save dated.
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
    if (option.when && !option.when.includes(type.id)) continue;
    if (option.kind === 'toggle') renderToggle(f.optionsHost, option, refreshSelection);
    else renderSegment(f.optionsHost, option, refreshSelection);
  }
  f.optionsHost.hidden = options.every((option) => option.when && !option.when.includes(type.id));

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
 * the face is built once, every binding reads the LIVE host, and a fresh
 * open replaces the previous session's state wholesale.
 */
export function openExportCenter(host: ExportCenterHost): void {
  const f = centerFace();

  // A still-open center (a reopen without a close) is stood down first —
  // through the dialog's own close event, so its cleanup runs exactly
  // once, through the one path that knows how. (jsdom-grade embeds have
  // no close() — the attribute itself stands down there.)
  if (document.body.contains(f.dialog) && f.dialog.open) {
    closeCenterDialog(f.dialog);
  }

  activeHost = host;
  f.heading.textContent = host.heading;
  f.subheading.textContent = host.subheading ?? '';
  f.subheading.hidden = !host.subheading;

  // The type list — one RADIO row per type, in groups that carry their
  // own labels (Images / This note / The pad itself): every row is
  // selectable, every selection speaks inline (the options, the preview,
  // the presses) — no handoffs, no chevrons.
  f.typeList.replaceChildren();
  const groupLabelFor = (key: string): string =>
    key === 'images' ? 'Images' : key === 'pad' ? 'The pad itself' : 'This note';
  const groupKeyFor = (type: ExportCenterType): string => type.section ?? 'note';
  let lastGroup: string | null = null;
  for (const type of host.types) {
    const group = groupKeyFor(type);
    if (group !== lastGroup) {
      const groupLabel = document.createElement('p');
      groupLabel.className = 'export-center-group-label';
      groupLabel.textContent = groupLabelFor(group);
      f.typeList.append(groupLabel);
    }
    lastGroup = group;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'export-center-type export-center-type--select';
    button.dataset.typeId = type.id;
    // Radio semantics — the dot is CSS, the aria-checked is real.
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    const label = document.createElement('span');
    label.className = 'export-center-type-label';
    label.textContent = type.label;
    if (type.hint) {
      const hint = document.createElement('span');
      hint.className = 'export-center-type-hint';
      hint.textContent = type.hint;
      label.append(hint);
    }
    const ext = document.createElement('span');
    ext.className = 'export-center-type-ext';
    ext.textContent = `.${type.extension}`;
    button.append(label, ext);
    f.typeList.append(button);
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

  // Initial selection: the host's pick, or the first row — every row is
  // a choice now. The stem starts from that type's default and the dirty
  // flag resets — a fresh open names the file by the type's rule, the
  // first edit makes it the user's.
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
    // rows reachable without the top-layer promise.
    f.dialog.setAttribute('open', '');
  }
  // The selected row takes the focus on open — the keyboard lands on
  // the primary control, not whichever button the UA picked first.
  // (Both paths: the fallback open keeps the same discipline.)
  f.typeList.querySelector<HTMLButtonElement>('.export-center-type[aria-checked="true"]')?.focus();
}
