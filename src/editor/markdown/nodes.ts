/**
 * The Markdown surface's custom nodes and interactions — the pieces that
 * turn Milkdown's stock presets into Padify's markdown editor:
 *
 *  • math_inline / math_block — LIVE equations in the WYSIWYG. The stock
 *    @milkdown/plugin-math ships its own KaTeX node rendering (and its
 *    own katex + utils copies); these nodes serialize through
 *    remark-math — the same `$…$` / `$$…$$` syntax the OWNED renderer
 *    (editor/markdown/render.ts) reads in preview, share links and
 *    export — and their node views render through the app's ONE math
 *    pipeline (editor/math.ts: the forbidden-macro gate, red-error
 *    display, renderToString — never katex.render), so the equation on
 *    screen in edit mode is pixel-identical to the one preview shows.
 *    The LaTeX lives in the node's text content (no attrs/value split
 *    brain): parse fills the content, serialize reads it back.
 *
 *  • image — a chip, never an `<img>`. The owned renderer deliberately
 *    renders images as links (a remote src would make the app fetch it
 *    — an IP logger in a note); the edit view must not be the one place
 *    that betrays that policy. The chip shows the alt text (or src) on
 *    the monochrome surface; the markdown round-trips untouched.
 *
 *  • task toggle — the GFM preset renders task items as
 *    li[data-item-type=task]; clicking the marker flips `checked`.
 *
 *  • Tab/Shift-Tab — list items sink/lift (the Docs gesture), code
 *    blocks take two spaces, tables defer to the GFM cell-walk keymap,
 *    and everywhere else Tab stays a focus key (keyboard users keep
 *    their escape hatch).
 *
 *  • Ctrl/Cmd-click on a link opens it (the html surface's gesture —
 *    the live DOM's hrefs already passed the surface's safe-href gate).
 */
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $inputRule, $nodeSchema, $prose, $remark } from '@milkdown/kit/utils';
import type {
  MarkdownNode,
  NodeSchema,
  ParserState,
  SerializerState,
} from '@milkdown/kit/transformer';
import { Fragment, type Node as ProseNode, type Schema } from '@milkdown/kit/prose/model';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { keymap } from '@milkdown/kit/prose/keymap';
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view';
import remarkMath from 'remark-math';
import { imageSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark';

import { MATH_CLASS, renderMathIn } from '../math';

export const MATH_INLINE_NODE = 'math_inline';
export const MATH_BLOCK_NODE = 'math_block';

/**
 * Fires when the user clicks a rendered equation (or an empty math
 * block's affordance): the toolbar's equation bubble opens in edit
 * mode for that node. detail: { latex, kind, pos }.
 */
export const MD_MATH_CLICK_EVENT = 'padify:md-math-click';

// ---------------------------------------------------------------------------
// remark-math — the syntax bridge (mdast math/inlineMath ↔ $…$/$$…$$)
// ---------------------------------------------------------------------------

export const remarkMathBridge = $remark('remarkMath', () => remarkMath as never);

// ---------------------------------------------------------------------------
// The math nodes
// ---------------------------------------------------------------------------

export const mathInlineSchema = $nodeSchema(
  MATH_INLINE_NODE,
  () =>
    ({
      group: 'inline',
      content: 'text*',
      inline: true,
      atom: true,
      parseDOM: [
        {
          tag: `span[data-type="${MATH_INLINE_NODE}"]`,
          getContent: (dom: Node, schema: Schema) => {
            if (!(dom instanceof HTMLElement)) {
              return Fragment.empty;
            }
            const text = dom.textContent;
            return text === '' ? Fragment.empty : Fragment.fromArray([schema.text(text)]);
          },
        },
      ],
      toDOM: (_node: ProseNode) => ['span', { 'data-type': MATH_INLINE_NODE }, 0],
      parseMarkdown: {
        match: (node: MarkdownNode) => node.type === 'inlineMath',
        runner: (
          state: ParserState,
          node: MarkdownNode,
          proseType: Parameters<ParserState['openNode']>[0],
        ) => {
          // An empty value must not reach addText — Schema.text('')
          // throws (empty text nodes are not allowed).
          const value = String(node.value ?? '');
          state.openNode(proseType);
          if (value !== '') {
            state.addText(value);
          }
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: ProseNode) => node.type.name === MATH_INLINE_NODE,
        runner: (state: SerializerState, node: ProseNode) => {
          state.addNode('inlineMath', undefined, node.textContent);
        },
      },
    }) as NodeSchema,
);

export const mathBlockSchema = $nodeSchema(
  MATH_BLOCK_NODE,
  () =>
    ({
      content: 'text*',
      group: 'block',
      marks: '',
      defining: true,
      atom: true,
      isolating: true,
      parseDOM: [
        {
          tag: `div[data-type="${MATH_BLOCK_NODE}"]`,
          preserveWhitespace: 'full',
        },
      ],
      toDOM: (_node: ProseNode) => ['div', { 'data-type': MATH_BLOCK_NODE }, 0],
      parseMarkdown: {
        match: (node: MarkdownNode) => node.type === 'math',
        runner: (
          state: ParserState,
          node: MarkdownNode,
          proseType: Parameters<ParserState['openNode']>[0],
        ) => {
          // An empty value must not reach addText — Schema.text('')
          // throws (empty text nodes are not allowed).
          const value = String(node.value ?? '');
          state.openNode(proseType);
          if (value !== '') {
            state.addText(value);
          }
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node: ProseNode) => node.type.name === MATH_BLOCK_NODE,
        runner: (state: SerializerState, node: ProseNode) => {
          state.addNode('math', undefined, node.textContent);
        },
      },
    }) as NodeSchema,
);

/**
 * Typing `$x$` at the caret becomes an inline equation. The pattern
 * mirrors remark-math's own fences: the content must not start or end
 * with whitespace (its parser refuses `$ x $`, so converting it would
 * break the round-trip on reparse) and holds no `$` or newline.
 */
export const mathInlineInputRule = $inputRule((ctx) => {
  const type = mathInlineSchema.type(ctx);
  return new InputRule(/(?:\$)([^$\s]|[^$\n][^$\n]*[^$\s])(?:\$)$/, (state, match, start, end) => {
    const latex = match[1];
    if (!latex) {
      return null;
    }
    const { tr } = state;
    tr.replaceWith(start, end, type.create(null, state.schema.text(latex)));
    return tr;
  });
});

/**
 * Typing `$$ ` at the start of a paragraph turns it into a display
 * equation (empty until the bubble — or a click on the affordance —
 * fills it).
 */
export const mathBlockInputRule = $inputRule((ctx) => {
  const type = mathBlockSchema.type(ctx);
  return new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type)) {
      return null;
    }
    const { tr } = state;
    return tr.delete(start, end).setBlockType(start, start, type);
  });
});

