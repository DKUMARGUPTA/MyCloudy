#!/usr/bin/env python3
"""Merge lock/unlock tool i18n keys into en.json + hi.json (P3.16)."""
import json

EN_LOCK = {
  "formTitle": "Set the passwords",
  "formSubtitle": "AES encryption happens on your device — nothing is sent anywhere",
  "openPw": "Open password",
  "pwPlaceholder": "Password to open the file",
  "confirmPw": "Confirm open password",
  "mismatch": "Passwords do not match",
  "pwRules": "Minimum 6 characters — 12 or more is better. Needed to open the file.",
  "recoverWarn": "If you forget the password it cannot be recovered — keep the original file or save the password somewhere safe.",
  "ownerPw": "Owner password",
  "optional": "optional",
  "ownerPlaceholder": "Full-control password (defaults to the open password)",
  "ownerHint": "Opening with the owner password unlocks full rights — changing permissions later.",
  "generate": "Generate",
  "genHint": "Suggest a strong password",
  "useThis": "Use this",
  "permsTitle": "Permissions for readers",
  "permsHint": "What someone opening with the open password may do. Enforced by well-behaved readers (Acrobat, Chrome, Preview).",
  "permPrint": "Print",
  "permCopy": "Copy text",
  "permModify": "Edit content",
  "permAnnotate": "Comment & annotate",
  "permForms": "Fill forms",
  "permAccess": "Screen readers (accessibility)",
  "algTitle": "Encryption strength",
  "alg256": "AES-256",
  "alg256Hint": "Modern standard — recommended",
  "alg128": "AES-128",
  "alg128Hint": "Only for very old readers",
  "pwTooShort": "Open password needs at least 6 characters",
  "privacyLine": "The PDF, both passwords and permissions are applied in your browser — they never leave this device.",
}

HI_LOCK = {
  "formTitle": "पासवर्ड सेट करें",
  "formSubtitle": "AES एन्क्रिप्शन आपके डिवाइस पर होता है — कुछ भी कहीं नहीं भेजा जाता",
  "openPw": "ओपन पासवर्ड",
  "pwPlaceholder": "फ़ाइल खोलने का पासवर्ड",
  "confirmPw": "ओपन पासवर्ड दोबारा",
  "mismatch": "दोनों पासवर्ड एक नहीं हैं",
  "pwRules": "कम से कम 6 अक्षर — 12 या ज़्यादा बेहतर। फ़ाइल खोलने के लिए चाहिए।",
  "recoverWarn": "पासवर्ड भूल गए तो वापस नहीं मिलेगा — ओरिजिनल फ़ाइल सुरक्षित रखें या पासवर्ड कहीं लिख लें।",
  "ownerPw": "ओनर पासवर्ड",
  "optional": "वैकल्पिक",
  "ownerPlaceholder": "पूरे अधिकार वाला पासवर्ड (ख़ाली छोड़ें तो ओपन वाला ही)",
  "ownerHint": "ओनर पासवर्ड से खोलने पर पूरे अधिकार — बाद में अनुमतियाँ बदली जा सकती हैं।",
  "generate": "बनाएँ",
  "genHint": "मज़बूत पासवर्ड सुझाएँ",
  "useThis": "यही रखें",
  "permsTitle": "पढ़ने वालों की अनुमतियाँ",
  "permsHint": "ओपन पासवर्ड से खोलने वाला क्या कर सकता है। अच्छे रीडर (Acrobat, Chrome, Preview) इन्हें मानते हैं।",
  "permPrint": "प्रिंट",
  "permCopy": "टेक्स्ट कॉपी",
  "permModify": "कंटेंट एडिट",
  "permAnnotate": "कमेंट और एनोटेट",
  "permForms": "फ़ॉर्म भरना",
  "permAccess": "स्क्रीन रीडर (एक्सेसिबिलिटी)",
  "algTitle": "एन्क्रिप्शन की मज़बूती",
  "alg256": "AES-256",
  "alg256Hint": "आधुनिक मानक — सुझाया गया",
  "alg128": "AES-128",
  "alg128Hint": "सिर्फ़ बहुत पुराने रीडर के लिए",
  "pwTooShort": "ओपन पासवर्ड में कम से कम 6 अक्षर चाहिए",
  "privacyLine": "PDF, दोनों पासवर्ड और अनुमतियाँ आपके ब्राउज़र में ही लागू होते हैं — ये कभी डिवाइस से बाहर नहीं जाते।",
}

