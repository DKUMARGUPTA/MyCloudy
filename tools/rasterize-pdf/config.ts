import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rasterize PDF (PRD §7.5 / §8.4, device mode): every selected page is
 * rendered to an image and rebuilt into a new PDF — the output has no
 * selectable text, no editable vectors, no hidden form fields. DPI choice
 * trades sharpness for size; JPEG re-encodes smaller, PNG is lossless.
 */
export const config: ToolConfig = {
  toolId: "rasterize-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "compress-pdf", "lock-pdf"],
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
        en: "Which pages to turn into images, e.g. 1-3, 5, 8-",
        hi: "कौन से पेज तस्वीर बनें, जैसे 1-3, 5, 8-",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  features: [
    {
      en: "Every page becomes a flat image — text can't be copied or edited",
      hi: "हर पेज एक सपाट तस्वीर बन जाता है — टेक्स्ट कॉपी या एडिट नहीं हो सकता",
    },
    {
      en: "Pick the DPI yourself — screen draft to print quality",
      hi: "DPI खुद चुनें — स्क्रीन ड्राफ़्ट से प्रिंट क्वालिटी तक",
    },
    {
      en: "JPEG or PNG per page, with a quality slider for JPEG",
      hi: "हर पेज JPEG या PNG, JPEG के लिए क्वालिटी स्लाइडर",
    },
    {
      en: "Keeps the visible page size and rotation exactly as you see them",
      hi: "पेज का साइज़ और रोटेशन वैसा ही रहता जैसा दिखता है",
    },
    {
      en: "100% on-device — your file never leaves the browser",
      hi: "100% ऑन-डिवाइस — फ़ाइल ब्राउज़र से बाहर नहीं जाती",
    },
  ],
  faq: [
    {
      q: {
        en: "What's the difference between Rasterize and Flatten?",
        hi: "रास्टराइज़ और फ़्लैटन में क्या फ़र्क़ है?",
      },
      a: {
        en: "Flatten merges form fields and comments into the page but keeps real text and vectors. Rasterize turns pages into images — nothing stays selectable, searchable or editable.",
        hi: "फ़्लैटन फ़ॉर्म फ़ील्ड और टिप्पणियाँ पेज में मिला देता है, पर टेक्स्ट असली रहता है। रास्टराइज़ पेजों को तस्वीर बना देता है — कुछ भी सिलेक्ट, सर्च या एडिट नहीं होता।",
      },
    },
    {
      q: {
        en: "Why would I want text to stop being selectable?",
        hi: "टेक्स्ट का सिलेक्ट न होना कब काम आता है?",
      },
      a: {
        en: "It's a privacy shield — quotes, hidden layers and metadata-like text structures can't be lifted from the file. It also freezes the exact look of tricky layouts everywhere.",
        hi: "यह प्राइवेसी कवच है — फ़ाइल से टेक्स्ट उठाया नहीं जा सकता, न छिपी परतें। मुश्किल लेआउट भी हर जगह वैसे ही दिखते हैं।",
      },
    },
    {
      q: {
        en: "Which DPI should I pick?",
        hi: "कौन सा DPI चुनें?",
      },
      a: {
        en: "150 DPI is sharp enough for reading on any screen. Use 300 DPI when the output will be printed; 72–96 DPI when you just need a light preview copy.",
        hi: "150 DPI स्क्रीन पर पढ़ने के लिए काफ़ी है। प्रिंट के लिए 300 DPI; हल्की प्रीव्यू कॉपी के लिए 72–96 DPI।",
      },
    },
  ],
};
