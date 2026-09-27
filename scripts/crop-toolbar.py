#!/usr/bin/env python3
"""Crop the rich toolbar from a full screenshot and upscale for icon review."""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src)
# Toolbar geometry measured in-app: x=240, y=50, w=1200, h=38 (+ margins)
crop = img.crop((240, 46, 1440, 94))
crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
crop.save(dst)
print(f"saved {dst} ({crop.width}x{crop.height})")
