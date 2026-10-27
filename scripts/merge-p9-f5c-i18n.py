#!/usr/bin/env python3
"""
P9 batch 5 (orchestrator part) i18n merge:
  - veinv namespace (validate-e-invoice how-steps)
  - x2pdf namespace (xml-invoice-to-pdf: how-steps + surface keys)
  - result.einvoicePass / einvoiceIssues / einvoiceNone chips
Verifies en<->hi flat-leaf parity before AND after, refuses clobber.
Run: python3 scripts/merge-p9-f5c-i18n.py
"""
import json
import sys

ROOT = "/home/z/my-project"

VEINV = {
    "en": {
        "how1": "Drop a Factur-X/ZUGFeRD PDF or a CII/UBL XML file.",
        "how2": "Run the check — the embedded data is read on your device.",
        "how3": "Read the verdict, download the report.",
    },
    "hi": {
        "how1": "Factur-X/ZUGFeRD PDF या CII/UBL XML फ़ाइल छोड़ें।",
        "how2": "जाँच चलाएँ — जुड़ा डेटा आपके डिवाइस पर पढ़ा जाता है।",
        "how3": "फ़ैसला देखें, रिपोर्ट डाउनलोड करें।",
    },
}

X2PDF = {
    "en": {
        "how1": "Drop a UBL or CII e-invoice XML file.",
        "how2": "Review what was read — parties, items, gaps flagged honestly.",
        "how3": "Run — a clean, readable PDF downloads.",
        "dropHint": "UBL 2.1 ( cac:Invoice ) and CII / Factur-X / XRechnung XML files are both understood. The file never leaves this device.",
        "reading": "Reading the XML…",
        "errNotXml": "This file is not XML — the e-invoice data must be a text .xml file.",
        "errDialect": "The XML root is neither CrossIndustryInvoice (CII) nor Invoice (UBL) — this is not an e-invoice.",
        "errFix": "Check you exported the right file from your ERP or portal, then try again.",
        "needFile": "Drop an XML e-invoice first",
        "parsedAs": "Read as {dialect}",
        "fNo": "Invoice number",
        "fDate": "Date",
        "fCur": "Currency",
        "fSeller": "Seller",
        "fBuyer": "Buyer",
        "fItems": "Items",
        "itemCount": "{shown} of {count} lines",
        "fSub": "Subtotal",
        "fTax": "Tax",
        "fTot": "Total",
        "truncated": "Only the first {max} items print — {total} found in the XML.",
        "itemsTitle": "Line items",
        "readyNote": "Everything set — hit the run button below to print the PDF.",
    },
    "hi": {
        "how1": "UBL या CII ई-इनवॉइस XML फ़ाइल छोड़ें।",
        "how2": "देखें क्या पढ़ा गया — पक्ष, आइटम, कमियाँ ईमानदारी से।",
        "how3": "चलाएँ — साफ़, पढ़ने लायक़ PDF डाउनलोड होती है।",
        "dropHint": "UBL 2.1 ( cac:Invoice ) और CII / Factur-X / XRechnung XML दोनों समझी जाती हैं। फ़ाइल इस डिवाइस से बाहर नहीं जाती।",
        "reading": "XML पढ़ी जा रही है…",
        "errNotXml": "यह फ़ाइल XML नहीं है — ई-इनवॉइस डेटा टेक्स्ट .xml फ़ाइल में होना चाहिए।",
        "errDialect": "XML की जड़ neither CrossIndustryInvoice (CII) है न Invoice (UBL) — यह ई-इनवॉइस नहीं है।",
        "errFix": "जाँचें कि आपने ERP या पोर्टल से सही फ़ाइल निकाली है, फिर कोशिश करें।",
        "needFile": "पहले XML ई-इनवॉइस छोड़ें",
        "parsedAs": "{dialect} के रूप में पढ़ी गई",
        "fNo": "इनवॉइस नंबर",
        "fDate": "तारीख़",
        "fCur": "मुद्रा",
        "fSeller": "विक्रेता",
        "fBuyer": "ख़रीदार",
        "fItems": "आइटम",
        "itemCount": "{count} में से {shown} लाइनें",
        "fSub": "उप-योग",
        "fTax": "कर",
        "fTot": "कुल",
        "truncated": "सिर्फ़ पहले {max} आइटम छपते हैं — XML में {total} मिले।",
        "itemsTitle": "लाइन आइटम",
        "readyNote": "सब तैयार — PDF छापने के लिए नीचे रन बटन दबाएँ।",
    },
}

RESULT_CHIPS = {
    "einvoicePass": {
        "en": "{dialect} e-invoice — all core checks passed",
        "hi": "{dialect} ई-इनवॉइस — सभी मुख्य जाँचें पास",
    },
    "einvoiceIssues": {
        "en": "{dialect} e-invoice — {n} check(s) failed",
        "hi": "{dialect} ई-इनवॉइस — {n} जाँचें फ़ेल",
    },
    "einvoiceNone": {
        "en": "No e-invoice XML found",
        "hi": "ई-इनवॉइस XML नहीं मिला",
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

    for ns, part in (("veinv", VEINV), ("x2pdf", X2PDF)):
        if ns in en or ns in hi:
            sys.exit(f"namespace {ns} already exists — refusing to clobber")
        if sorted(part["en"]) != sorted(part["hi"]):
            sys.exit(f"{ns}: en/hi key sets differ")
        en[ns] = part["en"]
        hi[ns] = part["hi"]

    if "result" not in en or "result" not in hi:
        sys.exit("result section missing")
    for key, pair in RESULT_CHIPS.items():
        if key in en["result"] or key in hi["result"]:
            sys.exit(f"result.{key} already exists — refusing to clobber")
        en["result"][key] = pair["en"]
        hi["result"][key] = pair["hi"]

    after = (flat(en), flat(hi))
    if after[0] != after[1]:
        sys.exit(f"parity broken AFTER merge: {after}")
    grew = after[0] - before[0]
    want = 3 + len(X2PDF["en"]) + 3
    if grew != want:
        sys.exit(f"unexpected growth: +{grew} (want +{want})")

    for path, data in ((f"{ROOT}/src/i18n/en.json", en), (f"{ROOT}/src/i18n/hi.json", hi)):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")

    print(f"OK  {before} -> {after} (+{grew}: veinv, x2pdf, result chips)")


if __name__ == "__main__":
    main()
