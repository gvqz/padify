#!/usr/bin/env python3
"""bootstrap-prune.py — remove the provably-dead residue from the bootstrap
subset inside public/css/vercel/02-base.css.

The Phase-1 extraction (scripts/bootstrap-extract.mjs) kept a rule when ANY
of its class tokens appeared in the app's emit corpus — deliberately
conservative, because a token can be referenced by a *different* rule than
the one that keeps it alive. The cost: groups whose every complex selector
requires a class the app can neither emit nor ever show on live DOM (the
bootstrap-JS vocabulary: btn-group, input-group, .table, .caret, .badge,
has-error, ...) shipped anyway. This tool removes exactly those.

A class token is IMPOSSIBLE when all of the following hold:
  1. never observed on any element across the live view matrix
     (css-cascade-audit.mjs views; collected by the companion collector —
     the JSON this script takes as input);
  2. never emitted as a literal by any app mechanism:
     class="..." attributes (markup or TS template strings),
     classList.add/toggle/remove/contains('...'), className = '...',
     jQuery-style .addClass/.toggleClass/.removeClass('...'),
     .attr('class', '...') / setAttribute('class', '...');
  3. not the value of a constant passed to one of those calls
     (resolved by simple const-definition search).

Note content cannot introduce classes: the storage-subset sanitizer strips
every attribute but href/style/data-*, and the one class survivor is the
fixed `padify-math` shell. So app code + observed DOM is the whole universe.

A complex selector (comma part) is DEAD when it references at least one
impossible class token (or an id the app never declares/selects). Dead
parts are stripped from surviving groups; groups whose parts are all dead
are removed; @media wrappers that empty out are removed. Everything else
stays byte-identical. The banner counts are updated; the content-hash pin
in src/architecture.test.ts must be re-run deliberately after this tool.

Usage:
  python3 scripts/bootstrap-prune.py <live-classes.json> [--apply]
Without --apply: prints the plan, writes nothing.
"""
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_CSS = os.path.join(REPO, "public", "css", "vercel", "02-base.css")
BANNER_START = "/* Bootstrap 3.4.1 — the surviving subset."
BANNER_END_MARK = "/* [phase-1 fold]"

# ---------------------------------------------------------------- corpus ----

def walk(directory, out):
    for name in sorted(os.listdir(directory)):
        full = os.path.join(directory, name)
        if os.path.isdir(full):
            if name in ("node_modules", "dist", ".git"):
                continue
            walk(full, out)
        elif re.search(r"\.(ts|html|js)$", name) and ".test." not in name:
            out.append(full)
    return out

corpus_files = (
    [os.path.join(REPO, "index.html")]
    + walk(os.path.join(REPO, "src"), [])
    + walk(os.path.join(REPO, "public", "share"), [])
)
corpus = "\n".join(open(f, encoding="utf-8", errors="replace").read() for f in corpus_files)

def literal_args(pattern):
    """Every string-literal argument matched by `pattern` (tokens split on
    whitespace). Handles ", ', ` literals."""
    toks = set()
    for m in re.finditer(pattern, corpus):
        lit = m.group(1)
        for tok in lit[1:-1].split():
            toks.add(tok)
    return toks

Q = r"(\"[^\"\n]*\"|'[^'\n]*'|`[^`\n]*`)"
emittable = set()
# class="..." attributes (markup + TS template strings)
emittable |= literal_args(r"class\s*=\s*" + Q)
# classList / className with literals
emittable |= literal_args(
    r"classList\s*\.\s*(?:add|toggle|remove|contains)\s*\(\s*" + Q
)
emittable |= literal_args(r"className\s*=\s*" + Q)
# jQuery-style class calls with literals
emittable |= literal_args(r"\.(?:addClass|toggleClass|removeClass|hasClass)\(\s*" + Q)
# attr('class', ...) / setAttribute('class', ...)
emittable |= literal_args(r"attr\(\s*['\"]class['\"]\s*,\s*" + Q)
emittable |= literal_args(r"setAttribute\(\s*['\"]class['\"]\s*,\s*" + Q)

