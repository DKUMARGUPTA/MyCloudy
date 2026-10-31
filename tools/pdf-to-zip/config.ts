import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to ZIP (PHASE-1 Batch C): render every page as an image (PNG or
 * JPG at your chosen resolution) and hand back ONE zip archive — the
 * tidy way to ship a whole document as images.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-zip",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "zip",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "format",
      label: { en: "Image format", hi: "इमेज फ़ॉर्मैट" },
      choices: [
        { value: "png", label: { en: "PNG — lossless", hi: "PNG — बिना नुकसान" } },
        { value: "jpg", label: { en: "JPG — smaller", hi: "JPG — छोटी" } },
      ],
      default: "png",
    },
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      choices: [
        { value: "72", label: { en: "72 — screen", hi: "72 — स्क्रीन" } },
        { value: "150", label: { en: "150 — balanced", hi: "150 — संतुलित" } },
        { value: "300", label: { en: "300 — print", hi: "300 — प्रिंट" } },
      ],
      default: "150",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["images-to-pdf", "compress-pdf", "merge-pdf"],
  features: [
    {
      en: "Every page becomes an image — all of them in one tidy ZIP.",
      hi: "हर पेज एक इमेज बनता है — सब एक ही सुथरी ZIP में।",
    },
    {
      en: "PNG for perfect quality, JPG for lighter archives.",
      hi: "PNG में पूर्ण क्वालिटी, JPG में हल्के अभिलेख।",
    },
    {
      en: "Screen, balanced or print resolution — you pick.",
      hi: "स्क्रीन, संतुलित या प्रिंट रेज़ोल्यूशन — आप चुनें।",
    },
    {
      en: "Batch: up to 5 PDFs, one ZIP each.",
      hi: "बैच: 5 तक PDF, हर एक की अपनी ZIP।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why a ZIP instead of separate images?",
        hi: "अलग-अलग इमेज की जगह ZIP क्यों?",
      },
      a: {
        en: "One click downloads everything at once, nothing gets lost between browser tabs, and the pages stay in named order (page-001.png, page-002.png…) inside the archive.",
        hi: "एक क्लिक में सब एक साथ डाउनलोड, ब्राउज़र टैब के बीच कुछ खोता नहीं, और पेज नाम के क्रम में रहते हैं (page-001.png, page-002.png…)।",
      },
    },
    {
      q: {
        en: "PNG or JPG — which should I choose?",
        hi: "PNG या JPG — कौन चुनूँ?",
      },
      a: {
        en: "PNG keeps every pixel exact (screenshots, line art, text scans) but files are bigger. JPG compresses smoothly for photos and keeps the archive light.",
        hi: "PNG हर पिक्सेल वैसा रखता है (स्क्रीनशॉट, लाइन-आर्ट, टेक्स्ट स्कैन) पर फ़ाइलें बड़ी होती हैं। JPG फ़ोटो वाले पेज आराम से दबा देता है और अभिलेख हल्का रखता है।",
      },
    },
    {
      q: {
        en: "What resolution do I need?",
        hi: "कौन-सा रेज़ोल्यूशन चाहिए?",
      },
      a: {
        en: "72 DPI for screen sharing, 150 for everyday reading, 300 when the images will be printed. Higher DPI means bigger files.",
        hi: "स्क्रीन पर दिखाने के लिए 72 DPI, रोज़ की पढ़ाई के लिए 150, और प्रिंट होने वाली इमेज के लिए 300। ज़्यादा DPI मतलब बड़ी फ़ाइलें।",
      },
    },
  ],
};
