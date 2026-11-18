# Text settings — where the substitutions go next

Status: the owner's calls from 2026-11-18 are IN. The em-dash pair, the
ellipsis, the ASCII arrows and Word's symbol shorthand ship as settings
rows in the Writing pane (each default OFF, each undoable back to the
raw characters); smart quotes and fractions were dropped by owner
decision. This doc keeps the catalog's rationale for whoever grows it
next.

## The machinery that now exists (2026-11-18)

The em-dash pair (`--` → `—`, `userChosenEmDashSubstitution`, default
OFF) shipped the whole substrate the family rides:

- **One catalog, one veto vocabulary** — `src/editor/typing-substitutions.ts`.
  Each rule carries `find` / `replacement` / `appliesAfterPrefix(linePrefix)`
  — the boundary veto that keeps the rewrite away from the structures it
  would damage (the markdown horizontal rule, the table separator,
  front-matter, inline-code ticks, the `<!` of an HTML comment opener) —
  and, when context beyond the line matters, `appliesInDocument(textBeforePair)`
  — the code-fence scan every shipped rule carries. The engine adds the
  one structural check only it can see: a caret inside a `<pre>` block
  never converts, in any rule.
- **Two apply paths, free for every rule** — the engine path (plain and
  rich notes: a model splice through `EditorPort.replaceBeforeCaret`, one
  history group of its own, undo walks it back to the raw pair) and the
  field path (markdown source textarea, task composer inputs: the
  `applyEdit` splice, native undo).
- **The burst contract** — a refused substitution (no pair, veto) leaves
  the open typing burst untouched; undo granularity never splits at a
  hyphen, a dot, an angle or a parenthesis.
- **The settings row pattern** — the Writing pane card, restore/change/
  reset through editor-preferences + one `onChangeSetting` subscription
  per family (app.ts's `SUBSTITUTION_SETTINGS` table is the wiring).
- **The block-boundary pin** — a pair that is a block's WHOLE content
  splices at its own block's start (the stream resolver can only answer
  a boundary offset as the previous run's end; the op pins the side).

What a further rule needs by hand: its catalog entry (plus a trigger
character in `SUBSTITUTION_TRIGGERS`), its settings key + row, and a
small loop in the tests. Most of the work is the veto tests.

## The shipped family (owner decisions, 2026-11-18)

### 1. Ellipsis — `...` → `…` — SHIPPED (`userChosenEllipsisSubstitution`)
Fires on the third dot. A leading-dot line is still prose — no
line-start veto; what refuses: a pair glued to a preceding dot (a
restored trio must not fuse into `a.…`) and to an inline-code tick,
plus the fence veto. Same undo manners as the dash.

### 2. ASCII arrows — `->` → `→`, `=>` → `⇒`, `<->` → `↔` — SHIPPED (`userChosenArrowSubstitution`)
Fires on the closing angle; the dash's own boundary rule (no line
starts, no syntax glue — `a-->`, `x==>` and `<!--` stay raw) plus the
fence veto. `<-` → `←` was deliberately LEFT OUT: under a
closing-character trigger it would swallow `<->` (typing `<->` would
first convert to `←`, and `↔` could never form), and it is the R
assignment operator — the highest false-positive cost of the set. If it
is ever wanted, it needs its own trigger design, not this catalog's.

### 3. Smart quotes — `'` → `'`/`'`, `"` → `"`/`"` — DROPPED (owner decision)
The open/close inference, the apostrophe case (`don't`), and the
markdown emphasis contexts earn the highest false-positive risk of the
set for the least polish. Not built; revisit only if the app ever
becomes 100% non-technical prose.

### 4. Word's symbol set — `(c)` → ©, `(r)` → ®, `(tm)` → ™ — SHIPPED (`userChosenSymbolSubstitution`)
Fires on the closing parenthesis; Word's own boundary rule — the `(`
must follow whitespace or open the line, so `foo(c)` stays a function
call and `2(c)` stays a footnote style — plus the fence veto.
Case-sensitive by design (`(C)` stands; extend the catalog if that ever
changes).

### 5. Fractions — `1/2` → ½, `1/4` → ¼, `3/4` → ¾ — DROPPED (owner decision)
The false positive is dates (`1/2/2026` becoming `½/2026`), and the
left-boundary rule that would contain it is harder than the payoff.
Not built.

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
the user can always get their `--`, their `(c)`, their `...`, their
`->` back). Any future rule that cannot honor both does not belong in
the catalog.
