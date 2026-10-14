#!/usr/bin/env python3
"""Merge the lock-pdf + unlock-pdf i18n sections into en.json + hi.json (P3.15)."""
import json

EN_LOCK = {
  "ctaNeedPassword": "Set an open password first",
  "ctaShortPassword": "Password needs at least {min} characters",
  "ctaMismatch": "The two passwords don't match",
  "pwTitle": "Open password",
  "pwHint": "Whoever types this password can open the PDF — within the permissions you set below.",
  "pwLabel": "Open password",
  "pwPlaceholder": "At least 6 characters",
  "pwMin": "At least {min} characters — 12 or more is recommended.",
  "generate": "Generate a strong password",
  "pwConfirmLabel": "Confirm password",
  "pwConfirmPlaceholder": "Type it once more",
  "ownerLabel": "Owner password",
  "ownerOptional": "optional",
  "ownerPlaceholder": "Master key (leave empty to reuse the open password)",
  "ownerHint": "The owner password is a master key — whoever holds it can change or remove these restrictions later.",
  "permsTitle": "What the reader may do",
  "permsHint": "These limits apply to anyone opening the file with the open password.",
  "printFull": "Full quality",
  "printLow": "Low quality",
  "printOff": "No printing",
  "permPrint": "Printing",
  "permPrintHint": "Low quality forces draft-mode prints",
  "permCopy": "Copy text and images",
  "permCopyHint": "Blocks selecting and copying content",
  "permEdit": "Edit content",
  "permEditHint": "Blocks changing text and pages",
  "permAnnotate": "Comments and highlights",
  "permAnnotateHint": "Adding notes and mark-ups",
  "permForms": "Fill forms",
  "permFormsHint": "Typing into form fields",
  "permAccess": "Screen readers",
  "permAccessHint": "Extraction for accessibility tools",
  "permAssemble": "Rearrange pages",
  "permAssembleHint": "Insert, rotate or delete pages",
  "cipherTitle": "Encryption",
  "cipher256Hint": "AES-256 — the modern standard, supported by every current PDF reader.",
  "cipher128Hint": "AES-128 — for very old readers and kiosk printers built before 2010.",
  "noteNoRecover": "If you forget the password it cannot be recovered — not by DocoPDF, not by anyone. Save it somewhere safe before you share the file.",
  "chipPrint": "Printing: {mode}",
  "chipCopy": "Copying: {state}",
  "chipEdit": "Editing: {state}",
  "on": "allowed",
  "off": "blocked",
  "panelTitle": "What happens on Apply",
  "panelLine": "{algo} encryption is applied to every page — the content itself is not re-encoded.",
  "notePages": "Pages, text and images are unchanged — only access to them is gated by the password.",
  "noteTestOpen": "Before sharing, open the protected file once with the password to be sure it works everywhere you'll send it.",
  "errorShortPassword": "The password is too short (minimum 6 characters).",
}

