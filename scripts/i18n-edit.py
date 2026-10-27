#!/usr/bin/env python3
"""Merge the edit.* namespace (Edit PDF editor, P4.8) into en/hi i18n JSON.

Keys are ADDED/UPDATED in place; key-count parity is verified at the end.
Run: python3 scripts/i18n-edit.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

EN = {
    "toolbarLabel": "Editor tools",
    "toolbarSelect": "Select",
    "toolbarText": "Text",
    "toolbarShape": "Shape",
    "toolbarDraw": "Draw",
    "toolbarEraser": "Eraser",
    "toolbarWhiteout": "Whiteout",
    "toolbarImage": "Image",
    "shape_rect": "Rectangle",
    "shape_ellipse": "Ellipse",
    "shape_line": "Line",
    "shape_arrow": "Arrow",
    "shape_check": "Tick mark",
    "shape_cross": "Cross",
    "penColor": "Pen color",
    "penWidthValue": "{n} pt",
    "undo": "Undo",
    "redo": "Redo",
    "zoomIn": "Zoom in",
    "zoomOut": "Zoom out",
    "fitWidth": "Fit width",
    "fitPage": "Fit page",
    "pageOf": "Page {page} of {pages}",
    "objectsOnPage": "{count, plural, =1 {1 object} other {# objects}}",
    "addBlank": "Add blank page",
    "rotatePage": "Rotate page right",
    "deletePage": "Delete page",
    "duplicatePage": "Duplicate page",
    "blankPage": "Blank",
    "thumbLabel": "Go to page {n}",
    "selectHint": "Click an object to select it — drag to move, handles to resize.",
    "typeHint": "Click on the page and type.",
    "shapeHint": "Drag on the page to draw the shape.",
    "drawHint": "Draw with the pen — the eraser removes strokes.",
    "eraserHint": "Drag over strokes to erase them.",
    "whiteoutHint": "Drag over what you want to cover.",
    "imageHint": "Use the Image button or paste an image with Ctrl+V.",
    "loadingPage": "Rendering page…",
    "opening": "Opening the document…",
    "blockedLoading": "Opening the document…",
    "renderFailed": "Couldn't render this page.",
    "canvasLabel": "PDF page canvas",
    "textEditLabel": "Text editor",
    "shortcutsLabel": "Keyboard shortcuts",
    "shortcutDel": "Del: remove",
    "shortcutNudge": "Arrows: nudge",
    "shortcutUndo": "Ctrl+Z: undo",
    "shortcutZoom": "Ctrl+wheel: zoom",
    "propsTitle": "Properties",
    "nothingSelected": "Nothing selected. Click an object to edit it, or pick a tool above to add one.",
    "pageInfoTitle": "Page {n}",
    "pageInfoSize": "{w} × {h} pt",
    "multiSelected": "{n, plural, =1 {1 object} other {# objects}} selected.",
    "fontFamily": "Font",
    "fontSans": "Sans (Helvetica)",
    "fontSerif": "Serif (Times)",
    "fontMono": "Monospace (Courier)",
    "fontDeva": "देवनागरी (Noto Sans)",
    "fontSize": "Size",
    "color": "Color",
    "bold": "Bold",
    "italic": "Italic",
    "underline": "Underline",
    "devaNoBold": "Not available for this font",
    "align_left": "Align left",
    "align_center": "Align center",
    "align_right": "Align right",
    "lineSpacing": "Line spacing",
    "lineGapValue": "{n}×",
    "background": "Background",
    "backgroundNone": "No background",
    "fill": "Fill",
    "fillNone": "No fill",
    "stroke": "Stroke",
    "strokeNone": "No stroke",
    "strokeWidth": "Thickness",
    "dashed": "Dashed",
    "whiteoutNote": "A cover box — the page underneath is untouched.",
    "imageNote": "Resize with the handles. Paste (Ctrl+V) adds more.",
    "opacity": "Opacity",
    "opacityValue": "{n}%",
    "layerFront": "Bring to front",
    "layerBack": "Send to back",
    "duplicate": "Duplicate",
    "deleteSel": "Delete",
    "imageBadType": "Only image files can be placed on the page.",
    "passwordProtected": "This PDF is password-protected",
    "passwordHint": "The editor can't open encrypted files. Use Unlock PDF first, then come back to edit.",
    "errorWire": "The edit data couldn't be read — reload the page and try again.",
    "errorFont": "A font needed for the export couldn't be loaded. Check your connection and try again.",
    "toolbarHighlight": "Highlight",
    "toolbarNote": "Note",
    "toolbarLink": "Link",
    "mark_highlight": "Highlight",
    "mark_underline": "Underline",
    "mark_strike": "Strike",
    "markKind": "Mark type",
    "markColor": "Mark color",
    "markNote": "Saved as a real PDF annotation",
    "highlightHint": "Drag across the text you want to mark.",
    "noteHint": "Click on the page to drop a sticky note.",
    "linkHint": "Drag a box, then set its target in the panel.",
    "noteColor": "Note color",
    "noteText": "Note text",
    "notePlaceholder": "Write your comment…",
    "noteOpenEditor": "Open editor",
    "noteEditLabel": "Note text",
    "noteDone": "Done",
    "linkType": "Link type",
    "linkUrlType": "Web page (URL)",
    "linkEmailType": "Email",
    "linkPageType": "Go to page",
    "linkDestPage": "Go to page number",
    "linkUrlLabel": "Web address",
    "linkEmailLabel": "Email address",
    "linkNote": "Links stay clickable in every PDF reader.",
    "commentsTitle": "Comments ({n})",
    "commentJump": "Go to comment on page {page}",
    "commentEmpty": "(empty note)",
    "commentPage": "Page {page}",
}

HI = {
    "toolbarLabel": "एडिटर टूल",
    "toolbarSelect": "चुनें",
    "toolbarText": "टेक्स्ट",
    "toolbarShape": "आकृति",
    "toolbarDraw": "बनाएँ",
    "toolbarEraser": "इरेज़र",
    "toolbarWhiteout": "व्हाइटआउट",
    "toolbarImage": "तस्वीर",
    "shape_rect": "आयत",
    "shape_ellipse": "दीर्घवृत्त",
    "shape_line": "रेखा",
    "shape_arrow": "तीर",
    "shape_check": "टिक चिह्न",
    "shape_cross": "क्रॉस",
    "penColor": "पेन का रंग",
    "penWidthValue": "{n} पॉइंट",
    "undo": "अनडू",
    "redo": "रीडू",
    "zoomIn": "ज़ूम इन",
    "zoomOut": "ज़ूम आउट",
    "fitWidth": "चौड़ाई भरें",
    "fitPage": "पेज भरें",
    "pageOf": "पेज {page} / {pages}",
    "objectsOnPage": "{count, plural, =1 {1 ऑब्जेक्ट} other {# ऑब्जेक्ट}}",
    "addBlank": "खाली पेज जोड़ें",
    "rotatePage": "पेज दाएँ घुमाएँ",
    "deletePage": "पेज मिटाएँ",
    "duplicatePage": "पेज डुप्लीकेट करें",
    "blankPage": "खाली",
    "thumbLabel": "पेज {n} पर जाएँ",
    "selectHint": "ऑब्जेक्ट पर क्लिक करके चुनें — खींचकर हिलाएँ, हैंडल से साइज़ बदलें।",
    "typeHint": "पेज पर क्लिक करके लिखें।",
    "shapeHint": "आकृति बनाने के लिए पेज पर खींचें।",
    "drawHint": "पेन से बनाएँ — इरेज़र स्ट्रोक मिटाता है।",
    "eraserHint": "स्ट्रोक पर खींचकर मिटाएँ।",
    "whiteoutHint": "जिसे ढकना है उस पर खींचें।",
    "imageHint": "तस्वीर बटन इस्तेमाल करें या Ctrl+V से पेस्ट करें।",
    "loadingPage": "पेज बन रहा है…",
    "opening": "दस्तावेज़ खुल रहा है…",
    "blockedLoading": "दस्तावेज़ खुल रहा है…",
    "renderFailed": "यह पेज नहीं बन पाया।",
    "canvasLabel": "PDF पेज कैनवास",
    "textEditLabel": "टेक्स्ट एडिटर",
    "shortcutsLabel": "कीबोर्ड शॉर्टकट",
    "shortcutDel": "Del: हटाएँ",
    "shortcutNudge": "ऐरो: खिसकाएँ",
    "shortcutUndo": "Ctrl+Z: अनडू",
    "shortcutZoom": "Ctrl+स्क्रॉल: ज़ूम",
    "propsTitle": "गुण",
    "nothingSelected": "कुछ चुना नहीं गया। एडिट करने के लिए ऑब्जेक्ट पर क्लिक करें, या ऊपर से टूल चुनकर नया जोड़ें।",
    "pageInfoTitle": "पेज {n}",
    "pageInfoSize": "{w} × {h} पॉइंट",
    "multiSelected": "{n, plural, =1 {1 ऑब्जेक्ट} other {# ऑब्जेक्ट}} चुने गए।",
    "fontFamily": "फ़ॉन्ट",
    "fontSans": "सैंस (Helvetica)",
    "fontSerif": "सेरिफ़ (Times)",
    "fontMono": "मोनोस्पेस (Courier)",
    "fontDeva": "देवनागरी (Noto Sans)",
    "fontSize": "साइज़",
    "color": "रंग",
    "bold": "बोल्ड",
    "italic": "इटैलिक",
    "underline": "अंडरलाइन",
    "devaNoBold": "इस फ़ॉन्ट के लिए उपलब्ध नहीं",
    "align_left": "बाएँ अलाइन",
    "align_center": "मध्य अलाइन",
    "align_right": "दाएँ अलाइन",
    "lineSpacing": "लाइन स्पेसिंग",
    "lineGapValue": "{n}×",
    "background": "बैकग्राउंड",
    "backgroundNone": "बैकग्राउंड नहीं",
    "fill": "भराव",
    "fillNone": "भराव नहीं",
    "stroke": "रेखा",
    "strokeNone": "रेखा नहीं",
    "strokeWidth": "मोटाई",
    "dashed": "डैश वाली",
    "whiteoutNote": "ढकने वाला बॉक्स — नीचे का पेज नहीं बदलता।",
    "imageNote": "हैंडल से साइज़ बदलें। और तस्वीरों के लिए Ctrl+V दबाएँ।",
    "opacity": "पारदर्शिता",
    "opacityValue": "{n}%",
    "layerFront": "सबसे आगे लाएँ",
    "layerBack": "सबसे पीछे भेजें",
    "duplicate": "डुप्लीकेट",
    "deleteSel": "मिटाएँ",
    "imageBadType": "पेज पर सिर्फ़ तस्वीर फ़ाइलें रखी जा सकती हैं।",
    "passwordProtected": "यह PDF पासवर्ड से सुरक्षित है",
    "passwordHint": "एडिटर एन्क्रिप्टेड फ़ाइलें नहीं खोल सकता। पहले Unlock PDF इस्तेमाल करें, फिर एडिट करने लौटें।",
    "errorWire": "एडिट डेटा पढ़ा नहीं जा सका — पेज दोबारा लोड करके कोशिश करें।",
    "errorFont": "एक्सपोर्ट के लिए ज़रूरी फ़ॉन्ट लोड नहीं हो सका। कनेक्शन जाँचकर दोबारा कोशिश करें।",
    "toolbarHighlight": "हाइलाइट",
    "toolbarNote": "नोट",
    "toolbarLink": "लिंक",
    "mark_highlight": "हाइलाइट",
    "mark_underline": "अंडरलाइन",
    "mark_strike": "स्ट्राइक",
    "markKind": "मार्क का प्रकार",
    "markColor": "मार्क का रंग",
    "markNote": "असली PDF एनोटेशन बनकर सेव होता है",
    "highlightHint": "जिस टेक्स्ट को मार्क करना है उस पर ड्रैग करें।",
    "noteHint": "पेज पर क्लिक करके स्टिकी नोट रखें।",
    "linkHint": "बॉक्स खींचें, फिर पैनल में लक्ष्य तय करें।",
    "noteColor": "नोट का रंग",
    "noteText": "नोट का टेक्स्ट",
    "notePlaceholder": "अपनी टिप्पणी लिखें…",
    "noteOpenEditor": "एडिटर खोलें",
    "noteEditLabel": "नोट का टेक्स्ट",
    "noteDone": "हो गया",
    "linkType": "लिंक का प्रकार",
    "linkUrlType": "वेब पेज (URL)",
    "linkEmailType": "ईमेल",
    "linkPageType": "पेज पर जाएँ",
    "linkDestPage": "इस नंबर के पेज पर जाएँ",
    "linkUrlLabel": "वेब पता",
    "linkEmailLabel": "ईमेल पता",
    "linkNote": "लिंक हर PDF रीडर में क्लिक करने योग्य रहते हैं।",
    "commentsTitle": "टिप्पणियाँ ({n})",
    "commentJump": "पेज {page} की टिप्पणी पर जाएँ",
    "commentEmpty": "(खाली नोट)",
    "commentPage": "पेज {page}",
}


def count_keys(node):
    total = 0
    for value in node.values():
        if isinstance(value, dict):
            total += count_keys(value)
        else:
            total += 1
    return total


def merge(locale: str, strings: dict) -> int:
    path = ROOT / "src" / "i18n" / f"{locale}.json"
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    before = count_keys(data)
    data.setdefault("edit", {})
    added = 0
    for key, value in strings.items():
        if data["edit"].get(key) != value:
            data["edit"][key] = value
            added += 1
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    after = count_keys(data)
    print(f"{locale}: {before} -> {after} keys (edited {added})")
    return after


def main() -> int:
    en_total = merge("en", EN)
    hi_total = merge("hi", HI)
    if en_total != hi_total:
        print(f"PARITY MISMATCH: en={en_total} hi={hi_total}")
        return 1
    print(f"parity OK: {en_total} = {hi_total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
