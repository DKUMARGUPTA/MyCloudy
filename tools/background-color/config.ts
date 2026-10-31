import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Background color — fill every (or selected) page with a solid color,
 * behind or over the content. Own-engine StampContext stampRect with the
 * `behind` flag, 100% on-device.
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
      label: { en: "Color", hi: "रंग" },
      choices: [
        { value: "yellow", label: { en: "Yellow", hi: "पीला" } },
        { value: "ivory", label: { en: "Ivory", hi: "आइवरी" } },
        { value: "mint", label: { en: "Mint", hi: "मिंट" } },
        { value: "sky", label: { en: "Sky", hi: "आसमानी" } },
        { value: "pink", label: { en: "Pink", hi: "गुलाबी" } },
        { value: "gray", label: { en: "Light gray", hi: "हल्का स्लेटी" } },
        { value: "custom", label: { en: "Custom hex…", hi: "अपना हेक्स…" } },
      ],
      default: "yellow",
    },
    {
      kind: "text",
      id: "hex",
      label: { en: "Hex color", hi: "हेक्स रंग" },
      hint: { en: "6-digit hex, e.g. FFF3C4", hi: "6-अंकों का हेक्स, जैसे FFF3C4" },
      placeholder: { en: "FFF3C4", hi: "FFF3C4" },
      default: "",
      showWhen: { id: "color", equals: "custom" },
    },
    {
      kind: "number",
      id: "opacity",
      label: { en: "Opacity %", hi: "पारदर्शिता %" },
      hint: {
        en: "Below 100% the old background blends through the fill.",
        hi: "100% से कम पर पुराना बैकग्राउंड भी झलकता है।",
      },
      min: 10,
      max: 100,
      step: 5,
      default: 100,
    },
    {
      kind: "select",
      id: "layer",
      label: { en: "Layer", hi: "परत" },
      choices: [
        {
          value: "behind",
          label: { en: "Behind content", hi: "कंटेंट के पीछे" },
        },
        { value: "over", label: { en: "Over content", hi: "कंटेंट के ऊपर" } },
      ],
      default: "behind",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      default: "all",
    },
  ],
  chainToolIds: ["add-watermark", "add-page-numbers", "pdf-to-jpg"],
  features: [
    {
      en: "Turn scanned white pages into warm ivory, yellow or any hex you like.",
      hi: "सफ़ेद स्कैन पेजों को गर्म आइवरी, पीला या कोई भी हेक्स बनाइए।",
    },
    {
      en: "Fill sits behind the text by default — readability first.",
      hi: "भराव डिफ़ॉल्ट रूप से टेक्स्ट के पीछे रहता है — पढ़ना पहले।",
    },
    {
      en: "Partial opacity lets the original background blend through.",
      hi: "आधी पारदर्शिता पर पुराना बैकग्राउंड मिलता-जुलता दिखता है।",
    },
    {
      en: "Apply to every page or just a range — cover pages, sections, anything.",
      hi: "सभी पेजों पर या सिर्फ़ किसी रेंज पर — कवर पेज, सेक्शन, जो चाहें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the text stay readable?",
        hi: "क्या टेक्स्ट पढ़ने लायक़ रहेगा?",
      },
      a: {
        en: "Yes — by default the fill is placed behind the content, so text and images keep their original colors on top. Choose light shades for the best contrast.",
        hi: "हाँ — डिफ़ॉल्ट रूप से भराव कंटेंट के पीछे रखा जाता है, ताकि टेक्स्ट और तस्वीरें ऊपर अपने असली रंगों में रहें। अच्छे कंट्रास्ट के लिए हल्के रंग चुनें।",
      },
    },
    {
      q: {
        en: "Can I use an exact brand color?",
        hi: "क्या ब्रांड का ठीक रंग लगा सकते हैं?",
      },
      a: {
        en: "Yes — pick “Custom hex…” and type the 6-digit code (e.g. 1A73E8 without the #).",
        hi: "हाँ — “अपना हेक्स…” चुनें और 6-अंकों का कोड लिखें (जैसे 1A73E8, बिना # के)।",
      },
    },
    {
      q: {
        en: "Does this reduce the quality of my scans?",
        hi: "क्या इससे स्कैन की क्वालिटी घटती है?",
      },
      a: {
        en: "No — pages are not re-rendered or re-compressed. A colored rectangle layer is added and everything else passes through untouched.",
        hi: "नहीं — पेज दोबारा रेंडर या कंप्रेस नहीं होते। रंगीन आयत की परत जुड़ती है, बाक़ी सब वैसा ही रहता है।",
      },
    },
  ],
};
