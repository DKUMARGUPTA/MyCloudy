import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * CSV to PDF (P3-b / R56) — comma-separated data → a clean table PDF,
 * 100% on-device (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone (accepts any file — the worker
 * does its own honest parsing), OptionsPanel (delimiter auto/comma/
 * semicolon/tab, header row toggle, orientation, page size, zebra,
 * fit-to-width), the worker parses the full RFC 4180 document (quoted
 * fields, embedded line breaks) and paints every file as its own
 * table with the shared data-table painter on our OWN PDF engine.
 */
export const config: ToolConfig = {
  toolId: "csv-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "delimiter",
      label: { en: "Delimiter", hi: "डेलिमिटर" },
      hint: {
        en: "Auto reads the first lines and picks the separator that splits them most consistently.",
        hi: "ऑटो पहली पंक्तियाँ पढ़कर वह सेपरेटर चुनता है जो उन्हें सबसे एकसार तोड़े।",
      },
      choices: [
        { value: "auto", label: { en: "Auto-detect", hi: "ऑटो-डिटेक्ट" } },
        { value: "comma", label: { en: "Comma ( , )", hi: "कॉमा ( , )" } },
        { value: "semicolon", label: { en: "Semicolon ( ; )", hi: "सेमीकोलन ( ; )" } },
        { value: "tab", label: { en: "Tab", hi: "टैब" } },
      ],
      default: "auto",
    },
    {
      kind: "switch",
      id: "header",
      label: { en: "First row is the header", hi: "पहली पंक्ति हेडर है" },
      hint: {
        en: "Bold the first row and repeat it at the top of every continuation page.",
        hi: "पहली पंक्ति बोल्ड हो और हर अगले पेज पर ऊपर दोहराई जाए।",
      },
      default: true,
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "ओरिएंटेशन" },
      hint: {
        en: "Landscape gives wide tables more room per column.",
        hi: "लैंडस्केप में चौड़ी टेबलों को हर कॉलम में ज़्यादा जगह मिलती है।",
      },
      choices: [
        { value: "portrait", label: { en: "Portrait", hi: "पोर्ट्रेट" } },
        { value: "landscape", label: { en: "Landscape", hi: "लैंडस्केप" } },
      ],
      default: "portrait",
    },
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "A4 (210 × 297 mm) or US Letter (8.5 × 11 in).",
        hi: "A4 (210 × 297 मिमी) या US लेटर (8.5 × 11 इंच)।",
      },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
      ],
      default: "a4",
    },
    {
      kind: "switch",
      id: "fit",
      label: { en: "Fit table to page width", hi: "टेबल पेज-चौड़ाई में फ़िट करें" },
      hint: {
        en: "Stretch or shrink the columns so the table exactly fills the printable width.",
        hi: "कॉलम खींचकर या सिकोड़कर टेबल प्रिंट-योग्य चौड़ाई में भर दे।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "zebra",
      label: { en: "Zebra striping", hi: "ज़ेबरा स्ट्राइप" },
      hint: {
        en: "A light background on alternate rows keeps wide tables readable.",
        hi: "हर दूसरी पंक्ति पर हल्का बैकग्राउंड चौड़ी टेबल को पढ़ने में आसान बनाता है।",
      },
      default: true,
    },
  ],
  chainToolIds: ["compress-pdf", "view-pdf"],
  features: [
    {
      en: "CSV becomes a proper table PDF — bold header row, hairline grid, wrapped text and automatic page breaks that repeat the header, all real selectable text.",
      hi: "CSV एक असली टेबल PDF बन जाती है — बोल्ड हेडर पंक्ति, बारीक ग्रिड, लिपेटा हुआ टेक्स्ट और हेडर दोहराने वाले ऑटोमैटिक पेज-ब्रेक, सब असली चुनने योग्य टेक्स्ट।",
    },
    {
      en: "The full RFC 4180 dialect is honoured: quoted fields, commas and line breaks inside quotes, doubled quotes — nothing breaks the grid.",
      hi: "पूरा RFC 4180 डायलेक्ट माना जाता है: कोट वाले फ़ील्ड, कोट के अंदर का कॉमा और लाइन-ब्रेक, दोहरे कोट — कुछ भी ग्रिड नहीं तोड़ता।",
    },
    {
      en: "Auto-detect picks between comma, semicolon and tab from your file's own consistency — or pin the delimiter yourself. Up to 5 CSVs paint into one PDF, each as its own titled table.",
      hi: "ऑटो-डिटेक्ट आपकी फ़ाइल की एकरूपता से कॉमा, सेमीकोलन और टैब में चुनता है — या डेलिमिटर खुद तय करें। 5 CSV तक एक PDF में बनती हैं, हर एक अपने शीर्षक वाली टेबल।",
    },
    {
      en: "Hindi and mixed data print properly — Devanagari text or ₹ amounts embed the Noto font automatically.",
      hi: "हिन्दी और मिश्रित डेटा सही छपता है — देवनागरी टेक्स्ट या ₹ राशि पर Noto फ़ॉन्ट अपने-आप जुड़ जाता है।",
    },
    {
      en: "Your data never leaves the device — parsing and rendering happen in your browser. Up to 100 columns × 2,000 rows per file, with the cut honestly reported.",
      hi: "आपका डेटा डिवाइस से बाहर नहीं जाता — पार्सिंग और रेंडरिंग ब्राउज़र में होती है। हर फ़ाइल में 100 कॉलम × 2,000 पंक्तियाँ तक, कटौती की साफ़ जानकारी के साथ।",
    },
  ],
  faq: [
    {
      q: {
        en: "What does auto-detect actually look at?",
        hi: "ऑटो-डिटेक्ट असल में क्या देखता है?",
      },
      a: {
        en: "It reads the first 50 lines, counts commas, semicolons and tabs outside quoted fields, and picks the separator that splits those lines into the most consistent column count. A single-column file falls back to comma. If you already know the dialect, pin it in the options.",
        hi: "यह पहली 50 पंक्तियाँ पढ़ता है, कोट के बाहर के कॉमा, सेमीकोलन और टैब गिनता है, और वह सेपरेटर चुनता है जो उन पंक्तियों को सबसे एकसार कॉलमों में तोड़े। सिंगल-कॉलम फ़ाइल को कॉमा पर छोड़ देता है। अगर डायलेक्ट पहले से पता है, तो विकल्पों में तय कर दें।",
      },
    },
    {
      q: {
        en: "What are the size limits?",
        hi: "आकार की सीमाएँ क्या हैं?",
      },
      a: {
        en: "Each file renders its first 100 columns and 2,000 rows — anything beyond is honestly cut, never silently garbled. Long cell text wraps within its column and a row that would outgrow a page is ellipsized, so the table always terminates cleanly.",
        hi: "हर फ़ाइल अपने पहले 100 कॉलम और 2,000 पंक्तियाँ रेंडर करती है — उसके आगे कुछ भी चुपचाप बिगड़ता नहीं, साफ़ कटता है। लंबा सेल-टेक्स्ट अपने कॉलम में लिपटता है और पेज से बड़ी होने वाली पंक्ति इलिप्सिस के साथ कटती है, ताकि टेबल हमेशा साफ़ पूरी हो।",
      },
    },
    {
      q: {
        en: "Is this the same as Excel to PDF?",
        hi: "क्या यह Excel to PDF जैसा ही है?",
      },
      a: {
        en: "The PDF output is the same clean table, but the input is plain CSV — no workbook, no formulas, no cached values. If you have an .xlsx file with multiple sheets, use Excel to PDF; if you have raw comma/semicolon/tab data from a script or export, this is the tool.",
        hi: "PDF आउटपुट वही साफ़ टेबल है, पर इनपुट सादी CSV है — कोई वर्कबुक नहीं, कोई फ़ॉर्मूला नहीं, कोई कैश वैल्यू नहीं। अगर आपके पास कई शीट वाली .xlsx फ़ाइल है तो Excel to PDF लें; स्क्रिप्ट या एक्सपोर्ट की रॉ कॉमा/सेमीकोलन/टैब डेटा के लिए यही टूल है।",
      },
    },
  ],
};
