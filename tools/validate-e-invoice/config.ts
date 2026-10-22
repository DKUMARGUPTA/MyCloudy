import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Validate e-invoice (RB5-e): structural + EN 16931-flavored semantic
 * checks for CII e-invoices — a raw XML file or the Factur-X/ZUGFeRD XML
 * embedded in a PDF. Runs entirely on-device in a Web Worker.
 *
 * HONEST LIMITS (mirrored in the FAQ + the report footer):
 *  - this is NOT a full XSD schema validation (the official XSD set is
 *    huge; we check structure + the semantic rules below instead);
 *  - no signature / e-seal verification;
 *  - no business-rule completeness beyond the checks listed — the
 *    checklist shown after a run IS the whole scope.
 */
export const config: ToolConfig = {
  toolId: "validate-e-invoice",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  howKeys: ["vei.how1", "vei.how2", "vei.how3"],
  chainToolIds: ["xml-invoice-to-pdf", "pdf-to-e-invoice", "view-pdf"],
  options: [],
  features: [
    {
      en: "Accepts a raw CII XML file OR a PDF with an embedded Factur-X/ZUGFeRD XML — the tool detects which arrived and, for PDFs, extracts the attachment itself (factur-x.xml, zugferd-invoice.xml, or any embedded .xml).",
      hi: "सीधी CII XML फ़ाइल या ऐसी PDF जिसमें Factur-X/ZUGFeRD XML जुड़ा हो — टूल ख़ुद पहचानता है कि क्या आया, और PDF होने पर अटैचमेंट (factur-x.xml, zugferd-invoice.xml या कोई भी .xml) ख़ुद निकालता है।",
    },
    {
      en: "Fourteen concrete checks: root element, document context + guideline, invoice number, issue date (format 102), type code, seller/buyer names, line items with parseable net amounts, and the three totals cross-checks — Σ line nets vs TaxBasisTotalAmount, GrandTotal vs tax basis + tax sum, DuePayable vs grand total − prepaid (±0.01 for decimal artifacts).",
      hi: "चौदह ठोस जाँचें: रूट एलिमेंट, डॉक्युमेंट कॉन्टेक्स्ट + गाइडलाइन, इनवॉइस नंबर, जारी तारीख़ (फ़ॉर्मैट 102), टाइप कोड, विक्रेता/क्रेता के नाम, लाइन आइटम और उनके शुद्ध अंक, और तीनों टोटल की क्रॉस-जाँच — लाइन नेट का योग बनाम TaxBasisTotalAmount, GrandTotal बनाम टैक्स-आधार + टैक्स योग, DuePayable बनाम कुल − अग्रिम (±0.01 सहनशीलता)।",
    },
    {
      en: "Every mismatch shows the actual vs expected numbers, and the three totals come out as a mini reconciliation table — you see exactly which line or total is off, by how much.",
      hi: "हर बेमेल पर असली बनाम अपेक्षित अंक दिखते हैं, और तीनों टोटल एक मिनी रिकंसिलिएशन टेबल में आते हैं — साफ़ दिखता है कि कौन सी लाइन या टोटल कितना ग़लत है।",
    },
    {
      en: "For Factur-X PDFs, the XMP /ConformanceLevel claim is cross-checked against the XML's actual completeness (MINIMUM / BASIC / EN 16931) — clearly labelled informational, never a verdict.",
      hi: "Factur-X PDF में XMP /ConformanceLevel के दावे की तुलना XML की असली पूर्णता (MINIMUM / BASIC / EN 16931) से होती है — जानकारी के तौर पर, फ़ैसले के तौर पर कभी नहीं।",
    },
    {
      en: "Download a plain-text validation report with the full checklist and totals — and run with full honesty: no XSD validation, no signature check, no rules beyond the listed ones (the FAQ says exactly what's checked).",
      hi: "पूरी चेकलिस्ट और टोटल के साथ सादा टेक्स्ट वैलिडेशन रिपोर्ट डाउनलोड करें — और पूरी ईमानदारी से: कोई XSD वैलिडेशन नहीं, कोई सिग्नेचर जाँच नहीं, सूची की जाँचों से आगे कोई नियम नहीं (FAQ में साफ़ लिखा है कि क्या जाँचा जाता है)।",
    },
    {
      en: "Runs entirely on your device — the invoice never leaves the browser.",
      hi: "पूरा काम आपके डिवाइस पर — इनवॉइस ब्राउज़र से बाहर कहीं नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly is checked, and what is NOT?",
        hi: "ठीक-ठाक क्या जाँचा जाता है, और क्या नहीं?",
      },
      a: {
        en: "Checked: the root is a CrossIndustryInvoice (CII) document; ExchangedDocumentContext with a guideline; the invoice number; the issue date (CII format 102, YYYYMMDD, or an accepted ISO form); the document type code (380 invoice, 381 credit note, 384 corrected…); seller and buyer names (a warning when empty); at least one line item, each with a name and a dot-decimal net amount; the three totals cross-checks — Σ line nets = TaxBasisTotalAmount, GrandTotal = tax basis + Σ tax amounts, DuePayable = grand − prepaid, each with ±0.01 tolerance for decimal artifacts; every ApplicableTradeTax has a parseable rate and a known category (S, Z, E, AE, K, G, O); the currency is a valid ISO 4217 code; and for Factur-X PDFs, the XMP conformance claim is compared with the XML's completeness (informational). NOT checked: full XSD schema validation (the official schema set is huge — this is an honest structural + semantic check, not schema validation), signatures and e-seals (no cryptographic verification at all), and any business rules beyond the checks listed above.",
        hi: "जाँचा जाता है: रूट CrossIndustryInvoice (CII) है; ExchangedDocumentContext और गाइडलाइन; इनवॉइस नंबर; जारी तारीख़ (CII फ़ॉर्मैट 102, YYYYMMDD, या मान्य ISO रूप); डॉक्युमेंट टाइप कोड (380 इनवॉइस, 381 क्रेडिट नोट, 384 संशोधित…); विक्रेता और क्रेता के नाम (ख़ाली होने पर चेतावनी); कम-से-कम एक लाइन आइटम, हर लाइन में नाम और डॉट-दशमलव शुद्ध राशि; तीनों टोटल की क्रॉस-जाँच — लाइन नेट का योग = TaxBasisTotalAmount, GrandTotal = टैक्स-आधार + टैक्स योग, DuePayable = कुल − अग्रिम, हर एक ±0.01 सहनशीलता के साथ; हर ApplicableTradeTax की दर पढ़ने-योग्य और श्रेणी ज्ञात हो (S, Z, E, AE, K, G, O); मुद्रा मान्य ISO 4217 कोड हो; और Factur-X PDF पर XMP के दावे की तुलना XML की पूर्णता से (जानकारी भर)। जाँचा नहीं जाता: पूरा XSD स्कीमा वैलिडेशन (आधिकारिक स्कीमा सेट बहुत बड़ा है — यह ईमानदार स्ट्रक्चरल + सिमेंटिक जाँच है, स्कीमा वैलिडेशन नहीं), सिग्नेचर और ई-सील (कोई क्रिप्टोग्राफ़िक जाँच बिल्कुल नहीं), और ऊपर लिखी जाँचों से आगे का कोई बिज़नेस नियम नहीं।",
      },
    },
    {
      q: {
        en: "Can I validate the invoice inside a PDF, or only raw XML files?",
        hi: "क्या PDF के अंदर वाली इनवॉइस भी जाँच सकते हैं, या सिर्फ़ XML फ़ाइलें?",
      },
      a: {
        en: "Both. Drop either file type — the tool sniffs the magic bytes: a PDF is opened with the in-browser PDF engine and its embedded XML is extracted (by name priority: factur-x.xml, then zugferd-invoice.xml, then any embedded .xml); an XML file is validated directly. A PDF with no XML attachment fails honestly with a clear message — the tool never guesses at invoice data hidden in page text. And the verdict never overstates: a PASS means the listed checks passed, not that the invoice is legally flawless.",
        hi: "दोनों। कोई भी फ़ाइल डालें — टूल मैजिक बाइट्स से पहचानता है: PDF होने पर उसे ब्राउज़र के PDF इंजन से खोलकर जुड़ा XML निकाला जाता है (नाम की प्राथमिकता: factur-x.xml, फिर zugferd-invoice.xml, फिर कोई भी .xml); XML फ़ाइल सीधे जाँची जाती है। जिस PDF में कोई XML अटैचमेंट नहीं, वह साफ़ संदेश के साथ ईमानदारी से अस्वीकृत — पेज के टेक्स्ट में छिपी इनवॉइस की टूल कभी अंदाज़ा नहीं लगाता। और फ़ैसला कभी बढ़ा-चढ़ाकर नहीं: PASS का मतलब है सूची की जाँचें पास हुईं, यह नहीं कि इनवॉइस क़ानूनी रूप से बेदाग़ है।",
      },
    },
    {
      q: {
        en: "Why does a totals mismatch fail but some things only warn?",
        hi: "टोटल बेमेल पर FAIL क्यों, और कुछ चीज़ें सिर्फ़ चेतावनी क्यों?",
      },
      a: {
        en: "Because the checks are ranked by what breaks an e-invoice in practice. Wrong arithmetic (Σ line nets ≠ TaxBasis, GrandTotal ≠ basis + tax, Due ≠ grand − prepaid), a missing invoice number, an impossible date, or an unparseable amount is a hard FAIL — receivers reject such files. Missing buyer/seller names, an absent DuePayableAmount, an exotic currency code or an unrecognized type code are warnings: worth fixing, but they don't make the file un-parseable. The verdict follows the strictest signal: any FAIL fails the whole report, any warning alone means PASS WITH WARNINGS.",
        hi: "क्योंकि जाँचें व्यवहार में क्या इनवॉइस तोड़ती है, उस हिसाब से क्रमबद्ध हैं। ग़लत अंकगणित (लाइन नेट का योग ≠ TaxBasis, GrandTotal ≠ आधार + टैक्स, Due ≠ कुल − अग्रिम), ग़ायब इनवॉइस नंबर, नामुमकिन तारीख़, या न पढ़ी जा सकने वाली राशि — सख़्त FAIL है, ऐसी फ़ाइलें पाने वाले ठुकरा देते हैं। विक्रेता/क्रेता का नाम न होना, DuePayableAmount ग़ायब होना, दुर्लभ मुद्रा कोड या अनजाना टाइप कोड — चेतावनियाँ हैं: ठीक करना ठीक, पर फ़ाइल पढ़ने-जोग़ बनी रहती है। फ़ैसला सबसे सख़्त संकेत से चलता है: एक भी FAIL पूरी रिपोर्ट फेल कर देता है, अकेली चेतावनी का मतलब PASS WITH WARNINGS।",
      },
    },
    {
      q: {
        en: "Is my invoice safe? Where does this happen?",
        hi: "क्या मेरी इनवॉइस सुरक्षित है? यह सब कहाँ होता है?",
      },
      a: {
        en: "Entirely inside your browser — a Web Worker reads the bytes, extracts the embedded XML, runs every check and builds the report on this device. Nothing is uploaded, no account, no queue; the downloadable report is generated in the same worker, on-device too.",
        hi: "पूरा काम आपके ब्राउज़र में — एक वर्कर थ्रेड बाइट्स पढ़ती है, जुड़ा XML निकालती है, हर जाँच चलाती है और रिपोर्ट इसी डिवाइस पर बनाती है। कुछ अपलोड नहीं होता, न खाता, न क़तार; डाउनलोड होने वाली रिपोर्ट भी उसी वर्कर में, डिवाइस पर ही बनती है।",
      },
    },
  ],
};
