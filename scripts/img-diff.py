#!/usr/bin/env python3
"""Pixel-diff two screenshot directories; print per-image verdicts."""
import sys
from pathlib import Path
from PIL import Image, ImageChops

a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
diffs = 0
for a in sorted(a_dir.glob("*.png")):
    b = b_dir / a.name
    if not b.exists():
        print(f"MISSING   {a.name} (no counterpart)")
        diffs += 1
        continue
    ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    if ia.size != ib.size:
        print(f"SIZE      {a.name}: {ia.size} vs {ib.size}")
        diffs += 1
        continue
    delta = ImageChops.difference(ia, ib)
    bbox = delta.getbbox()
    if bbox is None:
        print(f"IDENTICAL {a.name}")
    else:
        hist = delta.convert("L").histogram()
        changed = sum(hist[8:])  # pixels with any real channel delta
        total = ia.size[0] * ia.size[1]
        print(f"DIFFERS   {a.name}: bbox={bbox} changed={changed}/{total} ({100*changed/total:.3f}%)")
        diffs += 1
print(f"\n{diffs} image(s) differ" if diffs else "\nALL IDENTICAL")
sys.exit(1 if diffs else 0)
