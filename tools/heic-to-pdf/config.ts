import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * HEIC to PDF (PRD §8.6, P2) — ImageGrid preset over the shared images→PDF
 * worker. iPhone HEIC photos are decoded by the self-hosted libheif WASM
 * (works in every browser, not just Safari) and embedded as high-quality
 * JPEG pages.
 */
export const config: ToolConfig = {
  toolId: "heic-to-pdf",
  createWorker: () =>
    new Worker(new URL("../imagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 50,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
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
      en: "Turn iPhone HEIC photos into a single tidy PDF — receipts, notes, assignments.",
      hi: "iPhone की HEIC तस्वीरों को एक सीधी PDF में — रसीदें, नोट्स, असाइनमेंट।",
    },
    {
      en: "Works in Chrome, Firefox and Edge — not just Safari — thanks to our on-device decoder.",
      hi: "Chrome, Firefox और Edge में भी चलता है — सिर्फ़ Safari नहीं — डिवाइस के अंदरूनी डिकोडर से।",
    },
    {
      en: "Drag to reorder, rotate, A→Z sort — the photo order you meant, not the filename order.",
      hi: "खींचकर क्रम बदलें, घुमाएँ, A→Z करें — फ़ाइलनाम नहीं, आपका चुना हुआ क्रम।",
    },
    {
      en: "Runs entirely on your device — your photos never leave your browser.",
      hi: "पूरा काम डिवाइस पर — आपकी तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "How many photos fit?", hi: "कितनी तस्वीरें जुड़ सकती हैं?" },
      a: {
        en: "Up to 50 per PDF. Need more? Run it again and merge the results with Merge PDF.",
        hi: "एक PDF में 50 तक। ज़्यादा चाहिए? दोबारा चलाएँ और नतीजे Merge PDF से जोड़ लें।",
      },
    },
    {
      q: { en: "What about the quality?", hi: "क्वालिटी कैसी रहती है?" },
      a: {
        en: "Photos are embedded at high JPEG quality (92%) at their original resolution.",
        hi: "तस्वीरें हाई JPEG क्वालिटी (92%) पर ओरिजिनल रेज़ोल्यूशन में जुड़ती हैं।",
      },
    },
    {
      q: { en: "Can I mix JPG or PNG too?", hi: "JPG या PNG भी मिला सकते हैं?" },
      a: {
        en: "Yes — this tool accepts all common image formats, exactly like Images to PDF.",
        hi: "हाँ — यह टूल सभी आम इमेज फ़ॉर्मैट लेता है, बिल्कुल Images to PDF की तरह।",
      },
    },
  ],
};
