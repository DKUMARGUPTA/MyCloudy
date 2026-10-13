import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * HEIC to JPG (PRD §7.10, P1) — iPhone photos decoded by the self-hosted
 * libheif WASM build, re-encoded as universally readable JPG. Works in
 * every browser (Chromium too), fully on-device.
 */
export const config: ToolConfig = {
  toolId: "heic-to-jpg",
  createWorker: () =>
    new Worker(new URL("../convert-image/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 30,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  chainToolIds: ["jpg-to-pdf", "images-to-pdf", "merge-pdf", "heic-to-pdf"],
  options: [
    {
      kind: "number",
      id: "quality",
      label: { en: "JPG quality", hi: "JPG क्वालिटी" },
      hint: {
        en: "85 keeps photos crisp at a sane size",
        hi: "85 तस्वीरें साफ़ और साइज़ संतुलित रखता है",
      },
      min: 40,
      max: 100,
      step: 5,
      suffix: { en: "%", hi: "%" },
      default: 85,
    },
    {
      kind: "select",
      id: "background",
      label: { en: "Transparent areas", hi: "पारदर्शी हिस्से" },
      hint: {
        en: "JPG has no transparency — pick the fill color",
        hi: "JPG में पारदर्शिता नहीं होती — भरने का रंग चुनें",
      },
      choices: [
        { value: "white", label: { en: "White", hi: "सफ़ेद" } },
        { value: "soft", label: { en: "Soft gray", hi: "हल्का सलेटी" } },
        { value: "black", label: { en: "Black", hi: "काला" } },
      ],
      default: "white",
    },
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
      en: "iPhone and Samsung HEIC photos become JPGs that open everywhere — WhatsApp, forms, old laptops.",
      hi: "iPhone और Samsung की HEIC तस्वीरें हर जगह चलने वाली JPG बनती हैं — WhatsApp, फ़ॉर्म, पुराने लैपटॉप।",
    },
    {
      en: "Works in Chrome, Firefox and Edge — not just Safari — thanks to our on-device decoder.",
      hi: "Chrome, Firefox और Edge में भी चलता है — सिर्फ़ Safari नहीं — डिवाइस के अंदरूनी डिकोडर से।",
    },
    {
      en: "Rotate-free conversion: the phone's stored orientation is baked in correctly.",
      hi: "झुकाव ठीक रहता है — फ़ोन की सेव की हुई दिशा सही तरह जुड़ती है।",
    },
    {
      en: "Up to 30 photos per run, quality slider included, ZIP for batches.",
      hi: "एक बार में 30 तस्वीरें, क्वालिटी स्लाइडर सहित, बैच के लिए ZIP।",
    },
    {
      en: "Runs entirely on your device — your photos never leave your browser.",
      hi: "पूरा काम डिवाइस पर — आपकी तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "Will this work in Chrome?", hi: "Chrome में चलेगा?" },
      a: {
        en: "Yes — we bundle the HEIC decoder with the page, so every modern browser can read iPhone photos.",
        hi: "हाँ — HEIC डिकोडर पेज के साथ ही आता है, इसलिए हर नया ब्राउज़र iPhone तस्वीरें पढ़ सकता है।",
      },
    },
    {
      q: { en: "Does the quality drop?", hi: "क्वालिटी गिरती है?" },
      a: {
        en: "HEIC and JPG are both lossy, so one re-encode happens — at 85% quality it is visually identical.",
        hi: "HEIC और JPG दोनों लॉसी हैं, एक बार एनकोड होता है — 85% पर फ़र्क़ नहीं दिखता।",
      },
    },
    {
      q: { en: "Are live photos / videos supported?", hi: "लाइव फ़ोटो/वीडियो चलेंगे?" },
      a: {
        en: "No — HEIC is a photo format. Videos from iPhones (.mov) are out of scope here.",
        hi: "नहीं — HEIC फ़ोटो फ़ॉर्मैट है। iPhone के वीडियो (.mov) इसके दायरे में नहीं हैं।",
      },
    },
  ],
};
