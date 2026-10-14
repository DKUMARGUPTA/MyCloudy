#!/usr/bin/env python3
"""P3.14 OCR PDF — build QA fixtures (image-only "scanned" pages).

Outputs (into download/):
  qa-ocr-scan.pdf    2 pages, image-only: English page + Hindi page
                     (properly shaped via raqm + Noto Sans Devanagari).
  qa-ocr-en.jpg      the English page raster (for the mixed fixture)
  qa-ocr-mixed.pdf   is assembled by scripts/make-ocr-mixed.ts (bun):
                     page 1 = real text, page 2 = image-only.

Run: python3 scripts/make-ocr-fixture.py
"""
from PIL import Image, ImageDraw, ImageFont

DPI = 150
W, H = 1240, 1754  # A4 @ 150 DPI

DEVA = "/home/z/my-project/public/fonts/NotoSansDevanagari-Regular.ttf"
DEJA = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJA_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

OUT = "/home/z/my-project/download"


def new_page():
    img = Image.new("RGB", (W, H), (252, 251, 248))
    return img, ImageDraw.Draw(img)


def english_page():
    img, d = new_page()
    title = ImageFont.truetype(DEJA_BOLD, 64)
    body = ImageFont.truetype(DEJA, 44)
    small = ImageFont.truetype(DEJA, 36)
    # faint scan-ish border
    d.rectangle([16, 16, W - 16, H - 16], outline=(120, 120, 120), width=3)
    d.text((90, 130), "INVOICE 2026", font=title, fill=(20, 20, 20))
    d.text((90, 250), "DocoPDF Test Document", font=body, fill=(30, 30, 30))
    d.text((90, 340), "Invoice number 4721", font=body, fill=(30, 30, 30))
    d.text((90, 430), "Total amount 9350 rupees", font=body, fill=(30, 30, 30))
    d.text((90, 520), "Customer searchable document", font=body, fill=(30, 30, 30))
    d.text((90, 700), "This scanned page has no text layer.", font=small, fill=(60, 60, 60))
    d.text((90, 760), "OCR makes every word findable again.", font=small, fill=(60, 60, 60))
    return img


def hindi_page():
    img, d = new_page()
    title = ImageFont.truetype(DEVA, 60)
    body = ImageFont.truetype(DEVA, 44)
    d.rectangle([16, 16, W - 16, H - 16], outline=(120, 120, 120), width=3)
    d.text((90, 130), "खोजने योग्य दस्तावेज़", font=title, fill=(20, 20, 20),
           language="hi", direction="ltr")
    d.text((90, 280), "नमस्ते दुनिया", font=body, fill=(30, 30, 30),
           language="hi", direction="ltr")
    d.text((90, 380), "यह एक हिंदी पृष्ठ है", font=body, fill=(30, 30, 30),
           language="hi", direction="ltr")
    d.text((90, 480), "बिजली का बिल भुगतान", font=body, fill=(30, 30, 30),
           language="hi", direction="ltr")
    d.text((90, 580), "कुल राशि पाँच सौ रुपये", font=body, fill=(30, 30, 30),
           language="hi", direction="ltr")
    d.text((90, 680), "पेज क्रमांक दो", font=body, fill=(30, 30, 30),
           language="hi", direction="ltr")
    return img


def main():
    en = english_page()
    hi = hindi_page()

    # Image-only 2-page "scan" (JPEG-in-PDF, no text layer).
    en.save(f"{OUT}/qa-ocr-scan.pdf", "PDF", save_all=True, append_images=[hi],
            resolution=DPI, quality=88)
    # English raster for the mixed fixture.
    en.save(f"{OUT}/qa-ocr-en.jpg", "JPEG", quality=88)
    print("wrote download/qa-ocr-scan.pdf (2 image-only pages), download/qa-ocr-en.jpg")


if __name__ == "__main__":
    main()
