#!/usr/bin/env python3
"""Merge scan-pdf tool i18n keys into en.json + hi.json (P3.17)."""
import json

EN_SCAN = {
  "surfaceLabel": "Scan to PDF workspace",
  "heroTitle": "Scan with your camera",
  "heroDesc": "Point at any document — the page is detected, straightened and cleaned up into a multi-page PDF, all on this device.",
  "openCamera": "Open camera",
  "openCameraLabel": "Open the camera to scan more pages",
  "cameraUnavailable": "This browser has no camera access here — add photos from the gallery instead, they get the same treatment.",
  "galleryTitle": "or from your gallery",
  "dropImages": "Add photos to scan",
  "addMore": "Add more photos",
  "pageCount": "{count, plural, =1 {1 page} other {# pages}}",
  "autoCount": "{count, plural, =1 {1 auto-detected} other {# auto-detected}}",
  "filteredCount": "{count, plural, =1 {1 filtered} other {# filtered}}",
  "scanMore": "Scan more",
  "rotateAllLeft": "Rotate all pages left",
  "rotateAllRight": "Rotate all pages right",
  "hint": "Tap a page to fix corners, change its filter or rotate it. Drag cards to reorder — the preview is exactly what the PDF will contain.",
  "ctaNoPages": "Capture or add at least one photo first.",
  "capturedToast": "{count, plural, =1 {1 page captured} other {# pages captured}}",
  "cardPreviewLabel": "Preview of scanned page {index}",
  "cardPosition": "Page {index} of {total}",
  "autoBadge": "Auto-detected",
  "editLabel": "Edit corners of {name}",
  "rotateLeftLabel": "Rotate {name} left",
  "rotateRightLabel": "Rotate {name} right",
  "moveEarlierLabel": "Move {name} earlier",
  "moveLaterLabel": "Move {name} later",
  "removeLabel": "Remove {name}",
  "dragLabel": "Drag to reorder {name}",
  "filter": {
    "original": "Original",
    "magic": "Magic color",
    "bw": "B&W",
    "gray": "Grayscale",
  },
  "editTitle": "Edit page {index}",
  "editDesc": "Drag the corner handles onto the document corners — the right side shows the final page live.",
  "editHint": "Drag the circles to the document corners. Keyboard: focus a handle, then arrow keys to nudge (hold Shift for bigger steps).",
  "corner": {
    "tl": "Top-left corner",
    "tr": "Top-right corner",
    "br": "Bottom-right corner",
    "bl": "Bottom-left corner",
  },
  "autoDetect": "Auto detect",
  "resetCorners": "Reset corners",
  "previewLabel": "Final page preview",
  "previewAria": "Live preview of the corrected page",
  "filterTitle": "Filter",
  "sourceAlt": "Original photo with adjustable corners",
  "editDone": "Done",
  "cameraTitle": "Camera scan",
  "closeCamera": "Close camera",
  "cameraFeed": "Live camera feed",
  "shotsCount": "{count, plural, =1 {1 shot} other {# shots}}",
  "shotAlt": "Captured shot {index}",
  "removeShot": "Remove shot {index}",
  "capture": "Capture page",
  "doneShots": "Add to scan",
  "limitReached": "Page limit reached (30) — finish this scan and start another.",
  "retry": "Try again",
  "errDenied": "Camera permission was denied",
  "errDeniedHint": "Allow camera access in your browser's site settings, then try again. The gallery picker below the camera always works too.",
  "errNotFound": "No camera found on this device",
  "errUnsupported": "This browser cannot open a camera here",
  "torch": "Toggle torch",
  "detected": "Page detected",
  "searching": "Looking for the page…",
  "how1": "Open the camera (or add photos) and capture each page — a live overlay tracks the document.",
  "how2": "Adjust corners if needed and pick a filter: Original, Magic color, B&W or Grayscale — the preview is the final page.",
  "how3": "Create the PDF on your device — download it, share it, or continue with Compress, Lock or Sign.",
}

