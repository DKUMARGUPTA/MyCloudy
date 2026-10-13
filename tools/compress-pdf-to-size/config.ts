import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Compress to target size (PRD §7.5, device mode): the India-forms
 * classic — "the portal wants under 100 KB". The worker walks a
 * quality ladder (text-preserving first, whole-page rasterize only if
 * needed) and stops at the first attempt that fits the byte budget.
 */
export const config: ToolConfig = {
  toolId: "compress-pdf-to-size",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "lock-pdf", "pdf-to-jpg", "merge-pdf"],
  options: [
    {
      kind: "select",
      id: "target",
      label: { en: "Target size", hi: "लक्ष्य साइज़" },
      hint: {
        en: "The compressed file is brought under this size",
        hi: "कंप्रेस की फ़ाइल इस साइज़ से कम कर दी जाती है",
      },
      choices: [
        { value: "100", label: { en: "Under 100 KB", hi: "100 KB से कम" } },
        { value: "200", label: { en: "Under 200 KB", hi: "200 KB से कम" } },
        { value: "500", label: { en: "Under 500 KB", hi: "500 KB से कम" } },
        { value: "1000", label: { en: "Under 1 MB", hi: "1 MB से कम" } },
        { value: "custom", label: { en: "Custom size", hi: "कस्टम साइज़" } },
      ],
      default: "100",
    },
    {
      kind: "number",
      id: "customKB",
      label: { en: "Your target (KB)", hi: "आपका लक्ष्य (KB)" },
      hint: {
        en: "30 KB to 10 MB — the exact limit the portal or email asked for",
        hi: "30 KB से 10 MB तक — जो पोर्टल या ईमेल ने ठीक-ठीक माँगा है",
      },
      min: 30,
      max: 10240,
      step: 10,
      suffix: { en: "KB", hi: "KB" },
      default: 300,
      showWhen: { id: "target", equals: "custom" },
    },
  ],
  features: [
    {
      en: "Pick the exact limit the form portal asked for — 100 KB, 200 KB, 500 KB, 1 MB or your own custom number.",
      hi: "फ़ॉर्म पोर्टल ने जो ठीक लिमिट माँगी है वही चुनें — 100 KB, 200 KB, 500 KB, 1 MB या अपनी कस्टम संख्या।",
    },
    {
      en: "Smart ladder, best quality first: photos are re-encoded step by step and text is kept selectable as long as the budget allows.",
      hi: "समझदार सीढ़ी, बेहतर क्वालिटी पहले: तस्वीरें एक-एक कदम छोटी होती हैं और जब तक बजट बचता है, टेक्स्ट सिलेक्टेबल ही रहता है।",
    },
    {
      en: "If the file is still too big, pages are rasterized as a last resort — and if even that is not enough, you get the smallest possible file with an honest note, never a lie.",
      hi: "फिर भी बड़ा रहे तो आख़िरी उपाय में पेज रेस्टराइज़ होते हैं — और वह भी न बसे तो सबसे छोटी संभव फ़ाइल सच्ची सूचना के साथ मिलती है, कोई झूठ नहीं।",
    },
    {
      en: "Files that already fit are returned untouched — no needless quality loss.",
      hi: "जो फ़ाइल पहले सी लक्ष्य से कम है, वैसी ही लौटती है — बिना मतलब की क्वालिटी लॉस।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How does it reach the exact size?",
        hi: "यह ठीक साइज़ तक कैसे पहुँचता है?",
      },
      a: {
        en: "It compresses in steps — first lossless clean-up, then photos are re-encoded with progressively lower quality and smaller pixel size, keeping text selectable. Only if that is still not enough are pages converted to images. The first step that fits wins, so you always get the best quality possible under your limit.",
        hi: "यह कदम-दर-कदम कंप्रेस करता है — पहले बिना नुक़सान की सफ़ाई, फिर तस्वीरें धीरे-धीरे कम क्वालिटी और छोटे साइज़ पर दोबारा एन्कोड होती हैं, और टेक्स्ट सिलेक्टेबल रहता है। जब यह भी न बसे तब पेज तस्वीर बन जाते हैं। जो पहला कदम लक्ष्य में फ़िट हो जाए वही जीत जाता है — इसलिए आपको अपनी लिमिट में सबसे अच्छी मिलने वाली क्वालिटी मिलती है।",
      },
    },
    {
      q: {
        en: "My file won't go under 100 KB — why?",
        hi: "मेरी फ़ाइल 100 KB से कम नहीं हो रही — क्यों?",
      },
      a: {
        en: "A many-page file with dense text has a floor: after the strongest step, going smaller would make it unreadable. You still get the smallest readable version, clearly marked that the target was not reached — try a bigger target, fewer pages, or split the file first.",
        hi: "घने टेक्स्ट वाली कई-पेज फ़ाइल की एक हद होती है: सबसे मज़बूत कदम के बाद और छोटा करने पर पढ़ा नहीं जा सकता। आपको फिर भी सबसे छोटी पढ़ने-लायक़ फ़ाइल मिलती है, साफ़ लिखा होता है कि लक्ष्य पूरा नहीं हुआ — बड़ा लक्ष्य, कम पेज चुनें या पहले फ़ाइल स्प्लिट करें।",
      },
    },
    {
      q: {
        en: "Will the text stay selectable?",
        hi: "क्या टेक्स्ट सिलेक्ट करने लायक़ रहेगा?",
      },
      a: {
        en: "As long as your target allows it — yes. Text is only converted to an image in the final, most aggressive step, and only when the size cannot be reached any other way.",
        hi: "जब तक आपका लक्ष्य इजाज़त दे — हाँ। टेक्स्ट सिर्फ़ आख़िरी सबसे ज़्यादा आक्रामक कदम में तस्वीर बनता है, और वह भी तभी जब साइज़ किसी और तरह न बन पाए।",
      },
    },
  ],
};
