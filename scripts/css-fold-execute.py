#!/usr/bin/env python3
"""
css-fold-execute.py — execute the Phase-1 CSS consolidation.

One-shot migration companion to scripts/css-fold-plan.json (verified by
scripts/css-fold-check.mjs: zero same-selector tie flips). Line ranges are
explicit and deliberate: the split sources keep their comments, the four
usage-verified dead rules (#mode, #changelog, .new-badge, the heartbeat
keyframes) are dropped, and every section lands in its target BEFORE the
target's own rules in the exact source order the plan was verified with.

Idempotence: refuses to run twice (checks for the fold marker in
02-base.css). Run from the repo root.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "public" / "css"
VZ = CSS / "vercel"

FOLD_MARKER = "/* [phase-1 fold]"

def body(path, a, b):
    """1-indexed inclusive line slice of a css file."""
    lines = path.read_text().splitlines(keepends=True)
    return "".join(lines[a - 1 : b])

def banner(title, origin):
    return (
        f"\n{FOLD_MARKER} {title}\n"
        f"   Folded from public/css/{origin} (Phase 1 consolidation — the file\n"
        f"   itself is gone; see docs/ARCHITECTURE-REVIEW.md and\n"
        f"   scripts/css-fold-plan.json for the verified mapping). */\n"
    )

def section(title, origin, text):
    if not text.strip():
        return ""
    return banner(title, origin) + text.rstrip() + "\n"

def main():
    if (VZ / "02-base.css").read_text().find(FOLD_MARKER) >= 0:
        sys.exit("fold marker already present — refusing to run twice")

    # ------------------------------------------------------------------
    # Read sources once.
    # ------------------------------------------------------------------
    src = {n: CSS / n for n in [
        "tokens.css", "base.css", "navbar.css", "editor.css", "components.css",
        "timer.css", "effects.css", "switches.css", "animations.css",
        "fonts.css", "modals.css", "unicode-picker.css",
    ]}

    def prepend(target, *sections):
        path = VZ / target
        path.write_text(
            "".join(s for s in sections if s) + path.read_text()
        )
        print(f"folded into {target}")

    # ------------------------------------------------------------------
    # 01-tokens — the values (tokens.css) + the aliases (01's own rules).
    # ------------------------------------------------------------------
    prepend(
        "01-tokens.css",
        section(
            "Design tokens — the VALUES",
            "tokens.css",
            body(src["tokens.css"], 22, 137),
        ),
    )

    # ------------------------------------------------------------------
    # 02-base — bootstrap survivors, the old base layer, stray page-shell
    # rules from components/animations.
    # ------------------------------------------------------------------
    bootstrap_kept = Path("/tmp/bootstrap-kept.css").read_text()
    prepend(
        "02-base.css",
        bootstrap_kept.rstrip() + "\n",
        section(
            "Page shell — document base",
            "base.css",
            body(src["base.css"], 8, 131),
        ),
        section(
            "Page-shell odds and ends",
            "components.css",
            body(src["components.css"], 65, 67) + body(src["components.css"], 77, 79),
        ),
        section(
            "PiP host visibility (mobile)",
            "animations.css",
            body(src["animations.css"], 93, 97),
        ),
    )

    # ------------------------------------------------------------------
    # 03-topbar — navbar skin + icon-row layout + wordmark tilt.
    # ------------------------------------------------------------------
    prepend(
        "03-topbar.css",
        section(
            "Top bar — the bootstrap-era base layer",
            "navbar.css",
            body(src["navbar.css"], 8, 171),
        ),
        section(
            "Icon row + wordmark layout",
            "effects.css",
            body(src["effects.css"], 18, 36) + body(src["effects.css"], 52, 55),
        ),
        section(
            "Navbar responsive + mobile collapse + status dots",
            "animations.css",
            body(src["animations.css"], 25, 66)
            + body(src["animations.css"], 71, 76)
            + body(src["animations.css"], 86, 91)
            + body(src["animations.css"], 99, 151),
        ),
        section(
            "Wordmark letters tilt on hover",
            "fonts.css",
            body(src["fonts.css"], 333, 365),
        ),
    )

    # ------------------------------------------------------------------
    # 05-dialogs — modal chrome from five old sheets.
    # ------------------------------------------------------------------
    prepend(
        "05-dialogs.css",
        section(
            "Shortcuts-modal table",
            "editor.css",
            body(src["editor.css"], 33, 65),
        ),
        section(
            "Modal chrome",
            "components.css",
            body(src["components.css"], 8, 10)
            + body(src["components.css"], 87, 89)
            + body(src["components.css"], 122, 124)
            + body(src["components.css"], 131, 142),
        ),
        section(
            "About modal",
            "effects.css",
            body(src["effects.css"], 38, 50) + body(src["effects.css"], 57, 61),
        ),
        section(
            "Modal header close + white-noise title",
            "animations.css",
            body(src["animations.css"], 52, 62),
        ),
        section(
            "Dialogs — shortcuts search, dark theme, brand menu, help tour",
            "modals.css",
            body(src["modals.css"], 8, 237) + body(src["modals.css"], 259, 864),
        ),
    )

    # ------------------------------------------------------------------
    # 07-switches — the switch base + volume sliders.
    # ------------------------------------------------------------------
    prepend(
        "07-switches.css",
        section(
            "Switch base (the pre-skin layer)",
            "effects.css",
            body(src["effects.css"], 63, 121),
        ),
        section(
            "Volume sliders + the typewriter volume readout",
            "fonts.css",
            body(src["fonts.css"], 8, 39) + body(src["fonts.css"], 97, 99),
        ),
    )

    # ------------------------------------------------------------------
    # 08-toasts — #toast + toast-popup + break reminder.
    # ------------------------------------------------------------------
    prepend(
        "08-toasts.css",
        section(
            "The #toast element",
            "components.css",
            body(src["components.css"], 91, 120),
        ),
        section(
            "Toast popups + the break reminder",
            "animations.css",
            body(src["animations.css"], 153, 235),
        ),
    )

    # ------------------------------------------------------------------
    # 09-pills — word-count pill + the timer pill's dock line.
    # ------------------------------------------------------------------
    prepend(
        "09-pills.css",
        section(
            "Word-count pill",
            "components.css",
            body(src["components.css"], 12, 57),
        ),
        section(
            "The bottom dock line (base; the mobile override lives below)",
            "timer.css",
            body(src["timer.css"], 135, 141),
        ),
    )

    # ------------------------------------------------------------------
    # 12-timer — writing-session modal + chime.
    # ------------------------------------------------------------------
    prepend(
        "12-timer.css",
        section(
            "Writing-session modal",
            "timer.css",
            body(src["timer.css"], 8, 133),
        ),
        section(
            "Timer pill",
            "effects.css",
            body(src["effects.css"], 8, 16),
        ),
        section(
            "End-of-session chime",
            "fonts.css",
            body(src["fonts.css"], 314, 331),
        ),
    )

    # ------------------------------------------------------------------
    # 13-settings — reset button placement.
    # ------------------------------------------------------------------
    prepend(
        "13-settings.css",
        section(
            "Reset-preferences button",
            "components.css",
            body(src["components.css"], 126, 129),
        ),
    )

    # ------------------------------------------------------------------
    # 14-unicode-picker — the whole picker (its own token block).
    # ------------------------------------------------------------------
    prepend(
        "14-unicode-picker.css",
        section(
            "Unicode picker (ucp)",
            "unicode-picker.css",
            body(src["unicode-picker.css"], 1, 767),
        ),
    )

    # ------------------------------------------------------------------
    # 15-textures — fonts, paper textures, starfield.
    # ------------------------------------------------------------------
    fonts_faces = body(src["fonts.css"], 41, 87).replace(
        "url('../fonts/", "url('/fonts/"
    )
    prepend(
        "15-textures.css",
        section(
            "Paper textures, font classes, starfield",
            "switches.css",
            body(src["switches.css"], 8, 205),
        ),
        section(
            "@font-face + font-selection classes",
            "fonts.css",
            fonts_faces,
        ),
    )

    # ------------------------------------------------------------------
    # 16-editor-shell — the editor surface from five old sheets.
    # ------------------------------------------------------------------
    prepend(
        "16-editor-shell.css",
        section(
            "Editor surface base",
            "editor.css",
            body(src["editor.css"], 8, 31),
        ),
        section(
            "Editor surface padding + borders",
            "components.css",
            body(src["components.css"], 59, 75),
        ),
        section(
            "Editor surface (mobile borders)",
            "animations.css",
            body(src["animations.css"], 78, 84),
        ),
        section(
            "Keyburst — typing celebratory particles",
            "fonts.css",
            body(src["fonts.css"], 101, 312),
        ),
        section(
            "Print — the editor prints clean",
            "modals.css",
            body(src["modals.css"], 238, 258),
        ),
    )

    print("\nAll sections folded. Now: git mv the feature sheets, delete the")
    print("legacy files, rewrite index.html, update architecture.test.ts.")


if __name__ == "__main__":
    main()