HI_LOCK = {
  "ctaNeedPassword": "पहले ओपन पासवर्ड तय करें",
  "ctaShortPassword": "पासवर्ड में कम-से-कम {min} अक्षर चाहिए",
  "ctaMismatch": "दोनों पासवर्ड एक नहीं हैं",
  "pwTitle": "ओपन पासवर्ड",
  "pwHint": "यह पासवर्ड डालने वाला फ़ाइल खोल पाएगा — नीचे तय की अनुमतियों के भीतर।",
  "pwLabel": "ओपन पासवर्ड",
  "pwPlaceholder": "कम-से-कम 6 अक्षर",
  "pwMin": "कम-से-कम {min} अक्षर — 12 या ज़्यादा सबसे ठीक।",
  "generate": "मज़बूत पासवर्ड बनाएँ",
  "pwConfirmLabel": "पासवर्ड दुबारा लिखें",
  "pwConfirmPlaceholder": "एक बार और लिखें",
  "ownerLabel": "मालिक पासवर्ड",
  "ownerOptional": "ओप्शनल",
  "ownerPlaceholder": "मास्टर कुंजी (ख़ाली छोड़ें तो ओपन पासवर्ड ही)",
  "ownerHint": "मालिक पासवर्ड एक मास्टर कुंजी है — इसके पास रखने वाला बाद में ये पाबंदियाँ बदल या हटा सकता है।",
  "permsTitle": "पढ़ने वाला क्या कर सकता है",
  "permsHint": "ये सीमाएँ उस पर लागू होती हैं जो ओपन पासवर्ड से फ़ाइल खोलता है।",
  "printFull": "पूरी क्वालिटी",
  "printLow": "कम क्वालिटी",
  "printOff": "प्रिंट नहीं",
  "permPrint": "प्रिंट करना",
  "permPrintHint": "कम क्वालिटी ड्राफ़्ट-मोड प्रिंट देती है",
  "permCopy": "टेक्स्ट-तस्वीर कॉपी",
  "permCopyHint": "कंटेंट चुनकर कॉपी करना बंद",
  "permEdit": "कंटेंट बदलना",
  "permEditHint": "टेक्स्ट और पेज बदलना बंद",
  "permAnnotate": "टिप्पणी-हाइलाइट",
  "permAnnotateHint": "नोट और निशान जोड़ना",
  "permForms": "फ़ॉर्म भरना",
  "permFormsHint": "फ़ॉर्म के खानों में लिखना",
  "permAccess": "स्क्रीन रीडर",
  "permAccessHint": "अनुपलब्धता सहायक उपकरणों के लिए",
  "permAssemble": "पेज जमाना",
  "permAssembleHint": "पेज जोड़ना, घुमाना, हटाना",
  "cipherTitle": "एन्क्रिप्शन",
  "cipher256Hint": "AES-256 — आधुनिक मानक, हर नए PDF रीडर में चलता है।",
  "cipher128Hint": "AES-128 — 2010 से पहले के पुराने रीडर और कियोस्क प्रिंटर के लिए।",
  "noteNoRecover": "पासवर्ड भूल गए तो वापस नहीं मिलेगा — न DocoPDF से, न किसी से। शेयर करने से पहले कहीं सुरक्षित लिख लें।",
  "chipPrint": "प्रिंट: {mode}",
  "chipCopy": "कॉपी: {state}",
  "chipEdit": "एडिट: {state}",
  "on": "खुला",
  "off": "बंद",
  "panelTitle": "Apply पर क्या होगा",
  "panelLine": "हर पेज पर {algo} एन्क्रिप्शन लगता है — कंटेंट दोबारा एनकोड नहीं होता।",
  "notePages": "पेज, टेक्स्ट और तस्वीरें वैसी ही रहती हैं — सिर्फ़ उन तक पहुँच पासवर्ड से नियंत्रित होती है।",
  "noteTestOpen": "शेयर करने से पहले एक बार पासवर्ड डालकर फ़ाइल खोलकर देख लें कि हर जगह ठीक खुलती है।",
  "errorShortPassword": "पासवर्ड बहुत छोटा है (कम-से-कम 6 अक्षर चाहिए)।",
}

EN_UNLOCK = {
  "loading": "Reading the file's protection…",
  "lockedTitle": "This PDF needs its open password",
  "lockedHint": "Type the password you know — the file itself never leaves this device.",
  "pwLabel": "Open password",
  "pwPlaceholder": "The password you set",
  "verifying": "Checking the password…",
  "verified": "Password works — {count} pages will unlock",
  "wrong": "This password doesn't open the file",
  "policyNote": "DocoPDF only removes passwords you know, or owner restrictions. It never attempts to guess or crack an unknown password — please unlock only your own files or ones you have permission to.",
  "restrictedTitle": "Owner restrictions found",
  "restrictedHint": "This file opens without a password, but its owner limited what readers may do:",
  "restrictionsLabel": "Current restrictions",
  "restrictedRuns": "Apply removes all of these restrictions — no password is needed for this file.",
  "perm": {
    "print": "Printing",
    "copy": "Copy text and images",
    "edit": "Edit content",
    "annotate": "Comments and highlights",
    "forms": "Fill forms",
    "access": "Screen readers",
    "assemble": "Rearrange pages",
  },
  "allowed": "allowed",
  "blocked": "blocked",
  "printLow": "low quality only",
  "cleanTitle": "Nothing to unlock",
  "cleanHint": "This PDF has no password and no restrictions. If a viewer still asks for one, the file was replaced or renamed after it was shared.",
  "runsNote": "Apply decrypts the file on this device — pages, text and vectors come out identical.",
  "ctaChecking": "Reading the file's protection…",
  "ctaNeedPassword": "Type the open password first",
  "ctaVerifying": "Checking the password…",
  "ctaWrong": "This password doesn't open the file",
  "ctaNothing": "This PDF has nothing to unlock",
  "panelTitle": "What happens on Apply",
  "panelLine": "The encryption wrapper is removed — the content is decrypted, not re-created.",
  "noteIdentical": "Text stays selectable and pages stay vectors — nothing is re-scanned or converted to images.",
  "noteEngine": "The unlock engine (qpdf as WebAssembly) loads from this site only when this tool runs.",
  "errorWrongPassword": "That password doesn't open this file.",
  "errorTooLarge": "This file is too large to unlock in the browser. Try a desktop app for this one.",
}

