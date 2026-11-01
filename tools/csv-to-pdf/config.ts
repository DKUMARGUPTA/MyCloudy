import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * CSV → PDF (PHASE-3 batch 3): turn comma/semicolon/tab-separated data
 * into a clean, print-grade table PDF — measured columns, bold header
 * repeated on every page, zebra rows and a hairline grid. RFC-4180
 * parsing handles quoted fields with embedded commas and newlines.
 */
export const config: ToolConfig = {
  toolId: "csv-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 10,
  options: [
    {
      kind: "select",
      id: "delimiter",
      label: { en: "Delimiter", hi: "विभाजक" },
      choices: [
        { value: "comma", label: { en: "Comma ( , )", hi: "कॉमा ( , )" } },
        { value: "semicolon", label: { en: "Semicolon ( ; )", hi: "सेमीकोलन ( ; )" } },
        { value: "tab", label: { en: "Tab", hi: "टैब" } },
      ],
      default: "comma",
    },
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
        { value: "a3", label: { en: "A3", hi: "A3" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      choices: [
        { value: "portrait", label: { en: "Portrait", hi: "पोर्ट्रेट" } },
        { value: "landscape", label: { en: "Landscape", hi: "लैंडस्केप" } },
      ],
      default: "portrait",
    },
    {
      kind: "number",
      id: "fontSize",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      min: 6,
      max: 14,
      step: 1,
      default: 9,
    },
    {
      kind: "switch",
      id: "header",
      label: { en: "First row is the header", hi: "पहली पंक्ति हेडर है" },
      default: true,
    },
    {
      kind: "switch",
      id: "zebra",
      label: { en: "Zebra striping", hi: "ज़ेबरा स्ट्राइप" },
      default: true,
    },
    {
      kind: "switch",
      id: "grid",
      label: { en: "Grid lines", hi: "ग्रिड लाइनें" },
      default: true,
    },
  ],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Real CSV parsing — quoted fields, embedded commas and line breaks all survive.",
      hi: "असली CSV पार्सिंग — कोट वाले फ़ील्ड, अंदर के कॉमा और लाइन-ब्रेक सब बचते हैं।",
    },
    {
      en: "Print-grade tables: measured columns, bold header, zebra rows, hairline grid.",
      hi: "छपाई-लायक टेबल: नापे हुए कॉलम, बोल्ड हेडर, ज़ेबरा पंक्तियाँ, बारीक ग्रिड।",
    },
    {
      en: "The header repeats on every continuation page — wide tables stay readable.",
      hi: "हेडर हर अगले पेज पर दोहराया जाता है — चौड़े टेबल पढ़ने में आसान रहते हैं।",
    },
    {
      en: "Comma, semicolon or tab delimiters; A4, Letter or A3, portrait or landscape.",
      hi: "कॉमा, सेमीकोलन या टैब विभाजक; A4, लेटर या A3, पोर्ट्रेट या लैंडस्केप।",
    },
    {
      en: "Up to 10 files in one run, one PDF each — everything on your device.",
      hi: "एक रन में 10 फ़ाइलें, हर एक की अपनी PDF — सब कुछ आपके डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "My CSV uses semicolons — will it work?",
        hi: "मेरी CSV में सेमीकोलन हैं — क्या चलेगा?",
      },
      a: {
        en: "Yes — switch the Delimiter option to semicolon (common for European exports) or tab.",
        hi: "हाँ — विभाजक विकल्प को सेमीकोलन (यूरोपीय एक्सपोर्ट में आम) या टैब पर रखें।",
      },
    },
    {
      q: {
        en: "How wide can a table get?",
        hi: "टेबल कितना चौड़ा हो सकता है?",
      },
      a: {
        en: "Up to 60 columns. Column widths are measured against the content and capped at a third of the page, shrinking proportionally to fit — very wide tables are better on A3 landscape.",
        hi: "60 कॉलम तक। कॉलम की चौड़ाई सामग्री देखकर तय होती है और पेज के एक-तिहाई पर रुकती है, फिट होने के लिए घटती है — बहुत चौड़े टेबल A3 लैंडस्केप पर बेहतर।",
      },
    },
    {
      q: {
        en: "Are formulas or numbers converted?",
        hi: "फ़ॉर्मूले या नंबर बदले जाते हैं?",
      },
      a: {
        en: "No — CSV is plain text, so every cell renders exactly as written. Need calculations? Use Excel to PDF for a real spreadsheet.",
        hi: "नहीं — CSV सादा टेक्स्ट है, हर सेल वैसा ही छपता है जैसा लिखा है। हिसाब चाहिए तो असली स्प्रेडशीट के लिए Excel to PDF लें।",
      },
    },
  ],
};
