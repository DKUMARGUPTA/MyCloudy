#!/usr/bin/env python3
"""
P9 batch 3+4 i18n merge:
  - valpdfa namespace (validate-pdfa how-steps)
  - web2pdf namespace (webpage-to-pdf: how-steps + surface UI keys)
  - result.pdfaPass / pdfaIssues / pdfaNone chips (added into the existing
    "result" section, key-by-key, no clobber)
Verifies en<->hi flat-leaf parity before AND after.
Run: python3 scripts/merge-p9-d4-i18n.py
"""
import json
import sys

ROOT = "/home/z/my-project"

VALPDFA = {
    "en": {
        "how1": "Drop one PDF.",
        "how2": "Run the check — seven structural rules run on your device.",
        "how3": "Read the verdict chip, download the full report.",
    },
    "hi": {
        "how1": "एक PDF छोड़ें।",
        "how2": "जाँच चलाएँ — सात ढाँचागत नियम आपके डिवाइस पर चलते हैं।",
        "how3": "फ़ैसला चिप देखें, पूरी रिपोर्ट डाउनलोड करें।",
    },
}

WEB2PDF = {
    "en": {
        "how1": "Paste the web page address.",
        "how2": "Tap Save as PDF — Sidocs's converter prints the page.",
        "how3": "The PDF downloads with the site's name.",
        "label": "Web page address",
        "hint": "Articles, receipts, docs — any public page",
        "placeholder": "https://example.com",
        "cta": "Save as PDF",
        "fetching": "Printing…",
        "done": "{name} saved",
        "saved": "Saved {name} — {size}",
        "errUrl": "That doesn't look like a valid http(s) link.",
        "errTimeout": "The page took too long to load — try again or check the site.",
        "errGeneric": "Couldn't print this page — check the link or try again.",
        "privacy": "Server-assisted: Sidocs's own converter fetches the page for the seconds the print takes. No third party, nothing stored.",
    },
    "hi": {
        "how1": "वेब पेज का पता चिपकाएँ।",
        "how2": "Save as PDF दबाएँ — Sidocs का कन्वर्टर पेज छापता है।",
        "how3": "साइट के नाम वाली PDF डाउनलोड हो जाती है।",
        "label": "वेब पेज का पता",
        "hint": "लेख, रसीदें, दस्तावेज़ — कोई भी सार्वजनिक पेज",
        "placeholder": "https://example.com",
        "cta": "PDF में सेव करें",
        "fetching": "छाप रहे हैं…",
        "done": "{name} सेव हुई",
        "saved": "{name} सेव हुई — {size}",
        "errUrl": "यह सही http(s) लिंक नहीं लग रहा।",
        "errTimeout": "पेज लोड होने में बहुत देर लगी — दोबारा कोशिश करें या साइट जाँचें।",
        "errGeneric": "यह पेज नहीं छप सका — लिंक जाँचें या फिर कोशिश करें।",
        "privacy": "सर्वर-सहायता: छपाई के सेकंड भर के लिए Sidocs का अपना कन्वर्टर पेज लाता है। कोई तीसरा पक्ष नहीं, कुछ स्टोर नहीं।",
    },
}

RESULT_CHIPS = {
    "pdfaPass": {
        "en": "{level} — browser-visible checks all passed",
        "hi": "{level} — ब्राउज़र में दिखने वाली सभी जाँचें पास",
    },
    "pdfaIssues": {
        "en": "{level} — {n} check(s) failed",
        "hi": "{level} — {n} जाँचें फ़ेल",
    },
    "pdfaNone": {
        "en": "No PDF/A marker found",
        "hi": "PDF/A मार्कर नहीं मिला",
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

    # --- whole new namespaces (no clobber) ---
    for ns, part in (("valpdfa", VALPDFA), ("web2pdf", WEB2PDF)):
        if ns in en or ns in hi:
            sys.exit(f"namespace {ns} already exists — refusing to clobber")
        if sorted(part["en"]) != sorted(part["hi"]):
            sys.exit(f"{ns}: en/hi key sets differ")
        en[ns] = part["en"]
        hi[ns] = part["hi"]

    # --- result chips (key-by-key into existing section) ---
    if "result" not in en or "result" not in hi:
        sys.exit("result section missing — expected since P1")
    for key, pair in RESULT_CHIPS.items():
        if key in en["result"] or key in hi["result"]:
            sys.exit(f"result.{key} already exists — refusing to clobber")
        en["result"][key] = pair["en"]
        hi["result"][key] = pair["hi"]

    after = (flat(en), flat(hi))
    if after[0] != after[1]:
        sys.exit(f"parity broken AFTER merge: {after}")
    grew = after[0] - before[0]
    if grew != 3 + 14 + 3:
        sys.exit(f"unexpected growth: +{grew} (want +20)")

    for path, data in ((f"{ROOT}/src/i18n/en.json", en), (f"{ROOT}/src/i18n/hi.json", hi)):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")

    print(f"OK  {before} -> {after} (+20: valpdfa, web2pdf, result chips)")


if __name__ == "__main__":
    main()
