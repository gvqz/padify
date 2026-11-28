import { describe, expect, it } from 'vitest';
import { confirmDialog, promptDialog } from './dialog';

// One dialog, one standing question (see ask's activeSettle). A second ask
// used to close the ELEMENT only: the first ask's listeners stayed on the
// shared buttons, so one click resolved BOTH promises with the same answer
// — an async "Reload now?" arriving over a destructive confirm could
// silently confirm the destructive one — and the first promise hung until
// the second was answered. These tests pin the takeover.

describe('the owned dialog — one question at a time', () => {
  it('a re-ask settles the standing question cancelled; the click answers only the new one', async () => {
    const destructive = confirmDialog({ title: 'Clear completed reminders?', danger: true });
    const update = confirmDialog({ title: 'Update available — reload now?' });

    // The re-ask answered the destructive question cancelled (and
    // detached its listeners) — the takeover IS the settlement.
    await expect(destructive).resolves.toBe(false);

    const confirm = document.querySelector<HTMLButtonElement>('.vz-dialog-confirm');
    expect(confirm).not.toBeNull();
    confirm!.click();
    await expect(update).resolves.toBe(true);
  });

  it('a re-asked prompt settles its displaced ask with null', async () => {
    const first = promptDialog({ title: 'Name it', value: 'first' });
    const second = promptDialog({ title: 'Name it again', value: 'second' });

    await expect(first).resolves.toBeNull();

    document.querySelector<HTMLButtonElement>('.vz-dialog-cancel')!.click();
    await expect(second).resolves.toBeNull();
  });

  it('an answered question leaves no residue — the next ask works normally', async () => {
    const first = confirmDialog({ title: 'First?' });
    document.querySelector<HTMLButtonElement>('.vz-dialog-confirm')!.click();
    await expect(first).resolves.toBe(true);

    const second = confirmDialog({ title: 'Second?' });
    document.querySelector<HTMLButtonElement>('.vz-dialog-cancel')!.click();
    await expect(second).resolves.toBe(false);
  });

  it('a backdrop click answers the standing question cancelled — the one dismiss rule', async () => {
    const ask = confirmDialog({ title: 'Clear page?' });
    const dialog = document.querySelector<HTMLDialogElement>('dialog.vz-dialog')!;
    expect(dialog).not.toBeNull();
    // jsdom gives the dialog a 0×0 box, so (−40,−40) is honestly "outside"
    // — the coordinates are the browser's contract; what this pins is the
    // press-on-shell + outside rule answering cancelled, Escape's twin.
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -40, clientY: -40 }));
    await expect(ask).resolves.toBe(false);
  });

  it('a click on the dialog’s own surface never dismisses — the buttons still answer', async () => {
    const ask = confirmDialog({ title: 'Clear page?' });
    const dialog = document.querySelector<HTMLDialogElement>('dialog.vz-dialog')!;
    // jsdom's 0×0 box makes (0,0) the box itself — a padding-strip click,
    // not a backdrop one. The ask must survive it.
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
    document.querySelector<HTMLButtonElement>('.vz-dialog-confirm')!.click();
    await expect(ask).resolves.toBe(true);
  });
});
