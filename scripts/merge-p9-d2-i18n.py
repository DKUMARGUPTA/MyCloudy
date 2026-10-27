#!/usr/bin/env python3
"""
P9 batch 1+2 i18n merge: adds how-steps for pdf-to-webp, pdf-to-tiff,
pdf-to-html, pdf-to-markdown into the shared catalogs (namespaces
pdf2webp / pdf2tiff / pdf2html / pdf2md), following the P9-B convention.
Verifies en<->hi flat-leaf parity before AND after writing, refuses to
clobber existing namespaces.
Run: python3 scripts/merge-p9-d2-i18n.py
"""
import json
import sys

ROOT = "/home/z/my-project"
SECTIONS = {
    "pdf2webp": {
        "en": {
            "how1": "Drop one or more PDFs.",
            "how2": "Pick DPI, quality and pages — the live panel shows page 1's exact pixel size.",
            "how3": "Export — every page downloads as a modern .webp (ZIP for several).",
        },
        "hi": {
            "how1": "एक या कई PDF छोड़ें।",
            "how2": "DPI, क्वालिटी और पेज चुनें — लाइव पैनल पेज 1 का सटीक पिक्सेल साइज़ दिखाता है।",
            "how3": "एक्सपोर्ट करें — हर पेज एक नई .webp के रूप में मिलता है (कई हों तो ZIP)।",
        },
    },
    "pdf2tiff": {
        "en": {
            "how1": "Drop one or more PDFs.",
            "how2": "Pick DPI (300 keeps scans faithful) and the pages you need.",
            "how3": "Export — one real multi-page .tiff per PDF, print size baked in.",
        },
        "hi": {
            "how1": "एक या कई PDF छोड़ें।",
            "how2": "DPI चुनें (300 पर स्कैन सबसे सटीक) और ज़रूरी पेज।",
            "how3": "एक्सपोर्ट करें — हर PDF की एक असली मल्टी-पेज .tiff, प्रिंट साइज़ दर्ज।",
        },
    },
    "pdf2html": {
        "en": {
            "how1": "Drop a text PDF (reports, notes, letters).",
            "how2": "Pick pages — the live panel previews the selectable text it finds.",
            "how3": "Export a self-contained .html with real headings and lists.",
        },
        "hi": {
            "how1": "टेक्स्ट PDF छोड़ें (रिपोर्ट, नोट्स, पत्र)।",
            "how2": "पेज चुनें — लाइव पैनल मिलने वाला चुनने-लायक़ टेक्स्ट दिखाता है।",
            "how3": "असली हेडिंग और लिस्ट वाली आत्मनिर्भर .html एक्सपोर्ट करें।",
        },
    },
    "pdf2md": {
        "en": {
            "how1": "Drop a text PDF (notes, docs, minutes).",
            "how2": "Pick pages and whether --- separates PDF pages.",
            "how3": "Export .md with headings, lists and flowing paragraphs.",
        },
        "hi": {
            "how1": "टेक्स्ट PDF छोड़ें (नोट्स, दस्तावेज़, मिनट)।",
            "how2": "पेज चुनें और तय करें कि --- पेजों को अलग करे या नहीं।",
            "how3": "हेडिंग, लिस्ट और बहते पैराग्राफ़ वाली .md एक्सपोर्ट करें।",
        },
    },
}


def flat(d):
    n = 0
    for v in d.values():
        if isinstance(v, dict):
            n += flat(v)
        else:
            n += 1
    return n


def main():
    with open(f"{ROOT}/src/i18n/en.json", encoding="utf-8") as f:
        en = json.load(f)
    with open(f"{ROOT}/src/i18n/hi.json", encoding="utf-8") as f:
        hi = json.load(f)

    before = (flat(en), flat(hi))
    if before[0] != before[1]:
        sys.exit(f"parity broken BEFORE merge: {before}")

    for ns, part in SECTIONS.items():
        if ns in en or ns in hi:
            sys.exit(f"namespace {ns} already exists — refusing to clobber")
        if sorted(part["en"]) != sorted(part["hi"]):
            sys.exit(f"{ns}: en/hi key sets differ")
        en[ns] = part["en"]
        hi[ns] = part["hi"]

    after = (flat(en), flat(hi))
    if after[0] != after[1]:
        sys.exit(f"parity broken AFTER merge: {after}")
    if after[0] != before[0] + 12:
        sys.exit(f"unexpected growth: {before} -> {after} (want +12)")

    for path, data in ((f"{ROOT}/src/i18n/en.json", en), (f"{ROOT}/src/i18n/hi.json", hi)):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")

    print(f"OK  {before} -> {after} (+12: pdf2webp, pdf2tiff, pdf2html, pdf2md)")


if __name__ == "__main__":
    main()
