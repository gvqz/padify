#!/usr/bin/env python3
"""Pixel-diff two doctype-audit screenshot directories.

Usage: diff-audit.py <before-dir> <after-dir> <report-dir>
Prints a per-pair mismatch table; saves side-by-side + heat overlay for
any pair whose differing-pixel ratio exceeds the threshold.
"""
import os
import sys

import numpy as np
from PIL import Image


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)


def main(before_dir: str, after_dir: str, report_dir: str) -> None:
    os.makedirs(report_dir, exist_ok=True)
    names = sorted(
        f for f in os.listdir(before_dir) if f.endswith(".png") and os.path.exists(os.path.join(after_dir, f))
    )
    if not names:
        print("no comparable pairs")
        return

    threshold = 12  # per-channel abs diff considered "changed"
    print(f"{'pair':38} {'diff%':>8} {'maxΔ':>6}  verdict")
    worst = []
    for name in names:
        a = load(os.path.join(before_dir, name))
        b = load(os.path.join(after_dir, name))
        if a.shape != b.shape:
            print(f"{name:38} {'SIZE':>8}  {a.shape} vs {b.shape}  MISMATCH")
            worst.append((100.0, name))
            continue
        delta = np.abs(a - b).max(axis=2)
        changed = delta > threshold
        ratio = changed.mean() * 100
        verdict = "ok" if ratio < 0.5 else "CHECK"
        print(f"{name:38} {ratio:7.3f}% {delta.max():6}  {verdict}")
        if ratio >= 0.5:
            worst.append((ratio, name))

    for ratio, name in sorted(worst, reverse=True):
        base = name[:-4]
        a = Image.open(os.path.join(before_dir, name)).convert("RGB")
        b = Image.open(os.path.join(after_dir, name)).convert("RGB")
        delta = np.abs(
            np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16)
        ).max(axis=2)
        heat = np.zeros((*delta.shape, 3), dtype=np.uint8)
        heat[..., 0] = np.clip(delta * 8, 0, 255)
        heat[..., 1] = np.where(delta > 12, 255, 0)
        side = Image.new("RGB", (a.width * 3 + 20, a.height), (255, 255, 255))
        side.paste(a, (0, 0))
        side.paste(b, (a.width + 10, 0))
        side.paste(Image.fromarray(heat), (a.width * 2 + 20, 0))
        out = os.path.join(report_dir, f"diff-{base}.png")
        side.save(out)
        print(f"  report: {out} ({ratio:.2f}%)")

    if not worst:
        print("\nALL PAIRS IDENTICAL (within threshold)")


if __name__ == "__main__":
    main(*sys.argv[1:4])
