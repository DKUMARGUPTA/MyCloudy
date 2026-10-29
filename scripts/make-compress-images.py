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

# 4) Grayscale PNG 600x400 (P6-r): FlateDecode DeviceGray 8bpc.
gray = Image.new("L", (600, 400))
dg = ImageDraw.Draw(gray)
for y in range(400):
    for x in range(0, 600, 3):
        v = ((x * 3 + y * 2) // 7) & 0xFF
        for dx in range(3):
            if x + dx < 600:
                dg.point((x + dx, y), fill=v)
dg.rectangle([80, 60, 520, 120], fill=24)
dg.ellipse([200, 160, 400, 340], fill=230)
gray.save("download/qa-p312-gray.png", "PNG")

# 5) LZW strip 64x64 (P6-r): PIL writes an LZW TIFF; extract the raw
#    strip bytes — TIFF LZW == PDF LZWDecode with EarlyChange 1.
lw = Image.new("L", (64, 64))
for y in range(64):
    for x in range(64):
        lw.putpixel((x, y), (x * 4 + y) & 0xFF)
lw.save("download/qa-p312-lzw.tiff", "TIFF", compression="tiff_lzw")
with open("download/qa-p312-lzw.tiff", "rb") as f:
    tiff = f.read()
# First StripOffsets + StripByteCounts IFD entries (little-endian TIFF:
# tag 273 = 0x1101, tag 279 = 0x1117). Parse the minimal IFD.
import struct
bo = "<" if tiff[:2] == b"II" else ">"
ifd_at = struct.unpack(bo + "I", tiff[4:8])[0]
count = struct.unpack(bo + "H", tiff[ifd_at:ifd_at + 2])[0]
strip_offset = None
strip_len = None
for i in range(count):
    e = ifd_at + 2 + i * 12
    tag, typ, n = struct.unpack(bo + "HHI", tiff[e:e + 8])
    val = struct.unpack(bo + "I", tiff[e + 8:e + 12])[0]
    if tag == 273:
        strip_offset = val
    elif tag == 279:
        strip_len = val
assert strip_offset is not None and strip_len is not None, "no strip found"
with open("download/qa-p312-lzw.bin", "wb") as f:
    f.write(tiff[strip_offset:strip_offset + strip_len])

# 6) CMYK JPEG 320x200 (P6-r): Adobe-marker CMYK DCT — the strategy the
#    browser decodes natively (both engines' stream decoders must refuse).
cmyk = Image.new("CMYK", (320, 200))
dc = ImageDraw.Draw(cmyk)
for y in range(200):
    for x in range(0, 320, 2):
        c = (x * 100) // 320
        m = (y * 100) // 200
        for dx in range(2):
            dc.point((x + dx, y), fill=(c, m, 100 - c, 10))
dc.rectangle([60, 40, 260, 160], fill=(0, 0, 0, 80))
cmyk.save("download/qa-p312-cmyk.jpg", "JPEG", quality=92)

print(
    "wrote download/qa-p312-photo.jpg, qa-p312-flat.png, qa-p312-alpha.png, "
    "qa-p312-gray.png, qa-p312-lzw.bin, qa-p312-cmyk.jpg"
)
