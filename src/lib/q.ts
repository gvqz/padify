/**
 * q — padify's owned DOM facade (the `$` that replaced jQuery).
 *
 * NOT jQuery: no effects engine, no ajax, no deferreds, no globals, no
 * plugin system. This is the small typed subset padify actually uses,
 * implemented directly over native DOM. It exists so the app owns its DOM
 * access layer instead of carrying a 90KB dependency whose only remaining
 * hard consumer was Bootstrap 3's JS bundle.
 *
 * Semantics deliberately match jQuery where call sites rely on it:
 *   - handlers are called with `this` = the (possibly delegated) element
 *   - `.on(type, selector, handler)` supports event delegation
 *   - `trigger('focus'|'select'|'click')` calls the native method
 *   - `.each/.map` callbacks receive (index, element), jQuery argument order
 *   - `.show/.hide` remember the previous inline display value
 *   - `.data()` applies jQuery's attribute value type conversion
 *   - events get an `originalEvent` self-reference (legacy shim, see below)
 *
 * Everything else is plain DOM with a chainable, array-backed shape.
 */

export type ElementOrDocument = Element | Document;

type NodeArray = ElementOrDocument[];

// DOM event payloads are dynamic by nature (keyboard, mouse, input events and
// legacy jQuery-era `originalEvent` reads all flow through the same handler
// signature — exactly like jQuery's TriggeredEvent did). One contained `any`
// keeps 300+ call sites honest without casting at every listener.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QEvent = Event & { originalEvent?: Event } & Record<string, any>;

export type QEventHandler = (this: HTMLElement, event: QEvent) => void;

interface WrapperRecord {
  direct?: EventListener;
  delegated: Map<string, EventListener>;
}

// Registered wrappers so `.off(type, handler)` can remove the exact listener
// we added (we wrap handlers to bind `this` and stamp `originalEvent`).
const wrappers = new WeakMap<QEventHandler, WrapperRecord>();

// jQuery's show/hide keep the previous inline display around so `.show()`
// restores what `.hide()` overwrote instead of forcing a display value.
const previousDisplay = new WeakMap<Element, string>();

function getWrapper(handler: QEventHandler): WrapperRecord {
  let record = wrappers.get(handler);
  if (!record) {
    record = { delegated: new Map() };
    wrappers.set(handler, record);
  }
  return record;
}

/** Stamp the legacy `originalEvent` self-reference jQuery used to provide. */
function stampOriginalEvent(event: Event): void {
  const legacy = event as QEvent;
  if (legacy.originalEvent === undefined) {
    try {
      Object.defineProperty(event, 'originalEvent', { value: event, configurable: true });
    } catch {
      // Frozen exotic event object — consumers already null-check the field.
    }
  }
}

function bindHandler(handler: QEventHandler, event: Event, element: EventTarget): void {
  stampOriginalEvent(event);
  handler.call(element as HTMLElement, event);
}

function delegatedWrapper(selector: string, handler: QEventHandler): EventListener {
  return function delegated(this: EventTarget, event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const matched = target.closest(selector);
    // Delegation only fires for matches inside the delegation root.
    if (!matched) return;
    if (this instanceof Node && !this.contains(matched)) return;
    bindHandler(handler, event, matched);
  };
}

function directWrapper(handler: QEventHandler): EventListener {
  return function direct(this: EventTarget, event: Event): void {
    bindHandler(handler, event, this);
  };
}

/** jQuery's data-attribute value coercion. */
function convertDataValue(raw: string): string | number | boolean | null {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function isElement(node: ElementOrDocument): node is Element {
  return node instanceof Element;
}

function isVisible(element: Element): boolean {
  const display = window.getComputedStyle(element).display;
  if (display === 'none') return false;
  // jQuery treats zero-footprint elements (also hidden ancestors) as hidden.
  const box = element as HTMLElement;
  if (box.offsetWidth === 0 && box.offsetHeight === 0) return false;
  return true;
}

function parseHtml(html: string): Element[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.children) as Element[];
}

function normalizeAppendSource(source: Q | ElementOrDocument | string): Element[] {
  if (typeof source === 'string') return parseHtml(source);
  if (source instanceof Q) return source.els.filter(isElement);
  if (isElement(source)) return [source];
  return [];
}