HI_UNLOCK = {
  "loading": "फ़ाइल का सुरक्षा-हाल पढ़ा जा रहा है…",
  "lockedTitle": "इस PDF को ओपन पासवर्ड चाहिए",
  "lockedHint": "अपना पासवर्ड लिखें — फ़ाइल इस डिवाइस से बाहर नहीं जाती।",
  "pwLabel": "ओपन पासवर्ड",
  "pwPlaceholder": "आपका तय किया पासवर्ड",
  "verifying": "पासवर्ड जाँचा जा रहा है…",
  "wrong": "यह पासवर्ड फ़ाइल नहीं खोलता",
  "verified": "पासवर्ड सही है — {count} पेज अनलॉक होंगे",
  "policyNote": "DocoPDF सिर्फ़ आपके बताए पासवर्ड या मालिक पाबंदियाँ हटाता है। अनजान पासवर्ड की तोड़-फोड़ कभी नहीं करता — कृपया सिर्फ़ अपनी फ़ाइलें, या जिनकी अनुमति हो, उन्हें ही अनलॉक करें।",
  "restrictedTitle": "मालिक पाबंदियाँ मिलीं",
  "restrictedHint": "यह फ़ाइल बिना पासवर्ड खुलती है, पर उसके मालिक ने पढ़ने वालों की सीमाएँ रखी हैं:",
  "restrictionsLabel": "मौजूदा पाबंदियाँ",
  "restrictedRuns": "Apply ये सारी पाबंदियाँ हटा देता है — इस फ़ाइल के लिए पासवर्ड भी नहीं चाहिए।",
  "perm": {
    "print": "प्रिंट करना",
    "copy": "टेक्स्ट-तस्वीर कॉपी",
    "edit": "कंटेंट बदलना",
    "annotate": "टिप्पणी-हाइलाइट",
    "forms": "फ़ॉर्म भरना",
    "access": "स्क्रीन रीडर",
    "assemble": "पेज जमाना",
  },
  "allowed": "खुला",
  "blocked": "बंद",
  "printLow": "सिर्फ़ कम क्वालिटी",
  "cleanTitle": "अनलॉक करने को कुछ नहीं",
  "cleanHint": "इस PDF पर न पासवर्ड है, न पाबंदी। अगर फिर भी कोई व्यूअर पासवर्ड माँगे, तो शेयर के बाद फ़ाइल बदली गई है।",
  "runsNote": "Apply फ़ाइल को इसी डिवाइस पर डिक्रिप्ट करता है — पेज, टेक्स्ट और वेक्टर वैसे ही रहते हैं।",
  "ctaChecking": "फ़ाइल का सुरक्षा-हाल पढ़ा जा रहा है…",
  "ctaNeedPassword": "पहले ओपन पासवर्ड लिखें",
  "ctaVerifying": "पासवर्ड जाँचा जा रहा है…",
  "ctaWrong": "यह पासवर्ड फ़ाइल नहीं खोलता",
  "ctaNothing": "इस PDF में अनलॉक करने को कुछ नहीं",
  "panelTitle": "Apply पर क्या होगा",
  "panelLine": "एन्क्रिप्शन का लिफ़ाफ़ा हटता है — कंटेंट डिक्रिप्ट होता है, दोबारा नहीं बनता।",
  "noteIdentical": "टेक्स्ट चुनने योग्य और पेज वेक्टर रहते हैं — कुछ भी दोबारा स्कैन या तस्वीर नहीं बनता।",
  "noteEngine": "अनलॉक इंजन (WebAssembly में qpdf) ज़रूरत पर इसी साइट से लोड होता है।",
  "errorWrongPassword": "यह पासवर्ड इस फ़ाइल को नहीं खोलता।",
  "errorTooLarge": "यह फ़ाइल ब्राउज़र में अनलॉक होने के लिए बहुत बड़ी है। इसके लिए डेस्कटॉप ऐप आज़माएँ।",
}


def merge(path, lock, unlock):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    data.pop("lock", None)
    data.pop("unlock", None)
    # Keep the (roughly alphabetical) section order of the files.
    out = {}
    for key, value in data.items():
        if key == "merge":
            out["lock"] = lock
        elif key == "view" and "unlock" not in out:
            out["unlock"] = unlock
        out[key] = value
    if "lock" not in out:
        out["lock"] = lock
    if "unlock" not in out:
        out["unlock"] = unlock
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"{path}: lock keys={len(out['lock'])}, unlock keys={len(out['unlock'])}")


merge("src/i18n/en.json", EN_LOCK, EN_UNLOCK)
merge("src/i18n/hi.json", HI_LOCK, HI_UNLOCK)


def key_tree(node, prefix=""):
    keys = set()
    for key, value in node.items():
        full = f"{prefix}{key}"
        if isinstance(value, dict):
            keys |= key_tree(value, full + ".")
        else:
            keys.add(full)
    return keys


with open("src/i18n/en.json", encoding="utf-8") as fh:
    en = json.load(fh)
with open("src/i18n/hi.json", encoding="utf-8") as fh:
    hi = json.load(fh)
en_keys, hi_keys = key_tree(en), key_tree(hi)
print("parity:", "PERFECT" if en_keys == hi_keys else f"MISSING en-only={sorted(en_keys - hi_keys)} hi-only={sorted(hi_keys - en_keys)}")
