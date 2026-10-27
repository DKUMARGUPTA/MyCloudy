/**
 * Adds the wopt.* i18n namespace (P9 tool round: web-optimize-pdf —
 * linearize) to src/i18n/en.json + hi.json, and writes the reference
 * copy to tools/web-optimize-pdf/i18n.json. Also adds the shared
 * result.linearizedChip key. Idempotent: re-running replaces the
 * namespace with these definitions. Verifies flat-leaf parity.
 *
 * Run: bun scripts/merge-p9-i18n.ts
 */
import fs from "node:fs";

const WOPT_EN = {
  how1: "Drop the PDF — the file never leaves your device.",
  how2: "Its head is scanned on the spot: is it already linearized, and how big is the first-page jump today?",
  how3: "Press Run — the linearized copy downloads with a byte-exact verification report.",
  surfaceLabel: "Web optimization",
  analyzing: "Reading the file structure…",
  encryptedNote:
    "This file is password-protected. Unlock it with the Unlock PDF tool first, then optimize it for the web.",
  damagedNote:
    "This PDF's cross-reference structure is damaged. Run the Repair PDF tool first — its clean rebuild optimizes perfectly here afterwards.",
  failedNote:
    "This file could not be read. If it will not open anywhere, try the Repair PDF tool first.",
  verdictAlready: "Already optimized for the web",
  verdictAlreadyNote:
    "This PDF is linearized — browsers can paint its first page after a few kilobytes. Running again is harmless: the file is re-linearized and re-verified.",
  verdictWill: "Ready to linearize",
  verdictWillNote:
    "This PDF makes viewers wait for the whole file before the first page shows. The run rewrites it so page 1 arrives first.",
  pagesLabel: "Pages",
  sizeLabel: "Current size",
  statusLabel: "Fast web view",
  statusLinearized: "Ready",
  statusPlain: "Not yet",
  firstPageLabel: "First page ends at",
  firstPageValue: "byte {n}",
  hintLabel: "Hint table",
  hintValue: "{n} bytes",
  explainTitle: "What fast web view means",
  explain1:
    "The byte order is rewritten: everything page 1 needs moves to the front of the file.",
  explain2:
    "A small hint table is added so a viewer can locate any object without downloading the rest.",
  explain3:
    "The content — text, images, fonts — is untouched; only the order and the map change.",
  runNote:
    "Run writes the linearized copy plus a verification report (hint table, byte-exact length check).",
  errorEncrypted:
    "This PDF is encrypted. Unlock it first, then optimize it for the web.",
  errorDamaged:
    "This PDF's structure is damaged. Repair it first, then optimize it for the web.",
  errorNotPdf: "This file is not a PDF — the optimizer cannot rewrite it.",
  errorFailed:
    "The linearization engine could not process this file. If it is damaged, try the Repair PDF tool first.",
};

