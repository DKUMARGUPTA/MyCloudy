import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF invoice → e-invoice (RB5-c). Two honest paths, 100% on-device:
 *
 *  Path A — the file carries an embedded Factur-X / ZUGFeRD CII XML
 *  attachment (the REAL e-invoice case): pdf.js reads the attachment
 *  (and a raw /AF catalog walk catches producers that attach outside
 *  the name tree), the CII fields are summarized with their source
 *  elements, and the .xml itself is downloaded byte-exact.
 *
 *  Path B — a plain visual invoice PDF (no XML): the text layer is
 *  read inside the Web Worker and the fields are SNIFFED from the
 *  layout — best-effort, every field with a confidence chip and the
 *  exact matched text, "not found" for everything else, and an
 *  invoice.json download. The UI labels this path clearly; the FAQ
 *  says outright: for real e-invoicing use the embedded-XML path.
 *
 * No options are needed (attachments are document-level; Path B runs
 * under a fixed honesty page cap) — the surface syncs locale + the
 * output fallback word through the "run" payload like repair-pdf.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-e-invoice",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  outputKind: "text",
  howKeys: ["peinv.how1", "peinv.how2", "peinv.how3"],
  options: [],
  features: [
    {
      en: "Embedded e-invoice XML extracted on your device — when the PDF carries a Factur-X / ZUGFeRD attachment (what tax portals and e-invoicing portals actually consume), the tool reads it inside a Web Worker, summarizes the invoice fields from the structured XML, and downloads the .xml byte-exact. Nothing is uploaded.",
      hi: "जुड़ा हुआ ई-इनवॉइस XML आपके डिवाइस पर ही निकलता है — जब PDF में Factur-X / ZUGFeRD अटैचमेंट हो (जो टैक्स पोर्टल और ई-इनवॉइसिंग पोर्टल असल में पढ़ते हैं), तो टूल वेब वर्कर में उसे पढ़ता है, स्ट्रक्चर्ड XML से इनवॉइस फ़ील्ड समेटता है, और .xml हूबहू डाउनलोड करता है। कुछ भी अपलोड नहीं होता।",
    },
    {
      en: "Plain invoice PDFs get an honest best-effort read — no XML? The layout is sniffed: invoice number, dates in many formats, GSTIN (with the official mod-36 checksum verified), VAT id, currency (₹ → INR and friends) and totals. Every field carries a High/Medium/Low confidence chip plus the exact text it was read from, and anything not found is shown as not found — never invented.",
      hi: "सादी इनवॉइस PDF का ईमानदार बेस्ट-एफ़र्ट पाठ — XML नहीं है? लेआउट पढ़ा जाता है: इनवॉइस नंबर, कई फ़ॉर्मैट में तारीख़ें, GSTIN (आधिकारिक mod-36 चेकसम सहित जाँचा हुआ), VAT आईडी, मुद्रा (₹ → INR आदि) और कुल योग। हर फ़ील्ड पर High/Medium/Low भरोसा चिप और वही टेक्स्ट जिससे पढ़ा गया — जो नहीं मिला वह \"नहीं मिला\" दिखता है, कभी मनगढ़ंत नहीं।",
    },
    {
      en: "Verify-before-use by design — the fallback path is a heuristic reading of ink, and it says so in the results and the FAQ; for real e-invoicing compliance, generate PDFs with an embedded XML (the Electronic invoice tool builds exactly those) and use this one to read them back.",
      hi: "डिज़ाइन से ही \"इस्तेमाल से पहले जाँचें\" — फ़ॉलबैक पाथ स्याही की स्थिति का अनुमानित पाठ है, और नतीजे व FAQ में यही साफ़ कहा जाता है; असली ई-इनवॉइसिंग के लिए जुड़ा XML वाली PDF बनाएँ (Electronic invoice टूल वही बनाता है) और उसे वापस पढ़ने के लिए यह टूल चलाएँ।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between the two result banners — green and amber?",
        hi: "दो नतीजा बैनर — हरा और एम्बर — में क्या फ़र्क़ है?",
      },
      a: {
        en: "Green means Path A: the PDF itself carries an embedded Factur-X / ZUGFeRD (CII) XML attachment — the machine-readable e-invoice that portals consume. The tool extracts that XML verbatim, downloads the .xml, and summarizes its fields with the element each one came from. Amber means Path B: no XML is embedded, so the tool read the visible layout of the invoice and sniffed the fields heuristically — useful, clearly best-effort, and every value shows the exact text it came from plus a confidence chip so you can verify before using it.",
        hi: "हरा यानी पाथ A: PDF में ख़ुद जुड़ा Factur-X / ZUGFeRD (CII) XML अटैचमेंट है — वही मशीन-पढ़ने-योग्य ई-इनवॉइस जिसे पोर्टल पढ़ते हैं। टूल वह XML हूबहू निकालकर .xml डाउनलोड करता है और हर फ़ील्ड के साथ वह एलिमेंट दिखाता है जिससे वह आया। एम्बर यानी पाथ B: कोई XML नहीं जुड़ा, इसलिए टूल ने इनवॉइस का दिखता लेआउट पढ़कर फ़ील्ड अनुमान से खोजे — उपयोगी, साफ़ तौर पर बेस्ट-एफ़र्ट, और हर मान के साथ वही टेक्स्ट और भरोसा चिप है ताकि इस्तेमाल से पहले आप जाँच सकें।",
      },
    },
    {
      q: {
        en: "How reliable is the fallback (amber) extraction?",
        hi: "फ़ॉलबैक (एम्बर) एक्स्ट्रैक्शन कितना भरोसेमंद है?",
      },
      a: {
        en: "It is a conservative reading of the page's text layer, and it never guesses. Fields not matched are shown as \"not found\"; GSTIN hits are checksum-verified with the official mod-36 algorithm (a passing checksum is a strong signal, a failing one is flagged); dates come from the matched text, not arithmetic; totals take the last matching line with a largest-number sanity check. For anything official — filing, portals, IRN — use the embedded-XML path or generate a proper e-invoice PDF first (the Electronic invoice tool), then read it back here.",
        hi: "यह पेज के टेक्स्ट-लेयर का संयत पाठ है, और यह कभी अंदाज़ा नहीं लगाता। जो फ़ील्ड नहीं मिले वे \"नहीं मिला\" दिखते हैं; GSTIN आधिकारिक mod-36 एल्गोरिद्म से चेकसम-जाँचे जाते हैं (सही चेकसम मज़बूत संकेत है, ग़लत चेकसम चिह्नित होता है); तारीख़ें मैच हुए टेक्स्ट से आती हैं, हिसाब से नहीं; कुल योग आख़िरी मैच लाइन से लिए जाते हैं जिसमें सबसे-बड़ी-संख्या की समझदारी जुड़ी होती है। किसी आधिकारिक काम के लिए — रिटर्न, पोर्टल, IRN — जुड़े-XML वाला पाथ चुनें या पहले ठीक ई-इनवॉइस PDF बनाएँ (Electronic invoice टूल), फिर यहाँ वापस पढ़ें।",
      },
    },
    {
      q: {
        en: "My PDF is a scan / a photo — what happens?",
        hi: "मेरी PDF स्कैन या फ़ोटो है — तब क्या होगा?",
      },
      a: {
        en: "A scan has no embedded XML and no selectable text, so the tool stops honestly with \"this PDF is not an e-invoice\" instead of pretending — run the PDF OCR tool on it first (English and Hindi are supported), then bring the result back here for the layout read. Password-protected files fail with a clear password message (unlock first), and a damaged file fails as corrupt rather than as a wrong guess.",
        hi: "स्कैन में न जुड़ा XML होता है न चुनने योग्य टेक्स्ट, इसलिए टूल दिखावा करने की जगह साफ़ रुक जाता है — \"यह PDF ई-इनवॉइस नहीं है\"। पहले उस पर PDF OCR टूल चलाएँ (अंग्रेज़ी और हिंदी समर्थित), फिर नतीजा यहाँ लाकर लेआउट पढ़वाएँ। पासवर्ड वाली फ़ाइल साफ़ पासवर्ड संदेश देती है (पहले अनलॉक करें), और ख़राब फ़ाइल ग़लत अंदाज़े की जगह corrupt कहलाती है।",
      },
    },
  ],
};
