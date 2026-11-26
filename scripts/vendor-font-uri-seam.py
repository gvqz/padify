#!/usr/bin/env python3
"""One-shot port of the upstream package build's font-URI seam.

The vendored family index.ts files import their woff2 slices as vite
assets (``import _5 from "./Excalifont-Regular-….woff2"``) — under a plain
vite build those become hashed bundle assets, which would change the
deployed font layout (dist/assets/*.woff2 instead of the copied
dist/vendor/excalidraw/fonts tree the SW classifies runtime-cache).

Upstream's own package build rewrites those imports into RELATIVE URI
strings ("./fonts/<Family>/<file>.woff2") which ExcalidrawFontFace resolves
against window.EXCALIDRAW_ASSET_PATH — the seam the app's canvas-assets.ts
already speaks. This script performs that rewrite at the source level so
the fork's build produces the SAME deployed shape as the npm-dist era.
"""
import re
import sys
from pathlib import Path

FONTS = Path("vendor/excalidraw/excalidraw/fonts")

IMPORT_RE = re.compile(
    r'^import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+"\./([A-Za-z0-9_.-]+\.woff2)";\s*$'
)


def main() -> int:
    changed = 0
    for family_dir in sorted(p for p in FONTS.iterdir() if p.is_dir()):
        index = family_dir / "index.ts"
        if not index.exists():
            continue
        lines = index.read_text(encoding="utf-8").splitlines(keepends=True)
        uris: dict[str, str] = {}
        kept: list[str] = []
        for line in lines:
            m = IMPORT_RE.match(line.rstrip("\n"))
            if m:
                uris[m.group(1)] = f'"./fonts/{family_dir.name}/{m.group(2)}"'
                changed += 1
            else:
                kept.append(line)
        if not uris:
            continue
        out = "".join(kept)
        for name, uri in uris.items():
            # uri: _N,  |  uri: _N }  |  uri: _N\s
            out = re.sub(rf"uri:\s*{re.escape(name)}\b", f"uri: {uri}", out)
        index.write_text(out, encoding="utf-8")
        print(f"{family_dir.name}: {len(uris)} slices rewritten")
    print(f"total import lines converted: {changed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
