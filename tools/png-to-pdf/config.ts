import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PNG to PDF — ImageGrid preset over the shared images→PDF worker.
 * PNG transparency is preserved (alpha-capable re-encode path).
 */
export const config: ToolConfig = {
  toolId: "png-to-pdf",
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
  ],
  features: [
    {
      en: "Combine PNG screenshots, logos or scans into a single tidy PDF.",
      hi: "PNG स्क्रीनशॉट, लोगो या स्कैन एक साफ़ PDF में जोड़ें।",
    },
    {
      en: "Unrotated PNGs are embedded as-is — transparency and quality untouched.",
      hi: "बिना घुमाई PNG जस की तस जुड़ती है — पारदर्शिता और क्वालिटी अछूती।",
    },
    {
      en: "Reorder, rotate and sort visually before you build the PDF.",
      hi: "PDF बनाने से पहले क्रम बदलें, घुमाएँ और क्रमबद्ध करें।",
    },
    {
      en: "100% on-device — nothing is uploaded.",
      hi: "100% डिवाइस पर — कुछ भी अपलोड नहीं।",
    },
  ],
  faq: [
    {
      q: { en: "Is PNG transparency kept?", hi: "PNG की पारदर्शिता रहती है?" },
      a: {
        en: "Yes — the image itself keeps its alpha channel. The page background behind it is your choice (White / Soft / Dark).",
        hi: "हाँ — इमेज का अल्फ़ा चैनल बरक़रार रहता है। पेज का बैकग्राउंड आपकी पसंद (सफ़ेद / हल्का / गहरा)।",
      },
    },
    {
      q: { en: "Can I mix JPGs in?", hi: "JPG भी मिला सकती है?" },
      a: {
        en: "Yes, every common image format is accepted — JPG, PNG, WEBP and more.",
        hi: "हाँ, हर आम इमेज फ़ॉर्मैट चलता है — JPG, PNG, WEBP और भी।",
      },
    },
    {
      q: { en: "How many PNGs can I add?", hi: "कितनी PNG जोड़ सकते हैं?" },
      a: {
        en: "Up to 50 per run. For more, run twice and merge the two PDFs.",
        hi: "एक बार में 50 तक। ज़्यादा के लिए दो बार चलाकर दोनों PDF Merge कर लें।",
      },
    },
  ],
};
