/**
 * The one toast the app has (the #toast div in the navbar). Thirteen
 * modules used to reach for this through the old src/utils.ts grab-bag —
 * which is what made that file the busiest import in the repo and half of
 * its only import cycle. It is a leaf: imports nothing, owns one element.
 */

export function showToast(message: string): void {
  const toast = document.getElementById('toast')!;
  toast.className = 'show';
  // Use textContent — never innerHTML — to avoid XSS from externally-sourced
  // error strings (Spotify API responses, server error bodies, etc.).
  toast.textContent = message;

  setTimeout(function () {
    toast.className = toast.className.replace('show', '');
  }, 2000);
}
