#!/usr/bin/env python3
"""Split the former public/css/vercel.css monolith into its 17 numbered
sections as public/css/vercel/NN-*.css files, byte-exact per section,
order-preserving.

PROVENANCE NOTE: the monolith was split once (16 files) and has since
left the tree; this script is the record of how the directory was born
and can reproduce it from a recovered copy of vercel.css (drop it back
at public/css/vercel.css and re-run). Two post-split corrections are
baked in so the output matches the CURRENT layout, not the first cut:

  * Part 16 re-cut: the monolith's section 16 was labelled
    "Accessibility" but carried the whole rich-text editor-shell /
    note-rail layout after a three-rule reduced-motion block. It is now
    two files — 16-editor-shell.css (the layout, the app's most
    important CSS) and 17-accessibility.css (the reduced-motion block).
    The reduced-motion block moves AFTER the editor shell; the halves
    share no selector text, and the only equal-specificity crossover
    (.btn vs .cloud-submit on the cloud submit button) makes that
    button honor reduced motion — the block's intent — so the swap is
    cascade-neutral in every other respect.
  * The on-disk banners for parts 16/17 are longer, hand-written notes
    describing the re-cut; a re-run writes the standard 4-line banner
    instead. Section boundaries and cascade order are identical.

Cascade safety: concatenating the split files in numeric order, with
part 17's body swapped back before part 16's and its section banner
renumbered back to "16.", must equal the original file except for the
per-file banners we prepend. The script verifies that and exits
non-zero otherwise.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public' / 'css' / 'vercel.css'
OUT_DIR = ROOT / 'public' / 'css' / 'vercel'

if not SRC.exists():
    print(
        'vercel.css is gone from the tree (it was split into '
        'public/css/vercel/NN-*.css — 17 sections after the part-16 '
        'editor-shell/accessibility re-cut). This script is the '
        'provenance record; place a recovered monolith at '
        'public/css/vercel.css to re-run it.',
        file=sys.stderr,
    )
    sys.exit(1)

src_text = SRC.read_text()
lines = src_text.splitlines(keepends=True)

# Section banner pattern: a /* ----...---- */ block whose first content
# line starts with "   <number>."
banner_start = re.compile(r'^/\* -{10,}$')
section_header = re.compile(r'^\s{3}(\d+)\.\s+(.+?)\s*$')

starts: list[tuple[int, int, str]] = []  # (line index, number, title)
i = 0
while i < len(lines):
    if banner_start.match(lines[i]):
        # Look ahead for the "   N. Title" line inside the banner
        j = i + 1
        while j < len(lines) and not lines[j].rstrip().endswith('*/'):
            m = section_header.match(lines[j])
            if m:
                starts.append((i, int(m.group(1)), m.group(2)))
                break
            j += 1
    i += 1

assert len(starts) == 16, f'expected 16 sections, found {len(starts)}: {starts}'

# File-top banner (everything before the first section banner) belongs to
# the first file.
file_top = ''.join(lines[: starts[0][0]])
assert 'Vercel design system' in file_top

SLUGS = {
    1: 'tokens',
    2: 'base',
    3: 'topbar',
    4: 'dropdowns',
    5: 'dialogs',
    6: 'buttons',
    7: 'switches',
    8: 'toasts',
    9: 'pills',
    10: 'statistics',
    11: 'snapshots',
    12: 'timer',
    13: 'settings',
    14: 'unicode-picker',
    15: 'textures',
    16: 'editor-shell',
    17: 'accessibility',
}

# Part 16 re-cut: the "Rich text editor surface ..." banner inside the
# monolith's section 16 divides the reduced-motion block (before) from
# the editor-shell layout (after).
EDITOR_SHELL_BANNER = re.compile(r'^/\* -{10,}$')


def split_section_16(body_lines: list[str]) -> int:
    """Returns the index of the "Rich text editor surface ..." banner line
    inside the section body: everything from that banner onward is the
    editor shell; the rest (section banner + reduced-motion block) is the
    accessibility file's body."""
    for idx, line in enumerate(body_lines):
        if EDITOR_SHELL_BANNER.match(line) and any(
            'Rich text editor surface' in later for later in body_lines[idx : idx + 3]
        ):
            return idx
    raise AssertionError('editor-shell banner not found inside section 16')


