#!/usr/bin/env python3
"""Merge the OCR-group i18n sections into en.json + hi.json (P3.18).

Keys:
  tool.ocr.*   — engine/image error copy (codes posted by tools/ocr/worker.ts
                 and tools/imagegrid/worker.ts)
"""
import json

EN_OCR = {
  "errorEngine": "The OCR engine couldn't load — check your connection and try again.",
  "errorImage": "{detail} isn't an image DocoPDF can read here (JPG, PNG, WEBP or HEIC).",
}

HI_OCR = {
  "errorEngine": "OCR इंजन लोड नहीं हो सका — कनेक्शन जाँचकर दोबारा कोशिश करें।",
  "errorImage": "{detail} यहाँ पढ़ने लायक़ तस्वीर नहीं है (JPG, PNG, WEBP या HEIC)।",
}


def merge(path, ocr):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    tool = data.setdefault("tool", {})
    existing = tool.setdefault("ocr", {})
    existing.update(ocr)
    tool["ocr"] = existing
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


merge("src/i18n/en.json", EN_OCR)
merge("src/i18n/hi.json", HI_OCR)
print("merged tool.ocr into en.json + hi.json")
