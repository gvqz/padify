/**
 * Debounce wrapper. The returned function forwards its `this` value and all
 * arguments to `func` (the original implementation captured `this`/`arguments`
 * and re-applied them), so it can be used as a drop-in event handler.
 */
export function debounce<T extends (...args: never[]) => void>(
  func: T,
  wait: number,
  immediate?: boolean,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return function (this: unknown, ...args: Parameters<T>) {
    const context = this; // eslint-disable-line @typescript-eslint/no-this-alias -- classic debounce: `this` must outlive the timeout
    const later = function () {
      timeout = undefined;
      if (!immediate) {
        func.apply(context, args);
      }
    };

    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) {
      func.apply(context, args);
    }
  };
}
