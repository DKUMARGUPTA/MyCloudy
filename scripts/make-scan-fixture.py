#!/usr/bin/env python3
"""Scan-to-PDF QA fixture photos (P3.17). PIL-only.

1) qa-scan-photo1.jpg — A4 page shot from an angle: bright paper trapezoid
   on a dark desk, fake-perspective text bars + a stamp. Detection should
   lock onto the quad and the warp should straighten it.
2) qa-scan-photo2.jpg — straight-on page, slightly warmer paper, denser
   "text", landscape margins (still portrait page).
3) qa-scan-nodoc.jpg  — plain gradient photo with no document: the honest
   full-frame fallback (user must fix corners manually).
"""
import random
from PIL import Image, ImageDraw

random.seed(317)

OUT = "download"


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def noisy_bg(img, base=(38, 36, 40), jitter=10):
    d = img.load()
    w, h = img.size
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            n = random.randint(-jitter, jitter)
            c = (
                max(0, min(255, base[0] + n)),
                max(0, min(255, base[1] + n - 2)),
                max(0, min(255, base[2] + n + 2)),
            )
            for dy in range(2):
                for dx in range(2):
                    if x + dx < w and y + dy < h:
                        d[x + dx, y + dy] = c
    return img


def draw_document(img, quad, paper=(238, 234, 226), text=(45, 48, 52), lines=None):
    """Draws a paper quad + fake-perspective text bars (edge interpolation)."""
    d = ImageDraw.Draw(img)
    tl, tr, br, bl = quad
    d.polygon([tl, tr, br, bl], fill=paper)

    # Margins + text lines between 8%..92% of the page height.
    lines = lines or [
        (0.08, 0.12, 0.10, 0.905, 52, (30, 34, 60)),   # title (bigger, dark blue)
        (0.17, 0.21, 0.14, 0.88, text),                  # paragraph
        (0.22, 0.235, 0.14, 0.86, text),
        (0.245, 0.265, 0.14, 0.72, text),
        (0.27, 0.29, 0.14, 0.88, text),
        (0.31, 0.325, 0.14, 0.83, text),
        (0.335, 0.355, 0.14, 0.88, text),
        (0.37, 0.39, 0.14, 0.68, text),
        (0.44, 0.47, 0.10, 0.90, (120, 40, 40)),        # sub-heading (red)
        (0.50, 0.52, 0.14, 0.88, text),
        (0.525, 0.545, 0.14, 0.84, text),
        (0.55, 0.57, 0.14, 0.88, text),
        (0.575, 0.595, 0.14, 0.79, text),
        (0.60, 0.62, 0.14, 0.88, text),
        (0.625, 0.645, 0.14, 0.75, text),
        (0.70, 0.735, 0.14, 0.90, text),
        (0.745, 0.77, 0.14, 0.85, text),
        (0.775, 0.80, 0.14, 0.90, text),
        (0.80, 0.825, 0.14, 0.70, text),
        (0.83, 0.855, 0.14, 0.88, text),
    ]
    for entry in lines:
        top, bot, left, right, color = entry[0], entry[1], entry[2], entry[3], entry[4]
        # Bold title rows are thicker (extra tuple element) — same color.
        a_top = lerp(tl, bl, top)
        b_top = lerp(tr, br, top)
        a_bot = lerp(tl, bl, bot)
        b_bot = lerp(tr, br, bot)
        l0 = lerp(a_top, b_top, left)
        l1 = lerp(a_top, b_top, right)
        r0 = lerp(a_bot, b_bot, right)
        r1 = lerp(a_bot, b_bot, left)
        d.polygon([l0, l1, r0, r1], fill=color)

    # A round-ish stamp in the lower right of the page.
    sc = lerp(lerp(tl, bl, 0.78), lerp(tr, br, 0.78), 0.78)
    r = max(8, int((br[0] - bl[0]) * 0.06))
    d.ellipse([sc[0] - r, sc[1] - r, sc[0] + r, sc[1] + r], outline=(150, 60, 50), width=6)
    return img


# ---- 1) angled A4 on a dark desk -----------------------------------------
img1 = noisy_bg(Image.new("RGB", (1600, 1200)))
quad1 = [(205, 95), (1415, 160), (1465, 1045), (135, 1095)]
draw_document(img1, quad1, paper=(240, 236, 228))
img1.save(f"{OUT}/qa-scan-photo1.jpg", "JPEG", quality=92)
print("qa-scan-photo1.jpg:", img1.size, "quad:", quad1)

# ---- 2) straight-on page, warmer paper -----------------------------------
img2 = noisy_bg(Image.new("RGB", (1600, 1200)), base=(52, 50, 46), jitter=8)
quad2 = [(170, 80), (1450, 95), (1440, 1080), (160, 1065)]
draw_document(
    img2,
    quad2,
    paper=(232, 226, 210),
    text=(60, 58, 54),
)
img2.save(f"{OUT}/qa-scan-photo2.jpg", "JPEG", quality=92)
print("qa-scan-photo2.jpg:", img2.size, "quad:", quad2)

# ---- 3) no document at all (sunset gradient) ------------------------------
img3 = Image.new("RGB", (1600, 1200))
d3 = ImageDraw.Draw(img3)
for y in range(1200):
    t = y / 1200
    d3.line(
        [(0, y), (1600, y)],
        fill=(
            int(255 * (1 - t) * 0.9),
            int(160 * (1 - t) * 0.6 + 40),
            int(120 * (1 - t) * 0.4 + 30),
        ),
    )
for i in range(0, 1600, 7):
    d3.line([(i, 0), (i - 120, 1200)], fill=(0, 0, 0, 12))
img3.save(f"{OUT}/qa-scan-nodoc.jpg", "JPEG", quality=90)
print("qa-scan-nodoc.jpg:", img3.size, "no document — full-frame fallback")
