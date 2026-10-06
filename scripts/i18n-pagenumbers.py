#!/usr/bin/env python3
"""Merge pn.* + hf.* keys (Page numbers + Header & footer tools) into en/hi i18n."""
import json
import sys

EN = {
    # ---- page numbers tool ----
    "pn": {
        "previewTitle": "Live preview — page numbers",
        "formatTitle": "Number",
        "format": "Number format",
        "formatPlain": "1  (plain)",
        "formatPage": "Page 1",
        "formatSlash": "1/10",
        "formatPageOf": "Page 1 of 10",
        "formatRomanL": "i, ii, iii  (roman)",
        "formatRomanU": "I, II, III  (roman)",
        "formatAlphaL": "a, b, c  (letters)",
        "formatAlphaU": "A, B, C  (letters)",
        "sample": "Looks like",
        "start": "Start at number",
        "startHint": "The first numbered page shows this value.",
        "startUp": "Increase start number",
        "startDown": "Decrease start number",
        "hindiDigits": "Hindi digits",
        "hindiHint": "Show ०१२३ instead of 0123 — the font is embedded in the PDF.",
        "hindiOn": "Devanagari font gets embedded in your PDF (subset only).",
        "hindiRomanOff": "Hindi digits apply to the four number formats, not to roman or letter numbering.",
        "fontForced": "Hindi digits always render with the embedded Devanagari font.",
        "styleTitle": "Style",
        "chipFormat": "{sample}",
        "chipHindi": "Hindi digits",
        "ctaNoPages": "No pages selected — check the pages option.",
        "errorNoPages": "No pages selected — check the pages option.",
        "errorFont": "The Hindi font could not be loaded. Retry, or turn Hindi digits off."
    },
    # ---- header & footer tool ----
    "hf": {
        "previewTitle": "Live preview — header & footer",
        "varsTitle": "Variables",
        "varPage": "page no.",
        "varPages": "total pages",
        "varDate": "date",
        "varFilename": "file name",
        "varTitle": "PDF title",
        "varsHint": "Works in every field below, on every page.",
        "headerTitle": "Header",
        "footerTitle": "Footer",
        "left": "Left",
        "center": "Center",
        "right": "Right",
        "phLeft": "Left text…",
        "phCenter": "Center text…",
        "phRight": "Right text…",
        "margin": "Distance from edge",
        "dateFormat": "Date format",
        "dmy": "DD/MM/YYYY",
        "mdy": "MM/DD/YYYY",
        "ymd": "YYYY-MM-DD",
        "dateHint": "Only used when {date} appears in a field.",
        "fontHint": "Hindi text automatically switches to the embedded Devanagari font.",
        "chipHeader": "Header on",
        "chipFooter": "Footer on",
        "ctaEmpty": "Type something in at least one header or footer field first."
    }
}

HI = {
    "pn": {
        "previewTitle": "लाइव प्रीव्यू — पेज नंबर",
        "formatTitle": "नंबर",
        "format": "नंबर फ़ॉर्मैट",
        "formatPlain": "1  (सादा)",
        "formatPage": "Page 1",
        "formatSlash": "1/10",
        "formatPageOf": "Page 1 of 10",
        "formatRomanL": "i, ii, iii  (रोमन)",
        "formatRomanU": "I, II, III  (रोमन)",
        "formatAlphaL": "a, b, c  (अक्षर)",
        "formatAlphaU": "A, B, C  (अक्षर)",
        "sample": "ऐसा दिखेगा",
        "start": "इस नंबर से शुरू",
        "startHint": "पहला नंबर वाला पेज यही मान दिखाता है।",
        "startUp": "स्टार्ट नंबर बढ़ाएँ",
        "startDown": "स्टार्ट नंबर घटाएँ",
        "hindiDigits": "हिंदी अंक",
        "hindiHint": "0123 की जगह ०१२३ — फ़ॉन्ट PDF में ही जुड़ जाता है।",
        "hindiOn": "देवनागरी फ़ॉन्ट आपकी PDF में जुड़ जाता है (सिर्फ़ ज़रूरी ग्लिफ़)।",
        "hindiRomanOff": "हिंदी अंक चार नंबर फ़ॉर्मैट पर लागू होते हैं, रोमन या अक्षर वाले पर नहीं।",
        "fontForced": "हिंदी अंक हमेशा एम्बेडेड देवनागरी फ़ॉन्ट से बनते हैं।",
        "styleTitle": "स्टाइल",
        "chipFormat": "{sample}",
        "chipHindi": "हिंदी अंक",
        "ctaNoPages": "कोई पेज चुना नहीं गया — पेज विकल्प जाँचें।",
        "errorNoPages": "कोई पेज चुना नहीं गया — पेज विकल्प जाँचें।",
        "errorFont": "हिंदी फ़ॉन्ट लोड नहीं हो सका। फिर कोशिश करें, या हिंदी अंक बंद कर दें।"
    },
    "hf": {
        "previewTitle": "लाइव प्रीव्यू — हेडर-फुटर",
        "varsTitle": "वेरिएबल",
        "varPage": "पेज नं.",
        "varPages": "कुल पेज",
        "varDate": "तारीख़",
        "varFilename": "फ़ाइल का नाम",
        "varTitle": "PDF टाइटल",
        "varsHint": "नीचे हर फ़ील्ड में, हर पेज पर चलता है।",
        "headerTitle": "हेडर",
        "footerTitle": "फुटर",
        "left": "बाएँ",
        "center": "बीच",
        "right": "दाएँ",
        "phLeft": "बायाँ टेक्स्ट…",
        "phCenter": "मध्य टेक्स्ट…",
        "phRight": "दायाँ टेक्स्ट…",
        "margin": "किनारे से दूरी",
        "dateFormat": "तारीख़ फ़ॉर्मैट",
        "dmy": "DD/MM/YYYY",
        "mdy": "MM/DD/YYYY",
        "ymd": "YYYY-MM-DD",
        "dateHint": "सिर्फ़ तब जब किसी फ़ील्ड में {date} हो।",
        "fontHint": "हिंदी टेक्स्ट अपने आप एम्बेडेड देवनागरी फ़ॉन्ट से बनता है।",
        "chipHeader": "हेडर चालू",
        "chipFooter": "फुटर चालू",
        "ctaEmpty": "पहले हेडर या फुटर की किसी एक जगह में कुछ लिखें।"
    }
}


def merge(path: str, extra: dict, errors: dict) -> None:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    for top, values in extra.items():
        data.setdefault(top, {})
        for key, value in values.items():
            data[top][key] = value
    for key, value in errors.items():
        data["tool"][key] = value
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"merged {path}: pn={len(extra['pn'])} hf={len(extra['hf'])} errors={len(errors)}")


EN_ERRORS = {
    "errorPageNoPages": "No pages selected — check the pages option.",
    "errorPageFont": "The Hindi font could not be loaded. Retry, or turn Hindi digits off.",
}
HI_ERRORS = {
    "errorPageNoPages": "कोई पेज चुना नहीं गया — पेज विकल्प जाँचें।",
    "errorPageFont": "हिंदी फ़ॉन्ट लोड नहीं हो सका। फिर कोशिश करें, या हिंदी अंक बंद कर दें।",
}

merge("src/i18n/en.json", EN, EN_ERRORS)
merge("src/i18n/hi.json", HI, HI_ERRORS)
print("done")
