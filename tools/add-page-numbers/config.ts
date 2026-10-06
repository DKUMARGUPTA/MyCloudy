import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add page numbers (PRD §8.2): number formats (1 / Page 1 / 1 of N /
 * Page 1 of N / i / I / a / A), start number, 9-grid position + margin,
 * font, skip first page (and the full layout family), optional Hindi digits
 * via the self-hosted embedded Devanagari font. Custom panel + live preview
 * surface own every interactive value (split-tool pattern — schema stays
 * empty, worker defaults defensively).
 */
export const config: ToolConfig = {
  toolId: "add-page-numbers",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: [
    "add-header-footer",
    "pdf-to-jpg",
    "pdf-to-png",
    "merge-pdf",
  ],
  features: [
    {
      en: "Eight formats: 1 · Page 1 · 1 of N · Page 1 of N · roman i, I · letters a, A.",
      hi: "आठ फ़ॉर्मैट: 1 · Page 1 · 1 of N · Page 1 of N · रोमन i, I · अक्षर a, A।",
    },
    {
      en: "Start from any number, place it anywhere on a 9-position grid, and set the edge distance.",
      hi: "किसी भी नंबर से शुरू करें, 9-स्थिति ग्रिड पर कहीं भी रखें, किनारे से दूरी तय करें।",
    },
    {
      en: "Hindi digits (०१२३) optional — the font is embedded right inside your PDF.",
      hi: "हिंदी अंक (०१२३) वैकल्पिक — फ़ॉन्ट आपकी PDF के अंदर ही जुड़ जाता है।",
    },
    {
      en: "Number every page, or skip the first (a title page), or any range you pick.",
      hi: "हर पेज पर नंबर लगाएँ, या पहला (टाइटल पेज) छोड़ें, या कोई भी रेंज चुनें।",
    },
    {
      en: "Live preview shows the exact number before you run anything — on your device only.",
      hi: "लाइव प्रीव्यू चलाने से पहले ही सटीक नंबर दिखाता है — सब आपके डिवाइस पर।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I start numbering from a different page?",
        hi: "क्या किसी दूसरे पेज से नंबरिंग शुरू कर सकते हैं?",
      },
      a: {
        en: "Yes — set a start number and choose “Skip the first page” in Pages. Page 2 will then show your start number.",
        hi: "हाँ — स्टार्ट नंबर सेट करें और पेज में “पहला पेज छोड़ें” चुनें। दूसरा पेज आपका स्टार्ट नंबर दिखाएगा।",
      },
    },
    {
      q: {
        en: "What does “of N” count?",
        hi: "“of N” में N क्या गिनता है?",
      },
      a: {
        en: "N is the total number of pages in the PDF. With a start number, the last page can show more than N — that keeps “Page x of N” honest.",
        hi: "N पूरी PDF में पेजों की कुल संख्या है। स्टार्ट नंबर होने पर आख़िरी पेज N से बड़ा दिख सकता है — इससे “Page x of N” सही रहता है।",
      },
    },
    {
      q: {
        en: "Will Hindi digits work on any device?",
        hi: "हिंदी अंक हर डिवाइस पर चलेंगे?",
      },
      a: {
        en: "Yes — when you turn Hindi digits on, we embed a small subset of a Devanagari font inside the PDF itself, so it renders even where no Hindi font is installed.",
        hi: "हाँ — हिंदी अंक चालू करने पर PDF के अंदर ही देवनागरी फ़ॉन्ट का छोटा हिस्सा जुड़ जाता है, तो बिना हिंदी फ़ॉन्ट वाले डिवाइस पर भी दिखता है।",
      },
    },
  ],
};