EN_UNLOCK = {
  "checking": "Reading the file…",
  "pwTitle": "Enter the open password",
  "pwSubtitle": "The file asks for a password when opening",
  "pwPlaceholder": "Open password",
  "pwHint": "Type the password you use to open this PDF. Nothing is sent anywhere.",
  "pwAccepted": "Password looks right — ready to unlock",
  "ownerTitle": "No open password needed",
  "ownerSubtitle": "This file opens freely — restrictions will be stripped",
  "ownerBody": "This PDF opens without a password but carries owner restrictions (printing, copying or editing disabled). Leave everything as is and run — the restrictions are removed while pages, forms and content stay identical.",
  "unreadableTitle": "Could not read this file",
  "unreadableBody": "The PDF could not be opened. It may be damaged — try the Repair PDF tool first.",
  "policyTitle": "Use responsibly",
  "policyBody": "Only unlock files you own, or have permission to modify. An unknown open password cannot be removed — by anyone.",
}

HI_UNLOCK = {
  "checking": "फ़ाइल पढ़ी जा रही है…",
  "pwTitle": "ओपन पासवर्ड डालें",
  "pwSubtitle": "फ़ाइल खुलते समय पासवर्ड माँगती है",
  "pwPlaceholder": "ओपन पासवर्ड",
  "pwHint": "वही पासवर्ड डालें जिससे यह PDF खुलती है। कुछ भी कहीं नहीं भेजा जाता।",
  "pwAccepted": "पासवर्ड सही लगता है — अनलॉक के लिए तैयार",
  "ownerTitle": "ओपन पासवर्ड ज़रूरी नहीं",
  "ownerSubtitle": "यह फ़ाइल खुलकर आती है — पाबंदियाँ हटेंगी",
  "ownerBody": "यह PDF बिना पासवर्ड खुलती है पर ओनर पाबंदियाँ लिए है (प्रिंट, कॉपी या एडिट बंद)। कुछ न बदलें, सीधे चलाएँ — पाबंदियाँ हट जाती हैं, पेज, फ़ॉर्म और कंटेंट वैसे ही रहते हैं।",
  "unreadableTitle": "यह फ़ाइल नहीं खुल पाई",
  "unreadableBody": "PDF नहीं खुली। शायद ख़राब है — पहले Repair PDF टूल आज़माएँ।",
  "policyTitle": "ज़िम्मेदारी से इस्तेमाल करें",
  "policyBody": "सिर्फ़ अपनी फ़ाइलें, या जिन्हें बदलने की अनुमति हो, उन्हें अनलॉक करें। अनजान ओपन पासवर्ड किसी द्वारा नहीं हटाया जा सकता।",
}

EN_TOOL_ERRORS = {
  "errorAlreadyEncrypted": "This PDF is already password-protected — unlock it first.",
  "errorWrongPassword": "That password is not correct.",
  "errorNotEncrypted": "This PDF has no password — nothing to unlock.",
  "errorPwTooShort": "The open password needs at least 6 characters.",
  "errorNoPassword": "Enter a password first.",
}

HI_TOOL_ERRORS = {
  "errorAlreadyEncrypted": "यह PDF पहले से पासवर्ड-सुरक्षित है — पहले इसे अनलॉक करें।",
  "errorWrongPassword": "यह पासवर्ड सही नहीं है।",
  "errorNotEncrypted": "इस PDF पर कोई पासवर्ड नहीं है — हटाने के लिए कुछ नहीं।",
  "errorPwTooShort": "ओपन पासवर्ड में कम से कम 6 अक्षर चाहिए।",
  "errorNoPassword": "पहले पासवर्ड डालें।",
}

for path, lock, unlock, errs in (
    ("src/i18n/en.json", EN_LOCK, EN_UNLOCK, EN_TOOL_ERRORS),
    ("src/i18n/hi.json", HI_LOCK, HI_UNLOCK, HI_TOOL_ERRORS),
):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if "lock" in data or "unlock" in data:
        raise SystemExit(f"{path} already has lock/unlock sections — refusing to overwrite")
    data["lock"] = lock
    data["unlock"] = unlock
    tool = data["tool"]
    for key, value in errs.items():
        if key in tool:
            raise SystemExit(f"{path} already has tool.{key}")
        tool[key] = value
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"{path}: lock ({len(lock)}) + unlock ({len(unlock)}) + tool errors ({len(errs)}) merged")

print("done")
