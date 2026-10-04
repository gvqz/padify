/**
 * The Markdown renderer's contract — every construct of the documented
 * subset, pinned to its exact HTML, plus the security invariants that make
 * the preview safe to innerHTML: raw HTML never survives as markup, link
 * hrefs only ever pass the safe-href gate, and there are no images.
 *
 * The math assertions pin the `padify-math` shells (the storage container,
 * not KaTeX's rendering) — the surface layer runs renderMathIn over them.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './render';

describe('renderMarkdownToHtml — headings', () => {
  it('renders ATX headings level 1 through 6', () => {
    expect(renderMarkdownToHtml('# One')).toBe('<h1>One</h1>');
    expect(renderMarkdownToHtml('###### Six')).toBe('<h6>Six</h6>');
  });

  it('seven hashes are a paragraph, not a heading', () => {
    expect(renderMarkdownToHtml('####### seven')).toBe('<p>####### seven</p>');
  });

  it('a hash glued to text is a paragraph (#hashtag is not a heading)', () => {
    expect(renderMarkdownToHtml('#hashtag')).toBe('<p>#hashtag</p>');
  });

  it('strips the closing decoration of ATX headings', () => {
    expect(renderMarkdownToHtml('# Closed #')).toBe('<h1>Closed</h1>');
    expect(renderMarkdownToHtml('### Closed ###')).toBe('<h3>Closed</h3>');
  });

  it('renders setext underlines as h1/h2', () => {
    expect(renderMarkdownToHtml('Title\n===')).toBe('<h1>Title</h1>');
    expect(renderMarkdownToHtml('Title\n---')).toBe('<h2>Title</h2>');
  });

  it('a setext underline spans the whole paragraph', () => {
    expect(renderMarkdownToHtml('a\nb\n===')).toBe('<h1>a\nb</h1>');
  });

  it('a dash line under nothing is a thematic break, not setext', () => {
    expect(renderMarkdownToHtml('---')).toBe('<hr>');
    expect(renderMarkdownToHtml('\n---\n')).toBe('<hr>');
  });

  it('heading text renders inline markup', () => {
    expect(renderMarkdownToHtml('## **bold** head')).toBe('<h2><b>bold</b> head</h2>');
  });
});

describe('renderMarkdownToHtml — thematic breaks & code fences', () => {
  it('recognises every thematic-break shape', () => {
    expect(renderMarkdownToHtml('***')).toBe('<hr>');
    expect(renderMarkdownToHtml('- - -')).toBe('<hr>');
    expect(renderMarkdownToHtml('___')).toBe('<hr>');
  });

  it('renders fenced code blocks with the info string as a class', () => {
    expect(renderMarkdownToHtml('```js\nconst x = 1;\n```')).toBe(
      '<pre><code class="language-js">const x = 1;</code></pre>',
    );
  });

  it('tilde fences work, and the closing fence may be longer', () => {
    expect(renderMarkdownToHtml('~~~\na\n~~~~')).toBe('<pre><code>a</code></pre>');
  });

  it('an unclosed fence runs to the end of the source', () => {
    expect(renderMarkdownToHtml('```\nnever closed')).toBe('<pre><code>never closed</code></pre>');
  });

  it('code content escapes — a fence is not an HTML smuggle route', () => {
    expect(renderMarkdownToHtml('```\n<script>alert(1)</script>\n```')).toBe(
      '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    );
  });

  it('a weird info string is dropped, not emitted as an attribute', () => {
    expect(renderMarkdownToHtml('```"><script>\ncode\n```')).toBe('<pre><code>code</code></pre>');
  });

  it('a fence interrupts a paragraph', () => {
    expect(renderMarkdownToHtml('text\n```\ncode\n```\nafter')).toBe(
      '<p>text</p>\n<pre><code>code</code></pre>\n<p>after</p>',
    );
  });
});

describe('renderMarkdownToHtml — paragraphs & text', () => {
  it('wraps plain text in paragraphs', () => {
    expect(renderMarkdownToHtml('hello')).toBe('<p>hello</p>');
  });

  it('blank lines split paragraphs; leading/trailing blanks vanish', () => {
    expect(renderMarkdownToHtml('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>');
    expect(renderMarkdownToHtml('\n\none\n\n')).toBe('<p>one</p>');
  });

  it('escapes the HTML-significant characters of literal text', () => {
    expect(renderMarkdownToHtml('a & b < c > d "e"')).toBe(
      '<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>',
    );
  });

  it('raw HTML is escaped as text, never markup', () => {
    expect(renderMarkdownToHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(renderMarkdownToHtml('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    );
  });

  it('CRLF input behaves like LF', () => {
    expect(renderMarkdownToHtml('a\r\n\r\nb')).toBe('<p>a</p>\n<p>b</p>');
  });

  it('two trailing spaces make a hard break; one does not', () => {
    expect(renderMarkdownToHtml('a  \nb')).toBe('<p>a<br>b</p>');
    expect(renderMarkdownToHtml('a \nb')).toBe('<p>a \nb</p>');
  });

  it('a trailing backslash makes a hard break', () => {
    expect(renderMarkdownToHtml('a\\\nb')).toBe('<p>a<br>b</p>');
  });
});

describe('renderMarkdownToHtml — inline code', () => {
  it('renders code spans', () => {
    expect(renderMarkdownToHtml('use `const x` now')).toBe('<p>use <code>const x</code> now</p>');
  });

  it('a longer run needs a matching longer close', () => {
    expect(renderMarkdownToHtml('``a ` b``')).toBe('<p><code>a ` b</code></p>');
    expect(renderMarkdownToHtml('`no closing')).toBe('<p>`no closing</p>');
  });

  it('code content escapes and folds newlines to spaces', () => {
    expect(renderMarkdownToHtml('`a<b\nc>`')).toBe('<p><code>a&lt;b c&gt;</code></p>');
  });

  it('one padding space is trimmed from both ends, but not all of them', () => {
    expect(renderMarkdownToHtml('` code `')).toBe('<p><code>code</code></p>');
    expect(renderMarkdownToHtml('`  code  `')).toBe('<p><code> code </code></p>');
  });

  it('emphasis markers inside a code span are literal', () => {
    expect(renderMarkdownToHtml('*`*b*`*')).toBe('<p><i><code>*b*</code></i></p>');
  });
});

describe('renderMarkdownToHtml — emphasis', () => {
  it('bold, italic, and both', () => {
    expect(renderMarkdownToHtml('**bold**')).toBe('<p><b>bold</b></p>');
    expect(renderMarkdownToHtml('*em*')).toBe('<p><i>em</i></p>');
    expect(renderMarkdownToHtml('***both***')).toBe('<p><b><i>both</i></b></p>');
  });

  it('underscore flavors match asterisk flavors', () => {
    expect(renderMarkdownToHtml('__bold__')).toBe('<p><b>bold</b></p>');
    expect(renderMarkdownToHtml('_em_')).toBe('<p><i>em</i></p>');
  });

  it('strikethrough is exactly two tildes', () => {
    expect(renderMarkdownToHtml('~~gone~~')).toBe('<p><s>gone</s></p>');
    expect(renderMarkdownToHtml('~single~')).toBe('<p>~single~</p>');
    expect(renderMarkdownToHtml('a ~~~b~~~ c')).toBe('<p>a ~~~b~~~ c</p>');
  });

  it('intraword underscores never emphasise (snake_case stays whole)', () => {
    expect(renderMarkdownToHtml('snake_case_here')).toBe('<p>snake_case_here</p>');
  });

  it('intraword asterisks do emphasise', () => {
    expect(renderMarkdownToHtml('a*b*c')).toBe('<p>a<i>b</i>c</p>');
  });

  it('whitespace edges never open or close emphasis', () => {
    // `* text *` is a LIST in CommonMark (a marker followed by a space) —
    // the list suite pins that; here the no-space forms stay literal.
    expect(renderMarkdownToHtml('** spaced **')).toBe('<p>** spaced **</p>');
    expect(renderMarkdownToHtml('a * b * c')).toBe('<p>a * b * c</p>');
  });

  it('unclosed runs stay literal', () => {
    expect(renderMarkdownToHtml('*just text')).toBe('<p>*just text</p>');
    expect(renderMarkdownToHtml('**just text')).toBe('<p>**just text</p>');
  });

  it('leftover delimiters sit beside the emphasis they helped (documented)', () => {
    expect(renderMarkdownToHtml('***x**')).toBe('<p><b>*x</b></p>');
    expect(renderMarkdownToHtml('**x***')).toBe('<p><b>x*</b></p>');
  });

  it('emphasis wraps code spans and links', () => {
    expect(renderMarkdownToHtml('**a `code` b**')).toBe('<p><b>a <code>code</code> b</b></p>');
  });

  it('backslash escapes keep a marker literal', () => {
    expect(renderMarkdownToHtml('\\*not em\\*')).toBe('<p>*not em*</p>');
    expect(renderMarkdownToHtml('a \\* b')).toBe('<p>a * b</p>');
  });
});

describe('renderMarkdownToHtml — links & images', () => {
  it('renders links with the safe-href rel', () => {
    expect(renderMarkdownToHtml('[Padify](https://example.com)')).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer">Padify</a></p>',
    );
  });

  it('link labels render inline markup', () => {
    expect(renderMarkdownToHtml('[**bold link**](https://example.com)')).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer"><b>bold link</b></a></p>',
    );
  });

  it('mailto, anchors and relative paths pass the gate', () => {
    expect(renderMarkdownToHtml('[a](mailto:x@y.z)')).toContain('href="mailto:x@y.z"');
    expect(renderMarkdownToHtml('[a](#section)')).toContain('href="#section"');
    expect(renderMarkdownToHtml('[a](/path)')).toContain('href="/path"');
  });

  it('javascript: URLs leave the whole construct as literal text', () => {
    expect(renderMarkdownToHtml('[click](javascript:alert(1))')).toBe(
      '<p>[click](javascript:alert(1))</p>',
    );
  });

  it('data: URLs are refused the same way', () => {
    expect(renderMarkdownToHtml('[x](data:text/html,<b>hi</b>)')).toBe(
      '<p>[x](data:text/html,&lt;b&gt;hi&lt;/b&gt;)</p>',
    );
  });

  it('a quoted title is parsed and ignored', () => {
    expect(renderMarkdownToHtml('[a](https://example.com "Title")')).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer">a</a></p>',
    );
  });

  it('nested brackets survive in the label', () => {
    expect(renderMarkdownToHtml('[a [b] c](https://example.com)')).toContain('>a [b] c</a>');
  });

  it('images render as links with the alt text — nothing loads remotely', () => {
    expect(renderMarkdownToHtml('![alt text](https://example.com/i.png)')).toBe(
      '<p><a href="https://example.com/i.png" class="md-image-link" title="image">alt text</a></p>',
    );
    const html = renderMarkdownToHtml('![x](https://example.com/i.png)');
    expect(html).not.toContain('<img');
  });

  it('an href escapes for the attribute context', () => {
    expect(renderMarkdownToHtml('[x](https://example.com/?q="a&b")')).toContain(
      'href="https://example.com/?q=&quot;a&amp;b&quot;"',
    );
  });
});

describe('renderMarkdownToHtml — math', () => {
  it('inline $…$ becomes a padify-math shell carrying the LaTeX', () => {
    expect(renderMarkdownToHtml('$x^2$')).toBe(
      '<p><span class="padify-math" data-latex="x^2" contenteditable="false"></span></p>',
    );
  });

  it('$$…$$ on its own lines becomes a display block wrapper around the shell', () => {
    expect(renderMarkdownToHtml('$$E=mc^2$$')).toBe(
      '<div class="md-math-block"><span class="padify-math" data-latex="E=mc^2" contenteditable="false"></span></div>',
    );
    expect(renderMarkdownToHtml('$$\nE=mc^2\n$$')).toBe(
      '<div class="md-math-block"><span class="padify-math" data-latex="E=mc^2" contenteditable="false"></span></div>',
    );
  });

  it('display math does not wrap in a paragraph (no div-in-p)', () => {
    expect(renderMarkdownToHtml('$$x$$\n\ntext')).toBe(
      '<div class="md-math-block"><span class="padify-math" data-latex="x" contenteditable="false"></span></div>\n<p>text</p>',
    );
  });

  it('\\(…\\) delimiters render inline math', () => {
    expect(renderMarkdownToHtml('\\(x+1\\)')).toBe(
      '<p><span class="padify-math" data-latex="x+1" contenteditable="false"></span></p>',
    );
  });

  it('currency dollars are not math (space edges refuse the match)', () => {
    expect(renderMarkdownToHtml('5$ and 6$')).toBe('<p>5$ and 6$</p>');
    expect(renderMarkdownToHtml('it costs $ 5')).toBe('<p>it costs $ 5</p>');
  });

  it('an unclosed $ is a dollar', () => {
    expect(renderMarkdownToHtml('100% of $5')).toBe('<p>100% of $5</p>');
  });

  it('escaped \\$ stays a dollar', () => {
    expect(renderMarkdownToHtml('\\$5')).toBe('<p>$5</p>');
  });

  it('LaTeX escapes for the attribute context', () => {
    expect(renderMarkdownToHtml('$a"<b>$')).toContain('data-latex="a&quot;&lt;b&gt;"');
  });
});

describe('renderMarkdownToHtml — lists', () => {
  it('renders tight bullet lists', () => {
    expect(renderMarkdownToHtml('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(renderMarkdownToHtml('* a\n+ b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  });

  it('renders ordered lists, keeping a non-1 start', () => {
    expect(renderMarkdownToHtml('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    expect(renderMarkdownToHtml('3. a')).toBe('<ol start="3">\n<li>a</li>\n</ol>');
    expect(renderMarkdownToHtml('1) a')).toBe('<ol>\n<li>a</li>\n</ol>');
  });

  it('a marker glued to text is not a list (*emphasis* and -5 stay text)', () => {
    expect(renderMarkdownToHtml('***bold***')).toBe('<p><b><i>bold</i></b></p>');
    expect(renderMarkdownToHtml('-5 degrees')).toBe('<p>-5 degrees</p>');
  });

  it('blank lines between items make the list loose (paragraph wrappers)', () => {
    expect(renderMarkdownToHtml('- a\n\n- b')).toBe(
      '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>',
    );
  });

  it('indented lines nest as content of their item', () => {
    expect(renderMarkdownToHtml('- a\n  - b')).toBe(
      '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n</ul>',
    );
  });

  it('deeply indented continuation lines belong to the current item', () => {
    expect(renderMarkdownToHtml('- a\n  more text')).toBe('<ul>\n<li>a\nmore text</li>\n</ul>');
  });

  it('a blank line then indented content stays inside the item (and loosens it)', () => {
    expect(renderMarkdownToHtml('- a\n\n  more')).toBe('<ul>\n<li><p>a\nmore</p></li>\n</ul>');
  });

  it('lazy continuation text joins the item paragraph', () => {
    expect(renderMarkdownToHtml('- a\nlazy')).toBe('<ul>\n<li>a\nlazy</li>\n</ul>');
  });

  it('a shallower marker ends the inner list and starts a sibling of the outer one', () => {
    expect(renderMarkdownToHtml('- a\n  - b\n- c')).toBe(
      '<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li>c</li>\n</ul>',
    );
  });

  it('task list items render checkboxes with their state', () => {
    expect(renderMarkdownToHtml('- [ ] todo\n- [x] done')).toBe(
      '<ul>\n<li><input type="checkbox" disabled> todo</li>\n<li><input type="checkbox" disabled checked> done</li>\n</ul>',
    );
  });

  it('a fence inside an item becomes a code block inside the li', () => {
    expect(renderMarkdownToHtml('- item\n\n  ```\n  code\n  ```')).toBe(
      '<ul>\n<li><p>item</p>\n<pre><code>code</code></pre></li>\n</ul>',
    );
  });

  it('a list interrupts a paragraph', () => {
    expect(renderMarkdownToHtml('text\n- item')).toBe('<p>text</p>\n<ul>\n<li>item</li>\n</ul>');
  });

  it('a star followed by a space is a list item, not broken emphasis', () => {
    // CommonMark: `* not em *` IS a one-item list; the emphasis reading
    // never applies because whitespace edges cannot open.
    expect(renderMarkdownToHtml('* not em *')).toBe('<ul>\n<li>not em *</li>\n</ul>');
  });

  it('empty items are legal and hold only their nested content', () => {
    expect(renderMarkdownToHtml('-\n  nested')).toBe('<ul>\n<li>nested</li>\n</ul>');
  });
});

describe('renderMarkdownToHtml — blockquotes', () => {
  it('renders quoted paragraphs', () => {
    expect(renderMarkdownToHtml('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
  });

  it('nested markers nest', () => {
    expect(renderMarkdownToHtml('>> deep')).toBe(
      '<blockquote><blockquote><p>deep</p></blockquote></blockquote>',
    );
  });

  it('lazy continuation joins the quoted paragraph', () => {
    expect(renderMarkdownToHtml('> a\nlazy')).toBe('<blockquote><p>a\nlazy</p></blockquote>');
  });

  it('a blank line closes the quote', () => {
    expect(renderMarkdownToHtml('> a\n\nb')).toBe('<blockquote><p>a</p></blockquote>\n<p>b</p>');
  });

  it('a list inside a quote renders inside it', () => {
    expect(renderMarkdownToHtml('> - a\n> - b')).toBe(
      '<blockquote><ul>\n<li>a</li>\n<li>b</li>\n</ul></blockquote>',
    );
  });
});

describe('renderMarkdownToHtml — tables', () => {
  it('renders a GFM table with alignment', () => {
    expect(renderMarkdownToHtml('| A | B |\n|---|:-:|\n| 1 | 2 |')).toBe(
      '<table>\n<thead>\n<tr><th>A</th><th style="text-align:center">B</th></tr>\n</thead>\n' +
        '<tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody>\n</table>',
    );
  });

  it('left and right alignment', () => {
    const html = renderMarkdownToHtml('| A | B |\n|:--|--:|\n| x | y |');
    expect(html).toContain('<th style="text-align:left">A</th>');
    expect(html).toContain('<th style="text-align:right">B</th>');
  });

  it('column counts must agree — otherwise it is a paragraph', () => {
    expect(renderMarkdownToHtml('| A | B |\n|---|\n| 1 |')).toBe('<p>| A | B |\n|---|\n| 1 |</p>');
  });

  it('the delimiter row must be a delimiter row', () => {
    expect(renderMarkdownToHtml('| A |\n| x |\n| 1 |')).toBe('<p>| A |\n| x |\n| 1 |</p>');
  });

  it('escaped pipes stay inside their cell', () => {
    expect(renderMarkdownToHtml('| a \\| b |\n|---|\n| c |')).toContain('<th>a | b</th>');
  });

  it('cells render inline markup', () => {
    expect(renderMarkdownToHtml('| **A** |\n|---|\n| `x` |')).toContain('<th><b>A</b></th>');
  });

  it('extra cells beyond the header are dropped (GFM)', () => {
    const html = renderMarkdownToHtml('| A |\n|---|\n| 1 | 2 |');
    expect(html).toContain('<tr><td>1</td></tr>');
  });

  it('a table cannot interrupt a paragraph', () => {
    expect(renderMarkdownToHtml('text\n| A |\n|---|\n| 1 |')).toBe(
      '<p>text\n| A |\n|---|\n| 1 |</p>',
    );
  });
});

describe('renderMarkdownToHtml — security invariants', () => {
  it('no tag in the output ever came from the source (all escaped)', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<style>body{background:url(javascript:alert(1))}</style>',
      '![x](javascript:alert(1))',
      '[x](javascript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '![y](data:image/svg+xml,<svg onload=alert(1)>)',
      '<b onmouseover=alert(1)>hover</b>',
      '```\n</code></pre><script>alert(1)</script>\n```',
    ];
    for (const attack of attacks) {
      const html = renderMarkdownToHtml(attack);
      expect(html).not.toMatch(/<(script|img|iframe|style|b|a)\b/i);
    }
  });

  it('every href in the output passed the safe-href gate', () => {
    const html = renderMarkdownToHtml(
      '[a](https://x.com) [b](javascript:alert(1)) [c](data:x) [d](vbscript:x)',
    );
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(['https://x.com']);
  });

  it('the only attributes the renderer writes are its own', () => {
    const html = renderMarkdownToHtml(
      '# h\n[x](https://x.com) ![y](https://x.com/i.png) $a$\n- [ ] t\n\n| a |\n|:--|\n| b |',
    );
    const attributes = [...html.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => match[1]);
    expect(new Set(attributes)).toEqual(
      new Set(['href', 'rel', 'class', 'title', 'data-latex', 'contenteditable', 'type', 'style']),
    );
  });
});
