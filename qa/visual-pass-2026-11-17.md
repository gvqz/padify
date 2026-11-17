# Visual QA pass — the vision-model layer (2026-11-17)

**Tested:** `main` @ `272dd23` (all five change surfaces), rebuilt from source and re-shot
after the fix below landed (`63f4df1`). Light + dark × desktop (1440×900) + mobile
(375×667), motion enabled for the bloom pass plus a `prefers-reduced-motion` variant.
**Method:** Playwright chromium headless against `dist/` served fresh (`python3 -m
http.server 4174`), one browser context per scenario so no IndexedDB/service-worker
state leaks between "fresh" loads, a real screenshot read for every claim below.
Evidence shots live beside this file under `qa/evidence/` (`vp17-*.png`).

---

## The five change surfaces — verdicts

### 1. The CSS consolidation — no regressions found

Every view the pixel harness already proved byte-identical was re-judged by eye for
what a byte-diff cannot see, and none of it sagged:

- **Editor boot** (`vp17-boot-light/dark.png`): list rhythm inside the welcome note,
  tab rail, word pill, top bar — spacing even, dark contrast comfortable, no orphaned
  gaps where a removed rule used to fight another one.
- **Statistics** (`vp17-statistics-*.png`): the four-column headline grid, the
  VOCABULARY/TIME and RECORDS/QUALITY card pairs — aligned, breathing, readable in
  both schemes. (The S6 stats fixes are visible here too: lexical density 65.2%, no
  more impossible percentages.)
- **Preferences** (`vp17-preferences-*.png`): the section rail, the Theme segmented
  control and the Texture select sit on an even grid in both schemes — and the
  `.pref-eyebrow` / `.pref-subtitle` removal left no holes (the settings modal never
  carried either).
- **Rich and Markdown editors** (`vp17-rich-editor-*.png`, `vp17-markdown-editor-*.png`):
  both toolbars wrap cleanly at 1440px, no collisions, `Source/Split/Preview` toggles
  legible on dark.
- **Cloud sheet** (`vp17-cloud-*.png`) and **History sheet** (`vp17-history-*.png`):
  form fields, tab pills and the empty state all keep their rhythm.

### 2. The four title-only modal headers — all correct

Statistics, About (Padify), Keyboard Shortcuts and Writing Session each render one
clean title line with the close affordance, in light and dark, desktop and mobile
(`vp17-statistics/about/shortcuts/session-{light,dark}.png`,
`vp17-mob-statistics-light.png`, `vp17-mob-shortcuts-dark.png`,
`vp17-mob-session-light.png`). Nothing around them sagged: the search box in
shortcuts, the preset grid in Writing Session and the stat cards in Statistics all
start at the same comfortable offset below the header. The sheets that KEEP their
two-line heads still do — History ("History / Versions of this note.",
`vp17-history-*.png`, `vp17-mob-history-dark.png`) and Cloud sync
(`vp17-cloud-*.png`) — which is the deliberate split working as designed.

### 3. D1(c) reminder landing + row-reveal bloom — works from all three doors

With motion enabled, each entry path lands the note ON the dated row and blooms it
once (the 1.1s `tk-reveal` accent wash + ring); the settled shot 1.6s later shows the
wash gone and the row still in view:

- **Origin chip** from the hub's Today view: `vp17-bloom-chip-mid-light.png` (wash +
  ring mid-flight) vs `vp17-bloom-chip-settled-light.png`; dark pair
  `vp17-bloom-chip-mid-dark.png`.
