import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Invert PDF Colors (P1-b, device mode): every selected page is rendered
 * (pdf.js), every pixel's channels flipped (255 − v), and the page
 * rebuilt — a photographic negative of the document. White pages turn
 * black, classic dark-mode-for-printouts, and nothing stays selectable.
 */
export const config: ToolConfig = {
  toolId: "invert-pdf-colors",
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
        en: "Which pages to invert, e.g. 1-3, 5, 8-",
        hi: "कौन से पेज उलटें, जैसे 1-3, 5, 8-",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  features: [
    {
      en: "Flips every color — white pages become black, text becomes light",
      hi: "हर रंग पलटता है — सफ़ेद पेज काले, टेक्स्ट हल्के",
    },
    {
      en: "Great for dark-mode reading prints or artistic negative effects",
      hi: "डार्क-मोड रीडिंग प्रिंट या निगेटिव इफ़ेक्ट के लिए",
    },
    {
      en: "Pick the DPI yourself — screen draft to print quality",
      hi: "DPI खुद चुनें — स्क्रीन ड्राफ़्ट से प्रिंट क्वालिटी तक",
    },
    {
      en: "Choose the pages — invert the whole file or a range",
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
        en: "Is the inverted PDF still searchable?",
        hi: "क्या उलटा हुआ PDF फिर भी सर्च हो सकता है?",
      },
      a: {
        en: "No — pages become images, so text is no longer selectable or searchable. That's inherent to any color inversion of a rendered page; copy the text out first if you need it.",
        hi: "नहीं — पेज तस्वीर बन जाते हैं, इसलिए टेक्स्ट सिलेक्ट या सर्च नहीं होता। यह किसी भी रेंडर्ड इनवर्ज़न की स्वाभाविक बात है; ज़रूरत हो तो पहले टेक्स्ट निकाल लें।",
      },
    },
    {
      q: {
        en: "Why is my inverted file bigger than the original?",
        hi: "उलटी फ़ाइल मूल से बड़ी क्यों है?",
      },
      a: {
        en: "Dark pages have lots of tonal detail for JPEG to encode. Pick 96–150 DPI, JPEG format, and quality around 75–85 to keep it lean.",
        hi: "काले पेजों में JPEG के लिए बहुत टोनल डिटेल होती है। 96–150 DPI, JPEG और 75–85 क्वालिटी रखें।",
      },
    },
  ],
};
