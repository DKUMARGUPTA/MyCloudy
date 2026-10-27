#!/usr/bin/env python3
"""
DocoPDF PWA icon generator — rasterizes the brand mark (public/logo.svg
geometry) into install-ready PNGs using the REAL Inter variable font.

Outputs (public/):
  icon-192.png          rounded-square, transparent corners (any purpose)
  icon-512.png          rounded-square, transparent corners (any purpose)
  maskable-512.png      full-bleed gradient (maskable safe zone respected)
  apple-touch-icon.png  180x180 full square (iOS composites its own mask)

Geometry mirrors the SVG viewBox 0 0 32 32 (values scaled by S/32):
  rounded rect 2..30 r8, diagonal gradient #2563EB -> #F97316,
  white doc 9.7..22.5 x 7.5..24.8 (r1.8), folded corner #BFDBFE,
  "PDF" Inter 700 fill #1D4ED8 centered x16.1 baseline y20.6 size 6.6.
Drawn at 4x supersampling, downscaled with LANCZOS.

Run: python3 scripts/make-pwa-icons.py
"""
import os

from fontTools.ttLib.woff2 import decompress
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WOFF2 = os.path.join(ROOT, "src", "fonts", "InterVariable.woff2")
TTF = "/tmp/InterVariable-docopdf.ttf"

BLUE = (37, 99, 235, 255)     # #2563EB
ORANGE = (249, 115, 22, 255)  # #F97316
FOLD = (191, 219, 254, 255)   # #BFDBFE
TEXT_BLUE = (29, 78, 216, 255)  # #1D4ED8

decompress(WOFF2, TTF)


def diagonal_gradient(size: int) -> Image.Image:
    """Blue->orange diagonal gradient (t = (x+y)/(2*size)), smooth via resize."""
    small = 256
    grad = Image.new("RGBA", (small, small))
    px = grad.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * small - 2)
            px[x, y] = (
                round(BLUE[0] + (ORANGE[0] - BLUE[0]) * t),
                round(BLUE[1] + (ORANGE[1] - BLUE[1]) * t),
                round(BLUE[2] + (ORANGE[2] - BLUE[2]) * t),
                255,
            )
    return grad.resize((size, size), Image.BICUBIC)


def load_inter(px_size: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(TTF, px_size)
    try:
        font.set_variation_by_axes([700])  # wght axis -> Bold
    except Exception:
        pass  # Regular fallback still renders fine
    return font


def draw_mark(size: int, full_bleed: bool) -> Image.Image:
    """Draw the DocoPDF mark at `size` px (4x supersampled internally)."""
    s = size * 4  # supersample scale
    k = s / 32.0  # viewBox -> px

    img = diagonal_gradient(s)

    if not full_bleed:
        # Rounded-square brand tile with transparent corners.
        r = 8 * k
        m = 2 * k
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [m, m, s - m, s - m], radius=r, fill=255
        )
        img.putalpha(mask)
        tile = img
    else:
        # Maskable / apple: gradient covers the whole canvas.
        tile = img

    d = ImageDraw.Draw(tile)

    # White document body (9.7,7.5)-(22.5,24.8), radius 1.8.
    x0, y0, x1, y1 = 9.7 * k, 7.5 * k, 22.5 * k, 24.8 * k
    d.rounded_rectangle([x0, y0, x1, y1], radius=1.8 * k, fill=(255, 255, 255, 255))

    # Folded corner (light blue) — triangle below the diagonal fold.
    fx, fy = 17.8 * k, 7.5 * k
    fw, fh = 4.7 * k, 4.7 * k
    d.polygon(
        [(fx, fy), (fx + fw, fy + fh), (fx, fy + fh)],
        fill=FOLD,
    )

    # "PDF" — Inter Bold, centered x=16.1, baseline y=20.6, size 6.6 units.
    font = load_inter(round(6.6 * k))
    d.text(
        (16.1 * k, 20.6 * k),
        "PDF",
        font=font,
        fill=TEXT_BLUE,
        anchor="ms",
    )

    return tile.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = os.path.join(ROOT, "public")
    draw_mark(192, full_bleed=False).save(os.path.join(out, "icon-192.png"))
    draw_mark(512, full_bleed=False).save(os.path.join(out, "icon-512.png"))
    draw_mark(512, full_bleed=True).save(os.path.join(out, "maskable-512.png"))
    draw_mark(180, full_bleed=True).save(os.path.join(out, "apple-touch-icon.png"))
    for name in ("icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"):
        path = os.path.join(out, name)
        print(f"{name}: {os.path.getsize(path)} bytes, {Image.open(path).size}")
    # Safe-zone self-check: doc must fit the maskable 80% circle.
    doc_w = (22.5 - 9.7) * 512 / 32
    doc_h = (24.8 - 7.5) * 512 / 32
    half_diag = ((doc_w / 2) ** 2 + (doc_h / 2) ** 2) ** 0.5
    print(f"maskable safe zone: doc half-diagonal {half_diag:.0f}px <= {512 * 0.4:.0f}px radius: {half_diag <= 512 * 0.4}")


if __name__ == "__main__":
    main()