HI_SCAN = {
  "surfaceLabel": "स्कैन टू PDF वर्कस्पेस",
  "heroTitle": "कैमरे से स्कैन करें",
  "heroDesc": "किसी भी दस्तावेज़ की तरफ़ कैमरा घुमाइए — पेज पहचाना जाता है, सीधा और साफ़ करके मल्टी-पेज PDF बनती है, सब इसी डिवाइस पर।",
  "openCamera": "कैमरा खोलें",
  "openCameraLabel": "और पेज स्कैन करने के लिए कैमरा खोलें",
  "cameraUnavailable": "इस ब्राउज़र में यहाँ कैमरा नहीं मिलता — गैलरी से तस्वीरें जोड़ें, उन पर भी वही सुविधा मिलती है।",
  "galleryTitle": "या गैलरी से",
  "dropImages": "स्कैन के लिए तस्वीरें जोड़ें",
  "addMore": "और तस्वीरें जोड़ें",
  "pageCount": "{count, plural, =1 {1 पेज} other {# पेज}}",
  "autoCount": "{count, plural, =1 {1 ऑटो-पहचान} other {# ऑटो-पहचान}}",
  "filteredCount": "{count, plural, =1 {1 फ़िल्टर लागू} other {# फ़िल्टर लागू}}",
  "scanMore": "और स्कैन करें",
  "rotateAllLeft": "सभी पेज बाएँ घुमाएँ",
  "rotateAllRight": "सभी पेज दाएँ घुमाएँ",
  "hint": "कोने ठीक करने, फ़िल्टर बदलने या घुमाने के लिए पेज पर टैप करें। क्रम बदलने के लिए कार्ड खींचें — यही प्रीव्यू PDF में आएगा।",
  "ctaNoPages": "पहले कम से कम एक तस्वीर कैप्चर या जोड़ें।",
  "capturedToast": "{count, plural, =1 {1 पेज कैप्चर हुआ} other {# पेज कैप्चर हुए}}",
  "cardPreviewLabel": "स्कैन पेज {index} का प्रीव्यू",
  "cardPosition": "{total} में से पेज {index}",
  "autoBadge": "ऑटो-पहचान",
  "editLabel": "{name} के कोने एडिट करें",
  "rotateLeftLabel": "{name} बाएँ घुमाएँ",
  "rotateRightLabel": "{name} दाएँ घुमाएँ",
  "moveEarlierLabel": "{name} पहले लाएँ",
  "moveLaterLabel": "{name} बाद में ले जाएँ",
  "removeLabel": "{name} हटाएँ",
  "dragLabel": "क्रम बदलने के लिए {name} खींचें",
  "filter": {
    "original": "ओरिजिनल",
    "magic": "मैजिक कलर",
    "bw": "B&W",
    "gray": "ग्रेस्केल",
  },
  "editTitle": "पेज {index} एडिट करें",
  "editDesc": "कोने वाले हैंडल को दस्तावेज़ के कोनों तक खींचें — दाईं तरफ़ असली पेज लाइव दिखता है।",
  "editHint": "गोलों को दस्तावेज़ के कोनों पर खींचें। कीबोर्ड: हैंडल पर फ़ोकस करके तीर कुंजियों से खिसकाएँ (Shift से बड़े कदम)।",
  "corner": {
    "tl": "ऊपर-बायाँ कोना",
    "tr": "ऊपर-दायाँ कोना",
    "br": "नीचे-दायाँ कोना",
    "bl": "नीचे-बायाँ कोना",
  },
  "autoDetect": "ऑटो पहचान",
  "resetCorners": "कोने रीसेट करें",
  "previewLabel": "अंतिम पेज प्रीव्यू",
  "previewAria": "सुधारे हुए पेज का लाइव प्रीव्यू",
  "filterTitle": "फ़िल्टर",
  "sourceAlt": "मूल तस्वीर, एडिट करने योग्य कोनों के साथ",
  "editDone": "हो गया",
  "cameraTitle": "कैमरा स्कैन",
  "closeCamera": "कैमरा बंद करें",
  "cameraFeed": "लाइव कैमरा फ़ीड",
  "shotsCount": "{count, plural, =1 {1 शॉट} other {# शॉट}}",
  "shotAlt": "कैप्चर किया गया शॉट {index}",
  "removeShot": "शॉट {index} हटाएँ",
  "capture": "पेज कैप्चर करें",
  "doneShots": "स्कैन में जोड़ें",
  "limitReached": "पेज की सीमा (30) पूरी हो गई — यह स्कैन पूरा करके नया शुरू करें।",
  "retry": "दोबारा कोशिश करें",
  "errDenied": "कैमरे की अनुमति नहीं मिली",
  "errDeniedHint": "ब्राउज़र की साइट सेटिंग में कैमरा अनुमति देकर दोबारा कोशिश करें। कैमरे के नीचे वाला गैलरी विकल्प हमेशा काम करता है।",
  "errNotFound": "इस डिवाइस पर कोई कैमरा नहीं मिला",
  "errUnsupported": "यह ब्राउज़र यहाँ कैमरा नहीं खोल सकता",
  "torch": "टॉर्च चालू/बंद करें",
  "detected": "पेज पहचान लिया",
  "searching": "पेज खोजा जा रहा है…",
  "how1": "कैमरा खोलें (या तस्वीरें जोड़ें) और हर पेज कैप्चर करें — लाइव ओवरले दस्तावेज़ को ट्रैक करता है।",
  "how2": "ज़रूरत हो तो कोने ठीक करें और फ़िल्टर चुनें: Original, Magic color, B&W या Grayscale — प्रीव्यू ही असली पेज है।",
  "how3": "PDF आपके डिवाइस पर बनती है — डाउनलोड करें, शेयर करें, या Compress, Lock, Sign से आगे बढ़ें।",
}

EN_TOOL_ERRORS = {
  "errorNoPages": "No pages to scan — capture or add at least one photo.",
  "errorUnsupported": "{detail} is not a photo this tool can read.",
  "errorDecode": "{detail} could not be decoded.",
  "errorEncode": "The scan could not be rendered.",
}

HI_TOOL_ERRORS = {
  "errorNoPages": "स्कैन के लिए कोई पेज नहीं — कम से कम एक तस्वीर कैप्चर या जोड़ें।",
  "errorUnsupported": "{detail} इस टूल की पढ़ने लायक तस्वीर नहीं है।",
  "errorDecode": "{detail} डिकोड नहीं हो सकी।",
  "errorEncode": "स्कैन रेंडर नहीं हो सका।",
}

for path, scan, errs in (
    ("src/i18n/en.json", EN_SCAN, EN_TOOL_ERRORS),
    ("src/i18n/hi.json", HI_SCAN, HI_TOOL_ERRORS),
):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if "scan" in data:
        raise SystemExit(f"{path} already has a scan section — refusing to overwrite")
    data["scan"] = scan
    tool = data["tool"]
    for key, value in errs.items():
        if key in tool:
            raise SystemExit(f"{path} already has tool.{key}")
        tool[key] = value
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"{path}: scan ({len(scan)} top-level + nested) + tool errors ({len(errs)}) merged")

print("done")