// ---------------------------------------------------------------------------
// Display math — the single-line `$$…$$` parity bridge
// ---------------------------------------------------------------------------

/**
 * remark-math 6 parses the compact `$$x$$` form as INLINE math — text math
 * with a doubled delimiter — while the owned renderer (render.ts
 * collectDisplayMath: the preview, share and export pipeline) treats it as
 * DISPLAY math whenever it sits on its own line(s). This bridge keeps the
 * WYSIWYG honest to that rule, both directions:
 *
 *   parse      a paragraph whose children are nothing but `$$…$$` inline
 *              math (whitespace-only text between allowed) is rewritten to
 *              one `math` mdast node per equation — the same shape the
 *              multi-line `$$\nx\n$$` fence parses to, so the visual mode
 *              shows display math exactly where the preview will. The
 *              delimiter count is recovered from the SOURCE at the node's
 *              position offsets (mdast does not keep it), so a plain `$x$`
 *              paragraph is never touched. Without this, opening a note in
 *              visual mode degraded every `$$…$$` to `$…$` in the stored
 *              source — display math silently became inline.
 *   serialize  a `math` mdast node round-trips as the compact single-line
 *              `$$x$$` form whenever the latex is single-line-safe (no
 *              newline, no `$$`, no `$` or whitespace at either edge, non-
 *              empty); everything else keeps mdast-util-math's padded
 *              multi-line shape, fence length escalated past the longest
 *              `$` run in the value. Registered AFTER remarkMath so this
 *              handler wins (mdast-util-to-markdown merges extensions
 *              last-wins). The compact form re-parses as a double-dollar
 *              text-math paragraph — this bridge's parse side turns it
 *              straight back into a `math` node, so the round trip is
 *              stable: what the user typed stays typed.
 */
