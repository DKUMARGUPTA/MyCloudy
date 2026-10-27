/**
 * Adds the dsign.* i18n namespace (P11 tool round: digital-signature —
 * PAdES .pfx/.p12 signing) to src/i18n/en.json + hi.json, and writes
 * the reference copy to tools/digital-signature/i18n.json. Also adds
 * the shared result.signedChip / signedByNameChip / existingSigsChip
 * keys. Idempotent: re-running replaces the namespace with these
 * definitions. Verifies flat-leaf parity.
 *
 * Run: bun scripts/merge-dsign-i18n.ts
 */
import fs from "node:fs";

const DSIGN_EN = {
  how1: "Drop the PDF you want signed, then pick your .pfx/.p12 certificate file — both stay on your device.",
  how2: "Type the certificate password. The signer card appears when the key is proven usable — no guesswork.",
  how3: "Press Sign & download — the output carries a PAdES (ETSI.CAdES) signature, self-verified before it leaves.",
  surfaceLabel: "Digital signature",
  analyzing: "Reading the document…",
  encryptedNote:
    "This PDF is password-protected. Unlock it with the Unlock PDF tool first — a signature cannot be added to an encrypted file.",
  damagedNote:
    "This file's structure is damaged. Repair it with the Repair PDF tool first, then sign.",
  existingNote:
    "{count, plural, =1 {This document already carries 1 signature. Your new signature is added on top — the existing one stays valid.} other {This document already carries # signatures. Your new signature is added on top — the existing ones stay valid.}}",
  certTitle: "Signing certificate",
  certPick: "Choose your .pfx / .p12 file",
  certPickHint: "The certificate your authority issued — with its password.",
  passwordLabel: "Certificate password",
  passwordPlaceholder: "Type the password…",
  showPassword: "Show password",
  hidePassword: "Hide password",
  certRemove: "Remove",
  certReading: "Unlocking the certificate…",
  certLocked:
    "Password required — type it above to unlock the signing key.",
  certUnlocked: "Certificate unlocked",
  certName: "Name",
  certUnnamed: "(unnamed)",
  certKey: "Key",
  certChain: "Certificates",
  certChainValue: "{count, plural, =1 {1 in the file} other {# in the file}}",
  certMac: "Integrity",
  macOk: "MAC verified",
  macMissing: "not checked",
  detailsTitle: "Signature details",
  reasonLabel: "Reason (optional)",
  reasonPlaceholder: "e.g. Approved for release",
  locationLabel: "Location (optional)",
  locationPlaceholder: "e.g. Mumbai, India",
  pageLabel: "Page",
  pageOf: "of {total}",
  visibleOn: "Visible signature card",
  visibleOff: "Invisible signature",
  clockNote:
    "The signing time is your device clock — no timestamp server is contacted (that would send document data away). Chain trust and revocation cannot be checked offline; verify the output with the Verify PDF signatures tool before relying on it.",
  runNote:
    "Sign adds a proper incremental update — the original bytes are preserved and any existing signatures stay valid.",
  errorP12Parse:
    "This file could not be read as a PKCS#12 (.pfx/.p12) certificate. Make sure you picked the certificate file itself, not the key or a zip.",
  errorP12Password:
    "The password did not work — the file's integrity check failed. Check for typos and try again.",
  errorP12NoKey: "This certificate file contains no private key — it is export-only and cannot sign.",
  errorP12NoCert: "This certificate file contains no certificate.",
  errorP12Unsupported:
    "This certificate uses an encryption this tool cannot open (RC4-era). Re-export it from your system with modern settings.",
  errorKeyUnsupported:
    "The private key type is not supported (only RSA and EC P-256/P-384/P-521 keys can sign here).",
  errorNoSignerCert:
    "The certificate matching the private key was not found in the file — it may be corrupted.",
  errorNotPdf: "This file is not a PDF.",
  errorEncrypted: "The PDF is password-protected — unlock it first.",
  errorDamaged: "The PDF's structure is damaged — repair it first.",
  errorSignFailed: "Signing failed — the produced signature did not verify. Nothing was written.",
  errorTooLarge:
    "The signature did not fit the reserved space. Try a certificate with a shorter chain.",
  blockedNoDoc: "Waiting for a readable PDF…",
  blockedEncrypted: "Unlock the PDF first",
  blockedDamaged: "Repair the PDF first",
  blockedNoCert: "Pick your .pfx/.p12 and unlock it to sign",
};

