import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Posterize PDF (P1-b, device mode): snaps every page's colors to a few
 * evenly spaced levels — 2 levels is stark black/white per channel, 4 is
 * the classic screen-print poster look, 8 a subtle palette crunch.
 * Great for zines, flyers and low-ink proofs.
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
  chainToolIds: ["view-pdf", "compress-pdf"],
  options: [
    {
      kind: "select",
      id: "levels",
      label: { en: "Color levels per channel", hi: "हर चैनल में रंग लेवल" },
      hint: {
        en: "Fewer levels = bolder, flatter colors",
        hi: "कम लेवल = ज़्यादा बोल्ड, फ़्लैट रंग",
      },
      choices: [
        {
          value: "2",
          label: { en: "2 — pure black & white", hi: "2 — शुद्ध काला-सफ़ेद" },
        },
        {
          value: "3",
          label: { en: "3 — stark poster", hi: "3 — तीखा पोस्टर" },
        },
        {
          value: "4",
          label: { en: "4 — classic poster (suggested)", hi: "4 — क्लासिक पोस्टर (सुझाया)" },
        },
        {
          value: "6",
          label: { en: "6 — soft poster", hi: "6 — हल्का पोस्टर" },
        },
        {
          value: "8",
          label: { en: "8 — subtle crunch", hi: "8 — हल्की क्रंच" },
        },
      ],
      default: "4",
    },
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
          label: { en: "PNG — lossless, exact levels", hi: "PNG — लॉसलेस, सटीक लेवल" },
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
        en: "Which pages to posterize, e.g. 1-3, 5, 8-",
        hi: "कौन से पेज पोस्टराइज़ हों, जैसे 1-3, 5, 8-",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  features: [
    {
      en: "Snaps every color to a few flat levels — the poster look",
      hi: "हर रंग कुछ फ़्लैट लेवल पर बैठ जाता है — पोस्टर लुक",
    },
    {
      en: "2 to 8 levels — from stark black & white to a subtle crunch",
      hi: "2 से 8 लेवल — तीखे काले-सफ़ेद से हल्की क्रंच तक",
    },
    {
      en: "PNG mode keeps the exact flat levels, JPEG keeps it small",
      hi: "PNG मोड में सटीक फ़्लैट लेवल, JPEG में छोटा साइज़",
    },
    {
      en: "Choose the pages — posterize the whole file or a range",
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
        en: "Why choose PNG for exact levels?",
        hi: "सटीक लेवल के लिए PNG क्यों?",
      },
      a: {
        en: "JPEG is lossy — it smears the flat poster areas slightly. PNG stores each pixel exactly, so a 2-level page stays pure black & white.",
        hi: "JPEG लॉसी है — फ़्लैट पोस्टर हिस्सों को थोड़ा फैलाता है। PNG हर पिक्सेल सटीक रखता है, इसलिए 2-लेवल पेज शुद्ध काला-सफ़ेद रहता है।",
      },
    },
    {
      q: {
        en: "Is posterize the same as greyscale?",
        hi: "पोस्टराइज़ और ग्रेस्केल एक ही चीज़ है?",
      },
      a: {
        en: "No — posterize keeps the colors but flattens them to a few shades; greyscale removes color entirely. Combine them via the tool chain if you want a monochrome poster.",
        hi: "नहीं — पोस्टराइज़ रंग रखता है पर कुछ शेड में समेट देता है; ग्रेस्केल रंग हटा देता है। मोनोक्रोम पोस्टर चाहिए तो टूल चेन से दोनों लगाएँ।",
      },
    },
  ],
};
