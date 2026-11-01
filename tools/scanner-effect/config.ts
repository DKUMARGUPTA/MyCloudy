import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Scanner effect (PHASE-3 batch 2): make a clean digital PDF look like it
 * came off a flatbed — paper-gray palette, sensor noise and a half-degree
 * tilt. For authentic-looking archives, test fixtures and honest demos.
 */
export const config: ToolConfig = {
  toolId: "scanner-effect",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Scanner resolution (DPI)", hi: "स्कैनर रेज़ोल्यूशन (DPI)" },
      choices: [
        { value: "150", label: { en: "150 — quick scan", hi: "150 — तुरंत स्कैन" } },
        { value: "200", label: { en: "200 — typical flatbed", hi: "200 — आम फ़्लैटबेड" } },
        { value: "300", label: { en: "300 — office scanner", hi: "300 — ऑफ़िस स्कैनर" } },
      ],
      default: "200",
    },
    {
      kind: "select",
      id: "color",
      label: { en: "Scan mode", hi: "स्कैन मोड" },
      choices: [
        { value: "grayscale", label: { en: "Greyscale — classic office scan", hi: "ग्रेस्केल — क्लासिक ऑफ़िस स्कैन" } },
        { value: "bw", label: { en: "Black & white — fax / threshold", hi: "काला-सफ़ेद — फ़ैक्स / थ्रेशोल्ड" } },
        { value: "faint-color", label: { en: "Faint colour — old book scan", hi: "हल्का रंग — पुरानी किताब स्कैन" } },
      ],
      default: "grayscale",
    },
    {
      kind: "number",
      id: "tilt",
      label: { en: "Tilt (degrees)", hi: "झुकाव (डिग्री)" },
      hint: {
        en: "0 = straight · 0.5–1.5 = believable",
        hi: "0 = सीधा · 0.5–1.5 = सही लगता है",
      },
      min: 0,
      max: 3,
      step: 0.1,
      default: 0.5,
    },
    {
      kind: "number",
      id: "noise",
      label: { en: "Sensor noise", hi: "सेंसर नॉइज़" },
      hint: {
        en: "0 = clean · 100 = rough old machine",
        hi: "0 = साफ़ · 100 = पुरानी मशीन की खुरदरी",
      },
      min: 0,
      max: 100,
      step: 5,
      default: 25,
    },
  ],
  chainToolIds: ["compress-pdf", "pdf-to-greyscale", "view-pdf"],
  features: [
    {
      en: "Believable flatbed look — paper tones, sensor grain, slight rotation.",
      hi: "सच्चा फ़्लैटबेड लुक — काग़ज़ी रंग, सेंसर का दाना, हल्का झुकाव।",
    },
    {
      en: "Three scan modes: greyscale office, black-&-white fax, faded book colour.",
      hi: "तीन स्कैन मोड: ग्रेस्केल ऑफ़िस, काला-सफ़ेद फ़ैक्स, धुँधली किताब का रंग।",
    },
    {
      en: "Tilt and noise dials — from crisp office scanner to rough archive machine.",
      hi: "झुकाव और नॉइज़ के डायल — साफ़ ऑफ़िस स्कैनर से खुरदरी आर्काइव मशीन तक।",
    },
    {
      en: "JPEG pipeline like real scanners — honest about file-size trade-offs.",
      hi: "असली स्कैनर जैसी JPEG पाइपलाइन — साइज़ का सच भी साफ़।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why would I want a PDF to look scanned?",
        hi: "PDF को स्कैन किया हुआ क्यों दिखाना चाहेंगे?",
      },
      a: {
        en: "Digital-native files sometimes need the feel of paper — archive demos, test fixtures for OCR pipelines, or documents where 'this came from a machine' reads more natural than a perfect export.",
        hi: "डिजिटल फ़ाइलों को कभी-कभी काग़ज़ जैसा भाव चाहिए — आर्काइव डेमो, OCR पाइपलाइन के टेस्ट, या वे दस्तावेज़ जहाँ 'मशीन से आया' परफ़ेक्ट एक्सपोर्ट से ज़्यादा स्वाभाविक लगता है।",
      },
    },
    {
      q: {
        en: "Is the text still selectable afterwards?",
        hi: "बाद में टेक्स्ट चुनने योग्य रहता है?",
      },
      a: {
        en: "No — a scan is a picture of a page. That's the point of the effect. Need searchable text on top? Run OCR on the output.",
        hi: "नहीं — स्कैन पेज की तस्वीर होती है, यही तो असर है। ऊपर ढूँढने योग्य टेक्स्ट चाहिए तो आउटपुट पर OCR चलाएँ।",
      },
    },
    {
      q: {
        en: "Which settings look most realistic?",
        hi: "कौन-सी सेटिंग सबसे सच्ची लगती है?",
      },
      a: {
        en: "200 DPI greyscale, tilt 0.5–1°, noise 20–30 is the sweet spot for an office flatbed. B&W with noise 40+ reads as an old fax.",
        hi: "200 DPI ग्रेस्केल, झुकाव 0.5–1°, नॉइज़ 20–30 — ऑफ़िस फ़्लैटबेड का सही मिक्स। काला-सफ़ेद में नॉइज़ 40+ पुराना फ़ैक्स लगता है।",
      },
    },
  ],
};