const DSIGN_HI = {
  how1: "जिस PDF पर हस्ताक्षर करने हैं वह डालें, फिर अपनी .pfx/.p12 सर्टिफ़िकेट फ़ाइल चुनें — दोनों आपके डिवाइस पर रहते हैं।",
  how2: "सर्टिफ़िकेट का पासवर्ड लिखें। कुंजी जाँच-सिद्ध होते ही हस्ताक्षरकर्ता कार्ड दिखता है — कोई अंदाज़ा नहीं।",
  how3: "साइन करें दबाकर डाउनलोड करें — नतीजे में PAdES (ETSI.CAdES) हस्ताक्षर होता है, जाने से पहले खुद जाँचा जाता है।",
  surfaceLabel: "डिजिटल हस्ताक्षर",
  analyzing: "दस्तावेज़ पढ़ा जा रहा है…",
  encryptedNote:
    "यह PDF पासवर्ड-सुरक्षित है। पहले Unlock PDF टूल से खोलें — एन्क्रिप्टेड फ़ाइल पर हस्ताक्षर नहीं जोड़ा जा सकता।",
  damagedNote:
    "फ़ाइल का ढाँचा टूटा है। पहले Repair PDF टूल से ठीक करें, फिर हस्ताक्षर करें।",
  existingNote:
    "{count, plural, =1 {इस दस्तावेज़ में पहले से 1 हस्ताक्षर है। आपका नया हस्ताक्षर ऊपर जुड़ता है — पुराना वैध रहता है।} other {इस दस्तावेज़ में पहले से # हस्ताक्षर हैं। आपका नया हस्ताक्षर ऊपर जुड़ता है — पुराने वैध रहते हैं।}}",
  certTitle: "साइनिंग सर्टिफ़िकेट",
  certPick: "अपनी .pfx / .p12 फ़ाइल चुनें",
  certPickHint: "जो सर्टिफ़िकेट आपके प्राधिकरण ने दिया — उसके पासवर्ड सहित।",
  passwordLabel: "सर्टिफ़िकेट पासवर्ड",
  passwordPlaceholder: "पासवर्ड लिखें…",
  showPassword: "पासवर्ड दिखाएँ",
  hidePassword: "पासवर्ड छिपाएँ",
  certRemove: "हटाएँ",
  certReading: "सर्टिफ़िकेट खोला जा रहा है…",
  certLocked: "पासवर्ड चाहिए — साइनिंग कुंजी खोलने के लिए ऊपर लिखें।",
  certUnlocked: "सर्टिफ़िकेट खुल गया",
  certName: "नाम",
  certUnnamed: "(बेनाम)",
  certKey: "कुंजी",
  certChain: "सर्टिफ़िकेट",
  certChainValue: "{count, plural, =1 {फ़ाइल में 1} other {फ़ाइल में #}}",
  certMac: "अखंडता",
  macOk: "MAC सत्यापित",
  macMissing: "जाँच नहीं हुई",
  detailsTitle: "हस्ताक्षर विवरण",
  reasonLabel: "कारण (वैकल्पिक)",
  reasonPlaceholder: "जैसे: जारी करने के लिए स्वीकृत",
  locationLabel: "स्थान (वैकल्पिक)",
  locationPlaceholder: "जैसे: मुंबई, भारत",
  pageLabel: "पेज",
  pageOf: "/ {total}",
  visibleOn: "दिखने वाला हस्ताक्षर कार्ड",
  visibleOff: "अदृश्य हस्ताक्षर",
  clockNote:
    "हस्ताक्षर समय आपके डिवाइस की घड़ी का है — किसी टाइमस्टैम्प सर्वर से संपर्क नहीं होता (उसमें दस्तावेज़ का डेटा बाहर जाता)। चेन-ट्रस्ट और रिवोकेशन ऑफ़लाइन नहीं जाँचे जा सकते; भरोसा करने से पहले Verify PDF signatures टूल से नतीजा जाँचें।",
  runNote:
    "साइन असली इंक्रीमेंटल अपडेट जोड़ता है — मूल बाइट्स सुरक्षित रहते हैं और पहले के हस्ताक्षर वैध रहते हैं।",
  errorP12Parse:
    "यह फ़ाइल PKCS#12 (.pfx/.p12) सर्टिफ़िकेट नहीं पढ़ी गई। ध्यान रहे — कुंजी या ज़िप नहीं, सर्टिफ़िकेट फ़ाइल ही चुनी है?",
  errorP12Password:
    "पासवर्ड सही नहीं रहा — फ़ाइल की अखंडता जाँच असफल। दोबारा ज़रा ध्यान से लिखें।",
  errorP12NoKey: "इस सर्टिफ़िकेट फ़ाइल में निजी कुंजी नहीं है — यह केवल-पढ़ने निर्यात है, हस्ताक्षर नहीं कर सकती।",
  errorP12NoCert: "इस सर्टिफ़िकेट फ़ाइल में कोई सर्टिफ़िकेट नहीं मिला।",
  errorP12Unsupported:
    "यह सर्टिफ़िकेट ऐसी एन्क्रिप्शन में है जो यहाँ नहीं खुलती (RC4 युग की)। अपने सिस्टम से नई सेटिंग में दोबारा निर्यात करें।",
  errorKeyUnsupported:
    "यह निजी कुंजी-प्रकार समर्थित नहीं (यहाँ केवल RSA और EC P-256/P-384/P-521 कुंजियाँ हस्ताक्षर कर सकती हैं)।",
  errorNoSignerCert:
    "निजी कुंजी से मेल खाता सर्टिफ़िकेट फ़ाइल में नहीं मिला — शायद फ़ाइल टूटी है।",
  errorNotPdf: "यह फ़ाइल PDF नहीं है।",
  errorEncrypted: "PDF पासवर्ड-सुरक्षित है — पहले अनलॉक करें।",
  errorDamaged: "PDF का ढाँचा टूटा है — पहले रिपेयर करें।",
  errorSignFailed: "हस्ताक्षर असफल — बना हस्ताक्षर सत्यापित नहीं हुआ। कुछ भी लिखा नहीं गया।",
  errorTooLarge:
    "हस्ताक्षर आरक्षित जगह में समा नहीं। छोटी चेन वाला सर्टिफ़िकेट आज़माएँ।",
  blockedNoDoc: "पढ़ने योग्य PDF का इंतज़ार…",
  blockedEncrypted: "पहले PDF अनलॉक करें",
  blockedDamaged: "पहले PDF रिपेयर करें",
  blockedNoCert: "हस्ताक्षर के लिए .pfx/.p12 चुनकर खोलें",
};