export const padifyDisplayMathBridge = $remark(
  'remarkPadifyDisplayMath',
  () => padifyDisplayMath as never,
);

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset: number }; end: { offset: number } };
};

/** The remark plugin: parse-side transform + serialize-side handler. */
function padifyDisplayMath(this: {
  data: () => Record<string, unknown>;
}): (tree: MdNode, file: { value?: string } | string) => void {
  const data = this.data();
  const extensions = (data.toMarkdownExtensions as unknown[] | undefined) ?? [];
  data.toMarkdownExtensions = [...extensions, { handlers: { math: padifyMathToMarkdown } }];

  return (tree, file) => {
    const source = typeof file === 'string' ? file : String(file.value ?? '');
    if (source === '') {
      return;
    }
    rewriteDisplayMathParagraphs(tree, source);
  };
}

/** `$$…$$` in the raw source at the node's own offsets (mdast drops the
 * delimiter count; the offsets carry it). Conservative: no position, no
 * rewrite — the node keeps today's inline behavior. */
function isDoubleDollarInlineMath(node: MdNode, source: string): boolean {
  if (node.type !== 'inlineMath' || !node.position) {
    return false;
  }
  const raw = source.slice(node.position.start.offset, node.position.end.offset);
  return (
    raw.startsWith('$$') && raw.endsWith('$$') && raw.length > 4 && (node.value ?? '').trim() !== ''
  );
}

/** Whitespace-only text node (the newlines between consecutive equations). */
function isSpaceOnlyText(node: MdNode): boolean {
  return node.type === 'text' && (node.value ?? '').trim() === '';
}

/**
 * Walks the tree; any paragraph made ONLY of double-dollar inline math
 * (plus whitespace) becomes the equivalent `math` block nodes, in place.
 * Recursion covers every container that can hold a paragraph — blockquotes,
 * list items — matching the owned renderer's nested handling.
 */
function rewriteDisplayMathParagraphs(node: MdNode, source: string): void {
  const children = node.children;
  if (children) {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      rewriteDisplayMathParagraphs(children[i]!, source);
    }
    for (let i = 0; i < children.length; i += 1) {
      const para = children[i]!;
      if (para.type !== 'paragraph') {
        continue;
      }
      const parts = para.children ?? [];
      const maths = parts.filter((c) => isDoubleDollarInlineMath(c, source));
      const obstructing = parts.some(
        (c) => !isDoubleDollarInlineMath(c, source) && !isSpaceOnlyText(c),
      );
      if (maths.length === 0 || obstructing) {
        continue;
      }
      const replacement: MdNode[] = maths.map((m) => ({
        type: 'math',
        value: m.value,
      }));
      children.splice(i, 1, ...replacement);
    }
  }
}

