import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove PDF pages — PageGrid family preset "remove" (PRD §8.1):
 * select to delete, or type "2,5-7", plus "remove blank pages"
 * auto-detect. Safety: the CTA disables when every page would be deleted.
 */
export const config: ToolConfig = {
  toolId: "remove-pdf-pages",
  createWorker: () =>
    new Worker(new URL("../pagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Click pages to select them, or type a range like 2, 5-7.",
      hi: "पेज पर क्लिक करके चुनें, या 2, 5-7 जैसी रेंज लिखें।",
    },
    {
      en: "One tap removes auto-detected blank pages.",
      hi: "एक टैप में ख़ाली पेज पहचान कर हटाएँ।",
    },
    {
      en: "Undo brings any deleted page back (Ctrl+Z).",
      hi: "हटाया पेज Ctrl+Z से वापस आ जाता है।",
    },
    {
      en: "Nothing is uploaded — the file never leaves your device.",
      hi: "कुछ भी अपलोड नहीं होता — फ़ाइल आपके डिवाइस पर रहती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I undo a deletion?",
        hi: "क्या हटाना वापस ले सकते हैं?",
      },
      a: {
        en: "Yes. Every delete is on the undo stack — Ctrl+Z (or the Undo button) restores the page exactly where it was.",
        hi: "हाँ। हर हटाना undo स्टैक पर रहता है — Ctrl+Z (या Undo बटन) पेज वहीं वापस ले आता है।",
      },
    },
    {
      q: {
        en: "How does blank-page detection work?",
        hi: "ख़ाली पेज पहचान कैसे होती है?",
      },
      a: {
        en: "Each page is checked for text and visually scanned at low resolution — pages with no text and near-empty pixels are flagged as blank, then removed in one undoable action.",
        hi: "हर पेज का टेक्स्ट और कम रेज़ॉल्यूशन पर पिक्सल जाँचा जाता है — बिना टेक्स्ट और लगभग ख़ाली पेज चिन्हित होकर एक बार में हट जाते हैं।",
      },
    },
    {
      q: {
        en: "Are my files uploaded anywhere?",
        hi: "क्या मेरी फ़ाइल कहीं अपलोड होती है?",
      },
      a: {
        en: "No. Everything runs in your browser with Web Workers — the file never leaves your device.",
        hi: "नहीं। सब कुछ आपके ब्राउज़र में Web Workers से चलता है — फ़ाइल डिवाइस से बाहर नहीं जाती।",
      },
    },
  ],
};
