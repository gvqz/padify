/**
 * The export center — the ONE dialog every export goes through.
 *
 * WHY THIS EXISTS (the owner's consolidation call): the download menu used
 * to be a nine-row dropdown — six text/padify rows always on, plus
 * note-conditional image/excalidraw/markdown rows — each row firing a
 * fixed-default exporter with no preview and no name control, while the
 * drawing's R1 dialog owned the only option-bearing face. The owner asked
 * for one popup: a preview on the left, the settings on the right, the
 * file name and file type editable in the same place, for every kind of
 * note. This is that dialog.
 *
 * THE CONTRACT: the center is pure UI and vendor-free — the host hands in
 * one ExportCenterType per file type the ACTIVE NOTE can become, each with
 * its own preview() and run(stem, values). The drawing's renderers (the
 * vendor island) arrive from surface.ts as delegates, so the 1.3 MB canvas
 * chunk never rides this module. Text, PDF, DOCX, HTML, Markdown, the
 * .padify envelope and the whole-pad save are wired in download-menu.ts.
 *
 * THE FACE: the owned dialog recipe (src/ui/dialog.css) widened to two
 * panes — the preview stage left, file type + file name + per-type options
 * right, the open door on the footer's quiet left. A native <dialog>
 * supplies the focus trap, Escape and the top layer. Options are a data
 * model (not DOM) so the drawing's PNG and SVG types can share one live
 * option set — flipping between them keeps the toggles exactly like the
 * vendor's own dialog does.
 *
 * HONESTY RULES: preview() answers for an ungated state with a note (an
 * empty drawing says so in the stage); run() answers false when it did not
 * export (a toast has already explained why) and the dialog stays open.
 * The dialog closes only on a reported success or on Cancel.
 */

import './export-center.css';

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

/** One file type the active note can become. */
export interface ExportCenterType {
  id: string;
  label: string;
  /** The suffix chip and the appended extension. */
  extension: string;
  /** The prefilled file name, WITHOUT the extension. */
  defaultStem: string;
  /** A one-liner under the type's label. */
  hint?: string;
  /** 'pad' types render after a hairline (the pad-level saves). */
  section?: 'note' | 'pad';
  /** The option model this type shows (shared instances share live state). */
  options?: ExportOption[];
  preview(values: ExportOptionValues): Promise<ExportPreview>;
  /** Exports with the (already sanitized + suffixed) file name. True = done. */
  run(fileName: string, values: ExportOptionValues): Promise<boolean>;
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
  cancel: HTMLButtonElement;
  exportButton: HTMLButtonElement;
}

let face: CenterFace | null = null;
let activeType: ExportCenterType | null = null;
let previewToken = 0;
let previewTimer: number | null = null;
/** The object URL the image preview currently shows — revoked on replace. */
let previewUrl: string | null = null;
/** Whether the user has edited the file-name field this session. Until
 * they do, every type switch adopts the type's own default stem (the old
 * dropdown named each row's file by its own rule — the workspace save was
 * always the dated pad stem, never the note's title); after an edit the
 * user's stem survives the switches, minus the types' extensions. */
let stemDirty = false;

/** Strips characters the download family never allowed into file names. */
function sanitizeStem(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? 'export' : cleaned;
}

/** Drops a trailing extension equal to the type's own (the user typing
 * "note.png" into the stem must not export "note.png.png"). */
function stripOwnExtension(stem: string, extension: string): string {
  const suffix = `.${extension.toLowerCase()}`;
  return stem.toLowerCase().endsWith(suffix) ? stem.slice(0, -suffix.length) : stem;
}

function optionValues(type: ExportCenterType): ExportOptionValues {
  const values: ExportOptionValues = {};
  for (const option of type.options ?? []) {
    if (option.kind === 'toggle') values[option.id] = option.value;
    else values[option.id] = option.value;
  }
  return values;
}

function revokePreviewUrl(): void {
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

/** Builds (once) the one dialog the app exports through. */
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

  const typeLabel = document.createElement('p');
  typeLabel.className = 'export-center-label';
  typeLabel.textContent = 'File type';
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

  settings.append(typeLabel, typeList, nameLabel, nameRow, optionsHost);
  body.append(preview, settings);
  dialog.append(body);

  const foot = document.createElement('div');
  foot.className = 'export-center-foot';
  const door = document.createElement('button');
  door.type = 'button';
  door.className = 'export-center-door';
  const actions = document.createElement('div');
  actions.className = 'vz-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'vz-dialog-cancel';
  cancel.textContent = 'Cancel';
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'vz-dialog-confirm export-center-export';
  exportButton.textContent = 'Export';
  actions.append(cancel, exportButton);
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
    cancel,
    exportButton,
  };

  cancel.addEventListener('click', () => {
    dialog.close();
  });

  // The first edit makes the file name the user's — type switches stop
  // adopting defaults from that point on (see stemDirty).
  stem.addEventListener('input', () => {
    stemDirty = true;
  });

  return face;
}

/** One toggle row, bound live to its model. */
function renderToggle(
  host: HTMLElement,
  option: Extract<ExportOption, { kind: 'toggle' }>,
  rerenderPreview: () => void,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'export-center-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'export-center-check';
  input.checked = option.value;
  input.addEventListener('change', () => {
    option.value = input.checked;
    rerenderPreview();
  });
  const text = document.createElement('span');
  text.className = 'export-center-option-text';
  text.textContent = option.label;
  const hint = document.createElement('span');
  hint.className = 'export-center-option-hint';
  hint.textContent = option.hint;
  text.append(hint);
  row.append(input, text);
  host.append(row);
  return row;
}

