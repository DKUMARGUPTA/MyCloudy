import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to Greyscale (P1-b, device mode): every selected page is rendered
 * (pdf.js) and converted to Rec. 601 luma — the eye-weighted grey —
 * then rebuilt. Color logos, highlights and photos calm down to clean
 * printer-friendly greys; text contrast is preserved.
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
  chainToolIds: ["view-pdf", "compress-pdf"],
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Image resolution", hi: "इमेज रेज़ोल्यूशन" },
      hint: {
        en: "Higher DPI looks sharper but makes a bigger file",
        hi: "ज़्यादा DPI ज़्यादा शार्प, पर फ़ाइल बड़ी",
      },
      choices: [
        {
          value: "72",
          label: { en: "72 DPI — screen draft", hi: "72 DPI — स्क्रीन ड्राफ़्ट" },
        },
        {
          value: "96",
          label: { en: "96 DPI — screen", hi: "96 DPI — स्क्रीन" },
        },
        {
          value: "150",
          label: { en: "150 DPI — good (suggested)", hi: "150 DPI — अच्छा (सुझाया)" },
        },
        {
          value: "220",
          label: { en: "220 DPI — high", hi: "220 DPI — हाई" },
        },
        {
          value: "300",
          label: { en: "300 DPI — print", hi: "300 DPI — प्रिंट" },
        },
      ],
      default: "150",
    },
    {
      kind: "select",
      id: "format",
      label: { en: "Image format", hi: "इमेज फ़ॉर्मैट" },
      choices: [
        {
          value: "jpeg",
          label: { en: "JPEG — smaller file", hi: "JPEG — छोटी फ़ाइल" },
        },
        {
          value: "png",
          label: { en: "PNG — lossless", hi: "PNG — लॉसलेस" },
        },
      ],
      default: "jpeg",
    },
    {
      kind: "number",
      id: "jpegQuality",
      label: { en: "JPEG quality", hi: "JPEG क्वालिटी" },
      hint: {
        en: "Only used for JPEG — lower means a smaller file",
        hi: "सिर्फ़ JPEG के लिए — कम मतलब छोटी फ़ाइल",
      },
      min: 60,
      max: 95,
      step: 5,
      suffix: { en: "%", hi: "%" },
      default: 85,
      showWhen: { id: "format", equals: "jpeg" },
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages to grey out, e.g. 1-3, 5, 8-",
        hi: "कौन से पेज ग्रे बनें, जैसे 1-3, 5, 8-",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  features: [
    {
      en: "True greyscale conversion — eye-weighted luma, not a red-channel dump",
      hi: "असली ग्रेस्केल — आँख के हिसाब से ल्यूमा, सिर्फ़ एक चैनल नहीं",
    },
    {
      en: "Text stays sharp and readable on the grey pages",
      hi: "ग्रे पेजों पर टेक्स्ट शार्प और पढ़ने योग्य रहता है",
    },
    {
      en: "Printer-friendly — no more wasted color ink",
      hi: "प्रिंटर-फ़्रेंडली — रंगीन स्याही बचाएँ",
    },
    {
      en: "Choose the pages — grey the whole file or a range",
      hi: "पेज चुनें — पूरी फ़ाइल या सिर्फ़ एक रेंज",
    },
    {
      en: "100% on-device — your file never leaves the browser",
      hi: "100% ऑन-डिवाइस — फ़ाइल ब्राउज़र से बाहर नहीं जाती",
    },
  ],
  faq: [
    {
      q: {
        en: "What's the difference from printing in black & white?",
        hi: "प्रिंटर से ब्लैक-एंड-व्हाइट प्रिंट से इसमें क्या फ़र्क है?",
      },
      a: {
        en: "The file itself becomes greyscale — every viewer, every print dialog, every share shows it grey. Your print settings can stay on whatever the printer supports.",
        hi: "फ़ाइल ख़ुद ग्रेस्केल बन जाती है — हर व्यूअर, हर प्रिंट डायलॉग में वैसी ही दिखती है। प्रिंटर सेटिंग आपकी मर्ज़ी की रह सकती है।",
      },
    },
    {
      q: {
        en: "Why did my file size grow?",
        hi: "फ़ाइल साइज़ बढ़ी क्यों?",
      },
      a: {
        en: "Pages become images at your chosen DPI. 96–150 DPI with JPEG at 80–85 quality usually lands close to the original size — and often smaller than a color scan.",
        hi: "पेज आपकी चुनी DPI पर तस्वीर बनते हैं। 96–150 DPI और JPEG 80–85 पर साइज़ पास-पास आता है — कई बार रंगीन स्कैन से छोटा भी।",
      },
    },
  ],
};
