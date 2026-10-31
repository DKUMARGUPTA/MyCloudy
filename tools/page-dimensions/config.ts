import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Page dimensions (PHASE-3): read every page's exact size — points,
 * millimetres and inches — plus crop boxes and rotation, as a tidy text
 * report. Read-only; the PDF is never rewritten.
 */
export const config: ToolConfig = {
  toolId: "page-dimensions",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 20,
  options: [],
  chainToolIds: ["change-pdf-page-size", "crop-pdf", "view-pdf"],
  features: [
    {
      en: "Every page's size in points, millimetres AND inches.",
      hi: "हर पेज का साइज़ पॉइंट, मिलीमीटर और इंच तीनों में।",
    },
    {
      en: "Crop boxes and rotation shown — mixed-size documents laid bare.",
      hi: "क्रॉप बॉक्स और घुमाव सहित — मिक्स-साइज़ दस्तावेज़ पूरी तरह सामने।",
    },
    {
      en: "Batch: report up to 20 files in one run.",
      hi: "बैच: एक बार में 20 तक फ़ाइलों की रिपोर्ट।",
    },
    {
      en: "Perfect before resizing, cropping or print jobs.",
      hi: "रिसाइज़, क्रॉप या प्रिंट से पहले बिल्कुल सही।",
    },
    {
      en: "Read-only — the PDF is parsed, never modified or uploaded.",
      hi: "सिर्फ़ पढ़ना — PDF पढ़ी जाती है, बदली या अपलोड नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why does my \u201cA4\u201d PDF show odd numbers?",
        hi: "मेरी \u201cA4\u201d PDF में अजीब नंबर क्यों?",
      },
      a: {
        en: "A4 is 595.28 \u00d7 841.89 points — printers and editors often add slivers or work at different scales, so exact numbers reveal the truth. The report shows points, mm and inches side by side.",
        hi: "A4 = 595.28 \u00d7 841.89 पॉइंट — प्रिंटर और एडिटर अकसर थोड़ा सा जोड़ घटा देते हैं, इसलिए सटीक नंबर सच बताते हैं। रिपोर्ट पॉइंट, mm और इंच तीनों दिखाती है।",
      },
    },
    {
      q: {
        en: "What are crop boxes?",
        hi: "क्रॉप बॉक्स क्या हैं?",
      },
      a: {
        en: "A page can carry several boxes: the MediaBox is the full sheet, the CropBox is what viewers actually show. When they differ, you see both — that hidden margin is sometimes the reason content looks cropped.",
        hi: "पेज कई बॉक्स रख सकता है: MediaBox पूरी शीट है, CropBox वह जो व्यूअर दिखाता है। दोनों अलग हों तो आप दोनों देखते हैं — छुपा हुआ किनारा कभी-कभी सामग्री कटी दिखने की वजह होता है।",
      },
    },
    {
      q: {
        en: "Can I change the sizes after checking?",
        hi: "जाँच के बाद साइज़ बदल सकते हैं?",
      },
      a: {
        en: "Yes — follow up with Change page size (one paper size for every page) or Crop (trim margins visually).",
        hi: "हाँ — आगे पेज साइज़ बदलें (हर पेज एक पेपर साइज़) या क्रॉप (किनारे देखकर काटें) चलाएँ।",
      },
    },
  ],
};