/** Serialize a `math` node — compact `$$x$$` when single-line-safe. */
function padifyMathToMarkdown(
  node: { value?: string },
  _parent: unknown,
  state: {
    enter: (construct: string) => () => void;
    createTracker: (info: unknown) => { move: (s: string) => string };
  },
  info: unknown,
): string {
  const raw = node.value ?? '';
  if (isSingleLineSafeLatex(raw)) {
    const tracker = state.createTracker(info);
    const exit = state.enter('mathFlow');
    const value = tracker.move(`$$${raw}$$`);
    exit();
    return value;
  }
  // mdast-util-math's own multi-line shape: fence escalated past the
  // longest `$` run so a value containing `$$` cannot close its fence.
  let longest = 0;
  let run = 0;
  for (const ch of raw) {
    run = ch === '$' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = '$'.repeat(Math.max(longest + 1, 2));
  const tracker = state.createTracker(info);
  const exit = state.enter('mathFlow');
  let value = tracker.move(`${fence}\n`);
  if (raw !== '') {
    value += tracker.move(`${raw}\n`);
  }
  value += tracker.move(fence);
  exit();
  return value;
}

/**
 * The compact `$$x$$` form only re-parses cleanly when micromark's text
 * math cannot misread it: the value must be non-empty with no newline and
 * no `$$`, and neither edge may be a `$` (a `$$$` run is not a delimiter)
 * or whitespace (the serializer pads those — a shape this form cannot
 * round-trip). Everything else rides the multi-line fence, which has no
 * such constraints.
 */
function isSingleLineSafeLatex(raw: string): boolean {
  if (raw === '' || raw.includes('\n') || raw.includes('$$')) {
    return false;
  }
  const first = raw[0]!;
  const last = raw[raw.length - 1]!;
  return !(first === '$' || last === '$' || /\s/.test(first) || /\s/.test(last));
}

/** Everything the surface .use()s for live math. */
export const markdownMath: MilkdownPlugin[] = [
  ...remarkMathBridge,
  ...padifyDisplayMathBridge,
  ...mathInlineSchema,
  ...mathBlockSchema,
  mathInlineInputRule,
  mathBlockInputRule,
];

// ---------------------------------------------------------------------------
// The image schema, hardened for real-world markdown
// ---------------------------------------------------------------------------

/**
 * The stock preset passes mdast's `alt`/`title` straight into attrs that
 * validate `string` — both are NULL whenever the markdown omits them
 * (`![alt](url)`, no title), and the thrown RangeError silently drops
 * the image (the note degrades to a stray hard break). The extended
 * schema coerces the mdast nulls to the attrs' own defaults — the same
 * extendSchema pattern the GFM preset uses to arm list items as tasks.
 * Used AFTER the presets, so its slice wins.
 */
export const safeImageSchema = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (
        state: ParserState,
        node: MarkdownNode,
        proseType: Parameters<ParserState['openNode']>[0],
      ) => {
        state.addNode(proseType, {
          src: typeof node.url === 'string' ? node.url : '',
          alt: typeof node.alt === 'string' ? node.alt : '',
          title: typeof node.title === 'string' ? node.title : '',
        });
      },
    },
  } as NodeSchema;
});

/**
 * The paragraph serializer without Milkdown's empty-line placeholder.
 *
 * WHY: the preset round-trips an EMPTY paragraph (Enter Enter) as a raw
 * `<br />` HTML node in the markdown source — valid markdown that its
 * own parser understands, but the app's OWNED renderer (preview, share
 * links, export) escapes raw HTML BY SECURITY DESIGN, so every paragraph
 * break typed in the WYSIWYG leaked a literal `<br />` into every
 * non-WYSIWYG surface. Blank lines ARE the markdown paragraph break:
 * the empty paragraph serializes away, and the note's stored source
 * stays what its author meant to write.
 */
export const padifyParagraphSchema = paragraphSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  const baseRunner = base.toMarkdown?.runner;
  return {
    ...base,
    toMarkdown: {
      ...base.toMarkdown,
      runner: (state: SerializerState, node: ProseNode) => {
        if (!node.content || node.content.size === 0) {
          // An empty paragraph contributes nothing — the blank line the
          // serializer writes between blocks carries the break.
          return;
        }
        baseRunner?.(state, node);
      },
    },
  } as NodeSchema;
});

// ---------------------------------------------------------------------------
// Node views — math through the app's ONE KaTeX pipeline, images as chips
// ---------------------------------------------------------------------------

/**
 * The node views the surface hands ProseMirror. Every pixel is Padify's:
 * equations render through math.ts (gate, error display, dark mode via
 * the app's katex CSS), the image chip borrows the preview's
 * md-image-link vocabulary, and code blocks grow a language row — the
 * ``` fence's own info string, editable in place.
 */
