import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove PDF metadata (PRD §8.3): preview of everything found in the file —
 * author, software, dates, custom fields, XMP — then remove all of it with
 * an honest before/after list. Custom surface (the found-fields report) +
 * custom panel own every interactive value (split-tool pattern — schema
 * stays empty, the worker defaults defensively).
 */
export const config: ToolConfig = {
  toolId: "remove-pdf-metadata",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: [
    "change-pdf-doc-info",
    "compress-pdf",
    "protect-pdf",
    "pdf-to-jpg",
  ],
  features: [
    {
      en: "See every hidden field first — author, software, dates, custom keys and the XMP block.",
      hi: "पहले हर छुपी जानकारी देखें — लेखक, सॉफ़्टवेयर, तारीख़ें, कस्टम कुंजियाँ और XMP ब्लॉक।",
    },
    {
      en: "One click removes the entire document information dictionary — not just the visible fields.",
      hi: "एक क्लिक में पूरी जानकारी डिक्शनरी हटती है — सिर्फ़ दिखने वाले फ़ील्ड नहीं।",
    },
    {
      en: "The XMP block (a second copy many files carry) is removed too — your choice.",
      hi: "XMP ब्लॉक (दूसरी कॉपी जो कई फ़ाइलों में होती है) भी हटता है — आपकी मर्ज़ी।",
    },
    {
      en: "An honest before/after list shows exactly what will disappear.",
      hi: "ईमानदार पहले/बाद सूची — क्या मिटेगा, पहले ही साफ़।",
    },
    {
      en: "Pages, text and images stay untouched — only the identifying information goes.",
      hi: "पेज, टेक्स्ट और तस्वीरें वैसी ही रहती हैं — सिर्फ़ पहचान वाली जानकारी जाती है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why remove metadata?",
        hi: "मेटाडेटा क्यों हटाएँ?",
      },
      a: {
        en: "Files often carry your name, your software and exact timestamps — useful to know before you share a document publicly.",
        hi: "फ़ाइलों में अक्सर आपका नाम, सॉफ़्टवेयर और सटीक समय होता है — दस्तावेज़ सार्वजनिक करने से पहले जान लेना ठीक है।",
      },
    },
    {
      q: {
        en: "What is NOT removed?",
        hi: "क्या नहीं हटता?",
      },
      a: {
        en: "Page content, text, images and the file ID used for internal integrity. GPS data inside embedded images (EXIF) is rare in PDFs and is not touched — the images themselves are left bit-for-bit identical.",
        hi: "पेज कंटेंट, टेक्स्ट, तस्वीरें और आंतरिक अखंडता वाली फ़ाइल ID। तस्वीरों के अंदर का GPS डेटा (EXIF) PDF में दुर्लभ है और नहीं छेड़ा जाता — तस्वीरें बिल्कुल वैसी ही रहती हैं।",
      },
    },
    {
      q: {
        en: "Will the file look different afterwards?",
        hi: "क्या फ़ाइल बाद में अलग दिखेगी?",
      },
      a: {
        en: "No — every page renders exactly the same. Only the hidden information fields are gone, and the file usually gets a little smaller.",
        hi: "नहीं — हर पेज बिल्कुल वैसा ही दिखेगा। सिर्फ़ छुपी जानकारी हटती है, और फ़ाइल अक्सर थोड़ी छोटी हो जाती है।",
      },
    },
  ],
};
