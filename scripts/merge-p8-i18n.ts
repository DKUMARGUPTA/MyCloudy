/**
 * Adds the verify.* and repair.* i18n namespaces (P8 tools round:
 * verify-pdf-signatures + repair-pdf) to src/i18n/en.json + hi.json, and
 * writes the reference copies to tools/<tool>/i18n.json. Also adds the
 * shared result.signatureCount chip key. Idempotent: re-running replaces
 * the namespaces with these definitions. Verifies flat-leaf parity.
 *
 * Run: bun scripts/merge-p8-i18n.ts
 */
import fs from "node:fs";

const VERIFY_EN = {
  how1: "Drop the signed PDF — the file never leaves your device.",
  how2: "Every signature is checked on the spot: signer, time, coverage and the digest.",
  how3: "Press Run to write the full report you can keep or share.",
  surfaceLabel: "Signature verification",
  analyzing: "Reading signatures…",
  encryptedNote:
    "This file is password-protected. Unlock it with the Unlock PDF tool first, then check the signatures.",
  brokenNote:
    "This file is too damaged to read its signatures. Try the Repair PDF tool first.",
  summaryOk:
    "{count, plural, =1 {1 valid signature — the document is unchanged since signing.} other {# valid signatures — the document is unchanged since the last signature.}}",
  summaryProblems:
    "{count, plural, =1 {Problem found with 1 signature — see below.} other {Problems found across # signatures — see below.}}",
  summaryOnlyUnsigned:
    "{count, plural, =1 {No signature yet — the document has 1 empty signature field waiting to be signed.} other {No signature yet — the document has # empty signature fields waiting to be signed.}}",
  summaryNone:
    "This document has no signature fields — nothing has been digitally signed here.",
  unsignedFields:
    "{count, plural, =1 {1 unsigned signature field (a form field, not a signature).} other {# unsigned signature fields (form fields, not signatures).}}",
  chainNote:
    "DocoPDF checks signatures fully offline — it never contacts a CA, CRL or OCSP server. Chain trust and revocation are the only things it cannot judge; everything else is verified cryptographically on your device.",
  statusVerified: "Verified",
  statusModified: "Modified after signing",
  statusUnverified: "Could not verify",
  statusUnsupported: "Unsupported format",
  unknownSigner: "Unknown signer",
  timeLabel: "Signed on",
  digestLabel: "Algorithm",
  reasonLabel: "Reason",
  locationLabel: "Location",
  coverageLabel: "Signed coverage",
  coverageValue: "{pct}% · {signed} of {total}",
  trailingNote:
    "{count, plural, =1 {1 byte was} other {# bytes were}} added after this signature",
  attrsFailed: "The signed metadata itself failed its signature check.",
  sigCardLabel: "Signature {n}",
  certHeading: "Certificate details",
  subjectLabel: "Subject",
  issuerLabel: "Issuer",
  validityLabel: "Valid",
  keyLabel: "Key",
  serialLabel: "Serial",
  atSigningLabel: "At signing time",
  wasValid: "valid",
  wasExpired: "expired",
  wasNotYetValid: "not yet valid",
  fingerprintLabel: "SHA-256 fingerprint",
  copyLabel: "Copy fingerprint",
  errorEncrypted:
    "This PDF is encrypted. Unlock it first, then verify the signatures.",
  errorBroken:
    "This PDF could not be read. Try the Repair PDF tool, then verify again.",
};

