import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Divide PDF pages — cut every page into 2, 3 or 4 pieces, vertically
 * (columns), horizontally (rows) or both (grid). The general sibling of
 * "Halve pages": same /Rotate-aware crop engine, any piece count.
 * 100% on-device own-engine rebuild.
 */
export const config: ToolConfig = {
  toolId: "divide-page",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "axis",
      label: { en: "Cut direction", hi: "काटने की दिशा" },
      hint: {
        en: "Columns (vertical), rows (horizontal), or both.",
        hi: "कॉलम (खड़ा), पंक्तियाँ (आड़ा), या दोनों।",
      },
      choices: [
        { value: "vertical", label: { en: "Vertical — columns", hi: "खड़ा — कॉलम" } },
        { value: "horizontal", label: { en: "Horizontal — rows", hi: "आड़ा — पंक्तियाँ" } },
        { value: "grid", label: { en: "Grid — both", hi: "ग्रिड — दोनों" } },
      ],
      default: "vertical",
    },
    {
      kind: "select",
      id: "pieces",
      label: { en: "Pieces per axis", hi: "प्रति दिशा टुकड़े" },
      hint: {
        en: "Grid cuts apply this in both directions (3 → 3×3 = 9).",
        hi: "ग्रिड में दोनों दिशाओं में (3 → 3×3 = 9)।",
      },
      choices: [
        { value: "2", label: { en: "2", hi: "2" } },
        { value: "3", label: { en: "3", hi: "3" } },
        { value: "4", label: { en: "4", hi: "4" } },
      ],
      default: "2",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages to divide — all, or a range like 1-3, 5.",
        hi: "कौन से पेज काटने हैं — सभी, या 1-3, 5 जैसी रेंज।",
      },
      default: "all",
    },
  ],
  chainToolIds: ["merge-pdf", "rotate-pdf-pages", "pdf-to-jpg"],
  features: [
    {
      en: "Cut pages into 2, 3 or 4 columns, rows, or a grid.",
      hi: "पेज को 2, 3 या 4 कॉलम, पंक्तियों या ग्रिड में काटें।",
    },
    {
      en: "Divide only the pages you pick — the rest pass through untouched.",
      hi: "सिर्फ़ चुने पेज काटें — बाक़ी जैसे हैं वैसे रहते हैं।",
    },
    {
      en: "Rotated pages are cut exactly where the reader sees the line.",
      hi: "घुमाए पेज वहीं कटते हैं जहाँ पाठक रेखा देखता है।",
    },
    {
      en: "Pieces come out in reading order — columns left to right.",
      hi: "टुकड़े पढ़ने के क्रम में निकलते हैं — कॉलम बाएँ से दाएँ।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What's the difference from Halve pages?",
        hi: "आधे करें टूल से यह कैसे अलग है?",
      },
      a: {
        en: "Halve only cuts in two at the middle. Divide gives you 2, 3 or 4 pieces per axis and a grid mode — plus page-range picking in the same run.",
        hi: "आधे करें सिर्फ़ बीच में दो में काटता है। यहाँ प्रति दिशा 2, 3 या 4 टुकड़े और ग्रिड मोड मिलता है — साथ में पेज-रेंज चुनना भी।",
      },
    },
    {
      q: {
        en: "Does dividing re-compress or blur anything?",
        hi: "काटने से कुछ कंप्रेस या धुँधला होता है?",
      },
      a: {
        en: "No. Each piece is the same page with a smaller visible window — the content stream is copied byte-exact, so text stays sharp and searchable.",
        hi: "नहीं। हर टुकड़ा वही पेज है, बस छोटी दिखने वाली खिड़की के साथ — कंटेंट बाइट-एक्ज़ैक्ट कॉपी होता है, टेक्स्ट तेज़ और सर्च करने योग्य रहता है।",
      },
    },
    {
      q: {
        en: "Which pages does a grid 3 cut produce?",
        hi: "ग्रिड 3 काट से क्या बनता है?",
      },
      a: {
        en: "Nine pieces per page: a 3×3 grid, row by row from the top-left. Use page ranges to divide only the pages that need it.",
        hi: "प्रति पेज नौ टुकड़े: 3×3 ग्रिड, ऊपर-बाएँ से पंक्ति दर पंक्ति। ज़रूरत के पेज ही काटने के लिए पेज-रेंज इस्तेमाल करें।",
      },
    },
  ],
};
