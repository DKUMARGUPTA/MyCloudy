import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Deskew PDF (PHASE-7): auto-detect the tilt of every page (the scanner
 * skew that 90° rotate tools cannot touch) and straighten it — as a
 * vector transform, not a re-render, so text and line art keep their
 * full quality. Detection reuses the battle-tested ocr-pdf Hough-lite
 * projection-profile engine; the fix is a Form-XObject centre rotation
 * on our own ComposeContext.
 */
export const config: ToolConfig = {
  toolId: "deskew-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages to straighten", hi: "कौन से पेज सीधे करने हैं" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
    {
      kind: "select",
      id: "sizing",
      label: { en: "Page size", hi: "पेज का आकार" },
      choices: [
        {
          value: "keep",
          label: { en: "Keep original", hi: "असली रखें" },
        },
        {
          value: "grow",
          label: {
            en: "Grow to fit (nothing clips)",
            hi: "फ़िट होने तक बढ़ाएँ (कुछ नहीं कटे)",
          },
        },
      ],
      default: "keep",
    },
  ],
  chainToolIds: ["rotate-custom", "crop-pdf", "ocr-pdf"],
  features: [
    {
      en: "Automatic tilt detection — the page's own text baselines decide the angle, no measuring by hand.",
      hi: "झुकाव की अपने-आप पहचान — कोण पेज की टेक्स्ट-लाइनें ख़ुद तय करती हैं, हाथ से नापने की ज़रूरत नहीं।",
    },
    {
      en: "Sub-degree precision: corrections land in 0.05° steps, so the straightening is invisible-smooth.",
      hi: "डिग्री से भी बारीक: सुधार 0.05° के कदमों में लगते हैं — सीधा करना बिल्कुल सहज।",
    },
    {
      en: "A vector transform, not a re-render — text and line art stay as crisp as the original.",
      hi: "रेंडर नहीं, वेक्टर ट्रांसफ़ॉर्म — टेक्स्ट और लाइन-आर्ट उतने ही साफ़ रहते हैं जितने असली में थे।",
    },
    {
      en: "Every page keeps its size by default; a grow option keeps even the tilted corners from clipping.",
      hi: "हर पेज अपना आकार रखता है; grow विकल्प से तिरछे कोनों तक का कुछ भी नहीं कटता।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from Rotate by custom angle?",
        hi: "यह Rotate by custom angle से कैसे अलग है?",
      },
      a: {
        en: "There you type the angle; here the tool reads it from the page itself. It analyses the text baselines in a low-resolution probe and straightens each page by exactly its own tilt — per page, not one angle for all.",
        hi: "वहाँ आप कोण टाइप करते हैं; यहाँ टूल उसे पेज से ख़ुद पढ़ता है। यह टेक्स्ट-लाइनों का कम-रिज़ॉल्यूशन विश्लेषण करके हर पेज को उसी के अपने झुकाव से सीधा करता है — हर पेज का अलग, सबका एक नहीं।",
      },
    },
    {
      q: {
        en: "A page came back unchanged — why?",
        hi: "एक पेज बिना बदले लौट आया — क्यों?",
      },
      a: {
        en: "Honesty first: pages with no confident text baselines (photos, drawings, near-blank scans, or a tilt under ~0.3°) are passed through untouched rather than rotated by a guess.",
        hi: "ईमानदारी पहले: जिन पेजों पर भरोसेमंद टेक्स्ट-लाइनें नहीं मिलतीं (तस्वीरें, ड्रॉइंग, लगभग ख़ाली स्कैन, या ~0.3° से कम झुकाव) वे बिना अंधाधुंध घुमाए वैसे के रहते हैं।",
      },
    },
    {
      q: {
        en: "Will the fixed page look softer than the scan?",
        hi: "क्या सुधारे हुए पेज स्कैन से धुंधले लगेंगे?",
      },
      a: {
        en: "No. The pixels are only a probe for measuring the angle — the correction is applied to the page as vectors, so the output keeps every sharp edge of the original at any zoom.",
        hi: "नहीं। पिक्सल सिर्फ़ कोण नापने का औज़ार हैं — सुधार पेज पर वेक्टर की तरह लगता है, इसलिए नतीजा किसी भी ज़ूम पर असली की हर तेज़ धार रखता है।",
      },
    },
  ],
};
