/**
 * The Markdown selection-state contract — shared by the two editing
 * grammars (the WYSIWYG's ProseMirror selection and the source pane's
 * textarea selection) and every chrome that reads their pressed states
 * (the toolbar, the context menu). It lives in its own module so the
 * surface and the source primitives can both speak it without a
 * static import cycle between them (architecture.test.ts pins the
 * module graph acyclic).
 */

/** What the toolbar's pressed-state pass wants to know about the caret. */
export interface MarkdownSelectionState {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: boolean;
  /** The href at the caret/selection (the link chip's Open/Copy/Edit). */
  linkHref: string | null;
  /** Heading level when the caret's block IS a heading; null otherwise. */
  heading: number | null;
  blockquote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  /** The caret sits in a GFM task item (checkbox column). */
  task: boolean;
  codeBlock: boolean;
  /** The selection IS an equation node (the bubble's edit mode). */
  math: 'inline' | 'block' | null;
  /** The selection IS an image chip. */
  image: boolean;
  /** The caret sits inside a table (the table-ops menu). */
  inTable: boolean;
}
