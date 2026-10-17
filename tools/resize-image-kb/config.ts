import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Resize image to KB (PRD §7.10, P2): the India-forms classic for photos
 * and signatures — "the portal wants the photo under 100 KB". The worker
 * binary-searches the JPEG quality that fits, and only shrinks pixels
 * (×0.8 steps, 120px floor) when quality alone can't reach the budget.
 * Honest amber chip when even the floor can't fit.
 */
export const config: ToolConfig = {
  toolId: "resize-image-kb",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 10,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  chainToolIds: ["images-to-pdf", "convert-to-pdf", "jpg-to-pdf"],
  options: [
    {
      kind: "select",
      id: "target",
      label: { en: "Target size", hi: "लक्ष्य साइज़" },
      hint: {
        en: "The photo or signature is brought under this size",
        hi: "फ़ोटो या साइन इस साइज़ से कम कर दिया जाता है",
      },
      choices: [
        {
          value: "20",
          label: { en: "Under 20 KB — signature", hi: "20 KB से कम — साइन" },
        },
        {
          value: "50",
          label: { en: "Under 50 KB — photo", hi: "50 KB से कम — फ़ोटो" },
        },
        { value: "100", label: { en: "Under 100 KB", hi: "100 KB से कम" } },
        { value: "200", label: { en: "Under 200 KB", hi: "200 KB से कम" } },
        { value: "500", label: { en: "Under 500 KB", hi: "500 KB से कम" } },
        { value: "custom", label: { en: "Custom size", hi: "कस्टम साइज़" } },
      ],
      default: "100",
    },
    {
      kind: "number",
      id: "customKB",
      label: { en: "Your target (KB)", hi: "आपका लक्ष्य (KB)" },
      hint: {
        en: "10 KB to 5 MB — the exact limit the form asked for",
        hi: "10 KB से 5 MB तक — फ़ॉर्म ने जो ठीक लिमिट माँगी है",
      },
      min: 10,
      max: 5000,
      step: 10,
      suffix: { en: "KB", hi: "KB" },
      default: 300,
      showWhen: { id: "target", equals: "custom" },
    },
    {
      kind: "select",
      id: "format",
      label: { en: "Output format", hi: "आउटपुट फ़ॉर्मैट" },
      hint: {
        en: "JPEG reaches small sizes most easily; PNG keeps transparency",
        hi: "JPEG आसानी से छोटा होता है; PNG पारदर्शिता रखता है",
      },
      choices: [
        {
          value: "jpeg",
          label: { en: "JPEG — suggested", hi: "JPEG — सुझाया" },
        },
        { value: "png", label: { en: "PNG — transparent", hi: "PNG — पारदर्शी" } },
      ],
      default: "jpeg",
    },
    {
      kind: "select",
      id: "maxDim",
      label: { en: "Max size", hi: "अधिकतम साइज़" },
      hint: {
        en: "Caps the longest side — handy when the form wants specific pixels",
        hi: "सबसे लंबी भुजा की सीमा — जब फ़ॉर्म ठीक पिक्सेल माँगे",
      },
      choices: [
        { value: "0", label: { en: "Original", hi: "ओरिजिनल" } },
        { value: "1200", label: { en: "1200 px", hi: "1200 px" } },
        { value: "800", label: { en: "800 px", hi: "800 px" } },
        { value: "600", label: { en: "600 px", hi: "600 px" } },
        { value: "400", label: { en: "400 px", hi: "400 px" } },
        { value: "240", label: { en: "240 px", hi: "240 px" } },
      ],
      default: "0",
    },
  ],
  features: [
    {
      en: "Pick the exact limit the form portal asked for — 20 KB signature, 50 KB photo, 100/200/500 KB or your own custom number.",
      hi: "फ़ॉर्म पोर्टल ने जो ठीक लिमिट माँगी है वही चुनें — 20 KB साइन, 50 KB फ़ोटो, 100/200/500 KB या अपनी कस्टम संख्या।",
    },
    {
      en: "Best quality that fits: quality comes down step by step first, and the picture is shrunk only when quality alone can't reach the limit.",
      hi: "जो बजठे वही बेहतरीन क्वालिटी: पहले क्वालिटी धीरे-धीरे घटती है, पिक्चर तभी छोटी होती है जब क्वालिटी से लक्ष्य न बने।",
    },
    {
      en: "Reads JPG, PNG, WEBP, HEIC (iPhone), GIF and BMP — form portals always want the result back as a clean JPG.",
      hi: "JPG, PNG, WEBP, HEIC (iPhone), GIF और BMP पढ़ता है — फ़ॉर्म पोर्टल को नतीजा हमेशा साफ़ JPG में चाहिए।",
    },
    {
      en: "Photos already under the limit come back untouched — no needless quality loss.",
      hi: "जो फ़ोटो पहले से लिमिट में है, वैसी ही लौटती है — बिना मतलब की क्वालिटी लॉस।",
    },
    {
      en: "Runs entirely on your device — your photo and signature never leave the browser.",
      hi: "पूरा काम डिवाइस पर — फ़ोटो और साइन ब्राउज़र से बाहर नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "How does it reach the exact KB?",
        hi: "यह ठीक KB तक कैसे पहुँचता है?",
      },
      a: {
        en: "It re-encodes your photo again and again at carefully chosen quality levels and picks the highest one that fits under your limit. Only if even the lowest usable quality is too big does it shrink the picture — 20% at a time, never below a legible size.",
        hi: "यह आपकी फ़ोटो को ध्यान से चुनी गई क्वालिटियों पर बार-बार एन्कोड करता है और लिमिट में बसने वाली सबसे ऊँची क्वालिटी चुनता है। जब सबसे कम चलने-लायक़ क्वालिटी भी बड़ी हो, तभी पिक्चर छोटी होती है — 20% एक बार में, पढ़ने-लायक़ साइज़ से कभी नीचे नहीं।",
      },
    },
    {
      q: {
        en: "The form also asks for specific pixels — what do I do?",
        hi: "फ़ॉर्म ठीक पिक्सेल भी माँगता है — क्या करें?",
      },
      a: {
        en: "Use the Max size option to cap the longest side (for example 240 px for a 200×230 photograph). The size-to-KB step then makes sure the final file is also under your KB limit.",
        hi: "अधिकतम साइज़ से सबसे लंबी भुजा की सीमा लगाएँ (जैसे 200×230 फ़ोटो के लिए 240 px)। फिर KB वाला कदम ध्यान रखेगा कि आख़िरी फ़ाइल आपकी KB लिमिट में भी रहे।",
      },
    },
    {
      q: {
        en: "My file won't go under the limit — why?",
        hi: "मेरी फ़ाइल लिमिट से कम नहीं हो रही — क्यों?",
      },
      a: {
        en: "There is a legibility floor: a picture is never shrunk below a minimum readable size. If even that doesn't fit — a busy A3 scan at 10 KB, say — you still get the smallest possible file, clearly marked that the target was not reached. Try a bigger limit or crop the image first.",
        hi: "पढ़ने-लायक़ साइज़ की एक हद है: पिक्चर उससे नीचे कभी नहीं जाती। वह भी न बसे — जैसे 10 KB में भरी हुई A3 स्कैन — तो आपको फिर भी सबसे छोटी संभव फ़ाइल मिलती है, साफ़ लिखा होता है कि लक्ष्य पूरा नहीं हुआ। बड़ी लिमिट चुनें या पहले तस्वीर काटें।",
      },
    },
  ],
};
