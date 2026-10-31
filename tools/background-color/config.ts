import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Change page background colour (PHASE-1 Batch C): paint every selected
 * page a solid colour UNDER its content — tint scanned pages, make
 * dark-mode friendly reads, or colour-code sections. Text and images
 * stay on top and untouched.
 */
export const config: ToolConfig = {
  toolId: "background-color",
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
      id: "color",
      label: { en: "Colour", hi: "रंग" },
      choices: [
        { value: "ivory", label: { en: "Ivory — easy on the eyes", hi: "आइवरी — आँखों के लिए आरामदायक" } },
        { value: "warm", label: { en: "Warm cream", hi: "गर्म क्रीम" } },
        { value: "mint", label: { en: "Soft mint", hi: "हल्की पुदीना" } },
        { value: "sky", label: { en: "Pale sky", hi: "हल्का आसमानी" } },
        { value: "rose", label: { en: "Blush rose", hi: "गुलाबी" } },
        { value: "gray", label: { en: "Light grey", hi: "हल्का स्लेटी" } },
        { value: "yellow", label: { en: "Amber — highlight", hi: "एम्बर — हाइलाइट" } },
        { value: "black", label: { en: "Black — dark mode", hi: "काला — डार्क मोड" } },
      ],
      default: "ivory",
    },
    {
      kind: "number",
      id: "opacity",
      label: { en: "Opacity", hi: "अपारदर्शिता" },
      suffix: { en: "%", hi: "%" },
      min: 10,
      max: 100,
      step: 5,
      default: 100,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages to paint — all, or a range like 2-5",
        hi: "कौन से पेज रंगें — सभी, या 2-5 जैसी रेंज",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["view-pdf", "merge-pdf", "compress-pdf"],
  features: [
    {
      en: "Colour goes UNDER the content — text and images stay fully readable.",
      hi: "रंग सामग्री के नीचे जाता है — टेक्स्ट और तस्वीरें पूरी तरह पढ़ने लायक रहती हैं।",
    },
    {
      en: "Eight curated tints plus full black for dark-mode reading.",
      hi: "आठ चुने हुए रंग और पूरा काला — डार्क-मोड पढ़ाई के लिए।",
    },
    {
      en: "Dial the opacity down for a whisper of colour.",
      hi: "अपारदर्शिता घटाकर हल्की-सी रंगत लें।",
    },
    {
      en: "Paint every page or just a range — colour-code sections.",
      hi: "सभी पेज या सिर्फ़ एक रेंज रंगें — सेक्शन रंग-कोड करें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the colour cover my text?",
        hi: "क्या रंग मेरे टेक्स्ट को ढक देगा?",
      },
      a: {
        en: "No — the colour is painted first and the page's own content is drawn on top, exactly as it was. Nothing is re-rendered or flattened.",
        hi: "नहीं — रंग पहले लगता है और पेज की अपनी सामग्री उसके ऊपर वैसे ही बनती है जैसी थी। कुछ भी दोबारा रेंडर या फ़्लैट नहीं होता।",
      },
    },
    {
      q: {
        en: "Why would I change a PDF's background?",
        hi: "PDF की पृष्ठभूमि बदलने की ज़रूरत क्यों पड़ेगी?",
      },
      a: {
        en: "White pages glare at night — a dark or ivory background makes long reads comfortable. Tints also colour-code chapters, and scanned documents look less harsh with a warm cream.",
        hi: "सफ़ेद पेज रात में चौंधियाते हैं — काली या आइवरी पृष्ठभूमि लंबी पढ़ाई आरामदायक बनाती है। रंग अध्याय कोड करते हैं, और स्कैन किए दस्तावेज़ गर्म क्रीम के साथ कम कठोर लगते हैं।",
      },
    },
    {
      q: {
        en: "Can I remove the background later?",
        hi: "क्या पृष्ठभूमि बाद में हटा सकते हैं?",
      },
        a: {
        en: "The colour is a drawn layer, so reverting means keeping your original file — this tool always saves a new copy and never touches the source.",
        hi: "रंग एक बनाई हुई परत है, इसलिए वापसी का मतलब है असली फ़ाइल रखना — यह टूल हमेशा नई कॉपी बनाता है और स्रोत को नहीं छूता।",
      },
    },
  ],
};
