import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Pages per sheet / N-up (PRD §8.1: "2, 4, 6, 9 or 16 pages on one sheet
 * with live preview"). Schema-driven options — every id matches what the
 * worker reads via NUP_IDS (tools/pages-per-sheet/engine.ts): layout,
 * sheetSize, sheetOrientation, order, margin (mm), spacing (mm), borders,
 * pages. The custom panel (panel.tsx) renders the LIVE sheet preview from
 * the same values; the worker is the pdf-lib authority.
 */
export const config: ToolConfig = {
  toolId: "pages-per-sheet",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "pdf-to-jpg", "compress-pdf", "rotate-pdf-pages"],
  options: [
    {
      kind: "select",
      id: "layout",
      label: { en: "Pages per sheet", hi: "एक शीट पर पेज" },
      hint: {
        en: "How many source pages go on each output sheet",
        hi: "हर शीट पर कितने पेज आएँगे",
      },
      choices: [
        { value: "2", label: { en: "2", hi: "2" } },
        { value: "4", label: { en: "4", hi: "4" } },
        { value: "6", label: { en: "6", hi: "6" } },
        { value: "9", label: { en: "9", hi: "9" } },
        { value: "16", label: { en: "16", hi: "16" } },
      ],
      default: "2",
    },
    {
      kind: "select",
      id: "sheetSize",
      label: { en: "Sheet size", hi: "शीट साइज़" },
      hint: {
        en: "A4, US Letter, or the size of the first page",
        hi: "A4, US Letter, या पहले पेज जितना",
      },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US Letter" } },
        {
          value: "match",
          label: { en: "Match page 1", hi: "पेज 1 जितना" },
        },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "sheetOrientation",
      label: { en: "Sheet orientation", hi: "शीट की दिशा" },
      hint: {
        en: "Auto follows the first page's shape",
        hi: "ऑटो पहले पेज की दिशा अपनाता है",
      },
      choices: [
        {
          value: "auto",
          label: { en: "Auto", hi: "ऑटो" },
        },
        {
          value: "portrait",
          label: { en: "Portrait", hi: "पोर्ट्रेट" },
        },
        {
          value: "landscape",
          label: { en: "Landscape", hi: "लैंडस्केप" },
        },
      ],
      default: "auto",
    },
    {
      kind: "select",
      id: "order",
      label: { en: "Reading order", hi: "पढ़ने का क्रम" },
      hint: {
        en: "Across rows (left to right) or down columns",
        hi: "पंक्तियों में (बाएँ से दाएँ) या कॉलम में नीचे",
      },
      choices: [
        {
          value: "row",
          label: { en: "Across rows", hi: "पंक्ति-वार" },
        },
        {
          value: "column",
          label: { en: "Down columns", hi: "कॉलम-वार" },
        },
      ],
      default: "row",
    },
    {
      kind: "number",
      id: "margin",
      label: { en: "Sheet margin", hi: "शीट मार्जिन" },
      hint: {
        en: "Empty border around the whole sheet",
        hi: "पूरी शीट के चारों ओर ख़ाली जगह",
      },
      min: 0,
      max: 30,
      step: 1,
      suffix: { en: "mm", hi: "mm" },
      default: 8,
    },
    {
      kind: "number",
      id: "spacing",
      label: { en: "Gap between pages", hi: "पेजों के बीच गैप" },
      hint: {
        en: "Space between neighbouring page cells",
        hi: "आपस में लगे पेज-कोष्ठकों के बीच की जगह",
      },
      min: 0,
      max: 30,
      step: 1,
      suffix: { en: "mm", hi: "mm" },
      default: 4,
    },
    {
      kind: "switch",
      id: "borders",
      label: { en: "Thin cell borders", hi: "पतली बॉर्डर" },
      hint: {
        en: "Draws a hairline around each page cell",
        hi: "हर पेज-कोष्ठक के चारों ओर पतली रेखा",
      },
      default: true,
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
  ],
  features: [
    {
      en: "Put 2, 4, 6, 9 or 16 pages on one sheet — perfect for handouts, drafts and saving paper.",
      hi: "एक शीट पर 2, 4, 6, 9 या 16 पेज — हैंडआउट, ड्राफ़्ट और काग़ज़ बचाने के लिए।",
    },
    {
      en: "Live preview draws sheet 1 exactly as it will print — real page thumbnails, margins, gaps and borders.",
      hi: "लाइव प्रीव्यू शीट 1 वैसी ही बनाता है जैसी प्रिंट होगी — असली थंबनेल, मार्जिन, गैप और बॉर्डर।",
    },
    {
      en: "A4 or US Letter sheets, or match the first page — portrait, landscape or auto.",
      hi: "A4 या US Letter शीट, या पहले पेज जितनी — पोर्ट्रेट, लैंडस्केप या ऑटो।",
    },
    {
      en: "Choose reading order, sheet margin, page gap and hairline borders.",
      hi: "क्रम, शीट मार्जिन, पेज गैप और पतली बॉर्डर — सब आपके हिसाब से।",
    },
    {
      en: "Pages rotated 90°, 180° or 270° land the right way up in their cells.",
      hi: "90°, 180° या 270° घुमे पेज अपनी जगह सही दिशा में बैठते हैं।",
    },
    {
      en: "Nothing is uploaded — the PDF is rearranged entirely on your device.",
      hi: "कुछ भी अपलोड नहीं होता — पूरी PDF आपके डिवाइस पर ही बनती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does N-up make my text blurry?",
        hi: "क्या N-up से टेक्स्ट धुँधला हो जाता है?",
      },
      a: {
        en: "No. Pages are placed as live PDF objects, not screenshots — text and vectors stay sharp at any size, exactly like a PDF viewer zooming out.",
        hi: "नहीं। पेज स्क्रीनशॉट नहीं, असली PDF ऑब्जेक्ट की तरह रखे जाते हैं — टेक्स्ट और वेक्टर किसी भी साइज़ में साफ़ रहते हैं, वैसे ही जैसे व्यूअर में ज़ूम करने पर।",
      },
    },
    {
      q: {
        en: "Which sheet size should I pick?",
        hi: "कौन-सी शीट साइज़ चुनें?",
      },
      a: {
        en: "A4 is the safe default for printing in India and Europe; pick US Letter for American printers. “Match page 1” keeps the paper size of your document, just scaled down to fit more pages.",
        hi: "भारत और यूरोप के प्रिंट के लिए A4 सबसे सुरक्षित है; अमेरिकी प्रिंटर के लिए US Letter चुनें। “पेज 1 जितना” आपके दस्तावेज़ की साइज़ रखता है, बस छोटा करके ज़्यादा पेज समा जाते हैं।",
      },
    },
    {
      q: {
        en: "Why is my last sheet half empty?",
        hi: "आख़िरी शीट आधी ख़ाली क्यों है?",
      },
      a: {
        en: "That's normal — the final sheet simply holds the pages that were left over. Empty cells cost nothing; you can skip them when printing.",
        hi: "यह सामान्य है — आख़िरी शीट पर बचे हुए पेज ही आते हैं। ख़ाली कोष्ठक से कोई फ़र्क़ नहीं पड़ता; प्रिंट करते समय छोड़ सकते हैं।",
      },
    },
  ],
};
