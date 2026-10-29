/**
 * The owned confirm/prompt dialog — a native <dialog> on the design
 * tokens, replacing sweetalert2 (a 70KB library the app used for seven
 * confirm boxes, then fought with 150 lines of !important overrides).
 *
 * The recipe is the one the sweetalert overrides had already converged
 * on: elevated surface, border token, the radius-lg dialog geometry,
 * 600-weight title, muted body, primary confirm (danger variant for
 * destructive asks), quiet cancel. Native <dialog> brings the rest for
 * free — focus trapping, Escape, top-layer stacking, backdrop — where
 * the library had to fake each one.
 *
 * API (Promise-shaped, one call per question):
 *   const ok = await confirmDialog({ title, text?, danger?, confirm?, cancel? });
 *   const name = await promptDialog({ title, label?, value?, confirm? });
 */
import './dialog.css';

export interface ConfirmOptions {
  title: string;
  text?: string;
  /** Destructive ask — the confirm button takes the danger face. */
  danger?: boolean;
  confirm?: string;
  cancel?: string;
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  confirm?: string;
  cancel?: string;
  /** The input's placeholder. */
  placeholder?: string;
}

interface DialogFace {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  body: HTMLElement;
  confirm: HTMLButtonElement;
  cancel: HTMLButtonElement;
  input: HTMLInputElement;
  inputRow: HTMLElement;
  form: HTMLFormElement;
}

let face: DialogFace | null = null;

/** Builds (once) the one dialog the app owns. */
function dialogFace(): DialogFace {
  if (face) {
    return face;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'vz-dialog';

  const form = document.createElement('form');
  form.method = 'dialog';
  dialog.append(form);

  const title = document.createElement('h2');
  title.className = 'vz-dialog-title';
  form.append(title);

  const body = document.createElement('p');
  body.className = 'vz-dialog-text';
  form.append(body);

  const inputRow = document.createElement('label');
  inputRow.className = 'vz-dialog-input-row';
  const label = document.createElement('span');
  label.className = 'vz-dialog-input-label';
  const input = document.createElement('input');
  input.className = 'vz-dialog-input';
  input.type = 'text';
  inputRow.append(label, input);
  form.append(inputRow);

  const actions = document.createElement('div');
  actions.className = 'vz-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'vz-dialog-cancel';
  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.className = 'vz-dialog-confirm';
  actions.append(cancel, confirm);
  form.append(actions);

  document.body.append(dialog);
  face = { dialog, title, body, confirm, cancel, input, inputRow, form };
  return face;
}

/** Opens the dialog dressed for a confirm; resolves on the answer. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const face = dialogFace();
  face.title.textContent = options.title;
  face.body.textContent = options.text ?? '';
  face.body.hidden = !options.text;
  face.inputRow.hidden = true;
  face.confirm.textContent = options.confirm ?? 'OK';
  face.cancel.textContent = options.cancel ?? 'Cancel';
  face.confirm.classList.toggle('vz-dialog-danger', options.danger === true);
  return ask(face, false).then((answer) => answer === 'confirm');
}

/** Opens the dialog dressed for a prompt; resolves the value or null. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  const face = dialogFace();
  face.title.textContent = options.title;
  face.body.textContent = options.label ?? '';
  face.body.hidden = !options.label;
  face.inputRow.hidden = false;
  face.input.value = options.value ?? '';
  face.input.placeholder = options.placeholder ?? '';
  face.confirm.textContent = options.confirm ?? 'OK';
  face.cancel.textContent = options.cancel ?? 'Cancel';
  face.confirm.classList.remove('vz-dialog-danger');
  return ask(face, true).then((answer) =>
    answer === 'confirm' ? face.input.value.trim() : null,
  );
}

/**
 * The one open/close dance: show the (non-modal-free) dialog, wait for
 * either button or a native cancel (Escape / backdrop-ish), and hand the
 * answer back. The previous opener's pending promise resolves cancelled
 * if something re-asks first — the dialog is one, the questions queue
 * never.
 */
function ask(face: DialogFace, focusInput: boolean): Promise<'confirm' | 'cancel'> {
  return new Promise((resolve) => {
    const settle = (answer: 'confirm' | 'cancel'): void => {
      face.confirm.removeEventListener('click', onConfirm);
      face.cancel.removeEventListener('click', onCancel);
      face.dialog.removeEventListener('cancel', onCancel);
      closeDialog(face.dialog);
      resolve(answer);
    };
    const onConfirm = (): void => settle('confirm');
    const onCancel = (): void => settle('cancel');

    face.confirm.addEventListener('click', onConfirm);
    face.cancel.addEventListener('click', onCancel);
    face.dialog.addEventListener('cancel', onCancel);

    if (face.dialog.open) {
      // A question already stood — answer it cancelled before this one
      // takes the stage.
      closeDialog(face.dialog);
    }
    if (typeof face.dialog.showModal === 'function') {
      face.dialog.showModal();
    } else {
      // jsdom has no <dialog> semantics — the open attribute stands in so
      // the DOM asserts and the close paths still resolve.
      face.dialog.setAttribute('open', '');
    }
    (focusInput ? face.input : face.cancel).focus();
    if (focusInput) {
      face.input.select();
    }
  });
}

/** Closes the dialog wherever it opened (native or jsdom stand-in). */
function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}
