import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rotate PDF pages by a custom angle (PHASE-1 Batch B): fix that 3-7°
 * scan tilt 90° tools can't touch. Every page is re-placed on a sheet
 * sized to the rotated bounding box — nothing gets cropped or squashed.
 */
export const config: ToolConfig = {
  toolId: "rotate-custom",
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
      id: "angle",
      label: { en: "Angle", hi: "कोण" },
      suffix: { en: "°", hi: "°" },
      hint: {
        en: "1 to 179 degrees — 90° steps belong to the Rotate tool",
        hi: "1 से 179 डिग्री — 90° के कदम Rotate टूल के लिए हैं",
      },
      min: 1,
      max: 179,
      default: 7,
    },
    {
      kind: "select",
      id: "direction",
      label: { en: "Direction", hi: "दिशा" },
      choices: [
        { value: "cw", label: { en: "Clockwise", hi: "घड़ी की दिशा में" } },
        {
          value: "ccw",
          label: { en: "Counter-clockwise", hi: "घड़ी के उल्टी दिशा में" },
        },
      ],
      default: "cw",
    },
  ],
  chainToolIds: ["crop-pdf", "rotate-pdf-pages", "deskew-pdf"],
  features: [
    {
      en: "Any angle from 1° to 179° — straighten the slightly-tilted scan.",
      hi: "1° से 179° तक कोई भी कोण — थोड़ा तिरछे स्कैन को सीधा करें।",
    },
    {
      en: "The sheet grows to the rotated bounding box — no cropping, no squashing.",
      hi: "शीट घुमे हुए बाउंडिंग बॉक्स तक बढ़ती है — न कटाई, न निचोड़।",
    },
    {
      en: "Vector text and images keep their full quality — a transform, not a re-render.",
      hi: "वेक्टर टेक्स्ट और तस्वीरें पूरी क्वालिटी में — रेंडर नहीं, सिर्फ़ ट्रांसफ़ॉर्म।",
    },
    {
      en: "Clockwise or counter-clockwise, one angle for every page.",
      hi: "घड़ी की दिशा या उल्टी — हर पेज पर एक ही कोण।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from Rotate PDF pages?",
        hi: "यह Rotate PDF pages से कैसे अलग है?",
      },
      a: {
        en: "The Rotate tool turns pages in 90° steps only. This tool rotates by ANY degree — the fine-grained fix for scans that came out a few degrees off level.",
        hi: "Rotate टूल सिर्फ़ 90° के कदमों में घुमाता है। यह टूल किसी भी डिग्री पर घुमाता है — उन स्कैन के लिए बारीक इलाज जो कुछ डिग्री तिरछे निकले।",
      },
    },
    {
      q: {
        en: "Why did my page get bigger?",
        hi: "मेरा पेज बड़ा क्यों हो गया?",
      },
      a: {
        en: "A tilted rectangle needs a bigger axis-aligned box — the sheet grows to the rotated bounding box so no content is lost. Crop afterwards if you want the original page size back.",
        hi: "तिरछा आयत सीधे बॉक्स में समाने के लिए ज़्यादा जगह माँगता है — शीट घुमे हुए बाउंडिंग बॉक्स तक बढ़ती है ताकि कुछ भी कटे नहीं। असली साइज़ चाहिए तो बाद में क्रॉप करें।",
      },
    },
    {
      q: {
        en: "Will the text stay sharp?",
        hi: "क्या टेक्स्ट साफ़ रहेगा?",
      },
      a: {
        en: "Yes — the page is transformed as vectors, not re-rendered to pixels. Text and line art stay as crisp as the original at any zoom.",
        hi: "हाँ — पेज पिक्सल में रेंडर नहीं होता, वेक्टर की तरह घूमता है। टेक्स्ट और लाइन-आर्ट किसी भी ज़ूम पर उतने ही साफ़ रहते हैं।",
      },
    },
  ],
};