const VERIFY_HI = {
  how1: "हस्ताक्षरित PDF डालें — फ़ाइल आपके डिवाइस से बाहर नहीं जाती।",
  how2: "हर हस्ताक्षर की जाँच वहीं: हस्ताक्षरकर्ता, समय, कवरेज और डाइजेस्ट।",
  how3: "रन दबाएँ — पूरी रिपोर्ट बन जाएगी, रखें या शेयर करें।",
  surfaceLabel: "हस्ताक्षर जाँच",
  analyzing: "हस्ताक्षर पढ़े जा रहे हैं…",
  encryptedNote:
    "यह फ़ाइल पासवर्ड से सुरक्षित है। पहले Unlock PDF टूल से खोलें, फिर हस्ताक्षर जाँचें।",
  brokenNote:
    "फ़ाइल इतनी टूटी है कि हस्ताक्षर नहीं पढ़े जा सकते। पहले Repair PDF टूल आज़माएँ।",
  summaryOk:
    "{count, plural, =1 {1 मान्य हस्ताक्षर — दस्तावेज़ हस्ताक्षर के बाद से नहीं बदला।} other {# मान्य हस्ताक्षर — दस्तावेज़ आख़िरी हस्ताक्षर के बाद से नहीं बदला।}}",
  summaryProblems:
    "{count, plural, =1 {1 हस्ताक्षर में दिक़्क़त मिली — नीचे देखें।} other {# हस्ताक्षरों में दिक़्क़तें मिलीं — नीचे देखें।}}",
  summaryOnlyUnsigned:
    "{count, plural, =1 {अभी कोई हस्ताक्षर नहीं — दस्तावेज़ में 1 ख़ाली हस्ताक्षर फ़ील्ड है।} other {अभी कोई हस्ताक्षर नहीं — दस्तावेज़ में # ख़ाली हस्ताक्षर फ़ील्ड हैं।}}",
  summaryNone:
    "इस दस्तावेज़ में कोई हस्ताक्षर फ़ील्ड नहीं है — यहाँ डिजिटल हस्ताक्षर नहीं हुआ।",
  unsignedFields:
    "{count, plural, =1 {1 अनसाइन्ड हस्ताक्षर फ़ील्ड (फ़ॉर्म फ़ील्ड, हस्ताक्षर नहीं)।} other {# अनसाइन्ड हस्ताक्षर फ़ील्ड (फ़ॉर्म फ़ील्ड, हस्ताक्षर नहीं)।}}",
  chainNote:
    "DocoPDF पूरी तरह ऑफ़लाइन जाँच करता है — CA, CRL या OCSP सर्वर से कभी बात नहीं करता। चेन-ट्रस्ट और रद्दीकरण ही अकेली बातें हैं जो यह नहीं बता सकता; बाक़ी सब आपके डिवाइस पर क्रिप्टोग्राफ़िक रूप से जाँचा जाता है।",
  statusVerified: "मान्य",
  statusModified: "हस्ताक्षर के बाद बदला",
  statusUnverified: "जाँच नहीं हो सका",
  statusUnsupported: "असमर्थित फ़ॉर्मैट",
  unknownSigner: "अज्ञात हस्ताक्षरकर्ता",
  timeLabel: "हस्ताक्षर समय",
  digestLabel: "एल्गोरिद्म",
  reasonLabel: "कारण",
  locationLabel: "स्थान",
  coverageLabel: "हस्ताक्षरित कवरेज",
  coverageValue: "{pct}% · कुल {total} में {signed}",
  trailingNote:
    "{count, plural, =1 {इस हस्ताक्षर के बाद 1 बाइट जुड़ा} other {इस हस्ताक्षर के बाद # बाइट जुड़े}}",
  attrsFailed: "हस्ताक्षरित मेटाडेटा की अपनी जाँच भी फ़ेल हो गई।",
  sigCardLabel: "हस्ताक्षर {n}",
  certHeading: "सर्टिफ़िकेट विवरण",
  subjectLabel: "विषय",
  issuerLabel: "जारीकर्ता",
  validityLabel: "वैध",
  keyLabel: "की",
  serialLabel: "सीरियल",
  atSigningLabel: "हस्ताक्षर के समय",
  wasValid: "वैध",
  wasExpired: "एक्स्पायर्ड",
  wasNotYetValid: "तब अमान्य",
  fingerprintLabel: "SHA-256 फ़िंगरप्रिंट",
  copyLabel: "फ़िंगरप्रिंट कॉपी करें",
  errorEncrypted:
    "यह PDF एन्क्रिप्टेड है। पहले अनलॉक करें, फिर हस्ताक्षर जाँचें।",
  errorBroken:
    "यह PDF पढ़ा नहीं जा सका। पहले Repair PDF टूल आज़माएँ, फिर दोबारा जाँचें।",
};

const REPAIR_EN = {
  how1: "Drop the broken PDF — it is scanned object by object on your device.",
  how2: "The cross-reference table is rebuilt; every surviving page is kept.",
  how3: "Download the repaired file along with its damage report.",
  surfaceLabel: "PDF repair",
  scanning: "Scanning the file structure…",
  encryptedNote:
    "This file is password-protected. A locked PDF cannot be rebuilt — unlock it first, then repair.",
  failedNote:
    "Nothing could be recovered from this file — its structure is too damaged. If it is an important document, try a backup copy.",
  verdictHealthy: "This file is already readable",
  verdictHealthyNote:
    "No structural damage found. Running the tool gives you a clean rewrite — the same as “save as new PDF”.",
  verdictRebuilt: "Damaged — but it can be rebuilt",
  verdictRebuiltNote:
    "The broken structure can be replaced. Below is what survived the scan.",
  pagesLabel: "Pages",
  objectsLabel: "Objects",
  streamsLabel: "Streams",
  prunedLabel: "Dead links",
  sizeLabel: "New size",
  thumbAlt: "First page of the rebuilt PDF",
  previewNote: "Original {original} → rebuild {rebuilt}. The run downloads this exact rebuild.",
  noteXrefRebuilt:
    "The cross-reference table was rebuilt from the objects found in the file.",
  noteReparsed:
    "The file structure was damaged; every object that could be parsed was recovered and re-serialised cleanly.",
  noteKidsPruned:
    "{count, plural, =1 {1 page-tree reference pointed at a missing object and was removed.} other {# page-tree references pointed at missing objects and were removed.}}",
  noteObjStm:
    "{count, plural, =1 {1 compressed object stream was inflated and its objects restored.} other {# compressed object streams were inflated and their objects restored.}}",
  noteHeader: "The PDF header was missing and has been reconstructed.",
  errorEncrypted:
    "This PDF is encrypted. A locked file cannot be repaired — unlock it first.",
  errorNoCatalog:
    "No document structure survived in this file — there is nothing to rebuild.",
  errorUnrecoverable:
    "The rebuild did not hold — the damage is beyond repair.",
  errorNoPages: "No pages survived the damage — there is nothing to rebuild.",
};

