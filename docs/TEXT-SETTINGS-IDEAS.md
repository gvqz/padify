# Text settings — where the substitutions go next

Status: proposal (the owner asked for a brainstorm alongside the first
tenant). Nothing here is committed to a release; each candidate is a
settings row + a catalog entry away from shipping.

## The machinery that now exists (2026-11-18)

The em-dash pair (`--` → `—`, `userChosenEmDashSubstitution`, default
OFF) shipped the whole substrate a second rule needs:

- **One catalog, one veto vocabulary** — `src/editor/typing-substitutions.ts`.
  Each rule carries `find` / `replacement` / `appliesAfterPrefix(linePrefix)`,
  the boundary veto that keeps the rewrite away from structures it would
  damage (the markdown horizontal rule, the table separator, front-matter).
- **Two apply paths, free for every rule** — the engine path (plain and
  rich notes: a model splice through `EditorPort.replaceBeforeCaret`, one
  history group of its own, undo walks it back to the raw pair) and the
  field path (markdown source textarea, task composer inputs: the
  `applyEdit` splice, native undo).
- **The burst contract** — a refused substitution (no pair, veto) leaves
  the open typing burst untouched; undo granularity never splits at a
  hyphen.
- **The settings row pattern** — the Writing pane card, restore/change/
  reset through editor-preferences + one `onChangeSetting` subscription.

What a second rule still needs by hand: its catalog entry, its settings
key + row, and a small loop replacing the hook's single-rule call. A day
of work, most of it tests.

## Candidates, in the order I would ship them

### 1. Ellipsis — `...` → `…`
The cheapest honest win. Fires on the third dot; the veto barely matters
(a leading-dot line is still prose). Same undo manners as the dash.
Risk: someone typing three dots as a deliberate beat in markdown — the
`…` renders identically in prose; code-fence content would convert, so
the veto should refuse when the caret sits inside a fenced block (the
engine can answer that; the field path can scan the textarea).

### 2. ASCII arrows — `->` → `→`, `<-` → `←`, `<->` → `↔`, `=>` → `⇒`
The coder's favorite. Fires on the closing character; veto: the pair must
not ride a markdown arrow-list syntax (`->` at a line start is not
standard markdown, so a line-start veto is optional — I would still
veto, same rule as the dash, for predictability). Watch out for HTML
comment arrows inside `<pre>`; same fenced-block veto as the ellipsis.

### 3. Smart quotes — `'` → `'`/`'`, `"` → `"`/`"`.
The classic, and the one that earns its complexity. Needs open/close
inference (a tiny stateful tracker: quote opens after whitespace/start,
closes after a word char), plus the apostrophe case (`don't` must stay
`'`). Veto: never inside a code fence, never immediately after a letter
for double quotes in markdown emphasis contexts. Highest false-positive
risk of the set; ship last, maybe rich/plain only, never the markdown
source pane.

### 4. Word's symbol set — `(c)` → ©, `(r)` → ®, `(tm)` → ™
Trivial catalog entries; fires on the closing parenthesis. Veto: the
parenthesis must follow whitespace/line start (`foo(c)` is a function
call). Default OFF like the dash.

### 5. Fractions — `1/2` → ½, `1/4` → ¼, `3/4` → ¾
Trivial, but the false positive is dates (`1/2/2026` becomes `½/2026`).
Veto: refuse when the char before the pair starts a date-like run —
harder than it sounds. I would ship it with a strict left-boundary rule
(only after whitespace) and accept that `1/2` mid-sentence converts.

## Deliberately deferred

- **Capitalize the first letter of sentences** — needs sentence
  detection and edit-time lookahead; the failure mode (rewriting words
  the user already typed) breaks the "substitutions only touch the
  characters you just typed" contract. A different feature family.
- **Trim trailing whitespace on Enter** — a typing-hygiene setting, not
  a substitution; different trigger (`insertParagraph`), different undo
  story. Fine to build, but it belongs in its own change.
- **Two-spaces-after-period enforcement** — contentious, invisible,
  regressive. No.

## The one rule that protects all of them

Every rule rides the same veto: **a refusal must never disturb the
typing burst** (undo granularity stays whole), and **a conversion is its
own undo group** (the raw characters always come back first in line —
the user can always get their `--`, their `(c)`, their `...` back). Any
future rule that cannot honor both does not belong in the catalog.
