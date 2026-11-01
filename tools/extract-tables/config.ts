import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Extract tables (PHASE-7): find the DISTINCT tables inside a PDF and
 * export each one as clean CSV. The engine segments pages into tabular
 * runs (paragraph text between tables never leaks in), snaps cells to
 * column anchors, and writes RFC-4180 CSV — one file per table in a
 * ZIP, or everything in one combined CSV. On-device, EN + हिंदी.
 */
export const config: ToolConfig = {
  toolId: "extract-tables",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
    {
      kind: "select",
      id: "delimiter",
      label: { en: "Delimiter", hi: "सेपरेटर" },
      choices: [
        { value: "comma", label: { en: "Comma ( , )", hi: "कॉमा ( , )" } },
        { value: "semicolon", label: { en: "Semicolon ( ; )", hi: "सेमीकोलन ( ; )" } },
        { value: "tab", label: { en: "Tab", hi: "टैब" } },
      ],
      default: "comma",
    },
    {
      kind: "select",
      id: "output",
      label: { en: "Output", hi: "आउटपुट" },
      choices: [
        {
          value: "zip",
          label: {
            en: "ZIP — one CSV per table",
            hi: "ZIP — हर टेबल की अपनी CSV",
          },
        },
        {
          value: "single",
          label: {
            en: "One combined CSV",
            hi: "एक ही मिली-जुली CSV",
          },
        },
      ],
      default: "zip",
    },
  ],
  chainToolIds: ["pdf-to-excel", "csv-to-pdf", "view-pdf"],
  features: [
    {
      en: "Finds the tables inside a page — two tables with a paragraph between them leave as two tables, not one mixed sheet.",
      hi: "पेज के अंदर की टेबलें पहचानता है — बीच में पैराग्राफ़ छोड़कर दो टेबलें दो टेबलें ही रहती हैं, मिली-जुली शीट नहीं।",
    },
    {
      en: "Every cell lands in its true column — x-positions snap to column anchors, so jagged rows keep their shape.",
      hi: "हर सेल अपने सही कॉलम में बैठता है — x-स्थितियाँ कॉलम एंकर से जुड़ती हैं, इसलिए टेढ़ी-मेढ़ी पंक्तियाँ भी अपना आकार रखती हैं।",
    },
    {
      en: "Clean CSV, spreadsheet-ready: RFC-4180 quoting, comma / semicolon / tab delimiter, one file per table or one combined file.",
      hi: "साफ़ CSV, स्प्रेडशीट के लिए तैयार: RFC-4180 कोटिंग, कॉमा / सेमीकोलन / टैब सेपरेटर, हर टेबल की अलग फ़ाइल या सब एक में।",
    },
    {
      en: "Choose the pages — extract the annexure tables without re-reading the whole document.",
      hi: "पेज चुनें — पूरा दस्तावेज़ दोबारा पढ़े बिना सिर्फ़ अनुलग्नक की टेबलें निकालें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from PDF to Excel?",
        hi: "यह PDF to Excel से कैसे अलग है?",
      },
      a: {
        en: "PDF to Excel turns each page into a workbook sheet — great when the whole page is the table. This tool finds the tables themselves: a page with a paragraph and two tables exports exactly those two tables as CSV, nothing else.",
        hi: "PDF to Excel हर पेज को वर्कबुक शीट बना देता है — जब पूरा पेज ही टेबल हो तो बढ़िया। यह टूल टेबलें ख़ुद ढूँढता है: पैराग्राफ़ और दो टेबलों वाला पेज ठीक वही दो टेबलें CSV में भेजता है, और कुछ नहीं।",
      },
    },
    {
      q: {
        en: "My scanned table came back with nothing — why?",
        hi: "मेरी स्कैन की टेबल ख़ाली लौटी — क्यों?",
      },
      a: {
        en: "Scans are pictures — there is no selectable text to cluster. Run the OCR tool first, then extract tables from the OCRed copy.",
        hi: "स्कैन तस्वीर है — जोड़ने लायक कोई टेक्स्ट है ही नहीं। पहले OCR टूल चलाएँ, फिर OCR वाली कॉपी से टेबलें निकालें।",
      },
    },
    {
      q: {
        en: "Why is one of my columns empty in some rows?",
        hi: "कुछ पंक्तियों में मेरा एक कॉलम ख़ाली क्यों है?",
      },
      a: {
        en: "That cell is empty in the PDF too — or holds a value the author drew slightly off the column grid. The CSV keeps the true column structure, so empty cells stay empty instead of shifting data left.",
        hi: "वह सेल PDF में भी ख़ाली है — या लेखक ने उसे कॉलम-ग्रिड से थोड़ा हटाकर बनाया है। CSV सही कॉलम-ढाँचा रखती है, इसलिए ख़ाली सेल ख़ाली रहते हैं, बायीं ओर खिसकते नहीं।",
      },
    },
  ],
};
