/**
 * The legacy editor implementation of EditorPort: the existing
 * contenteditable #note surface driven by document.execCommand.
 *
 * This file concentrates everything the old editor did implicitly —
 * styleWithCSS tuning, sanitize-on-entry, innerHTML round-trips, the
 * execCommand boolean contract — so the rest of the app never touches the
 * surface directly. When the document-model editor lands, it ships as a
 * sibling implementation of EditorPort and this adapter retires.
 */
import type { EditorCommand, EditorPort, FormatCommand } from './port';

const FORMAT_COMMANDS: readonly FormatCommand[] = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
];

function isFormatCommand(command: EditorCommand): command is FormatCommand {
  return (FORMAT_COMMANDS as readonly string[]).includes(command);
}

export interface ContentEditablePortDeps {
  /**
   * The storage-format sanitizer (tabs.ts). Every string that enters the
   * surface through setHtml passes through it, exactly like storage load.
   */
  sanitize: (html: string) => string;

  /**
   * Called after setHtml replaces the content — the TabManager hook that
   * persists the replacement and refreshes the tab label.
   */
  onDocumentReplaced?: () => void;
}

export class ContentEditablePort implements EditorPort {
  private readonly element: HTMLElement;
  private readonly deps: ContentEditablePortDeps;

  constructor(element: HTMLElement, deps: ContentEditablePortDeps) {
    this.element = element;
    this.deps = deps;

    // Keep execCommand producing plain tags (b/i/u/s) rather than inline
    // styles — the storage subset has no place for `<span style>`.
    document.execCommand('styleWithCSS', false, 'false');
  }

  getHtml(): string {
    return this.element.innerHTML;
  }

  setHtml(html: string): void {
    this.element.innerHTML = this.deps.sanitize(html);
    this.deps.onDocumentReplaced?.();
  }

  getText(): string {
    return this.element.innerText.replace(/\u00a0/g, ' ');
  }

  isEmpty(): boolean {
    return this.getText().trim() === '';
  }

  focus(): void {
    this.element.focus();
  }

  isCaretInside(): boolean {
    const selection = window.getSelection();
    return (
      !!selection &&
      selection.rangeCount > 0 &&
      this.element.contains(selection.getRangeAt(0).startContainer)
    );
  }

  ensureCaretInside(): boolean {
    if (this.isCaretInside()) {
      return true;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this.element);
    range.collapse(false); // end of the note
    selection?.removeAllRanges();
    selection?.addRange(range);
    return this.isCaretInside();
  }

  charBeforeCaret(): string {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return '';
    }

    const anchor = selection.getRangeAt(0).startContainer;
    const offset = selection.getRangeAt(0).startOffset;

    if (anchor.nodeType === Node.TEXT_NODE) {
      return (anchor.nodeValue ?? '').slice(0, offset).slice(-1);
    }

    // Element anchor: the text right before it, if any.
    const element = anchor as Element;
    const before = element.textContent ?? '';
    return offset > 0 ? before.slice(-1) : before;
  }

  insertText(text: string): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('insertText', false, text);
  }

  applyFormat(command: EditorCommand): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    if (!isFormatCommand(command) && command !== 'removeFormat') {
      return false;
    }
    return document.execCommand(command, false);
  }

  queryFormat(command: FormatCommand): boolean {
    return document.queryCommandState(command);
  }

  undo(): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('undo', false);
  }

  redo(): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    return document.execCommand('redo', false);
  }

  onInput(listener: () => void): () => void {
    this.element.addEventListener('input', listener);
    return () => {
      this.element.removeEventListener('input', listener);
    };
  }
}
