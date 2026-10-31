import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove blank pages — scans every page's content for actual marks
 * (text, fills, strokes, images) and drops the pages that have none.
 * Own-engine content analysis, 100% on-device.
 */
export const config: ToolConfig = {
  toolId: "remove-blank-pages",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["merge-pdf", "remove-pdf-pages", "compress-pdf"],
  features: [
    {
      en: "Finds pages with no text, no drawing, no image — and drops them.",
      hi: "जिन पेज पर न टेक्स्ट है, न रेखा, न तस्वीर — वे हटा दिए जाते हैं।",
    },
    {
      en: "Honest detection — content streams are decoded and analysed, not guessed from file size.",
      hi: "ईमानदार पहचान — कंटेंट स्ट्रीम डिकोड कर जाँचे जाते हैं, अंदाज़े से नहीं।",
    },
    {
      en: "The classic cleanup for scans, printouts and exported notes.",
      hi: "स्कैन, प्रिंटआउट और एक्सपोर्ट नोट्स की क्लासिक सफ़ाई।",
    },
    {
      en: "Kept pages are copied byte-exact — nothing is re-rendered.",
      hi: "बचे पेज बाइट-एक्ज़ैक्ट कॉपी होते हैं — कुछ भी दोबारा रेंडर नहीं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What counts as a blank page?",
        hi: "खाली पेज किसे माना जाता है?",
      },
      a: {
        en: "A page whose content stream carries no marks — no text shown, no filled or stroked shapes, no images and no XObjects. Pages that only set graphics state (like an empty “q Q”) are blank too.",
        hi: "जिस पेज के कंटेंट स्ट्रीम में कोई निशान नहीं — न टेक्स्ट, न भरी/खिंची आकृति, न तस्वीर, न XObject। सिर्फ़ “q Q” जैसी खाली स्थिति वाले पेज भी खाली माने जाते हैं।",
      },
    },
    {
      q: {
        en: "Will it remove pages that look almost blank?",
        hi: "क्या लगभग खाली दिखने वाले पेज भी हटेंगे?",
      },
      a: {
        en: "No — detection is exact, not fuzzy. A single visible dot or character keeps the page. Use Remove pages to hand-pick borderline cases.",
        hi: "नहीं — पहचान सटीक है, अंदाज़े वाली नहीं। एक भी दिखने वाला बिंदु या अक्षर पेज को बचा लेता है। सीमा वाले केस हाथ से चुनने के लिए पेज हटाएँ टूल लें।",
      },
    },
    {
      q: {
        en: "What if there are no blank pages?",
        hi: "अगर कोई खाली पेज ही न हो?",
      },
      a: {
        en: "The tool tells you honestly instead of writing an identical copy — nothing is charged, nothing is changed.",
        hi: "टूल ईमानदारी से बता देता है, हूबहू वैसी ही कॉपी नहीं बनाता — कुछ नहीं बदलता।",
      },
    },
  ],
};
