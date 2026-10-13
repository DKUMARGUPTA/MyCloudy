#!/usr/bin/env python3
"""Merge the redact tool i18n keys into en.json + hi.json (P3.14)."""
import json

EN_RD = {
  "ctaNoMarks": "Mark something to redact first — search for text or draw a box",
  "previewHint": "Drag on the page to draw a box; found text appears as red boxes",
  "previewCanvas": "Page {page} preview",
  "previewLoading": "Rendering page…",
  "previewFailed": "This page could not be rendered for preview. Redaction may still work — try running it.",
  "marksCount": "Redaction boxes ready: {count}",
  "findTitle": "Find sensitive text",
  "findDeviceOnly": "this device only",
  "findHint": "Scans the document's text layer and marks every hit as a redaction box. Click a box to skip it.",
  "presetAadhaar": "Aadhaar numbers",
  "presetPan": "PAN cards",
  "presetPhone": "Phone numbers",
  "presetEmail": "Email addresses",
  "customLabel": "Your own words",
  "customPlaceholder": "One word or phrase per line — e.g. a client name",
  "findButton": "Find & mark",
  "finding": "Reading text…",
  "findNothingSelected": "Pick at least one thing to search for",
  "findError": "The text layer could not be read. You can still draw boxes manually.",
  "findSummary": "{count} matches marked on {pages} pages",
  "findNone": "No matches found",
  "findNoneScan": "This file has no selectable text — it looks like a scan. Draw boxes instead.",
  "clearFound": "Clear found boxes",
  "kindAadhaar": "Aadhaar",
  "kindPan": "PAN",
  "kindPhone": "Phone",
  "kindEmail": "Email",
  "kindText": "Custom",
  "kindManual": "Manual box",
  "matchAria": "{kind}: {label} — toggle redaction",
  "manualAria": "Redaction box — drag to move",
  "deleteBox": "Delete box",
  "resizeHandle": "Resize box",
  "selectedTitle": "Selected box",
  "propKind": "Type",
  "propText": "Text",
  "propPage": "Page",
  "propState": "Status",
  "stateWillRedact": "Will be redacted",
  "stateKept": "Kept",
  "keepThis": "Keep this",
  "redactThis": "Redact this",
  "howTitle": "How this redaction works",
  "howBody": "Pages with boxes are flattened into images — their text layer, comments and form fields never enter the output file. After saving, the tool re-checks the file and fails loudly if any hidden text survived.",
}

HI_RD = {
  "ctaNoMarks": "पहले कुछ चुनें — टेक्स्ट खोजें या बॉक्स बनाएँ",
  "previewHint": "बॉक्स बनाने के लिए पेज पर खींचें; मिला टेक्स्ट लाल बॉक्स में दिखेगा",
  "previewCanvas": "पेज {page} प्रीव्यू",
  "previewLoading": "पेज बन रहा है…",
  "previewFailed": "यह पेज प्रीव्यू के लिए नहीं बन पाया। रिडैक्शन फिर भी हो सकता है — चलाकर देखें।",
  "marksCount": "रिडैक्शन बॉक्स तैयार: {count}",
  "findTitle": "संवेदनशील टेक्स्ट खोजें",
  "findDeviceOnly": "सिर्फ़ इस डिवाइस पर",
  "findHint": "दस्तावेज़ का टेक्स्ट स्कैन होकर हर मैच रिडैक्शन बॉक्स बन जाता है। छोड़ने के लिए बॉक्स पर क्लिक करें।",
  "presetAadhaar": "आधार नंबर",
  "presetPan": "पैन कार्ड",
  "presetPhone": "फ़ोन नंबर",
  "presetEmail": "ईमेल पते",
  "customLabel": "आपके शब्द",
  "customPlaceholder": "हर लाइन में एक शब्द या वाक्यांश — जैसे किसी का नाम",
  "findButton": "खोजें और चिह्नित करें",
  "finding": "टेक्स्ट पढ़ा जा रहा है…",
  "findNothingSelected": "खोजने के लिए कम से कम एक चीज़ चुनें",
  "findError": "टेक्स्ट लेयर नहीं पढ़ी जा सकी। आप खुद बॉक्स बना सकते हैं।",
  "findSummary": "{pages} पेजों पर {count} मैच चिह्नित",
  "findNone": "कोई मैच नहीं मिला",
  "findNoneScan": "इस फ़ाइल में चुनने योग्य टेक्स्ट नहीं है — यह स्कैन जैसी लगती है। इसके बजाय बॉक्स बनाएँ।",
  "clearFound": "खोजे गए बॉक्स हटाएँ",
  "kindAadhaar": "आधार",
  "kindPan": "पैन",
  "kindPhone": "फ़ोन",
  "kindEmail": "ईमेल",
  "kindText": "कस्टम",
  "kindManual": "हाथ का बॉक्स",
  "matchAria": "{kind}: {label} — रिडैक्शन चालू/बंद करें",
  "manualAria": "रिडैक्शन बॉक्स — खिसकाने के लिए खींचें",
  "deleteBox": "बॉक्स हटाएँ",
  "resizeHandle": "बॉक्स का आकार बदलें",
  "selectedTitle": "चुना हुआ बॉक्स",
  "propKind": "प्रकार",
  "propText": "टेक्स्ट",
  "propPage": "पेज",
  "propState": "स्थिति",
  "stateWillRedact": "रिडैक्ट होगा",
  "stateKept": "रहने दिया",
  "keepThis": "इसे रहने दें",
  "redactThis": "इसे रिडैक्ट करें",
  "howTitle": "यह रिडैक्शन कैसे काम करता है",
  "howBody": "बॉक्स वाले पेज इमेज बन जाते हैं — उनका टेक्स्ट लेयर, टिप्पणियाँ और फ़ॉर्म फ़ील्ड आउटपुट फ़ाइल में आते ही नहीं। सेव करने के बाद टूल फ़ाइल दोबारा जाँचता है और कुछ भी बचा हो तो साफ़ बता देता है।",
}

EN_TOOL_EXTRA = {
  "errorRedactNoMarks": "Mark at least one redaction box first — search for text or draw one.",
  "errorRedactVerify": "The redaction could not be verified. Nothing was downloaded — please try again.",
}

HI_TOOL_EXTRA = {
  "errorRedactNoMarks": "पहले कम से कम एक रिडैक्शन बॉक्स बनाएँ — टेक्स्ट खोजें या बॉक्स खींचें।",
  "errorRedactVerify": "रिडैक्शन की पुष्टि नहीं हो पाई। कुछ भी डाउनलोड नहीं हुआ — फिर से कोशिश करें।",
}


def merge(path, redact, tool_extra, after="sign"):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    # Insert the tool section right after its neighbour for a stable order.
    rebuilt = {}
    for key, value in data.items():
        rebuilt[key] = value
        if key == after:
            rebuilt["redact"] = redact
    if "redact" not in rebuilt:
        rebuilt["redact"] = redact
    rebuilt.setdefault("tool", {}).update(tool_extra)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rebuilt, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


merge("/home/z/my-project/src/i18n/en.json", EN_RD, EN_TOOL_EXTRA)
merge("/home/z/my-project/src/i18n/hi.json", HI_RD, HI_TOOL_EXTRA)
print("merged redact sections:",
      len(EN_RD), "en keys /", len(HI_RD), "hi keys +", len(EN_TOOL_EXTRA), "tool extras")