function inDocumentOrder(nodes: Iterable<ElementOrDocument>): NodeArray {
  const unique = Array.from(new Set(nodes));
  if (unique.length < 2) return unique;
  return unique.sort((a, b) => {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

export class Q {
  readonly els: NodeArray;

  constructor(elements: NodeArray) {
    this.els = elements;
  }

  get length(): number {
    return this.els.length;
  }

  /** Element accessor (jQuery's `.get(i)`, supports negative indexes). */
  get(index: number): ElementOrDocument | undefined {
    const i = index < 0 ? this.els.length + index : index;
    return this.els[i];
  }

  eq(index: number): Q {
    const el = this.get(index);
    return new Q(el ? [el] : []);
  }

  each(fn: (index: number, element: ElementOrDocument) => void): this {
    this.els.forEach((element, index) => fn(index, element));
    return this;
  }

  /**
   * jQuery-style map: callback is (index, element); array results are
   * flattened one level; null/undefined results are dropped. Returns a
   * plain array.
   */
  map<T>(fn: (index: number, element: ElementOrDocument) => T): T[] {
    const result: T[] = [];
    this.els.forEach((element, index) => {
      const value = fn(index, element);
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) result.push(...value);
      else result.push(value);
    });
    return result;
  }

  find(selector: string): Q {
    const found: Element[] = [];
    this.els.forEach((el) => {
      if (isElement(el)) found.push(...Array.from(el.querySelectorAll(selector)));
    });
    return new Q(inDocumentOrder(found));
  }

  closest(selector: string): Q {
    const found: Element[] = [];
    this.els.forEach((el) => {
      if (isElement(el) && el.closest(selector)) found.push(el.closest(selector) as Element);
    });
    return new Q(inDocumentOrder(found));
  }

  children(selector?: string): Q {
    const found: Element[] = [];
    this.els.forEach((el) => {
      if (!isElement(el)) return;
      Array.from(el.children).forEach((child) => {
        if (!selector || child.matches(selector)) found.push(child);
      });
    });
    return new Q(inDocumentOrder(found));
  }

  filter(match: string | ((index: number, element: ElementOrDocument) => boolean)): Q {
    const predicate =
      typeof match === 'string'
        ? (_i: number, el: ElementOrDocument) => isElement(el) && el.matches(match)
        : (i: number, el: ElementOrDocument) => match(i, el);
    return new Q(this.els.filter((el, i) => predicate(i, el)));
  }

  not(match: string | ((index: number, element: ElementOrDocument) => boolean)): Q {
    const kept = this.filter(match);
    return new Q(this.els.filter((el) => !kept.els.includes(el)));
  }

  is(match: string): boolean {
    return this.els.some((el) => {
      if (match === ':checked') {
        return (el as HTMLInputElement).checked === true;
      }
      if (match === ':hidden') {
        return !isElement(el) || !isVisible(el);
      }
      return isElement(el) && el.matches(match);
    });
  }

  on(type: string, handler: QEventHandler): this;
  on(type: string, selector: string, handler: QEventHandler): this;
  on(type: string, selector: QEventHandler | string, maybeHandler?: QEventHandler): this {
    const delegated = typeof selector === 'string';
    const handler = (delegated ? maybeHandler : selector) as QEventHandler;
    const record = getWrapper(handler);

    this.els.forEach((el) => {
      if (delegated) {
        const wrap = delegatedWrapper(selector as string, handler);
        record.delegated.set(selector as string, wrap);
        el.addEventListener(type, wrap);
      } else {
        const wrap = record.direct ?? directWrapper(handler);
        record.direct = wrap;
        el.addEventListener(type, wrap);
      }
    });
    return this;
  }

  one(type: string, handler: QEventHandler): this {
    const record = getWrapper(handler);
    const wrap: EventListener = (event: Event) => {
      bindHandler(handler, event, event.currentTarget as ElementOrDocument);
    };
    record.direct = wrap;
    this.els.forEach((el) => el.addEventListener(type, wrap, { once: true }));
    return this;
  }

  off(type: string, handler: QEventHandler): this {
    const record = wrappers.get(handler);
    if (!record) return this;
    this.els.forEach((el) => {
      if (record.direct) el.removeEventListener(type, record.direct);
      record.delegated.forEach((wrap) => el.removeEventListener(type, wrap));
    });
    return this;
  }

  /**
   * jQuery-style trigger: `focus`/`select`/`click` call the native method
   * (jQuery special-cased those too); everything else dispatches a bubbling
   * native Event so both delegated and direct listeners receive it.
   */
  trigger(type: string): this {
    const nativeMethod: 'focus' | 'select' | 'click' | 'blur' | null =
      type === 'focus' || type === 'select' || type === 'click' || type === 'blur'
        ? type
        : null;
    this.els.forEach((el) => {
      if (nativeMethod && isElement(el)) {
        const html = el as HTMLElement & { select?: () => void };
        if (typeof html[nativeMethod] === 'function') {
          html[nativeMethod]();
          return;
        }
      }
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    });
    return this;
  }

  text(value?: string | number): string | this {
    if (value === undefined) {
      return this.els.length ? (this.els[0].textContent ?? '') : '';
    }
    this.els.forEach((el) => {
      if (isElement(el)) el.textContent = String(value);
    });
    return this;
  }

  html(value?: string): string | this {
    if (value === undefined) {
      return this.els.length && 'innerHTML' in this.els[0]
        ? String((this.els[0] as Element).innerHTML)
        : '';
    }
    this.els.forEach((el) => {
      if ('innerHTML' in el) (el as Element).innerHTML = value;
    });
    return this;
  }

  val(value?: string | number): string | number | null | this {
    if (value === undefined) {
      const first = this.els[0] as HTMLInputElement | undefined;
      return first ? first.value : null;
    }
    this.els.forEach((el) => {
      (el as HTMLInputElement).value = String(value);
    });
    return this;
  }

  attr(name: string): string | null;
  attr(name: string, value: string | number | boolean): this;
  attr(name: string, value?: string | number | boolean): string | null | this {
    if (value === undefined) {
      const first = this.els[0];
      return first && isElement(first) ? first.getAttribute(name) : null;
    }
    this.els.forEach((el) => {
      if (isElement(el)) el.setAttribute(name, String(value));
    });
    return this;
  }

  removeAttr(name: string): this {
    this.els.forEach((el) => {
      if (isElement(el)) el.removeAttribute(name);
    });
    return this;
  }

  prop(name: string): unknown;
  prop(name: string, value: unknown): this;
  prop(name: string, value?: unknown): unknown | this {
    if (value === undefined) {
      const first = this.els[0] as unknown as Record<string, unknown> | undefined;
      return first ? first[name] : undefined;
    }
    this.els.forEach((el) => {
      (el as unknown as Record<string, unknown>)[name] = value;
    });
    return this;
  }

  /** Reads `data-*` attributes (jQuery coercion applied). Read-only. */
  data(key: string): string | number | boolean | null {
    const first = this.els[0];
    if (!first || !isElement(first)) return null;
    const attribute = `data-${camelToKebab(key)}`;
    const raw = first.getAttribute(attribute);
    return raw === null ? null : convertDataValue(raw);
  }

  css(name: string): string;
  css(name: string, value: string | number): this;
  css(styles: Record<string, string | number>): this;
  css(
    nameOrStyles: string | Record<string, string | number>,
    value?: string | number,
  ): string | this {
    if (typeof nameOrStyles === 'string') {
      if (value === undefined) {
        const first = this.els[0];
        return first && isElement(first)
          ? window.getComputedStyle(first).getPropertyValue(camelToKebab(nameOrStyles))
          : '';
      }
      this.els.forEach((el) => {
        if (isElement(el)) (el as HTMLElement).style.setProperty(camelToKebab(nameOrStyles), String(value));
      });
      return this;
    }
    Object.entries(nameOrStyles).forEach(([name, styleValue]) => {
      this.els.forEach((el) => {
        if (isElement(el)) (el as HTMLElement).style.setProperty(camelToKebab(name), String(styleValue));
      });
    });
    return this;
  }

  addClass(classes: string): this {
    this.els.forEach((el) => {
      if (isElement(el)) el.classList.add(...classes.split(/\s+/).filter(Boolean));
    });
    return this;
  }

  removeClass(classes: string): this {
    this.els.forEach((el) => {
      if (isElement(el)) el.classList.remove(...classes.split(/\s+/).filter(Boolean));
    });
    return this;
  }

  toggleClass(classes: string, force?: boolean): this {
    this.els.forEach((el) => {
      if (isElement(el)) {
        classes
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => el.classList.toggle(c, force));
      }
    });
    return this;
  }

  hasClass(className: string): boolean {
    return this.els.some((el) => isElement(el) && el.classList.contains(className));
  }

  hide(): this {
    this.els.forEach((el) => {
      if (!isElement(el)) return;
      const style = (el as HTMLElement).style;
      if (!previousDisplay.has(el)) {
        previousDisplay.set(el, style.display);
      }
      style.display = 'none';
    });
    return this;
  }

  show(): this {
    this.els.forEach((el) => {
      if (!isElement(el)) return;
      const style = (el as HTMLElement).style;
      const previous = previousDisplay.get(el);
      if (previous !== undefined && previous !== 'none') {
        style.display = previous;
      } else {
        style.display = '';
      }
      // Hidden by a stylesheet rule (not inline) — jQuery forces the tag's
      // default display in that case.
      if (window.getComputedStyle(el).display === 'none') {
        style.display = 'block';
      }
    });
    return this;
  }

  append(source: Q | ElementOrDocument | string): this {
    const sources = normalizeAppendSource(source);
    this.els.forEach((el, containerIndex) => {
      if (!isElement(el)) return;
      sources.forEach((src) => {
        const lastContainer = containerIndex === this.els.length - 1;
        el.appendChild(lastContainer ? src : src.cloneNode(true));
      });
    });
    return this;
  }

  empty(): this {
    this.els.forEach((el) => {
      if ('innerHTML' in el) (el as Element).innerHTML = '';
    });
    return this;
  }

  remove(): this {
    this.els.forEach((el) => {
      if (isElement(el)) el.remove();
    });
    return this;
  }

  replaceWith(source: Q | ElementOrDocument | string): this {
    const sources = normalizeAppendSource(source);
    this.els.forEach((el, index) => {
      if (!isElement(el)) return;
      const last = index === this.els.length - 1;
      const nodes = sources.map((src) => (last ? src : src.cloneNode(true)));
      el.replaceWith(...nodes);
    });
    return this;
  }

  focus(handler?: QEventHandler): this {
    if (handler) return this.on('focus', handler);
    const first = this.els[0];
    if (isElement(first) && typeof (first as HTMLElement).focus === 'function') {
      (first as HTMLElement).focus();
    }
    return this;
  }

  select(handler?: QEventHandler): this {
    if (handler) return this.on('select', handler);
    const first = this.els[0];
    if (isElement(first) && typeof (first as HTMLInputElement).select === 'function') {
      (first as HTMLInputElement).select();
    }
    return this;
  }

  /** Event-binding shorthands (jQuery's direct event helpers). */
  keydown(handler: QEventHandler): this {
    return this.on('keydown', handler);
  }

  keyup(handler: QEventHandler): this {
    return this.on('keyup', handler);
  }

  input(handler: QEventHandler): this {
    return this.on('input', handler);
  }

  change(handler: QEventHandler): this {
    return this.on('change', handler);
  }

  scroll(handler: QEventHandler): this {
    return this.on('scroll', handler);
  }

  click(handler?: QEventHandler): this {
    return handler ? this.on('click', handler) : this.trigger('click');
  }

  blur(handler?: QEventHandler): this {
    return handler ? this.on('blur', handler) : this.trigger('blur');
  }

  scrollTop(value?: number): number | this {
    if (value === undefined) {
      const first = this.els[0] as { scrollTop?: number } | undefined;
      return first?.scrollTop ?? 0;
    }
    this.els.forEach((el) => {
      (el as { scrollTop?: number }).scrollTop = value;
    });
    return this;
  }

  /**
   * TEMPORARY compat shim: while Bootstrap 3's JS bundle still drives
   * modals, programmatic `.modal('show'/'hide')` calls delegate to it via
   * the window.jQuery global it requires. This method is deleted together
   * with the bundle when src/ui/behavior/ owns modals.
   */
  modal(action: string): this {
    const legacy = (window as unknown as {
      jQuery?: (input: unknown) => { modal: (a: string) => void };
    }).jQuery;
    if (!legacy) {
      throw new Error('.modal() compat shim needs the legacy bootstrap bundle');
    }
    this.els.forEach((el) => {
      if (isElement(el)) legacy(el).modal(action);
    });
    return this;
  }
}

export function $(input: string | ElementOrDocument | Q | ArrayLike<ElementOrDocument>): Q {
  if (input instanceof Q) {
    return new Q([...input.els]);
  }
  if (typeof input === 'string') {
    if (input.trimStart().startsWith('<')) {
      return new Q(parseHtml(input));
    }
    return new Q(Array.from(document.querySelectorAll(input)));
  }
  if (input instanceof Document) {
    return new Q([input]);
  }
  if (input instanceof Element) {
    return new Q([input]);
  }
  return new Q(inDocumentOrder(Array.from(input)));
}
