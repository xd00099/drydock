#!/usr/bin/env python3
"""Drydock app icon master (single source of truth).

The dock/bundle identity: the same anchor the menu-bar tray shows (⚓), drawn
in the app's palette on the standard macOS icon grid (824px rounded-rect
centered in a 1024 canvas, transparent margin). Drawn with PIL at 4x and
downscaled — SVG renderers available on a stock Mac each dropped different
elements, so this stays deterministic.

Regenerate the whole bundle set:
    python3 src-tauri/icons/make-icon.py /tmp/drydock-icon-1024.png
    npx tauri icon /tmp/drydock-icon-1024.png
"""

import sys

from PIL import Image, ImageDraw

F = 4  # supersampling factor
S = 1024 * F

BG_TOP, BG_BOT = (0x1C, 0x26, 0x37), (0x0B, 0x0F, 0x16)
INK_TOP, INK_BOT = (0xA8, 0xCC, 0xFF), (0x6D, 0x9F, 0xF0)
BORDER = (0x31, 0x40, 0x5A, 255)
WATER = (0x27, 0x35, 0x4C, 255)

W = 42 * F  # anchor stroke width
CAP = W // 2


def vgrad(top, bot, y0, y1):
    """Vertical gradient over the full canvas, interpolating between y0..y1."""
    img = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):
        t = min(max((y - y0) / (y1 - y0), 0.0), 1.0)
        c = tuple(round(a + (b - a) * t) for a, b in zip(top, bot))
        d.line([(0, y), (S, y)], fill=c + (255,))
    return img


def main(out: str) -> None:
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # rounded-rect plate with a vertical gradient (masked), then a subtle border
    plate_box = (100 * F, 100 * F, 924 * F, 924 * F)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(plate_box, radius=185 * F, fill=255)
    icon.paste(vgrad(BG_TOP, BG_BOT, 100 * F, 924 * F), (0, 0), mask)
    d = ImageDraw.Draw(icon)
    d.rounded_rectangle(plate_box, radius=185 * F, outline=BORDER, width=6 * F)

    # waterline behind the anchor's arms
    import math

    pts = [(x, 700 * F + math.sin((x / F - 180) / 55) * 13 * F) for x in range(180 * F, 845 * F, 4 * F)]
    d.line(pts, fill=WATER, width=14 * F, joint="curve")

    # the anchor, drawn as a mask and filled with its own vertical gradient
    am = Image.new("L", (S, S), 0)
    a = ImageDraw.Draw(am)

    def dot(x, y):
        a.ellipse((x - CAP, y - CAP, x + CAP, y + CAP), fill=255)

    def line(x1, y1, x2, y2):
        a.line((x1, y1, x2, y2), fill=255, width=W)
        dot(x1, y1)
        dot(x2, y2)

    # eye (PIL strokes inward from the bbox → bbox at centerline + half-stroke)
    r_out = 54 * F + CAP
    a.ellipse((512 * F - r_out, 330 * F - r_out, 512 * F + r_out, 330 * F + r_out), outline=255, width=W)
    # shank and stock
    line(512 * F, 392 * F, 512 * F, 742 * F)
    line(398 * F, 470 * F, 626 * F, 470 * F)
    # arms: bowl through the bottom (center 512,580 r 214), tips curling up
    r_arc = 214 * F + CAP
    a.arc((512 * F - r_arc, 580 * F - r_arc, 512 * F + r_arc, 580 * F + r_arc), 0, 180, fill=255, width=W)
    dot(298 * F, 580 * F)
    dot(726 * F, 580 * F)
    line(298 * F, 580 * F, 298 * F, 522 * F)
    line(726 * F, 580 * F, 726 * F, 522 * F)

    icon.paste(vgrad(INK_TOP, INK_BOT, 270 * F, 800 * F), (0, 0), am)

    icon.resize((1024, 1024), Image.LANCZOS).save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/drydock-icon-1024.png")