export function markdownNodeViews(): Record<
  string,
  (node: ProseNode, view: EditorView, getPos: () => number | undefined) => NodeView
> {
  return {
    [MATH_INLINE_NODE]: mathView('inline'),
    [MATH_BLOCK_NODE]: mathView('block'),
    image: imageView,
    code_block: codeBlockView,
  };
}

function mathView(kind: 'inline' | 'block') {
  const nodeName = kind === 'inline' ? MATH_INLINE_NODE : MATH_BLOCK_NODE;
  return (node: ProseNode): NodeView => {
    let current = node;
    const dom = document.createElement(kind === 'inline' ? 'span' : 'div');
    dom.className = kind === 'inline' ? 'md-math-inline' : 'md-math-block';
    const shell = document.createElement('span');
    shell.className = MATH_CLASS;
    shell.setAttribute('contenteditable', 'false');
    dom.append(shell);

    const paint = (): void => {
      const latex = current.textContent;
      shell.setAttribute('data-latex', latex);
      shell.removeAttribute('data-rendered');
      shell.innerHTML = '';
      if (latex === '' && kind === 'block') {
        // An empty display equation is an affordance, not a void: the
        // dashed chip says what the click does. (Inline math never
        // sits empty — the input rule requires content.)
        dom.classList.add('md-math-empty');
      } else {
        dom.classList.remove('md-math-empty');
        renderMathIn(dom);
      }
    };
    paint();

    dom.addEventListener('click', () => {
      // A plain click both node-selects (ProseMirror's atom handling)
      // and asks for the bubble — the rich note's padify:math-click
      // gesture, markdown's edition.
      dom.dispatchEvent(
        new CustomEvent(MD_MATH_CLICK_EVENT, {
          bubbles: true,
          detail: { latex: current.textContent, kind },
        }),
      );
    });

    return {
      dom,
      update(next: ProseNode) {
        if (next.type.name !== nodeName) {
          return false;
        }
        current = next;
        paint();
        return true;
      },
      // KaTeX's own markup mutations (fonts, aria) must not schedule
      // redraws or desync the view.
      ignoreMutation: () => true,
    };
  };
}

function imageView(node: ProseNode): NodeView {
  let current = node;
  const dom = document.createElement('span');
  dom.className = 'md-image-chip';
  dom.setAttribute('contenteditable', 'false');

  const paint = (): void => {
    const alt = typeof current.attrs.alt === 'string' ? current.attrs.alt : '';
    const src = typeof current.attrs.src === 'string' ? current.attrs.src : '';
    const label = alt.trim() !== '' ? alt : src.trim() !== '' ? src : 'image';
    // textContent only — the alt/src are data, never markup.
    dom.textContent = label;
    dom.title = src;
  };
  paint();

  return {
    dom,
    update(next: ProseNode) {
      if (next.type.name !== 'image') {
        return false;
      }
      current = next;
      paint();
      return true;
    },
    ignoreMutation: () => true,
  };
}

// ---------------------------------------------------------------------------
// Code blocks — the language row (the fence's info string, in place)
// ---------------------------------------------------------------------------

/** The datalist's curated languages — suggestions, never a gate. */
const CODE_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'html',
  'css',
  'json',
  'bash',
  'sql',
  'java',
  'c',
  'cpp',
  'csharp',
  'go',
  'rust',
  'ruby',
  'php',
  'yaml',
  'toml',
  'xml',
  'markdown',
  'diff',
  'plaintext',
];

let codeLanguageList: HTMLDataListElement | null = null;

/**
 * Mounts the shared <datalist> once (the input's suggestion list).
 * Tracked by reference — a dynamically-created element never goes
 * through a string id lookup (the markup↔JS contract's rule).
 */
function ensureCodeLanguageList(): HTMLDataListElement {
  if (codeLanguageList?.isConnected) {
    return codeLanguageList;
  }
  const list = document.createElement('datalist');
  list.id = 'mdCodeLanguages';
  for (const language of CODE_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language;
    list.append(option);
  }
  document.body.append(list);
  codeLanguageList = list;
  return list;
}

