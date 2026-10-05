import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to JPG (PRD §8.6) — every selected page becomes a JPG at your DPI.
 * Shared worker with pdf-to-png; quality slider + DPI + page range here,
 * live pixel-size preview in the custom panel. Multiple pages → ZIP.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-jpg",
  createWorker: () =>
    new Worker(new URL("../pdf-to-images/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["images-to-pdf", "jpg-to-pdf", "webp-to-pdf", "heic-to-pdf"],
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      hint: {
        en: "Higher DPI = sharper but heavier files",
        hi: "ज़्यादा DPI = ज़्यादा साफ़ लेकिन भारी फ़ाइलें",
      },
      choices: [
        { value: "72", label: { en: "72 — screen", hi: "72 — स्क्रीन" } },
        { value: "150", label: { en: "150 — balanced", hi: "150 — संतुलित" } },
        { value: "300", label: { en: "300 — print", hi: "300 — प्रिंट" } },
        { value: "600", label: { en: "600 — archive", hi: "600 — आर्काइव" } },
      ],
      default: "150",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
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
  ],
  features: [
    {
      en: "Every page becomes a JPG — pick 72/150/300/600 DPI for screen, print or archive.",
      hi: "हर पेज एक JPG — स्क्रीन, प्रिंट या आर्काइव के लिए 72/150/300/600 DPI चुनें।",
    },
    {
      en: "Live preview shows the exact pixel size page 1 will get before you run.",
      hi: "चलाने से पहले लाइव प्रीव्यू दिखाता है कि पेज 1 का पिक्सेल साइज़ क्या होगा।",
    },
    {
      en: "Export everything or just “1-3, 7” — multiple pages download as a ZIP plus singles.",
      hi: "सब कुछ या सिर्फ़ “1-3, 7” — कई पेज ZIP में और अलग-अलग भी मिलते हैं।",
    },
    {
      en: "Sequential rendering keeps memory flat — 200-page files won't choke your device.",
      hi: "क्रमबद्ध रेंडरिंग से मेमोरी कम खर्च होती है — 200 पेज की फ़ाइल भी आसानी से चलेगी।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: { en: "Which DPI should I pick?", hi: "कौन-सा DPI चुनें?" },
      a: {
        en: "72 for quick screen viewing, 150 for sharing, 300 for printing, 600 only when you need to zoom deep into scans. File size grows with the square of DPI.",
        hi: "झटपट देखने के लिए 72, शेयर के लिए 150, प्रिंट के लिए 300, और 600 सिर्फ़ जब स्कैन में गहरा ज़ूम चाहिए। DPI बढ़ने पर साइज़ तेज़ी से बढ़ती है।",
      },
    },
    {
      q: { en: "How do I export just a few pages?", hi: "कुछ ही पेज निकालें?" },
      a: {
        en: "Write ranges in the Pages field: 1-3, 5, 8- means pages one to three, page five, and eight to the end.",
        hi: "पेज फ़ील्ड में रेंज लिखें: 1-3, 5, 8- का मतलब पेज 1 से 3, पेज 5, और 8 से आख़िर तक।",
      },
    },
    {
      q: { en: "Why JPG and not PNG?", hi: "JPG क्यों, PNG क्यों नहीं?" },
      a: {
        en: "JPG is perfect for photos and scans — small and universally supported. For text screenshots or transparency, use PDF to PNG instead.",
        hi: "JPG फ़ोटो और स्कैन के लिए सबसे फ़िट है — छोटी और हर जगह चलने वाली। टेक्स्ट स्क्रीनशॉट या पारदर्शिता के लिए PDF to PNG चुनें।",
      },
    },
  ],
};