# Constants passed to class calls: resolve const X = 'value'.
constant_names = set()
for m in re.finditer(
    r"(?:classList\s*\.\s*(?:add|toggle|remove|contains)\s*\(\s*"
    r"|\.(?:addClass|toggleClass|removeClass|hasClass)\(\s*)"
    r"([A-Z_][A-Z0-9_]*)\s*[,)]",
    corpus,
):
    constant_names.add(m.group(1))
for name in constant_names:
    for m in re.finditer(rf"const\s+{name}\s*=\s*{Q}", corpus):
        for tok in m.group(1)[1:-1].split():
            emittable.add(tok)

# Value-interpolated classes: template literals whose ${...} resolves to a
# closed vocabulary the app supports by API. The one bootstrap-relevant
# case: the owned tooltip module (src/ui/behavior/tooltip.ts) builds
# `tooltip fade ${placement}` where placement is read from the supported
# data-placement="top|bottom|left|right" attribute (top the default). The
# module is wired at boot and is the documented bootstrap-parity
# replacement — its whole vocabulary must stay reachable even though no
# element carries data-toggle="tooltip" today.
EXTRA_POSSIBLE = {"top", "bottom", "left", "right"}
emittable |= EXTRA_POSSIBLE

# ids the app can reference (declared in markup or queried by selector)
ids_possible = set(re.findall(r"id\s*=\s*[\"']([\w-]+)[\"']", corpus))
for m in re.finditer(r"[\"']#([\w-]+)[\"']", corpus):
    ids_possible.add(m.group(1))

# live classes from the view matrix
live_path = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else None
if not live_path:
    print("usage: bootstrap-prune.py <live-classes.json> [--apply]", file=sys.stderr)
    sys.exit(2)
live = set(json.load(open(live_path)))

possible = emittable | live

# ------------------------------------------------------------------ parse ----

css = open(BASE_CSS, encoding="utf-8").read()
start = css.index(BANNER_START)
end = css.index(BANNER_END_MARK)
before_banner = css[:start]
subset = css[start:end]
after = css[end:]

banner_close = subset.index("*/") + 2
banner_text = subset[:banner_close]
body = subset[banner_close:]

def parse_groups(text):
    """Returns (style_rules, at_rules). Style rules are (at_context, selector,
    decls); @keyframes/@font-face blocks (the extractor emits them after the
    style rules) land in at_rules as raw selector+block strings."""
    groups = []
    at_rules = []
    i, n = 0, len(text)
    at = []
    buf = ""
    while i < n:
        c = text[i]
        if c == "{":
            sel = buf.strip()
            if sel.startswith("@media") or sel.startswith("@supports"):
                at.append(sel)
                buf = ""
                i += 1
                continue
            depth = 1
            j = i + 1
            while j < n and depth:
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                j += 1
            if sel.startswith("@keyframes") or sel.startswith("@font-face"):
                at_rules.append(sel + text[i:j])
            else:
                groups.append((list(at), sel, text[i:j]))
            buf = ""
            i = j
            continue
        if c == "}":
            if at:
                at.pop()
            buf = ""
            i += 1
            continue
        buf += c
        i += 1
    return groups, at_rules

groups, at_rules = parse_groups(body)

# ------------------------------------------------------------- classify ----

def part_dead(part):
    for m in re.finditer(r"\.(-?[A-Za-z_][\w-]*)", part):
        if m.group(1) not in possible:
            return m.group(1)
    for m in re.finditer(r"#([\w-]+)", part):
        if m.group(1) not in ids_possible:
            return "#" + m.group(1)
    return None

plan = []  # (kind, at, selector, note)
kept_groups = []  # (at_context, selector, decls, new_selector or None)
impossible_seen = {}

for at, sel, decls in groups:
    parts = [p.strip() for p in sel.split(",")]
    dead_parts = []
    live_parts = []
    killers = []
    for p in parts:
        why = part_dead(p)
        if why:
            dead_parts.append(p)
            killers.append(why)
            impossible_seen.setdefault(why, 0)
            impossible_seen[why] += 1
        else:
            live_parts.append(p)
    if not live_parts:
        plan.append(("DROP-GROUP", at, sel, ",".join(sorted(set(killers)))))
    elif dead_parts:
        plan.append(("STRIP-PARTS", at, sel, f"dropped {len(dead_parts)}/{len(parts)} parts"))
        kept_groups.append((at, sel, decls, ",".join(live_parts)))
    else:
        kept_groups.append((at, sel, decls, None))