/**
 * The code block's own chrome: a quiet language row above the code —
 * the chip shows the ``` fence's info string, clicking it swaps in an
 * input (free text, datalist suggestions), Enter/blur commits through
 * setNodeMarkup and the fence round-trips. The <pre><code> below is
 * the contentDOM — PM writes the code itself.
 */
function codeBlockView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  let current = node;

  const dom = document.createElement('div');
  dom.className = 'md-code-block';
  dom.dataset.language = typeof node.attrs.language === 'string' ? node.attrs.language : '';

  const row = document.createElement('div');
  row.className = 'md-code-lang-row';
  row.setAttribute('contenteditable', 'false');

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'md-code-lang-chip';

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.append(code);
  row.append(chip);
  dom.append(row, pre);

  const paint = (): void => {
    const language = typeof current.attrs.language === 'string' ? current.attrs.language : '';
    dom.dataset.language = language;
    chip.textContent = language.trim() === '' ? 'language' : language;
    chip.classList.toggle('md-code-lang-empty', language.trim() === '');
    chip.title = language.trim() === '' ? 'Set the code language' : `Language: ${language}`;
  };
  paint();

  const commit = (language: string): void => {
    const cleaned = language.trim().toLowerCase().slice(0, 40);
    const pos = getPos();
    if (pos === undefined) {
      return;
    }
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, {
        ...current.attrs,
        language: cleaned,
      }),
    );
    view.focus();
  };

  chip.addEventListener('mousedown', (event) => {
    // The click must not park the caret in the code below.
    event.preventDefault();
  });
  chip.addEventListener('click', () => {
    if (row.querySelector('.md-code-lang-input')) {
      return;
    }
    ensureCodeLanguageList();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'md-code-lang-input';
    input.setAttribute('list', 'mdCodeLanguages');
    input.setAttribute('aria-label', 'Code language');
    input.placeholder = 'js, python, bash…';
    input.value = typeof current.attrs.language === 'string' ? current.attrs.language : '';
    chip.hidden = true;
    row.append(input);
    input.focus();
    input.select();

    const close = (): void => {
      input.remove();
      chip.hidden = false;
      paint();
    };
    input.addEventListener('keydown', (event) => {
      // The input is not the editor's text — PM's keymap stands down.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(input.value);
        close();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    input.addEventListener('blur', () => {
      // A click on the chip's own commit path closes first; a blur from
      // anything else commits what was typed (the fence's honest state).
      if (input.isConnected) {
        commit(input.value);
        close();
      }
    });
  });

  return {
    dom,
    contentDOM: code,
    update(next: ProseNode) {
      if (next.type.name !== 'code_block') {
        return false;
      }
      current = next;
      paint();
      return true;
    },
    ignoreMutation: (mutation: ViewMutationRecord) => {
      // The language row is ours (chrome + input); only the contentDOM's
      // text belongs to PM.
      return mutation.type === 'selection' || row.contains(mutation.target);
    },
  };
}

// ---------------------------------------------------------------------------
// Task-list click-to-toggle
// ---------------------------------------------------------------------------

/** The click zone's width beyond the li's padding, in ems (matches 18-markdown.css). */
const TASK_MARKER_EM = 1.7;

/**
 * Clicking a task item's checkbox flips it. The GFM preset renders
 * tasks as `li[data-item-type=task]` with the state in data-checked —
 * the marker is a ::before box the CSS paints, so the hit test is "the
 * click landed left of the item's text content".
 */
export const taskTogglePlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('PADIFY_TASK_TOGGLE'),
    props: {
      handleClickOn: (
        view: EditorView,
        _pos: number,
        node: ProseNode,
        nodePos: number,
        event: MouseEvent,
      ) => {
        if (node.type.name !== 'list_item' || node.attrs.checked == null) {
          return false;
        }
        const el = view.nodeDOM(nodePos);
        if (!(el instanceof HTMLElement)) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        const styles = window.getComputedStyle(el);
        const paddingLeft = parseFloat(styles.paddingLeft) || 0;
        const fontSize = parseFloat(styles.fontSize) || 16;
        const zone = rect.left + paddingLeft + fontSize * TASK_MARKER_EM;
        if (event.clientX > zone) {
          return false;
        }
        const checked = node.attrs.checked === true;
        view.dispatch(
          view.state.tr.setNodeMarkup(nodePos, undefined, {
            ...node.attrs,
            checked: !checked,
          }),
        );
        return true;
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Tab / Shift-Tab — the Docs indentation gesture, markdown's semantics
// ---------------------------------------------------------------------------

function ancestorNamed(state: EditorState, name: string): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === name) {
      return true;
    }
  }
  return false;
}

