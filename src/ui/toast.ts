/**
 * The one toast the app has (the #toast div in the navbar). Thirteen
 * modules used to reach for this through the old src/utils.ts grab-bag —
 * which is what made that file the busiest import in the repo and half of
 * its only import cycle. It is a leaf: imports nothing, owns one element.
 *
 * The SweetAlert2 toast variant ("Notes copied to clipboard!") used to
 * run alongside this one — a different position, a different animation,
 * a green checkmark outside the palette — and the two disagreed about
 * everything but the 2-second lifetime. Every transient confirmation now
 * comes through here; the tone parameter carries the success/error
 * flavor as a monochrome glyph instead of Swal's icon set.
 *
 * Lifecycle, for the record:
 *  - one pending hide timer, cleared on every call — spam clicks restart
 *    the toast instead of letting an earlier timer cut it off mid-display;
 *  - the .show class is removed and re-added across a forced reflow, so
 *    the CSS transition treats each message as a fresh one (re-adding a
 *    class that is already present would not restart anything, which is
 *    exactly the stale-timeline bug the old string-surgery version had);
 *  - the enter/leave are TRANSITIONS (see 08-toasts.css), so the leave
 *    plays for real — the old keyframe timeline baked the fade-out into
 *    .show, snapped the toast back to full opacity when it ended, and
 *    only hid it when the JS timer happened to fire.
 */

export type ToastTone = 'neutral' | 'success' | 'error';

const TOAST_LIFETIME_MS = 2200;

let hideTimer: number | null = null;

export function showToast(message: string, tone: ToastTone = 'neutral'): void {
  const toast = document.getElementById('toast');
  if (!toast) {
    return;
  }

  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  toast.className = '';
  void toast.offsetWidth; // reflow — the enter transition restarts below
  toast.dataset.tone = tone;
  // Use textContent — never innerHTML — to avoid XSS from externally-sourced
  // error strings (music service responses, server error bodies, etc.).
  toast.textContent = message;
  toast.className = 'show';

  hideTimer = window.setTimeout(function () {
    hideTimer = null;
    toast.className = '';
  }, TOAST_LIFETIME_MS);
}
