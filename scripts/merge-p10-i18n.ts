/**
 * Adds the xinv.* i18n namespace (P10 tool round: xml-invoice-to-pdf —
 * UBL/CII e-invoice → readable PDF) to src/i18n/en.json + hi.json, and
 * writes the reference copy to tools/xml-invoice-to-pdf/i18n.json.
 * Also adds the shared result.lineCount / result.totalsChip /
 * result.totalsFailChip keys. Idempotent: re-running replaces the
 * namespace with these definitions. Verifies flat-leaf parity.
 *
 * Run: bun scripts/merge-p10-i18n.ts
 */
import fs from "node:fs";

const XINV_EN = {
  how1: "Drop the e-invoice XML — UBL 2.1 (Peppol, India IRP) or CII (Factur-X / ZUGFeRD). Nothing leaves your device.",
  how2: "The file is read on the spot: parties, lines, taxes — and its totals cross-checked against its own lines.",
  how3: "Press Run — a clean, readable PDF sheet downloads with the amounts exactly as the file states.",
  surfaceLabel: "XML e-invoice reader",
  analyzing: "Reading the e-invoice…",
  errorNotInvoice:
    "This XML is well-formed, but it is not an e-invoice — the root element is neither a UBL Invoice/Credit Note nor a CII CrossIndustryInvoice.",
  errorXml: "This file is not well-formed XML — it looks truncated or damaged.",
  notInvoiceNote:
    "This is valid XML, but not an e-invoice we can read: the root element is neither a UBL Invoice/Credit Note nor a CII CrossIndustryInvoice. Export the e-invoice XML from your accounting software or the IRP portal and drop that here.",
  brokenNote:
    "The XML could not be parsed — it may be truncated or damaged. Check that the file opens in another viewer first, then drop it again.",
  kindInvoice: "Invoice",
  kindCreditNote: "Credit note",
  kindDebitNote: "Debit note",
  kindProforma: "Proforma invoice",
  kindOther: "E-invoice",
  gstBadge: "GST e-invoice",
  seller: "From",
  buyer: "Bill to",
  number: "Invoice no.",
  date: "Issue date",
  due: "Due date",
  currency: "Currency",
  buyerRef: "Buyer ref.",
  orderRef: "Order no.",
  taxId: "Tax ID",
  gstin: "GSTIN",
  hash: "#",
  desc: "Description",
  qty: "Qty",
  price: "Unit price",
  taxCol: "Tax %",
  amt: "Amount",
  sub: "Subtotal",
  allowance: "Allowance",
  charge: "Charge",
  basis: "Taxable amount",
  taxBreakdown: "Tax breakdown",
  rate: "Rate",
  category: "Category",
  base: "Base",
  taxTotal: "Total tax",
  rounding: "Rounding",
  grand: "Grand total",
  prepaid: "Prepaid",
  payable: "Balance due",
  payment: "Payment",
  account: "Account",
  upi: "UPI ID",
  notes: "Notes",
  terms: "Terms",
  wordsLabel: "Amount in words:",
  linesLabel: "Lines",
  linesValue: "{count, plural, =1 {1 line} other {# lines}}",
  checkTitle: "Consistency checks",
  checkLines: "Line amounts add up to the stated line total",
  checkBasis: "Tax basis arithmetic (lines − allowance + charges)",
  checkTaxSum: "VAT/GST breakdown adds up to the stated tax total",
  checkGrand: "Grand total = tax basis + tax + rounding",
  checkPayable: "Payable = grand total − prepaid",
  checksOk: "Totals verified",
  checksFail: "Inconsistent totals in the source file",
  runNote:
    "Run writes the readable PDF sheet — the same data, the same checks, in the language you picked.",
  footerNote:
    "Amounts are shown exactly as stated in the source XML — nothing was recalculated. Generated on-device by DocoPDF.",
};

