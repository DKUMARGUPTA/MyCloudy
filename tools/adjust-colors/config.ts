import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Adjust PDF colors (PHASE-3 batch 2): brightness, contrast and saturation
 * per page — lighten scans, punch up washed-out exports or calm loud
 * slides. A high-quality raster pass (every selected page re-rendered at
 * your chosen DPI, pixels transformed, rebuilt losslessly as PNG).
 */
export const config: ToolConfig = {
  toolId: "adjust-colors",
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
      id: "brightness",
      label: { en: "Brightness", hi: "चमक" },
      hint: {
        en: "−100 dark · 0 unchanged · 100 bright",
        hi: "−100 अंधेरा · 0 वैसा ही · 100 रोशन",
      },
      min: -100,
      max: 100,
      step: 5,
      default: 0,
    },
    {
      kind: "number",
      id: "contrast",
      label: { en: "Contrast", hi: "कंट्रास्ट" },
      hint: {
        en: "−100 flat · 0 unchanged · 100 punchy",
        hi: "−100 फीका · 0 वैसा ही · 100 चुस्त",
      },
      min: -100,
      max: 100,
      step: 5,
      default: 0,
    },
    {
      kind: "number",
      id: "saturation",
      label: { en: "Saturation", hi: "सैचुरेशन" },
      hint: {
        en: "−100 greyscale · 0 unchanged · 100 vivid",
        hi: "−100 ग्रेस्केल · 0 वैसा ही · 100 चटकीला",
      },
      min: -100,
      max: 100,
      step: 5,
      default: 0,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["compress-pdf", "invert-colors", "pdf-to-greyscale"],
  features: [
    {
      en: "Brightness, contrast and saturation — one pass, live on every selected page.",
      hi: "चमक, कंट्रास्ट और सैचुरेशन — एक ही बार में चुने हुए हर पेज पर।",
    },
    {
      en: "Rescue dark scans, faded prints and over-busy slides without re-exporting.",
      hi: "अँधेरे स्कैन, फीके प्रिंट और भड़कीली स्लाइड बिना दोबारा एक्सपोर्ट सुधारें।",
    },
    {
      en: "Screen, balanced or print resolution — you pick the sharpness.",
      hi: "स्क्रीन, संतुलित या प्रिंट रेज़ोल्यूशन — तीखापन आप चुनें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
    {
      en: "Honest about the trade-off: adjusted pages become high-quality images.",
      hi: "साफ़-साफ़ बात: बदले हुए पेज उच्च-क्वालिटी इमेज बन जाते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does 0 mean the page is left untouched?",
        hi: "क्या 0 का मतलब है पेज बिल्कुल अछूता?",
      },
      a: {
        en: "Yes — all three sliders at 0 is a faithful copy; the transform only bends pixels away from 0. Set saturation −100 alone for a greyscale copy with brightness/contrast still available.",
        hi: "हाँ — तीनों स्लाइडर 0 पर रखने से जस की तस कॉपी बनती है। सिर्फ़ सैचुरेशन −100 रखें तो ग्रेस्केल कॉपी मिलती है, साथ में चमक-कंट्रास्ट भी।",
      },
    },
    {
      q: {
        en: "Why do pages become images?",
        hi: "पेज इमेज क्यों बन जाते हैं?",
      },
      a: {
        en: "Color math works on rendered pixels, so the adjusted pages carry images. Text stays perfectly readable; keep the original for editing.",
        hi: "रंग का हिसाब रेंडर किए पिक्सलों पर चलता है, इसलिए बदले पेज इमेज लेते हैं। टेक्स्ट पढ़ने में बिल्कुल साफ़ रहता है; संपादन के लिए मूल रखें।",
      },
    },
    {
      q: {
        en: "What order are the adjustments applied in?",
        hi: "बदलाव किस क्रम में लगते हैं?",
      },
      a: {
        en: "Brightness first, then contrast, then saturation — the classic photo-editor order, so results match what you'd expect from any image app.",
        hi: "पहले चमक, फिर कंट्रास्ट, फिर सैचुरेशन — फ़ोटो एडिटर का मानक क्रम, ताकि नतीजा हर इमेज ऐप जैसा ही लगे।",
      },
    },
  ],
};