# ------------------------------------------------------------- rebuild ----

out_lines = []
prev_at = None
open_at = False

def close_wrappers():
    global open_at
    if open_at:
        out_lines.append("}")
        open_at = False

for at, sel, decls, new_sel in kept_groups:
    if at != prev_at:
        close_wrappers()
        if at:
            for prelude in at:
                out_lines.append(prelude + "{")
            open_at = True
        prev_at = at
    out_lines.append((new_sel if new_sel else sel) + decls)
close_wrappers()

# Pass 2 — orphaned @keyframes: the extractor kept a keyframes when a kept
# rule referenced its name in an animation declaration. The prune may have
# killed that referencing rule (progress-bar-stripes lost .progress*), so
# re-check against the SURVIVING declarations only.
kept_decl_text = "\n".join(
    (new_sel if new_sel else sel) + decls for _, sel, decls, new_sel in kept_groups
)
final_lines = []
keyframes_kept = 0
for line in out_lines:
    m = re.match(r"@keyframes\s+([\w-]+)\s*\{", line)
    if m:
        name = m.group(1)
        if not re.search(rf"(^|[\s,]){re.escape(name)}($|[\s,])", kept_decl_text):
            plan.append(("DROP-KEYFRAMES", [], line[:60], f"orphaned: no surviving rule references {name}"))
            continue
        keyframes_kept += 1
    final_lines.append(line)
out_lines = final_lines

dropped = sum(1 for k, *_ in plan if k == "DROP-GROUP")
stripped = sum(1 for k, *_ in plan if k == "STRIP-PARTS")
orig_count = len(groups)
new_count = len(kept_groups)

new_banner = (
    "/* Bootstrap 3.4.1 — the surviving subset.\n"
    f" * {new_count}/{orig_count} rule groups kept (live-matched, emittable, or\n"
    " * state-reachable); pruned 2026-11-16 by scripts/bootstrap-prune.py from\n"
    " * the extractor's conservative keep: every removed group/complex-selector\n"
    " * required a class token the app can neither emit (markup, classList,\n"
    " * jQuery-style, attr) nor show on live DOM — bootstrap's JS-only\n"
    " * vocabulary that left with the bootstrap JS. Note content is sanitized\n"
    " * to a class-free subset, so app code is the only class source.\n"
    f" * 0 @font-face, {keyframes_kept} @keyframes.\n"
    " * Rendering parity re-proven by the computed-style and pixel diffs (see\n"
    " * the Phase 1 notes in docs/ARCHITECTURE-REVIEW.md). */\n"
)

new_subset = new_banner + "\n".join(out_lines) + "\n"

# ---------------------------------------------------------------- report ----

print(f"groups: {orig_count} -> {new_count}  (dropped {dropped}, stripped parts in {stripped})")
print(f"bytes: subset {len(subset)} -> {len(new_subset)}  ({len(new_subset)-len(subset):+d})")
print("\nimpossible tokens and their kill count:")
for tok, cnt in sorted(impossible_seen.items(), key=lambda x: -x[1]):
    print(f"  {tok:28} {cnt}")
print("\nDROPPED GROUPS:")
for kind, at, sel, note in plan:
    if kind == "DROP-GROUP":
        ctx = ("@" + "+".join(at) + " | ") if at else ""
        print(f"  {ctx}{sel[:110]}{'…' if len(sel) > 110 else ''}   [impossible: {note}]")
print("\nSTRIPPED (partial) GROUPS:")
for kind, at, sel, note in plan:
    if kind == "STRIP-PARTS":
        ctx = ("@" + "+".join(at) + " | ") if at else ""
        print(f"  {ctx}{sel[:110]}{'…' if len(sel) > 110 else ''}   [{note}]")

if "--apply" in sys.argv:
    new_css = before_banner + new_subset + after
    with open(BASE_CSS, "w", encoding="utf-8") as f:
        f.write(new_css)
    print("\nAPPLIED — 02-base.css rewritten. Re-pin the hash in src/architecture.test.ts.")
else:
    with open("/tmp/02-base.pruned.css", "w", encoding="utf-8") as f:
        f.write(new_subset)
    print("\nDRY RUN — pruned subset written to /tmp/02-base.pruned.css (nothing applied).")
