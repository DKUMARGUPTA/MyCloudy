import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * XML e-invoice to PDF (RB5-d — the 87th tool). CII XML → clean vector
 * PDF, 100% on-device (a Web Worker parses the rsm:CrossIndustryInvoice
 * and paints it with pdf-lib), EN + हिंदी.
 *
 * The surface (tools/xml-invoice-to-pdf/surface.tsx) owns the input flow:
 * a drop zone that sniffs the XML shape itself, a pre-render parse report
 * (fields found / missing chips + parse issues), A4/Letter toggle, and the
 * Convert button that spawns the worker. The shell CTA runs the same
 * worker through the standard pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - CII dialects only (rsm:CrossIndustryInvoice — Factur-X / ZUGFeRD
 *    1.0 + 2.x, XRechnung-style CII). UBL 2.1 is DETECTED and rejected
 *    with a clear "not supported yet" error — never a wrong render;
 *  - IncludedNote content renders as small footer text only; attachments
 *    embedded in the XML wrapper (PDF/A-3 parts) are ignored;
 *  - 80 line items render max (a printed truncation note says so), 10 MB
 *    XML cap;
 *  - Hindi bold renders as regular (the Noto OFL face ships Regular only).
 */
export const config: ToolConfig = {
  toolId: "xml-invoice-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "Most e-invoice rails print A4",
        hi: "ज़्यादातर ई-इनवॉइस सिस्टम A4 छापते हैं",
      },
      choices: [
        { value: "a4", label: { en: "A4 (210 × 297 mm)", hi: "A4 (210 × 297 मिमी)" } },
        { value: "letter", label: { en: "US Letter (8.5 × 11 in)", hi: "US लेटर (8.5 × 11 इंच)" } },
      ],
      default: "a4",
    },
  ],
  howKeys: ["xinv.how1", "xinv.how2", "xinv.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn CII e-invoice XML (rsm:CrossIndustryInvoice — the Factur-X / ZUGFeRD 1.0 + 2.x dialect) into a clean, readable A4 PDF entirely on your device — the file is parsed in your browser and never uploaded.",
      hi: "CII ई-इनवॉइस XML (rsm:CrossIndustryInvoice — Factur-X / ZUGFeRD 1.0 + 2.x रूप) को साफ़, पढ़ने योग्य A4 PDF में बदलें — पूरी तरह आपके डिवाइस पर। फ़ाइल आपके ब्राउज़र में ही खुलती है, कहीं अपलोड नहीं होती।",
    },
    {
      en: "Real selectable text, never a screenshot: seller and buyer blocks, a line-item table with quantities and unit codes (piece, hour, kg…), per-rate tax rows, grand total and amount due — bold, vector, searchable.",
      hi: "असली चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं: विक्रेता और खरीदार के ब्लॉक, मात्रा और यूनिट कोड (piece, hour, kg…) वाली आइटम टेबल, दर-वार कर पंक्तियाँ, कुल राशि और देय राशि — बोल्ड, वेक्टर, खोजने योग्य।",
    },
    {
      en: "Before converting, see exactly what the XML holds: found/missing chips for invoice number, dates, currency, parties, items and totals — and a plain list of everything the renderer filled in or left out. Missing fields never break the render.",
      hi: "बदलने से पहले देखें कि XML में ठीक क्या है: इनवॉइस नंबर, तारीख़ें, मुद्रा, पक्ष, आइटम और कुल के लिए मिला/नहीं मिला चिप्स — और उन सबकी साफ़ सूची जो रेंडरर ने भरा या छोड़ा। कोई फ़ील्ड missing होने से रेंडर कभी नहीं टूटता।",
    },
    {
      en: "Latin-only invoices export with the built-in Helvetica (nothing embedded, tiny files); any Devanagari — or ₹ amounts — switches those runs to the embedded Noto Sans Devanagari subset. English and हिंदी both print perfectly, and UBL files are detected and told apart honestly.",
      hi: "सिर्फ़ लैटिन वाले इनवॉइस बिल्ट-इन Helvetica से निकलते हैं (कुछ एम्बेड नहीं, छोटी फ़ाइल); कोई देवनागरी — या ₹ राशि — आते ही वह हिस्सा एम्बेडेड Noto Sans Devanagari सबसेट से छपता है। अंग्रेज़ी और हिंदी दोनों बेदाग़ छपती हैं, और UBL फ़ाइलें ईमानदारी से पहचानकर बता दी जाती हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which XML e-invoice formats does this support?",
        hi: "कौन से XML ई-इनवॉइस फ़ॉर्मैट चलते हैं?",
      },
      a: {
        en: "The CII dialect only: files whose root is rsm:CrossIndustryInvoice — the UN/CEFACT Cross Industry Invoice used by Factur-X and ZUGFeRD 1.0 and 2.x, and XRechnung-style CII. The parser matches local names, so the different namespace versions all read. UBL 2.1 files (root Invoice or CreditNote, the oasis.org schema) are detected and rejected with an honest \"UBL invoices are not supported yet\" — we never render a wrong document. EDIFACT, X12 and proprietary XML dialects are likewise rejected up front.",
        hi: "केवल CII रूप: जिन फ़ाइलों की जड़ rsm:CrossIndustryInvoice है — Factur-X और ZUGFeRD 1.0 व 2.x, और XRechnung-शैली का CII। पार्सर लोकल नाम मिलाता है, इसलिए अलग-अलग नेमस्पेस वर्ज़न सब पढ़े जाते हैं। UBL 2.1 फ़ाइलें (जड़ Invoice या CreditNote, oasis.org स्कीमा) पहचानी जाती हैं और ईमानदार \"UBL इनवॉइस अभी समर्थित नहीं\" के साथ अस्वीकार कर दी जाती हैं — हम कभी ग़लत दस्तावेज़ नहीं बनाते। EDIFACT, X12 और निजी XML बोलियाँ भी शुरू में ही अस्वीकार होती हैं।",
      },
    },
    {
      q: {
        en: "What is left out of the PDF — and what happens to incomplete XML?",
        hi: "PDF में क्या छूटता है — और अधूरे XML का क्या होता है?",
      },
      a: {
        en: "IncludedNote content renders as small footer text only, never as body sections. Attachments riding inside the XML wrapper (the embedded PDF of a Factur-X PDF/A-3 file) are ignored — this tool reads the business data and paints a fresh invoice. Incomplete XML never breaks the render: every missing piece becomes a visible note in the pre-render report and the result, and the PDF simply shows what exists. Very large files are capped honestly: 10 MB XML in, 80 line items rendered (a printed truncation note says so).",
        hi: "IncludedNote की सामग्री केवल छोटे फ़ुटर टेक्स्ट में छपती है, मुख्य भाग में कभी नहीं। XML आवरण के अंदर सवार अटैचमेंट (Factur-X PDF/A-3 फ़ाइल का जुड़ा PDF) नज़रअंदाज़ होते हैं — यह टूल बिज़नेस डेटा पढ़कर नया इनवॉइस बनाता है। अधूरा XML रेंडर नहीं तोड़ता: हर छूटा हिस्सा रिपोर्ट और परिणाम में दिखता है, और PDF जो मिला वही दिखाता है। बहुत बड़ी फ़ाइलें ईमानदारी से सीमित हैं: 10 MB XML तक, 80 आइटम तक छपते हैं (छपा नोट बता देता है)।",
      },
    },
    {
      q: {
        en: "Does it handle Hindi parties and items?",
        hi: "हिंदी पक्ष और आइटम चलते हैं?",
      },
      a: {
        en: "Yes. Every string is split into Latin and Devanagari runs: Latin-only invoices export with the built-in Helvetica and embed nothing; the moment a Devanagari character (or a ₹ amount) appears, those runs switch to the embedded Noto Sans Devanagari subset — so \"शर्मा ट्रेडिंग कंपनी\" as the seller prints correctly next to Latin item text. One honest limit: the Noto OFL face ships Regular only, so bold Hindi renders at regular weight.",
        hi: "हाँ। हर स्ट्रिंग लैटिन और देवनागरी हिस्सों में बँटती है: सिर्फ़ लैटिन इनवॉइस बिल्ट-इन Helvetica से निकलते हैं, कुछ एम्बेड नहीं होता; जैसे ही कोई देवनागरी अक्षर (या ₹ राशि) आता है, वह हिस्सा एम्बेडेड Noto Sans Devanagari सबसेट से छपता है — इसलिए विक्रेता \"शर्मा ट्रेडिंग कंपनी\" लैटिन आइटम टेक्स्ट के साथ सही छपता है। एक ईमानदार सीमा: Noto OFL फ़ेस में केवल Regular है, इसलिए बोल्ड हिंदी सामान्य मोटाई में छपती है।",
      },
    },
    {
      q: {
        en: "Where is my invoice processed, and is the PDF a legal e-invoice?",
        hi: "मेरा इनवॉइस कहाँ प्रोसेस होता है, और क्या यह PDF कानूनी ई-इनवॉइस है?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread parses the XML and paints the PDF; nothing is uploaded, no sign-up, no watermark. The output is a human-readable rendering of the XML data for printing, archiving and sharing — it is NOT a validated e-invoice: signatures, the embedded XML wrapper and schema validation are out of scope here (the dedicated e-invoice tools cover creation and validation).",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड XML पढ़ता और PDF बनाता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। निकली PDF XML डेटा का मानव-पठन प्रतिरूप है — छापने, संग्रह और साझा करने के लिए — यह मान्यांकित ई-इनवॉइस नहीं है: हस्ताक्षर, जुड़ा XML आवरण और स्कीमा जाँच इसके दायरे से बाहर हैं (वे काम ई-इनवॉइस टूल्स करते हैं)।",
      },
    },
  ],
};
