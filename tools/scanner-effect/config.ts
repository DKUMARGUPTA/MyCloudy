import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Scanner Effect (P1-b, device mode): makes a crisp digital PDF look
 * like it came off a flatbed scanner — greyscale, a light contrast
 * crunch, per-pixel sensor noise (light / medium / heavy) and an
 * optional warm lamp tint. Popular for "proof of paper" copies where a
 * too-perfect digital print looks suspicious.
 */
export const config: ToolConfig = {
  toolId: "scanner-effect",
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
      id: "intensity",
      label: { en: "Noise intensity", hi: "नॉइज़ की तेज़ी" },
      hint: {
        en: "How grainy the fake scan looks",
        hi: "नकली स्कैन कितना दानेदार दिखे",
      },
      choices: [
        {
          value: "light",
          label: { en: "Light — subtle grain", hi: "हल्का — बहुत हल्का दाना" },
        },
        {
          value: "medium",
          label: { en: "Medium — typical office scanner (suggested)", hi: "मध्यम — सामान्य ऑफिस स्कैनर (सुझाया)" },
        },
        {
          value: "heavy",
          label: { en: "Heavy — old clunky machine", hi: "ज़्यादा — पुरानी भारी मशीन" },
        },
      ],
      default: "medium",
    },
    {
      kind: "select",
      id: "tint",
      label: { en: "Paper tint", hi: "काग़ज़ की रंगत" },
      choices: [
        {
          value: "none",
          label: { en: "None — clean grey scan", hi: "कोई नहीं — साफ़ ग्रे स्कैन" },
        },
        {
          value: "cream",
          label: { en: "Cream — warm old lamp", hi: "क्रीम — पुरानी गर्म लैंप" },
        },
      ],
      default: "none",
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
          label: { en: "JPEG — like a real scan (suggested)", hi: "JPEG — असली स्कैन जैसा (सुझाया)" },
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
        en: "Only used for JPEG — lower looks more scanned",
        hi: "सिर्फ़ JPEG के लिए — कम ज़्यादा स्कैन-जैसा लगता है",
      },
      min: 60,
      max: 95,
      step: 5,
      suffix: { en: "%", hi: "%" },
      default: 75,
      showWhen: { id: "format", equals: "jpeg" },
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages get the scan look, e.g. 1-3, 5, 8-",
        hi: "कौन से पेज स्कैन जैसे बनें, जैसे 1-3, 5, 8-",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  features: [
    {
      en: "Crisp digital pages get flatbed-scanner character — grain and all",
      hi: "साफ़ डिजिटल पेजों में फ़्लैटबेड-स्कैनर जान आ जाती है — दाने समेत",
    },
    {
      en: "Three noise levels, from subtle office scan to old clunker",
      hi: "तीन नॉइज़ लेवल — हल्के ऑफिस स्कैन से पुरानी मशीन तक",
    },
    {
      en: "Optional cream tint — like a warm scanner lamp on paper",
      hi: "क्रीम रंगत — जैसे काग़ज़ पर गर्म स्कैनर लैंप पड़ी हो",
    },
    {
      en: "Choose the pages — scan-look the whole file or a range",
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
        en: "Does it make the PDF look like a real scan?",
        hi: "क्या PDF असली स्कैन जैसा दिखने लगता है?",
      },
      a: {
        en: "It applies the classic scan signatures — greyscale, a contrast crunch, sensor grain and JPEG softness. It does not fake a photograph of paper (no perspective, no shadows) — the result reads as a clean flatbed scan.",
        hi: "यह स्कैन की क्लासिक निशानियाँ लगाता है — ग्रेस्केल, कंट्रास्ट क्रंच, सेंसर दाने और JPEG नरमी। यह काग़ज़ की तस्वीर नहीं बनाता (न परस्पेक्टिव, न परछाई) — नतीजा साफ़ फ़्लैटबेड स्कैन जैसा दिखता है।",
      },
    },
    {
      q: {
        en: "When is this useful?",
        hi: "यह कब काम आता है?",
      },
      a: {
        en: "When a document needs to read as an offline paper copy — internal proofs, informal submissions — or when you simply like the archival scanned look without owning a scanner.",
        hi: "जब दस्तावेज़ काग़ज़ की ऑफ़लाइन कॉपी जैसा लगना चाहिए — इंटरनल प्रूफ़, इनफ़ॉर्मल सबमिशन — या जब बिना स्कैनर के पुरानी स्कैन शैली पसंद हो।",
      },
    },
  ],
};
