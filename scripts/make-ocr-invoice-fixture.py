#!/usr/bin/env python3
"""R5-c OCR → invoice E2E fixture: a clean "scanned invoice" PNG.

A single A4 @150dpi image with labelled invoice fields (number, dates,
vendor, line items with qty × rate, totals with ₹) rendered in large
clean type so tesseract recognizes them reliably. Output:
public/qa/audit5-ocr-invoice.png
"""
from PIL import Image, ImageDraw, ImageFont

DPI = 150
W, H = 1240, 1754  # A4 @ 150 DPI

DEJA = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJA_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
OUT = "/home/z/my-project/public/qa/audit5-ocr-invoice.png"


def main():
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(DEJA_BOLD, 56)
    head = ImageFont.truetype(DEJA_BOLD, 44)
    body = ImageFont.truetype(DEJA, 38)

    y = 90
    d.text((90, y), "TAX INVOICE", font=big, fill=(20, 20, 20)); y += 110
    d.text((90, y), "Sharma Electricals & Hardware", font=head, fill=(20, 20, 20)); y += 80
    d.text((90, y), "Invoice No: INV-2024-0157", font=body, fill=(30, 30, 30)); y += 64
    d.text((90, y), "Invoice Date: 12/08/2024", font=body, fill=(30, 30, 30)); y += 64
    d.text((90, y), "Due Date: 26/08/2024", font=body, fill=(30, 30, 30)); y += 64
    d.text((90, y), "Seller: Sharma Electricals Pvt Ltd", font=body, fill=(30, 30, 30)); y += 100

    d.text((90, y), "Item                        Qty   Rate    Amount", font=body, fill=(60, 60, 60)); y += 60
    items = [
        ("LED Bulb 9W", "12", "149.00", "1788.00"),
        ("Copper Wire 1.5mm 90m", "3", "689.00", "2067.00"),
        ("Switch Plate 6-gang", "8", "95.50", "764.00"),
        ("MCB 32A Double Pole", "4", "540.00", "2160.00"),
    ]
    for it in items:
        line = f"{it[0]:<26}  {it[1]:>3}  {it[2]:>7}  {it[3]:>8}"
        d.text((90, y), line, font=body, fill=(30, 30, 30)); y += 58

    y += 60
    d.text((90, y), "Subtotal: 6779.00", font=body, fill=(30, 30, 30)); y += 58
    d.text((90, y), "CGST 9%: 610.11", font=body, fill=(30, 30, 30)); y += 58
    d.text((90, y), "SGST 9%: 610.11", font=body, fill=(30, 30, 30)); y += 58
    d.text((90, y), "Total: \u20b9 7999.22", font=head, fill=(20, 20, 20)); y += 80

    img.save(OUT, "PNG")
    print("wrote", OUT, img.size)


if __name__ == "__main__":
    main()