const RESULT_EN = {
  signedChip: "Digitally signed",
  signedByNameChip: "Signed by {name}",
  existingSigsChip: "{n} earlier signature(s) intact",
};
const RESULT_HI = {
  signedChip: "डिजिटल हस्ताक्षर हुआ",
  signedByNameChip: "{name} द्वारा हस्ताक्षरित",
  existingSigsChip: "{n} पुराने हस्ताक्षर सुरक्षित",
};

function writeJson(path: string, data: unknown): void {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function flatLeaves(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node).flatMap(([k, v]) =>
    flatLeaves(v, prefix === "" ? k : `${prefix}.${k}`)
  );
}

const enPath = "src/i18n/en.json";
const hiPath = "src/i18n/hi.json";

const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
const hi = JSON.parse(fs.readFileSync(hiPath, "utf8"));

en.dsign = DSIGN_EN;
hi.dsign = DSIGN_HI;
en.result = { ...en.result, ...RESULT_EN };
hi.result = { ...hi.result, ...RESULT_HI };

writeJson(enPath, en);
writeJson(hiPath, hi);
writeJson("tools/digital-signature/i18n.json", {
  en: DSIGN_EN,
  hi: DSIGN_HI,
});

const enLeaves = flatLeaves(en).sort();
const hiLeaves = flatLeaves(hi).sort();
if (enLeaves.length !== hiLeaves.length) {
  const enSet = new Set(enLeaves);
  const hiSet = new Set(hiLeaves);
  const onlyEn = enLeaves.filter((k) => !hiSet.has(k));
  const onlyHi = hiLeaves.filter((k) => !enSet.has(k));
  console.error("PARITY FAIL", { onlyEn, onlyHi });
  process.exit(1);
}
console.log(
  `dsign.* ${Object.keys(DSIGN_EN).length} keys merged — parity OK: ${enLeaves.length} = ${hiLeaves.length} flat-leaf keys`
);