const XINV_HI = {
  how1: "ई-इनवॉइस XML डालें — UBL 2.1 (Peppol, भारत IRP) या CII (Factur-X / ZUGFeRD)। कुछ भी डिवाइस से बाहर नहीं जाता।",
  how2: "फ़ाइल वहीं पढ़ी जाती है: पार्टियाँ, लाइनें, कर — और टोटल अपनी ही लाइनों से मिलाकर जाँचे जाते हैं।",
  how3: "रन दबाएँ — साफ़, पढ़ने योग्य PDF शीट उतरेगी, रकम वही जो फ़ाइल कहती है।",
  surfaceLabel: "XML ई-इनवॉइस रीडर",
  analyzing: "ई-इनवॉइस पढ़ा जा रहा है…",
  errorNotInvoice:
    "यह XML सही तो है, पर ई-इनवॉइस नहीं — मूल एलिमेंट न UBL Invoice/Credit Note है न CII CrossIndustryInvoice।",
  errorXml: "यह फ़ाइल सही XML नहीं है — कटी हुई या टूटी लगती है।",
  notInvoiceNote:
    "XML वैध है, पर पढ़ने लायक़ ई-इनवॉइस नहीं: मूल एलिमेंट न UBL Invoice/Credit Note है न CII CrossIndustryInvoice। अपने अकाउंटिंग सॉफ़्टवेयर या IRP पोर्टल से ई-इनवॉइस XML निकालकर यहाँ डालें।",
  brokenNote:
    "XML पढ़ी नहीं जा सकी — शायद कटी या टूटी हुई है। पहले किसी और व्यूअर में खोलकर देखें, फिर दोबारा डालें।",
  kindInvoice: "इनवॉइस",
  kindCreditNote: "क्रेडिट नोट",
  kindDebitNote: "डेबिट नोट",
  kindProforma: "प्रोफ़ॉर्मा इनवॉइस",
  kindOther: "ई-इनवॉइस",
  gstBadge: "GST ई-इनवॉइस",
  seller: "प्रेषक",
  buyer: "प्राप्तकर्ता",
  number: "इनवॉइस सं.",
  date: "जारी तारीख़",
  due: "देय तारीख़",
  currency: "मुद्रा",
  buyerRef: "खरीदार संदर्भ",
  orderRef: "ऑर्डर सं.",
  taxId: "कर पहचान",
  gstin: "GSTIN",
  hash: "#",
  desc: "विवरण",
  qty: "मात्रा",
  price: "इकाई मूल्य",
  taxCol: "कर %",
  amt: "रकम",
  sub: "उप-योग",
  allowance: "छूट",
  charge: "शुल्क",
  basis: "कर योग्य राशि",
  taxBreakdown: "कर विवरण",
  rate: "दर",
  category: "श्रेणी",
  base: "आधार",
  taxTotal: "कुल कर",
  rounding: "राउंडिंग",
  grand: "कुल योग",
  prepaid: "अग्रिम",
  payable: "शेष देय",
  payment: "भुगतान",
  account: "खाता",
  upi: "UPI आईडी",
  notes: "टिप्पणियाँ",
  terms: "शर्तें",
  wordsLabel: "शब्दों में राशि:",
  linesLabel: "लाइनें",
  linesValue: "{count, plural, =1 {1 लाइन} other {# लाइनें}}",
  checkTitle: "टोटल-मिलान जाँचें",
  checkLines: "लाइन की रकमें बताए गए लाइन-टोटल से जुड़ती हैं",
  checkBasis: "कर-आधार का हिसाब (लाइनें − छूट + शुल्क)",
  checkTaxSum: "VAT/GST ब्रेकडाउन बताए गए कुल कर से जुड़ता है",
  checkGrand: "कुल योग = कर आधार + कर + राउंडिंग",
  checkPayable: "देय = कुल योग − अग्रिम",
  checksOk: "टोटल जाँचे गए",
  checksFail: "फ़ाइल के टोटल आपस में नहीं मिलते",
  runNote: "रन पर पढ़ने योग्य PDF शीट बनती है — वही डेटा, वही जाँचें, आपकी चुनी भाषा में।",
  footerNote:
    "रकम स्रोत XML में जैसी लिखी है वैसी ही दिखती हैं — कुछ भी दोबारा गणना नहीं हुई। DocoPDF द्वारा डिवाइस पर ही बनाई गई।",
};

const RESULT_EN = {
  lineCount: "{n} lines",
  totalsChip: "Totals verified",
  totalsFailChip: "Inconsistent totals in source",
};
const RESULT_HI = {
  lineCount: "{n} लाइनें",
  totalsChip: "टोटल जाँचे गए",
  totalsFailChip: "फ़ाइल के टोटल असंगत",
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

en.xinv = XINV_EN;
hi.xinv = XINV_HI;
en.result = { ...en.result, ...RESULT_EN };
hi.result = { ...hi.result, ...RESULT_HI };

writeJson(enPath, en);
writeJson(hiPath, hi);
writeJson("tools/xml-invoice-to-pdf/i18n.json", {
  en: XINV_EN,
  hi: XINV_HI,
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
  `xinv.* ${Object.keys(XINV_EN).length} keys merged — parity OK: ${enLeaves.length} = ${hiLeaves.length} flat-leaf keys`
);
