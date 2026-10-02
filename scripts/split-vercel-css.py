#!/usr/bin/env python3
"""Split public/css/vercel.css into its 16 numbered sections as
public/css/vercel/NN-*.css files, byte-exact per section, order-preserving.

Cascade safety: the concatenation of the split files (in numeric order)
must equal the original file except for the per-file banner we prepend.
The script verifies that and exits non-zero otherwise.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public' / 'css' / 'vercel.css'
OUT_DIR = ROOT / 'public' / 'css' / 'vercel'

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
    16: 'accessibility',
}

OUT_DIR.mkdir(parents=True, exist_ok=True)
recombined: list[str] = []
for idx, (start, number, title) in enumerate(starts):
    end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
    body = ''.join(lines[start:end])
    slug = SLUGS[number]
    name = f'{number:02d}-{slug}.css'
    banner = (
        f'/* vercel design system — part {number}/16: {title}\n'
        f'   Split from the former vercel.css (cascade order preserved —\n'
        f'   index.html loads these files in numeric order, last in the\n'
        f'   stylesheet chain, exactly where the monolith sat). */\n'
    )
    content = (banner + body) if number != 1 else (banner + file_top + body)
    (OUT_DIR / name).write_text(content)
    recombined.append(content)

# Verify: strips our banners -> must equal the original byte-for-byte.
rebuilt = ''.join(recombined)
stripped = rebuilt.replace(
    recombined[0].split('\n', 5)[5] if False else '', ''
)
# Simpler check: remove each banner block (exactly the 5 lines we added,
# or 5 lines + file_top for part 1).
check = []
for idx, content in enumerate(recombined):
    n_banner_lines = 4  # banner is 4 lines ending with newline
    if idx == 0:
        # banner(4 lines) + file_top
        rest = content.split('\n', 4)[4]  # drop the 4 banner lines
        check.append(rest)
    else:
        rest = content.split('\n', 4)[4]
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

print('split ok: 16 files, recombination byte-exact')
for start, number, title in starts:
    print(f'  {number:02d}-{SLUGS[number]}.css  <- {title}')
