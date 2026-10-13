import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * WEBP to JPG (PRD §7.10) — native browser WEBP decode, canvas re-encode.
 * Older apps (forms, banks, gov portals) still demand JPG — this unblocks
 * them without any upload. Shared worker with the other image converters.
 */
export const config: ToolConfig = {
  toolId: "webp-to-jpg",
  createWorker: () =>
    new Worker(new URL("../convert-image/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 30,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  chainToolIds: ["jpg-to-pdf", "images-to-pdf", "merge-pdf", "png-to-pdf"],
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
      en: "Convert WEBP screenshots and downloads to JPG in one drop — up to 30 at a time.",
      hi: "WEBP स्क्रीनशॉट और डाउनलोड एक बार में JPG — एक साथ 30 तक।",
    },
    {
      en: "Quality slider and background color for transparent areas — you control the output.",
      hi: "क्वालिटी स्लाइडर और पारदर्शी हिस्सों के लिए बैकग्राउंड रंग — आपका कंट्रोल।",
    },
    {
      en: "Optional max-size downscale — great for form portals that reject huge photos.",
      hi: "ज़रूरत पड़े तो साइज़ घटाएँ — बड़ी तस्वीरें ना लेने वाले फ़ॉर्म के लिए।",
    },
    {
      en: "Runs entirely on your device — images never leave your browser.",
      hi: "पूरा काम डिवाइस पर — तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "Will the quality drop?", hi: "क्वालिटी गिरेगी?" },
      a: {
        en: "WEBP is lossy, so a re-encode is unavoidable — but 85% quality keeps photos visually identical.",
        hi: "WEBP लॉसी होती है, इसलिए दोबारा एनकोड होती है — पर 85% क्वालिटी पर फ़र्क़ नहीं दिखता।",
      },
    },
    {
      q: { en: "What happens to transparency?", hi: "पारदर्शिता का क्या होगा?" },
      a: {
        en: "JPG cannot store transparency — transparent pixels are filled with the background color you pick.",
        hi: "JPG में पारदर्शिता नहीं रहती — आपके चुने बैकग्राउंड रंग से भर जाती है।",
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
