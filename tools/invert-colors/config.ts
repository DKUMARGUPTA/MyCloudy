import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Invert PDF colors (PHASE-3): photographic-negative pages — white text
 * on black for night reading, or artistic effects. A high-quality
 * raster pass (every page re-rendered at your chosen DPI, then
 * pixel-inverted and rebuilt losslessly).
 */
export const config: ToolConfig = {
  toolId: "invert-colors",
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
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["background-color", "compress-pdf", "view-pdf"],
  features: [
    {
      en: "Photographic negative — white text on black, easy night reading.",
      hi: "फ़ोटो निगेटिव — काले पर सफ़ेद टेक्स्ट, रात की आरामदायक पढ़ाई।",
    },
    {
      en: "Screen, balanced or print resolution — you pick the sharpness.",
      hi: "स्क्रीन, संतुलित या प्रिंट रेज़ोल्यूशन — तीखापन आप चुनें।",
    },
    {
      en: "Invert every page or just a range.",
      hi: "हर पेज उलटें या सिर्फ़ एक रेंज।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
    {
      en: "Honest about the trade-off: pages become high-quality images.",
      hi: "साफ़-साफ़ बात: पेज उच्च-क्वालिटी इमेज बन जाते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the text still be selectable?",
        hi: "क्या टेक्स्ट अब भी चुनने योग्य रहेगा?",
      },
      a: {
        en: "No — inverting works on rendered pixels, so the output pages are images. Keep the original for text work; use this copy for reading.",
        hi: "नहीं — उलटना रेंडर किए पिक्सलों पर चलता है, इसलिए पेज इमेज बन जाते हैं। टेक्स्ट के काम के लिए मूल रखें; पढ़ने के लिए यह कॉपी।",
      },
    },
    {
      q: {
        en: "Why does the file size change?",
        hi: "फ़ाइल साइज़ क्यों बदलती है?",
      },
      a: {
        en: "The rebuilt pages carry rendered images. 150 DPI keeps documents reasonable; use Compress PDF afterwards if you need it lighter.",
        hi: "बने पेज रेंडर की इमेज लेते हैं। 150 DPI में फ़ाइल ठीक रहती है; हल्की चाहिए तो बाद में PDF कंप्रेस करें।",
      },
    },
    {
      q: {
        en: "Inverted colors for dark mode — is that all it's for?",
        hi: "उलटे रंग सिर्फ़ डार्क मोड के लिए हैं?",
      },
      a: {
        en: "Night reading is the main use, but negatives also help low-vision contrast tweaks, film-scanning checks and striking print designs.",
        hi: "रात की पढ़ाई मुख्य इस्तेमाल है, पर निगेटिव कम दृष्टि के कंट्रास्ट, फ़िल्म-स्कैन जाँच और असरदार प्रिंट डिज़ाइन में भी काम आते हैं।",
      },
    },
  ],
};