const WOPT_HI = {
  how1: "PDF डालें — फ़ाइल आपके डिवाइस से बाहर नहीं जाती।",
  how2: "फ़ाइल का हिस्सा वहीं जाँचा जाता है: क्या यह पहले से लीनियराइज़्ड है, और आज पहला पेज कितनी देर में खुलेगा?",
  how3: "रन दबाएँ — लीनियराइज़्ड कॉपी उतरेगी, साथ में बाइट-सटीक जाँच रिपोर्ट।",
  surfaceLabel: "वेब ऑप्टिमाइज़ेशन",
  analyzing: "फ़ाइल का ढाँचा पढ़ा जा रहा है…",
  encryptedNote:
    "यह फ़ाइल पासवर्ड से सुरक्षित है। पहले Unlock PDF टूल से खोलें, फिर वेब के लिए ऑप्टिमाइज़ करें।",
  damagedNote:
    "इस PDF की क्रॉस-रेफ़रेंस ढाँचा टूटा है। पहले Repair PDF टूल चलाएँ — उसकी साफ़ बनी फ़ाइल यहाँ बड़ी अच्छी ऑप्टिमाइज़ होती है।",
  failedNote:
    "फ़ाइल पढ़ी नहीं जा सकी। अगर वह कहीं भी नहीं खुलती तो पहले Repair PDF टूल आज़माएँ।",
  verdictAlready: "पहले से वेब के लिए तैयार",
  verdictAlreadyNote:
    "यह PDF लीनियराइज़्ड है — ब्राउज़र कुछ ही किलोबाइट पर पहला पेज दिखा सकते हैं। दोबारा चलाना नुक़सानदेह नहीं: फ़ाइल फिर लीनियराइज़ होकर फिर जाँची जाती है।",
  verdictWill: "लीनियराइज़ के लिए तैयार",
  verdictWillNote:
    "इस PDF में पहला पेज दिखने से पहले पूरी फ़ाइल का इंतज़ार कराना पड़ता है। रन इसे इस तरह दोबारा लिखता है कि पेज 1 सबसे पहले पहुँचे।",
  pagesLabel: "पेज",
  sizeLabel: "मौजूदा साइज़",
  statusLabel: "फ़ास्ट वेब व्यू",
  statusLinearized: "तैयार",
  statusPlain: "अभी नहीं",
  firstPageLabel: "पहला पेज ख़त्म",
  firstPageValue: "बाइट {n} पर",
  hintLabel: "हिंट टेबल",
  hintValue: "{n} बाइट",
  explainTitle: "फ़ास्ट वेब व्यू का मतलब",
  explain1:
    "बाइट्स का क्रम दोबारा लिखा जाता है: पेज 1 को जो कुछ चाहिए, वह सब फ़ाइल के आगे आ जाता है।",
  explain2:
    "एक छोटी हिंट टेबल जुड़ती है — व्यूअर बाक़ी फ़ाइल डाउनलोड किए बिना हर ऑब्जेक्ट ढूँढ लेता है।",
  explain3:
    "कंटेंट — टेक्स्ट, तस्वीरें, फ़ॉन्ट — वैसा ही रहता है; सिर्फ़ क्रम और नक़्शा बदलता है।",
  runNote:
    "रन लीनियराइज़्ड कॉपी लिखता है, साथ में जाँच-रिपोर्ट (हिंट टेबल, बाइट-सटीक लंबाई जाँच)।",
  errorEncrypted:
    "यह PDF एन्क्रिप्टेड है। पहले अनलॉक करें, फिर वेब के लिए ऑप्टिमाइज़ करें।",
  errorDamaged:
    "इस PDF का ढाँचा टूटा है। पहले मरम्मत करें, फिर वेब के लिए ऑप्टिमाइज़ करें।",
  errorNotPdf: "यह फ़ाइल PDF नहीं है — ऑप्टिमाइज़र इसे दोबारा नहीं लिख सकता।",
  errorFailed:
    "लीनियराइज़ेशन इंजन यह फ़ाइल नहीं चला सका। अगर टूटी है तो पहले Repair PDF टूल आज़माएँ।",
};

const RESULT_CHIP_EN = {
  linearizedChip: "Fast web view ready",
};

const RESULT_CHIP_HI = {
  linearizedChip: "फ़ास्ट वेब व्यू तैयार",
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

en.wopt = WOPT_EN;
hi.wopt = WOPT_HI;
en.result = { ...en.result, ...RESULT_CHIP_EN };
hi.result = { ...hi.result, ...RESULT_CHIP_HI };

writeJson(enPath, en);
writeJson(hiPath, hi);
writeJson("tools/web-optimize-pdf/i18n.json", {
  en: WOPT_EN,
  hi: WOPT_HI,
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
  `wopt.* ${Object.keys(WOPT_EN).length} keys merged — parity OK: ${enLeaves.length} = ${hiLeaves.length} flat-leaf keys`
);
