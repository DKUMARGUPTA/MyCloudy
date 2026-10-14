import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Halve PDF pages (PRD §8.1: "Cut scanned book spreads into left/right
 * single pages"). Schema-driven options — every id matches what the
 * worker reads via HALVE_IDS (tools/halve-pdf-pages/engine.ts): cut,
 * verticalOrder, horizontalOrder, cutPosition (percent), reverseOrder,
 * pages. The custom panel (panel.tsx) explains the cut visually from the
 * same values; the worker windows each page's MediaBox/CropBox to the
 * planned halves — no re-rendering, so content stays lossless.
 */
export const config: ToolConfig = {
  toolId: "halve-pdf-pages",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "merge-pdf", "split-pdf"],
  options: [
    {
      kind: "select",
      id: "cut",
      label: { en: "Cut direction", hi: "काट की दिशा" },
      hint: {
        en: "Vertical splits a spread into left/right pages",
        hi: "लंबवत काट स्प्रेड को बाएँ/दाएँ पेज बनाती है",
      },
      choices: [
        {
          value: "vertical",
          label: { en: "Vertical — left / right", hi: "लंबवत — बाएँ / दाएँ" },
        },
        {
          value: "horizontal",
          label: { en: "Horizontal — top / bottom", hi: "क्षैतिज — ऊपर / नीचे" },
        },
      ],
      default: "vertical",
    },
    {
      kind: "select",
      id: "verticalOrder",
      label: { en: "Which half comes first", hi: "पहले कौन-सा आधा" },
      showWhen: { id: "cut", equals: "vertical" },
      choices: [
        { value: "left", label: { en: "Left half first", hi: "पहले बायाँ आधा" } },
        { value: "right", label: { en: "Right half first", hi: "पहले दायाँ आधा" } },
      ],
      default: "left",
    },
    {
      kind: "select",
      id: "horizontalOrder",
      label: { en: "Which half comes first", hi: "पहले कौन-सा आधा" },
      showWhen: { id: "cut", equals: "horizontal" },
      choices: [
        { value: "top", label: { en: "Top half first", hi: "पहले ऊपर का आधा" } },
        { value: "bottom", label: { en: "Bottom half first", hi: "पहले नीचे का आधा" } },
      ],
      default: "top",
    },
    {
      kind: "number",
      id: "cutPosition",
      label: { en: "Cut position", hi: "काट की जगह" },
      hint: {
        en: "Where the cut lands across the page — 50 is the middle",
        hi: "काट पेज पर कहाँ लगेगी — 50 बीच में",
      },
      min: 40,
      max: 60,
      step: 1,
      suffix: { en: "%", hi: "%" },
      default: 50,
    },
    {
      kind: "switch",
      id: "reverseOrder",
      label: { en: "Reverse output order", hi: "क्रम उलटें" },
      hint: {
        en: "Handy for book scans read back to front",
        hi: "उल्टी किताबों के स्कैन के लिए उपयोगी",
      },
      default: false,
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
      en: "Turn scanned book spreads into single pages — every page becomes its left and right half, in order.",
      hi: "स्कैन की किताब के स्प्रेड अलग-अलग पेज बनें — हर पेज का बायाँ और दायाँ आधा, क्रम से।",
    },
    {
      en: "Cut vertically or horizontally, left/right or top/bottom first, at any position between 40% and 60%.",
      hi: "लंबवत या क्षैतिज काटें, बाएँ/दाएँ या ऊपर/नीचे पहले — 40% से 60% के बीच कहीं भी।",
    },
    {
      en: "The cut follows what you SEE: pages rotated 90° or 270° are halved in their displayed direction.",
      hi: "काट वैसी लगती है जैसी दिखती है: 90° या 270° घुमे पेज भी दिखने वाली दिशा में कटते हैं।",
    },
    {
      en: "Nothing is re-rendered — text and vectors stay lossless, only the page window moves.",
      hi: "कुछ दोबारा नहीं बनता — टेक्स्ट और वेक्टर जस के तस, सिर्फ़ पेज की खिड़की खिसकती है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is any content thrown away?",
        hi: "क्या कुछ कंटेंट हट जाता है?",
      },
      a: {
        en: "Each half is a window onto the same page content — nothing is re-compressed or re-rendered. The two halves together still contain everything the original page had; the cut only sets which part each output page shows.",
        hi: "हर आधा उसी पेज कंटेंट की खिड़की है — कुछ भी दोबारा कंप्रेस या रेंडर नहीं होता। दोनों आधे मिलकर पुराना पेज पूरा रखते हैं; काट सिर्फ़ तय करती है कि हर आउटपुट पेज कौन-सा हिस्सा दिखाए।",
      },
    },
    {
      q: {
        en: "My book scans are two pages per sheet — which cut do I need?",
        hi: "मेरी किताब के स्कैन में एक शीट पर दो पेज हैं — कौन-सी काट लगाएँ?",
      },
      a: {
        en: "Vertical, left first, at 50%. That turns each scanned spread into its left page followed by its right page, in reading order.",
        hi: "लंबवत, पहले बायाँ, 50% पर। इससे हर स्कैन किया स्प्रेड पढ़ने के क्रम में बायाँ पेज और फिर दायाँ पेज बन जाता है।",
      },
    },
    {
      q: {
        en: "Why can the cut position only move between 40% and 60%?",
        hi: "काट की जगह सिर्फ़ 40% से 60% के बीच क्यों?",
      },
      a: {
        en: "This tool is for halving, not arbitrary cropping — a cut far off the middle usually means the scan needs the Crop tool instead. Keep it near the spine, or crop first and halve after.",
        hi: "यह टूल आधा करने के लिए है, मनमर्ज़ी से क्रॉप करने के लिए नहीं — बीच से दूर काट आम तौर पर क्रॉप टूल का काम है। पहले क्रॉप करें, फिर आधा करें।",
      },
    },
  ],
};
