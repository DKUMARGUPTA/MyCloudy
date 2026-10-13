import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * WEBP to PNG (PRD §7.10) — native decode, lossless PNG out, transparency
 * preserved. Shared worker with the other image converters.
 */
export const config: ToolConfig = {
  toolId: "webp-to-png",
  createWorker: () =>
    new Worker(new URL("../convert-image/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 30,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  chainToolIds: ["png-to-pdf", "images-to-pdf", "merge-pdf", "jpg-to-pdf"],
  options: [
    {
      kind: "select",
      id: "maxDim",
      label: { en: "Max size", hi: "अधिकतम साइज़" },
      hint: {
        en: "Downscales bigger images, original pixels otherwise",
        hi: "बड़ी तस्वीरें छोटी होंगी, वरना ओरिजिनल पिक्सेल",
      },
      choices: [
        { value: "0", label: { en: "Original", hi: "ओरिजिनल" } },
        { value: "4096", label: { en: "4096 px", hi: "4096 px" } },
        { value: "2048", label: { en: "2048 px", hi: "2048 px" } },
        { value: "1024", label: { en: "1024 px", hi: "1024 px" } },
      ],
      default: "0",
    },
  ],
  features: [
    {
      en: "Lossless PNG from WEBP — transparency kept, pixels untouched at original size.",
      hi: "WEBP से बिना नुक़सान PNG — पारदर्शिता बरक़रार, पिक्सेल वैसे ही।",
    },
    {
      en: "Design tools and older software that refuse WEBP open PNG everywhere.",
      hi: "जो सॉफ़्टवेयर WEBP नहीं खोलते, वे PNG हर जगह खोलते हैं।",
    },
    {
      en: "Up to 30 images per run, downloaded together as a ZIP.",
      hi: "एक बार में 30 तस्वीरें, सब ZIP में साथ मिलती हैं।",
    },
    {
      en: "Runs entirely on your device — images never leave your browser.",
      hi: "पूरा काम डिवाइस पर — तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "Is PNG bigger than WEBP?", hi: "PNG, WEBP से बड़ी होती है?" },
      a: {
        en: "Usually yes — PNG is lossless and uncompressed compared to WEBP. That is the price of pixel-perfect output.",
        hi: "अक्सर हाँ — PNG लॉसलेस और कम कंप्रेस्ड होती है। यही बिल्कुल साफ़ आउटपुट की क़ीमत है।",
      },
    },
    {
      q: { en: "Does transparency survive?", hi: "पारदर्शिता बचती है?" },
      a: {
        en: "Yes — transparent WEBP logos become transparent PNGs, ready for any editor.",
        hi: "हाँ — पारदर्शी WEBP लोगो पारदर्शी PNG बनते हैं, किसी भी एडिटर के लिए तैयार।",
      },
    },
    {
      q: { en: "Many files at once?", hi: "एक साथ कई फ़ाइलें?" },
      a: {
        en: "Up to 30 — several files download together as a ZIP, each converted separately.",
        hi: "30 तक — कई फ़ाइलें ZIP में मिलती हैं, हर एक अलग से बदली जाती है।",
      },
    },
  ],
};
