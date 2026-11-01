import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF → BMP (PHASE-3 batch 3): every selected page as a 24-bit BMP —
 * the uncompressed, maximally-compatible raster that legacy software,
 * industrial printers and embedded systems still ask for.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-bmp",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      choices: [
        { value: "96", label: { en: "96 — screen", hi: "96 — स्क्रीन" } },
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
  chainToolIds: ["bmp-to-pdf", "compress-pdf"],
  features: [
    {
      en: "24-bit BMP output — opens everywhere from legacy tools to embedded displays.",
      hi: "24-बिट BMP आउटपुट — पुराने टूल से लेकर एम्बेडेड डिस्प्ले तक हर जगह खुलता है।",
    },
    {
      en: "Screen, balanced or print resolution — you pick the sharpness.",
      hi: "स्क्रीन, संतुलित या प्रिंट रेज़ोल्यूशन — तीखापन आप चुनें।",
    },
    {
      en: "Convert every page or just a range.",
      hi: "हर पेज बदलें या सिर्फ़ एक रेंज।",
    },
    {
      en: "Honest about size: BMP is uncompressed — a 300 DPI page runs large.",
      hi: "साइज़ की साफ़ बात: BMP बिना कंप्रेशन का है — 300 DPI पेज बड़ा बनता है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why are BMP files so big?",
        hi: "BMP फ़ाइलें इतनी बड़ी क्यों होती हैं?",
      },
      a: {
        en: "BMP stores every pixel uncompressed — a 300 DPI A4 page is about 25 MB. That is exactly why legacy systems trust it: zero decoding, zero surprises.",
        hi: "BMP हर पिक्सल बिना कंप्रेस रखता है — 300 DPI का A4 पेज क़रीब 25 MB। यही वजह है कि पुराने सिस्टम इस पर भरोसा करते हैं: कोई डिकोडिंग नहीं, कोई चौंकाने वाली बात नहीं।",
      },
    },
    {
      q: {
        en: "Which should I use — BMP, PNG or JPG?",
        hi: "कौन-सा लूँ — BMP, PNG या JPG?",
      },
      a: {
        en: "BMP only when a specific system demands it. For everything else use our PDF to PNG (lossless, small) or PDF to JPG (photos, smallest) tools.",
        hi: "BMP सिर्फ़ तब जब कोई सिस्टम ख़ास तौर पर माँगे। बाक़ी सब के लिए PDF to PNG (बिना नुक़सान, छोटी) या PDF to JPG (फ़ोटो, सबसे छोटी) लें।",
      },
    },
    {
      q: {
        en: "Is transparency preserved?",
        hi: "पारदर्शिता बचती है?",
      },
      a: {
        en: "No — the 24-bit BMP format has no alpha channel, so transparent areas render white (the same as printing on paper).",
        hi: "नहीं — 24-बिट BMP में अल्फ़ा चैनल नहीं होता, पारदर्शी हिस्से सफ़ेद छपते हैं (काग़ज़ पर छपने जैसा)।",
      },
    },
  ],
};
