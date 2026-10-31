import type { ToolConfig } from "@/lib/tools/config-types";
import { FIT_MODE_OPTION } from "../imagegrid/fit-mode-option";

/**
 * WEBP to PDF — ImageGrid preset over the shared images→PDF worker.
 * WEBP is transcoded to PNG on-device (pdf-lib embeds JPG/PNG only).
 */
export const config: ToolConfig = {
  toolId: "webp-to-pdf",
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  createWorker: () =>
    new Worker(new URL("../imagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 50,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "Letter", hi: "लेटर" } },
        { value: "fit", label: { en: "Fit to image", hi: "तस्वीर के अनुसार" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      choices: [
        { value: "auto", label: { en: "Auto", hi: "ऑटो" } },
        { value: "portrait", label: { en: "Portrait", hi: "पोर्ट्रेट" } },
        { value: "landscape", label: { en: "Landscape", hi: "लैंडस्केप" } },
      ],
      default: "auto",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margin", hi: "मार्जिन" },
      choices: [
        { value: "none", label: { en: "None", hi: "कोई नहीं" } },
        { value: "small", label: { en: "Small", hi: "छोटा" } },
        { value: "big", label: { en: "Big", hi: "बड़ा" } },
      ],
      default: "small",
    },
    FIT_MODE_OPTION,
  ],
  features: [
    {
      en: "Convert modern WEBP images into a classic, share-anywhere PDF.",
      hi: "आधुनिक WEBP तस्वीरों को क्लासिक, कहीं भी शेयर होने वाली PDF में बदलें।",
    },
    {
      en: "WEBP is transcoded to PNG on your device — alpha transparency preserved.",
      hi: "WEBP आपके डिवाइस पर PNG में बदलती है — पारदर्शिता बरक़रार।",
    },
    {
      en: "Reorder, rotate and sort the images visually first.",
      hi: "पहले तस्वीरों का क्रम बदलें, घुमाएँ और क्रमबद्ध करें।",
    },
    {
      en: "Nothing is uploaded — the conversion happens inside your browser.",
      hi: "कुछ अपलोड नहीं होता — बदलाव आपके ब्राउज़र के अंदर होता है।",
    },
  ],
  faq: [
    {
      q: { en: "Why is my PDF larger than the WEBP files?", hi: "PDF, WEBP से बड़ी क्यों है?" },
      a: {
        en: "WEBP compresses extremely well, while PDFs store PNG/JPEG images. The output is a faithful, high-quality conversion — not a smaller archive. Use Compress PDF afterwards if you need it lighter.",
        hi: "WEBP बेहद अच्छी तरह कंप्रेस होती है, जबकि PDF में PNG/JPEG होती है। नतीजा ईमानदार हाई-क्वालिटी रूपांतरण है — छोटा आर्काइव नहीं। हल्की चाहिए तो बाद में Compress PDF चलाएँ।",
      },
    },
    {
      q: { en: "Can animated WEBP files be converted?", hi: "एनिमेटेड WEBP चलेगी?" },
      a: {
        en: "Only the first frame is used — PDFs show still images.",
        hi: "सिर्फ़ पहला फ़्रेम लिया जाता है — PDF में स्थिर तस्वीरें होती हैं।",
      },
    },
    {
      q: { en: "Can I mix JPG and PNG in the same PDF?", hi: "JPG और PNG साथ चलेंगी?" },
      a: {
        en: "Yes — all common image formats work together in one run.",
        hi: "हाँ — सभी आम फ़ॉर्मैट एक ही बार में साथ चलते हैं।",
      },
    },
  ],
};