const REPAIR_HI = {
  how1: "टूटी PDF डालें — उसका स्कैन ऑब्जेक्ट-दर-ऑब्जेक्ट आपके डिवाइस पर होता है।",
  how2: "क्रॉस-रेफ़रेंस टेबल नए सिरे से बनती है; जो पेज बचे वे रहते हैं।",
  how3: "मरम्मत की फ़ाइल उतारें — साथ में डैमेज रिपोर्ट भी।",
  surfaceLabel: "PDF मरम्मत",
  scanning: "फ़ाइल का ढाँचा स्कैन हो रहा है…",
  encryptedNote:
    "यह फ़ाइल पासवर्ड से सुरक्षित है। लॉक PDF नहीं बन सकती — पहले अनलॉक करें।",
  failedNote:
    "इस फ़ाइल से कुछ नहीं बचा — ढाँचा इतना टूटा है। ज़रूरी दस्तावेज़ हो तो बैकअप कॉपी देखें।",
  verdictHealthy: "यह फ़ाइल पहले से पढ़ने योग्य है",
  verdictHealthyNote:
    "ढाँचे में कोई नुक़सान नहीं मिला। रन करने पर साफ़ रीराइट मिलेगी — “नई PDF सेव करो” जैसा।",
  verdictRebuilt: "टूटी है — पर बन सकती है",
  verdictRebuiltNote:
    "टूटा ढाँचा बदला जा सकता है। नीचे वह सब है जो स्कैन में बचा।",
  pagesLabel: "पेज",
  objectsLabel: "ऑब्जेक्ट",
  streamsLabel: "स्ट्रीम",
  prunedLabel: "मरे लिंक",
  sizeLabel: "नई साइज़",
  thumbAlt: "बनी PDF का पहला पेज",
  previewNote: "असली {original} → नई {rebuilt}। रन यही बनावट उतारता है।",
  noteXrefRebuilt:
    "फ़ाइल में मिले ऑब्जेक्टों से क्रॉस-रेफ़रेंस टेबल नए सिरे से बनाई गई।",
  noteReparsed:
    "ढाँचा टूटा था; जो ऑब्जेक्ट पढ़े जा सके, वे सहेजकर साफ़ तरीक़े से दोबारा लिखे गए।",
  noteKidsPruned:
    "{count, plural, =1 {1 पेज-लिंक ग़ायब ऑब्जेक्ट पर जाता था, हटाया गया।} other {# पेज-लिंक ग़ायब ऑब्जेक्टों पर जाते थे, हटाए गए।}}",
  noteObjStm:
    "{count, plural, =1 {1 संपीड़ित ऑब्जेक्ट स्ट्रीम खोलकर उसके ऑब्जेक्ट वापस लाए गए।} other {# संपीड़ित ऑब्जेक्ट स्ट्रीम खोलकर उनके ऑब्जेक्ट वापस लाए गए।}}",
  noteHeader: "PDF हेडर ग़ायब था, नए सिरे से बनाया गया।",
  errorEncrypted:
    "यह PDF एन्क्रिप्टेड है। लॉक फ़ाइल की मरम्मत नहीं हो सकती — पहले अनलॉक करें।",
  errorNoCatalog:
    "इस फ़ाइल में दस्तावेज़ का ढाँचा ही नहीं बचा — बनाने को कुछ नहीं।",
  errorUnrecoverable: "बनावट टिकी नहीं — नुक़सान मरम्मत से बाहर है।",
  errorNoPages: "टूट-फूट में कोई पेज नहीं बचा — बनाने को कुछ नहीं।",
};

const RESULT_CHIP_EN = {
  signatureCount:
    "{n, plural, =1 {1 signature checked} other {# signatures checked}}",
};

const RESULT_CHIP_HI = {
  signatureCount:
    "{n, plural, =1 {1 हस्ताक्षर जाँचा} other {# हस्ताक्षर जाँचे}}",
};

function writeJson(path: string, data: unknown): void {
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

en.verify = VERIFY_EN;
hi.verify = VERIFY_HI;
en.repair = REPAIR_EN;
hi.repair = REPAIR_HI;
en.result = { ...en.result, ...RESULT_CHIP_EN };
hi.result = { ...hi.result, ...RESULT_CHIP_HI };

writeJson(enPath, en);
writeJson(hiPath, hi);
writeJson("tools/verify-pdf-signatures/i18n.json", {
  en: VERIFY_EN,
  hi: VERIFY_HI,
});
writeJson("tools/repair-pdf/i18n.json", {
  en: REPAIR_EN,
  hi: REPAIR_HI,
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
  `verify.* ${Object.keys(VERIFY_EN).length} + repair.* ${Object.keys(REPAIR_EN).length} keys merged — parity OK: ${enLeaves.length} = ${hiLeaves.length} flat-leaf keys`
);
