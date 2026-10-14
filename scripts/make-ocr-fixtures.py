#!/usr/bin/env python3
"""Build OCR QA fixtures (P4.4): image-only "scanned" pages rendered by PIL.

Outputs (300 DPI A4 PNGs, raqm-shaped Devanagari from the self-hosted Noto):
  download/qa-ocr-scan-eng.png  — invoice-style English page
  download/qa-ocr-scan-hin.png  — simple Hindi (Devanagari) page
"""
from PIL import Image, ImageDraw, ImageFont

W, H = 2480, 3508  # A4 @ 300 DPI
FONT = "public/fonts/NotoSansDevanagari-Regular.ttf"


def page() -> Image.Image:
    img = Image.new("RGB", (W, H), "#f7f5f2")  # slightly warm scanner paper
    draw = ImageDraw.Draw(img)
    # subtle scan artifacts: a faint gray edge strip
    draw.rectangle([0, 0, W, 26], fill="#e8e4de")
    draw.rectangle([0, H - 26, W, H], fill="#e8e4de")
    return img


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


# ---------------- English invoice ----------------
img = page()
d = ImageDraw.Draw(img)
d.text((180, 220), "INVOICE #2026-789", font=font(110), fill="#1a1a1a")
d.text((180, 400), "Date: 12 October 2026", font=font(64), fill="#333333")
d.text((180, 500), "Bill To: DocoPDF Customer", font=font(64), fill="#333333")
d.line([(180, 650), (W - 180, 650)], fill="#999999", width=4)
rows = [
    ("Widget Pro", "2", "599.00"),
    ("Gadget Lite", "1", "249.50"),
    ("Super Cable", "3", "99.00"),
]
y = 740
for item, qty, price in rows:
    d.text((180, y), item, font=font(72), fill="#222222")
    d.text((1500, y), qty, font=font(72), fill="#222222")
    d.text((1900, y), price, font=font(72), fill="#222222")
    y += 150
d.line([(180, y + 40), (W - 180, y + 40)], fill="#999999", width=4)
d.text((180, y + 130), "TOTAL: 1645.50", font=font(96), fill="#111111")
d.text((180, y + 300), "Thank you for your business!", font=font(64), fill="#444444")
img.save("download/qa-ocr-scan-eng.png", optimize=True)
print("eng png:", img.size)

# ---------------- Hindi page ----------------
img = page()
d = ImageDraw.Draw(img)
d.text((180, 260), "नमस्ते दुनिया", font=font(130), fill="#1a1a1a")
d.text((180, 560), "भारत एक महान देश है।", font=font(84), fill="#333333")
d.text((180, 720), "कार्यालय: नई दिल्ली, भारत", font=font(84), fill="#333333")
d.text((180, 880), "फ़ोन नंबर: ९८७६५ ४३२१०", font=font(84), fill="#333333")
d.text((180, 1040), "यह एक स्कैन किया हुआ पृष्ठ है।", font=font(84), fill="#333333")
d.line([(180, 1250), (W - 180, 1250)], fill="#999999", width=4)
d.text((180, 1330), "Email: namaste@example.in", font=font(64), fill="#444444")
d.text((180, 1440), "Website: www.example.in", font=font(64), fill="#444444")
img.save("download/qa-ocr-scan-hin.png", optimize=True)
print("hin png:", img.size)
