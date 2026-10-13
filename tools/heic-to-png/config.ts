import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * HEIC to PNG (PRD §7.10, P1) — iPhone photos decoded by the self-hosted
 * libheif WASM build, saved as lossless PNG with transparency preserved.
 */
export const config: ToolConfig = {
  toolId: "heic-to-png",
  createWorker: () =>
    new Worker(new URL("../convert-image/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 30,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  chainToolIds: ["png-to-pdf", "images-to-pdf", "merge-pdf", "heic-to-pdf"],
  options: [
    {
      kind: "select",
      id: "maxDim",
      label: { en: "Max size", hi: "अधिकतम साइज़" },
      hint: {
        en: "Downscales bigger photos, original pixels otherwise",
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
      en: "Lossless PNG from HEIC — for editing, printing, or lossless archives.",
      hi: "HEIC से बिना नुक़सान PNG — एडिटिंग, प्रिंट या आर्काइव के लिए।",
    },
    {
      en: "Works in Chrome, Firefox and Edge — not just Safari — thanks to our on-device decoder.",
      hi: "Chrome, Firefox और Edge में भी चलता है — सिर्फ़ Safari नहीं — डिवाइस के अंदरूनी डिकोडर से।",
    },
    {
      en: "Up to 30 photos per run, downloaded together as a ZIP.",
      hi: "एक बार में 30 तस्वीरें, सब ZIP में साथ मिलती हैं।",
    },
    {
      en: "Runs entirely on your device — your photos never leave your browser.",
      hi: "पूरा काम डिवाइस पर — आपकी तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "Why is the PNG bigger than the HEIC?", hi: "PNG, HEIC से बड़ी क्यों?" },
      a: {
        en: "HEIC is heavily compressed; PNG is lossless. Bigger file, zero extra quality loss.",
        hi: "HEIC ज़्यादा कंप्रेस्ड होती है; PNG लॉसलेस है। फ़ाइल बड़ी, क्वालिटी का और नुक़सान शून्य।",
      },
    },
    {
      q: { en: "Will this work in Chrome?", hi: "Chrome में चलेगा?" },
      a: {
        en: "Yes — we bundle the HEIC decoder with the page, so every modern browser can read iPhone photos.",
        hi: "हाँ — HEIC डिकोडर पेज के साथ ही आता है, इसलिए हर नया ब्राउज़र iPhone तस्वीरें पढ़ सकता है।",
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
