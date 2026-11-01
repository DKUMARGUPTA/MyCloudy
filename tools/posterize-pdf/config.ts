import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Posterize PDF (PHASE-3 batch 2): crush each channel down to 2–32 levels —
 * the flat, poster-like look of screen-print art. A raster pass (every
 * selected page re-rendered at your DPI, quantized, rebuilt losslessly).
 */
export const config: ToolConfig = {
  toolId: "posterize-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
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
      kind: "number",
      id: "levels",
      label: { en: "Color levels per channel", hi: "हर चैनल में रंग स्तर" },
      hint: {
        en: "2 = boldest poster · 32 = subtle",
        hi: "2 = सबसे बड़ा पोस्टर · 32 = हल्का",
      },
      min: 2,
      max: 32,
      step: 1,
      default: 4,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["compress-pdf", "adjust-colors", "pdf-to-greyscale"],
  features: [
    {
      en: "Screen-print look in one pass — flat color fields, no gradients.",
      hi: "एक बार में स्क्रीन-प्रिंट लुक — फ़्लैट रंग के मैदान, ग्रेडिएंट नहीं।",
    },
    {
      en: "2 to 32 levels per channel — dial from bold poster to gentle stylization.",
      hi: "हर चैनल में 2 से 32 स्तर — बड़े पोस्टर से हल्की स्टाइल तक।",
    },
    {
      en: "Screen, balanced or print resolution — you pick the sharpness.",
      hi: "स्क्रीन, संतुलित या प्रिंट रेज़ोल्यूशन — तीखापन आप चुनें।",
    },
    {
      en: "Great for flyers, zines and bold presentation covers.",
      hi: "फ़्लायर, ज़ाइन और दमदार प्रेज़ेंटेशन कवर के लिए बढ़िया।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly does posterize do?",
        hi: "पोस्टराइज़ करने से आख़िर होता क्या है?",
      },
      a: {
        en: "Each color channel is snapped to a small set of evenly spaced values. With 4 levels, every red/green/blue becomes one of just 4 shades — gradients collapse into flat bands, which reads as poster art.",
        hi: "हर रंग चैनल थोड़े से बराबर फ़ासले वाले मानों पर बैठ जाता है। 4 स्तर पर हर लाल/हरा/नीला सिर्फ़ 4 शेड में से एक बन जाता है — ग्रेडिएंट फ़्लैट पट्टियों में मिट जाते हैं, जो पोस्टर-कला जैसा दिखता है।",
      },
    },
    {
      q: {
        en: "Which level count should I pick?",
        hi: "कितने स्तर चुनने चाहिए?",
      },
      a: {
        en: "3–6 gives the classic bold poster. 8–12 keeps recognizable photos with a stylized edge. Above 20 you'll need to squint to see any change.",
        hi: "3–6 पर क्लासिक बोल्ड पोस्टर। 8–12 पर फ़ोटो पहचान में रहती है, स्टाइल भी। 20 से ऊपर फ़र्क़ देखने को आँखें तानी पड़ेंगी।",
      },
    },
    {
      q: {
        en: "Is the text still selectable?",
        hi: "टेक्स्ट अब भी चुनने योग्य रहता है?",
      },
      a: {
        en: "No — posterizing works on rendered pixels, so pages become images. Keep the original for text work.",
        hi: "नहीं — पोस्टराइज़ रेंडर किए पिक्सलों पर चलता है, इसलिए पेज इमेज बन जाते हैं। टेक्स्ट के काम के लिए मूल रखें।",
      },
    },
  ],
};
