import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Divide PDF pages (PHASE-1 Batch A): cut each selected page into a grid
 * of pieces — 2 halves, 4 quadrants, 3 strips, anything up to 4×4. The
 * general-purpose version of "Halve": comic panels, contact sheets,
 * scanned sheets and tile prints become individual pages.
 *
 * Schema-driven; the worker windows each page's MediaBox/CropBox to the
 * planned cells on OUR OWN engine — no re-rendering, so content stays
 * lossless.
 */
export const config: ToolConfig = {
  toolId: "divide-pages",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "number",
      id: "columns",
      label: { en: "Columns", hi: "कॉलम" },
      hint: {
        en: "Vertical cuts — pieces across the page",
        hi: "लंबवत कट — पेज के आर-पार टुकड़े",
      },
      min: 1,
      max: 4,
      default: 2,
    },
    {
      kind: "number",
      id: "rows",
      label: { en: "Rows", hi: "पंक्तियाँ" },
      hint: {
        en: "Horizontal cuts — pieces down the page",
        hi: "क्षैतिज कट — पेज के नीचे तक टुकड़े",
      },
      min: 1,
      max: 4,
      default: 1,
    },
    {
      kind: "select",
      id: "order",
      label: { en: "Piece order", hi: "टुकड़ों का क्रम" },
      choices: [
        {
          value: "rows",
          label: { en: "Reading order — left to right", hi: "पढ़ने का क्रम — बाएँ से दाएँ" },
        },
        {
          value: "columns",
          label: { en: "Column by column — top to bottom", hi: "कॉलम दर कॉलम — ऊपर से नीचे" },
        },
      ],
      default: "rows",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages to divide — all, or a range like 2-5",
        hi: "कौन से पेज काटें — सभी, या 2-5 जैसी रेंज",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["view-pdf", "merge-pdf", "rearrange-pdf-pages"],
  features: [
    {
      en: "Cut pages into halves, thirds, quadrants — any grid up to 4×4.",
      hi: "पेज काटें आधे, तिहाई, चौथाई — 4×4 तक कोई भी ग्रिड।",
    },
    {
      en: "Pick exactly which pages to cut — leave the rest untouched.",
      hi: "ठीक चुनें कौन से पेज काटने हैं — बाकी जस के तस रहेंगे।",
    },
    {
      en: "Reading order or column order — the pieces stack how you want.",
      hi: "पढ़ने का क्रम या कॉलम क्रम — टुकड़े वैसे जुड़ेंगे जैसे आप चाहें।",
    },
    {
      en: "Lossless cuts — the content is windowed, never re-rendered.",
      hi: "बिना नुकसान कटाई — सामग्री सिर्फ़ विंडो होती है, दोबारा रेंडर नहीं होती।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference from Halve PDF pages?",
        hi: "पेज आधे करने वाले टूल से यह कैसे अलग है?",
      },
      a: {
        en: "Halve always makes two pieces per page. Divide generalises it: choose any column × row grid — 3 strips, 2×2 quadrants, a 4×4 contact sheet split — and pick which pages get cut.",
        hi: "आधे करने वाला टूल हमेशा दो टुकड़े बनाता है। यह उसका बड़ा रूप है: कोई भी कॉलम × पंक्ति ग्रिड चुनें — 3 पट्टियाँ, 2×2 चौथाई, 4×4 संपर्क-शीट स्प्लिट — और तय करें कौन से पेज कटें।",
      },
    },
    {
      q: {
        en: "Does cutting reduce the quality?",
        hi: "क्या काटने से क्वालिटी गिरती है?",
      },
      a: {
        en: "No. Each piece is the same page shown through a smaller window — text stays crisp, images keep their original resolution, nothing is re-compressed.",
        hi: "नहीं। हर टुकड़ा वही पेज है, बस छोटी खिड़की से दिखता है — टेक्स्ट उतना ही साफ़, तस्वीरों का असली रेज़ोल्यूशन वही, कुछ भी दोबारा कंप्रेस नहीं होता।",
      },
    },
    {
      q: {
        en: "Can I cut only some pages of a big scan?",
        hi: "क्या बड़े स्कैन के सिर्फ़ कुछ पेज काट सकते हैं?",
      },
      a: {
        en: "Yes — enter a range like 2-5 in Pages and only those pages are divided; every other page passes through unchanged.",
        hi: "हाँ — पेज में 2-5 जैसी रेंज लिखें, सिर्फ़ वही पेज कटेंगे; बाकी सब पेज बिना बदलाव निकलेंगे।",
      },
    },
  ],
};