/**
 * List nesting via Tab (sink), Shift-Tab (lift); two spaces inside
 * code blocks; tables defer to the GFM preset's cell-walk keymap;
 * plain paragraphs take a two-space tab — the browser default (focus
 * jumps out of the note to the topbar) ejects the author mid-sentence.
 * Mod-\\ clears formatting — the context menu's shared row advertises
 * the hint, and the html surface's rich-shortcuts own the same gesture.
 */
export const indentKeymapPlugin = $prose(() => {
  return keymap({
    'Mod-\\': (state, dispatch) => {
      const { from, to, empty } = state.selection;
      if (empty) {
        dispatch?.(state.tr.setStoredMarks([]));
        return true;
      }
      dispatch?.(state.tr.removeMark(from, to));
      return true;
    },
    Tab: (state, dispatch) => {
      if (ancestorNamed(state, 'table')) {
        return false;
      }
      if (ancestorNamed(state, 'list_item')) {
        const itemType = state.schema.nodes.list_item;
        if (!itemType) {
          return false;
        }
        return sinkListItem(itemType)(state, dispatch);
      }
      if (state.selection.$from.parent.type.name === 'code_block') {
        dispatch?.(state.tr.insertText('  '));
        return true;
      }
      // Plain paragraph: keep the caret, type the two-space tab. A
      // spanning selection stays untouched — replacing it would eat text.
      if (!state.selection.empty) {
        return true;
      }
      dispatch?.(state.tr.insertText('  '));
      return true;
    },
    'Shift-Tab': (state, dispatch) => {
      if (ancestorNamed(state, 'table')) {
        return false;
      }
      if (ancestorNamed(state, 'list_item')) {
        const itemType = state.schema.nodes.list_item;
        if (!itemType) {
          return false;
        }
        return liftListItem(itemType)(state, dispatch);
      }
      // Plain paragraph: unwind the two-space gesture when the two
      // characters directly before the caret are it; otherwise hold the
      // caret where it is (never the focus jump the browser would do).
      const at = state.selection instanceof TextSelection ? state.selection.$cursor : null;
      if (at) {
        const before = at.parent.textBetween(
          Math.max(0, at.parentOffset - 2),
          at.parentOffset,
          undefined,
          '\ufffc',
        );
        if (before === '  ') {
          dispatch?.(state.tr.delete(at.pos - 2, at.pos));
        }
      }
      return true;
    },
  });
});

// ---------------------------------------------------------------------------
// Ctrl/Cmd-click opens links (the html surface's gesture)
// ---------------------------------------------------------------------------

/** The modifier-click-to-open gesture for links inside the editor. */
export const openLinkClickPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('PADIFY_MD_OPEN_LINK'),
    props: {
      handleClick: (view: EditorView, pos: number, event: MouseEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
          return false;
        }
        const { doc, selection } = view.state;
        // Only a caret click (a selection drag would be a weird open).
        if (!selection.empty) {
          return false;
        }
        const $pos = doc.resolve(pos);
        if (!$pos.parent.isTextblock) {
          return false;
        }
        const link = $pos.marks().find((mark) => mark.type.name === 'link');
        const href = link?.attrs.href;
        if (typeof href !== 'string' || href === '') {
          return false;
        }
        window.open(href, '_blank', 'noopener,noreferrer');
        return true;
      },
    },
  });
});
