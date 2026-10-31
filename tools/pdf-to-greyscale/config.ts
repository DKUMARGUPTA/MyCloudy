import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to greyscale (PHASE-3): drain the colour out of every page —
 * print-ready monochrome, archival calm, ink-saving drafts. Each page
 * is rendered and converted with the luminance formula (the same one
 * cameras and editors use), then rebuilt losslessly.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-greyscale",
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
  chainToolIds: ["compress-pdf", "print", "view-pdf"],
  features: [
    {
      en: "True greyscale — the luminance formula, not a muddy desaturate.",
      hi: "असली ग्रेस्केल — ल्युमिनेंस फ़ॉर्मूला, फीका डिसैचुरेट नहीं।",
    },
    {
      en: "Save ink, calm loud documents, prep for monochrome printing.",
      hi: "स्याही बचाएँ, चिल्लाते दस्तावेज़ शांत करें, मोनोक्रोम प्रिंट की तैयारी।",
    },
    {
      en: "Screen, balanced or print resolution — you pick the sharpness.",
      hi: "स्क्रीन, संतुलित या प्रिंट रेज़ोल्यूशन — तीखापन आप चुनें।",
    },
    {
      en: "Convert every page or just a range.",
      hi: "हर पेज बदलें या सिर्फ़ एक रेंज।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the text stay selectable?",
        hi: "क्या टेक्स्ट चुनने योग्य रहेगा?",
      },
      a: {
        en: "The converted pages are images, so text is no longer selectable — keep the original for that. Colours inside the text and graphics become their grey equivalents.",
        hi: "बदले पेज इमेज होते हैं, इसलिए टेक्स्ट चुना नहीं जा सकता — उसके लिए मूल रखें। टेक्स्ट और ग्राफ़िक्स के रंग अपने स्लेटी रूप में बदल जाते हैं।",
      },
    },
    {
      q: {
        en: "Why greyscale instead of just printing in black?",
        hi: "सीधे काले में प्रिंट करने की जगह ग्रेस्केल क्यों?",
      },
      a: {
        en: "Printers convert colour pages themselves, often badly — banding and muddy photos. A proper luminance conversion bakes the decision in, so what you see is what prints.",
        hi: "प्रिंटर रंगीन पेज खुद बदलते हैं, अकसर बुरी तरह — धारियाँ और फीकी फ़ोटो। ठीक ल्युमिनेंस बदलाव फ़ैसला पहले ही तय कर देता है, जो दिखे वही छपे।",
      },
    },
    {
      q: {
        en: "Does this reduce the file size?",
        hi: "क्या इससे फ़ाइल छोटी होती है?",
      },
      a: {
        en: "Not by itself — the pages are rebuilt as images. Run Compress PDF on the result when you need a lighter file.",
        hi: "अपने आप नहीं — पेज इमेज बनकर दोबारा जुड़ते हैं। हल्की फ़ाइल चाहिए तो नतीजे पर PDF कंप्रेस चलाएँ।",
      },
    },
  ],
};