- **Calendar pick** (the day pane's row chip): `vp17-bloom-cal-mid-light.png`,
  `vp17-bloom-cal-mid-dark.png`. The month-grid chips themselves only select a day —
  the open gesture lives in the day pane rows, as built.
- **Reminder toast**: the toast fires on the sweep (`vp17-toast.png`; toasts key on
  `reminderAt`, not the NL quick-add's `dueDate` — a task with only a due date stays
  quiet, which is the documented model) and its click lands on the row:
  `vp17-bloom-toast-mid.png` → `vp17-bloom-toast-settled.png`.
- **The calendar's first quick-add creates its task list in the BACKGROUND**: after
  filing "Call the bank" from the day pane on a profile with no task notes, the hub
  stays open over an untouched editor — no hijack (`vp17-cal-quickadd-no-hijack.png`,
  the "Task list created via your reminder" toast visible).
- **Reduced motion respected**: with `prefers-reduced-motion: reduce` the reveal
  still centers the row but `animation-name` computes to `none` — no bloom
  (`vp17-bloom-reduced-motion.png`).

One taste note, not a regression: in dark mode the 14% accent wash is quiet — the
expanding ring carries most of the affordance (`vp17-bloom-chip-mid-dark.png`). It
reads fine at 1.1s; flagging only so the owner knows the dark bloom is ring-led.

### 4. D2 — the snapshot chord — one clear-cut regression, found and fixed

Consistent everywhere except one spot:

- **Keyboard Shortcuts modal**: "Take a snapshot → Ctrl + Alt + S"
  (`vp17-shortcuts-*.png`), and the Underline row correctly claims Ctrl+U.
- **History empty state**: "Take one with the button above, or Ctrl + Alt + S."
  (`vp17-mob-history-dark.png`).
- **REGRESSION (fixed in `63f4df1`):** the History sheet's **Take snapshot button**
  kept `data-shortcut-title="mod+u"`, so its hover tooltip rendered **"Take snapshot
  [Ctrl + U]"** — the chord the editor now binds to underline — directly above an
  empty state saying Ctrl+Alt+S. Before/after: `vp17-tooltip-before.png` /
  `vp17-tooltip-after.png` (the attribute string is the proof: native `title`
  tooltips do not paint in headless screenshots). The e2e spec had pinned the stale
  string; both moved together in the commit.

### 5. D3 — the dimmed Floating Window button — dims, never vanishes

On the plain welcome note the PiP icon sits at full strength with tooltip "Activate
Floating Window"; on rich and markdown notes the container takes `is-unavailable`
(container opacity 0.45 over the icon's own 0.72, `cursor: not-allowed`,
`aria-disabled="true"`, tooltip "Floating Window works on plain notes only") and the
icon visibly dims against its un-dimmed neighbours while staying in place:
`vp17-pip-{plain,rich,markdown}-{light,dark}.png`. The dim is unmistakable in both
schemes. (A real floating window cannot open headless — the dock/placeholder flow is
out of this pass's visual reach, as in the previous live pass.)

---

## Mobile (375×667)

Boot, Statistics, Keyboard Shortcuts, Writing Session, Settings and History all
render cleanly at phone width in both schemes (`vp17-mob-*.png`); the collapsed
navbar's hamburger expands to the full tool set (History lives behind it at this
width — same behavior the e2e suite drives). No overflow, no clipped modals, the
kbd chips stay legible.

## Observations for the owner (judgment calls, not fixed)

1. **Mobile word pill overlap** (`vp17-mob-boot-dark.png`): on a full-height note the
   floating word/char pill can sit over the last line of text. Pre-existing pattern
   (the pill is fixed furniture, not a consolidation artifact) and it carries an
   opaque background — noted only because the vision pass finally has the shot that
   shows it.
2. **Dark bloom is ring-led** (above): spec-compliant, just quieter than light. A
   nudge to the dark `--tk-accent` mix would be a one-line taste change; left alone.

## Method notes (for whoever reruns this)

- `npm install` (npm-resolved) breaks `tsc --noEmit` on this lockfile generation —
  CI's `bun install --frozen-lockfile` reproduces the green toolchain; use that.
- Drivers were ad-hoc Playwright scripts modeled on `scripts/css-shot.mjs` (fresh
  context per scenario, `networkidle` + settle waits, DOM assertions for tooltip /
  aria / animation-name alongside the pixels). The bloom pass drives the real UI:
  quick-add with NL dates, the row editor's Remind popover, the rail's Today card,
  the tab-rail calendar, and the toast from a ~1-minute-out reminder.
- Headless limits, unchanged from the live pass: no microphone, no PiP window, no
  OS-level notification, and native `title` tooltips do not paint — the tooltip
  chord is proven by the hydrated attribute string.
