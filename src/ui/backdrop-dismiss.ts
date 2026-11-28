/**
 * The one backdrop dismiss for the app's native <dialog> popups.
 *
 * The rule the whole app already lives by (behavior/modal.ts, the topbar
 * panels, the context menus): a popup is a tool, not a room — a click on
 * the dark outside closes it. A native <dialog>'s ::backdrop answers a
 * click as a click ON the dialog element itself, at coordinates outside
 * its box — but the dialog's own padding strip answers the same way with
 * coordinates inside, and a drag that starts on the surface and ends on
 * the backdrop lands the same click too. The dismiss is therefore exact:
 *
 *   - the PRESS must begin on the dialog element itself (a selection
 *     drag from the surface never counts), and
 *   - the click must land OUTSIDE the dialog's box (a stray click on the
 *     padding never throws the user out of a form mid-word).
 *
 * The caller supplies the close — every dialog owns its one close path
 * (the close event's cleanup runs the same for ×, Escape and this).
 */
export function attachBackdropDismiss(
  dialog: HTMLDialogElement,
  onClose: () => void,
): void {
  let pressOnShell = false;

  dialog.addEventListener('mousedown', (event) => {
    pressOnShell = event.target === dialog;
  });

  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || !pressOnShell) {
      return;
    }
    pressOnShell = false;
    const rect = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (inside) {
      return;
    }
    onClose();
  });
}