/** One segmented row, bound live to its model. */
function renderSegment(
  host: HTMLElement,
  option: Extract<ExportOption, { kind: 'segment' }>,
  rerenderPreview: () => void,
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
      rerenderPreview();
    });
    group.append(button);
    return button;
  });
  row.append(label, group);
  host.append(row);
  return row;
}

/** Paints the stage from one preview answer. */
function paintPreview(face: CenterFace, preview: ExportPreview): void {
  face.stageBody.replaceChildren();
  if (preview.image) {
    const img = document.createElement('img');
    img.className = 'export-center-stage-img';
    img.alt = 'Export preview';
    img.src = preview.image;
    face.stageBody.append(img);
  } else if (preview.html) {
    const doc = document.createElement('div');
    doc.className = 'export-center-stage-html';
    doc.innerHTML = preview.html;
    face.stageBody.append(doc);
  } else if (preview.text !== undefined) {
    const pre = document.createElement('pre');
    pre.className = 'export-center-stage-text';
    pre.textContent = preview.text;
    face.stageBody.append(pre);
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
    face.stageBody.append(card);
  }
  face.stageNote.textContent = preview.note ?? '';
  face.stageNote.hidden = (preview.note ?? '') === '';
}

/** The debounced, token-guarded preview render. */
function schedulePreview(face: CenterFace, type: ExportCenterType): void {
  const token = ++previewToken;
  face.stageNote.textContent = 'Rendering the preview…';
  face.stageNote.hidden = false;
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
      paintPreview(face, answer);
    })();
  }, 220);
}

/** Selects one type: pressed states, name suffix, options section, preview. */
function selectType(
  face: CenterFace,
  type: ExportCenterType,
  previousType: ExportCenterType | null,
  rerenderPreview: () => void,
): void {
  activeType = type;
  for (const button of face.typeList.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.typeId === type.id));
  }
  // The stem survives a type switch once the user has edited it (their
  // naming is theirs, minus the types' own extensions — switching
  // PNG→SVG must not export "note.png.svg"). Until the first edit, each
  // type adopts its own default — the old dropdown named every row's file
  // by its own rule, and that discipline keeps the workspace save dated.
  let stem = face.stem.value;
  if (stemDirty) {
    if (previousType) stem = stripOwnExtension(stem, previousType.extension);
    stem = stripOwnExtension(stem, type.extension);
  }
  face.stem.value = stem.trim() === '' || !stemDirty ? type.defaultStem : stem;
  face.suffix.textContent = `.${type.extension}`;

  face.optionsHost.replaceChildren();
  const options = type.options ?? [];
  for (const option of options) {
    if (option.when && !option.when.includes(type.id)) continue;
    if (option.kind === 'toggle') renderToggle(face.optionsHost, option, rerenderPreview);
    else renderSegment(face.optionsHost, option, rerenderPreview);
  }
  face.optionsHost.hidden = options.every(
    (option) => option.when && !option.when.includes(type.id),
  );

  schedulePreview(face, type);
}

/**
 * Opens the export center for the given host. Safe to call repeatedly:
 * the face is built once and refreshed per open.
 */
export function openExportCenter(host: ExportCenterHost): void {
  const f = centerFace();

  f.heading.textContent = 'Export';
  f.subheading.textContent = host.subheading ?? '';
  f.subheading.hidden = !host.subheading;

  // The type list — one pressed row per type, a hairline before pad-level
  // saves, the door wired for this session.
  f.typeList.replaceChildren();
  let lastSection: string | null = null;
  for (const type of host.types) {
    if (type.section === 'pad' && lastSection !== 'pad') {
      const sep = document.createElement('hr');
      sep.className = 'export-center-types-sep';
      f.typeList.append(sep);
    }
    lastSection = type.section ?? 'note';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'export-center-type';
    button.dataset.typeId = type.id;
    button.setAttribute('aria-pressed', 'false');
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
    f.door.textContent = host.door.label;
    f.door.hidden = false;
    f.door.onclick = () => {
      f.dialog.close();
      host.door?.onOpen();
    };
  } else {
    f.door.hidden = true;
    f.door.onclick = null;
  }

  const rerenderPreview = (): void => {
    if (activeType) schedulePreview(f, activeType);
  };
  f.typeList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.export-center-type');
    if (!button?.dataset.typeId) return;
    const type = host.types.find((t) => t.id === button.dataset.typeId);
    if (type && type !== activeType) selectType(f, type, activeType, rerenderPreview);
  });

  const run = (): void => {
    const type = activeType;
    if (!type) return;
    const stem = sanitizeStem(stripOwnExtension(f.stem.value, type.extension));
    if (f.stem.value.trim() === '') f.stem.value = stem;
    f.exportButton.disabled = true;
    void (async () => {
      let done: boolean;
      try {
        done = await type.run(`${stem}.${type.extension}`, optionValues(type));
      } catch {
        done = false;
      }
      f.exportButton.disabled = false;
      if (done) f.dialog.close();
    })();
  };
  f.exportButton.onclick = run;

  // Initial selection: the host's pick, else the first type. The stem
  // starts from that type's default and the dirty flag resets — a fresh
  // open names the file by the type's rule, and the first edit makes it
  // the user's.
  stemDirty = false;
  const initial = host.types.find((t) => t.id === host.initialTypeId) ?? host.types[0] ?? null;
  f.stem.value = initial?.defaultStem ?? '';
  if (document.body.contains(f.dialog) && f.dialog.open) {
    f.dialog.close();
  }
  f.dialog.showModal();
  if (initial) selectType(f, initial, null, rerenderPreview);
}
