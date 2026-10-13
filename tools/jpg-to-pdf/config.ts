import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * JPG to PDF — ImageGrid preset over the shared images→PDF worker.
 * Same engine + surface as Images to PDF (PRD §8.6), JPG-tuned copy.
 */
export const config: ToolConfig = {
  toolId: "jpg-to-pdf",
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
  ],
  features: [
    {
      en: "Turn any number of JPG photos into one PDF — camera rolls, scans, screenshots.",
      hi: "कितनी भी JPG तस्वीरें एक PDF में — कैमरा रोल, स्कैन, स्क्रीनशॉट।",
    },
    {
      en: "Your JPGs are embedded as-is — no re-compression, no quality loss.",
      hi: "आपकी JPG जस की तस जुड़ती है — दोबारा कंप्रेस नहीं, क्वालिटी बरक़रार।",
    },
    {
      en: "Drag to reorder, rotate, A→Z sort — the photo order you meant, not the filename order.",
      hi: "खींचकर क्रम बदलें, घुमाएँ, A→Z करें — फ़ाइलनाम नहीं, आपका चुना हुआ क्रम।",
    },
    {
      en: "Runs fully on your device — photos never leave your browser.",
      hi: "पूरा काम डिवाइस पर — तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "Is there a photo limit?", hi: "कितनी तस्वीरें जोड़ सकते हैं?" },
      a: {
        en: "Up to 50 photos per PDF. Need more? Run it again and merge the results with Merge PDF.",
        hi: "एक PDF में 50 तक। ज़्यादा चाहिए? दोबारा चलाएँ और नतीजे Merge PDF से जोड़ लें।",
      },
    },
    {
      q: { en: "Does it reduce photo quality?", hi: "क्वालिटी गिरती है?" },
      a: {
        en: "No. Unrotated JPGs are embedded byte-for-byte. Only rotated photos are re-encoded once, at high quality.",
        hi: "नहीं। बिना घुमाई JPG जस की तस जुड़ती है। सिर्फ़ घुमाई गई तस्वीर एक बार हाई क्वालिटी पर दोबारा एनकोड होती है।",
      },
    },
    {
      q: { en: "Can I mix PNG or WEBP files too?", hi: "PNG/WEBP भी मिला सकते हैं?" },
      a: {
        en: "Yes — this tool accepts all common image formats, exactly like Images to PDF.",
        hi: "हाँ — यह टूल सभी आम इमेज फ़ॉर्मैट लेता है, बिल्कुल Images to PDF की तरह।",
      },
    },
  ],
};
