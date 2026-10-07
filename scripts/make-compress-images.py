"""Compress-PDF QA fixture photos (P3.12). PIL-only, no deps beyond Pillow."""
import random
from PIL import Image, ImageDraw

random.seed(312)

# 1) Big noisy photo — hard-to-compress gradient + noise, 2200x1500.
w, h = 2200, 1500
img = Image.new("RGB", (w, h))
px = img.load()
for y in range(h):
    for x in range(0, w, 4):
        r = (x * 255) // w
        g = (y * 255) // h
        b = ((x + y) * 255) // (w + h)
        for dx in range(4):
            if x + dx < w:
                n = random.randint(-14, 14)
                px[x + dx, y] = (
                    max(0, min(255, r + n)),
                    max(0, min(255, g + n)),
                    max(0, min(255, b + n)),
                )
img.save("download/qa-p312-photo.jpg", "JPEG", quality=95)

# 2) Flat RGB PNG 1400x1000 — FlateDecode RGB (chunky flat areas compress
#    well losslessly; a naive JPEG re-encode should NOT beat it → guard path).
flat = Image.new("RGB", (1400, 1000))
d = ImageDraw.Draw(flat)
d.rectangle([0, 0, 700, 500], fill=(210, 60, 40))
d.rectangle([700, 0, 1400, 500], fill=(40, 90, 200))
d.rectangle([0, 500, 700, 1000], fill=(250, 210, 60))
d.rectangle([700, 500, 1400, 1000], fill=(30, 140, 80))
d.ellipse([500, 350, 900, 750], fill=(240, 240, 240))
flat.save("download/qa-p312-flat.png", "PNG")

# 3) Alpha PNG 900x700 — Flate RGB + SMask (soft mask must survive).
alpha = Image.new("RGBA", (900, 700), (0, 0, 0, 0))
da = ImageDraw.Draw(alpha)
for i in range(9):
    x0 = 40 + i * 95
    da.ellipse(
        [x0, 180 + (i % 3) * 90, x0 + 130, 470 + (i % 3) * 90],
        fill=(200 - i * 12, 90 + i * 14, 60 + i * 18, 90 + i * 15),
    )
da.text = None  # keep it drawing-only
alpha.save("download/qa-p312-alpha.png", "PNG")

print("wrote download/qa-p312-photo.jpg, qa-p312-flat.png, qa-p312-alpha.png")