OUT_DIR.mkdir(parents=True, exist_ok=True)
bodies: dict[int, str] = {}  # section number -> body text (banner excluded)
section_titles = {n: t for _, n, t in starts}
section_titles[16] = 'Editor shell — rich text surface (#note) + left note rail'
section_titles[17] = 'Accessibility (prefers-reduced-motion)'

for idx, (start, number, _title) in enumerate(starts):
    end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
    if number == 16:
        body_lines = lines[start:end]
        cut = split_section_16(body_lines)
        # Accessibility body: the section banner (renumbered 16. -> 17.)
        # plus everything up to the editor-shell banner.
        bodies[17] = ''.join(body_lines[:cut]).replace(
            '   16. Accessibility', '   17. Accessibility', 1
        )
        # Editor-shell body: from the editor-shell banner to the end of
        # the section (its own banner; the "16. Accessibility" banner
        # above it belongs to the accessibility half).
        bodies[16] = ''.join(body_lines[cut:])
    else:
        bodies[number] = ''.join(lines[start:end])

written: dict[int, str] = {}  # section number -> file content
for number in sorted(bodies):
    slug = SLUGS[number]
    if number in (16, 17):
        banner = (
            f'/* vercel design system — part {number}/17: {section_titles[number]}\n'
            f'   Re-cut from the monolith\'s section 16, which carried the\n'
            f'   editor-shell layout under an "Accessibility" name; part 17\n'
            f'   loads after part 16 — the halves share no selectors, so the\n'
            f'   swap from the monolith\'s internal order is cascade-neutral. */\n'
        )
    else:
        banner = (
            f'/* vercel design system — part {number}/17: {section_titles[number]}\n'
            f'   Split from the former vercel.css (cascade order preserved —\n'
            f'   index.html loads these files in numeric order, last in the\n'
            f'   stylesheet chain, exactly where the monolith sat). */\n'
        )
    content = (banner + bodies[number]) if number != 1 else (banner + file_top + bodies[number])
    (OUT_DIR / f'{number:02d}-{slug}.css').write_text(content)
    written[number] = content

# Verify: strips our banners -> must equal the original byte-for-byte,
# with part 17 swapped back before part 16 (and its section banner
# renumbered back) to undo the deliberate re-cut.
def strip_banner(content: str) -> str:
    """Drops the prepended banner: everything up to and including the
    first line that ends the comment (*/). Parts 16/17 carry a 5-line
    re-cut banner, the others the original 4-line one."""
    lines_out = content.split('\n')
    for idx, line in enumerate(lines_out):
        if line.rstrip().endswith('*/'):
            return '\n'.join(lines_out[idx + 1 :])
    raise AssertionError('banner not found')


check = []
# Monolith order inside the old section 16: reduced-motion block first,
# editor shell after. The re-cut loads 16 (shell) before 17 (motion), so
# the check swaps them back.
for number in [n for n in sorted(written) if n not in (16, 17)] + [17, 16]:
    rest = strip_banner(written[number])
    if number == 17:
        rest = rest.replace('   17. Accessibility', '   16. Accessibility', 1)
    check.append(rest)
result = ''.join(check)
if result != src_text:
    # locate first divergence
    for a, b in zip(result, src_text):
        if a != b:
            pos = result.index(a)
            print('DIVERGENCE at ~char', pos)
            print('ours  :', repr(result[pos:pos + 80]))
            print('orig  :', repr(src_text[pos:pos + 80]))
            break
    print('lengths:', len(result), len(src_text))
    sys.exit(1)

print('split ok: 17 files (part 16 re-cut into editor-shell + accessibility), recombination byte-exact')
for number in sorted(bodies):
    print(f'  {number:02d}-{SLUGS[number]}.css')
