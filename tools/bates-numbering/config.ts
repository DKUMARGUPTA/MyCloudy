import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Bates numbering — the legal-discovery page stamp (DOC-000001, DOC-000002,
 * …) applied sequentially across the document. Own-engine StampContext,
 * 100% on-device.
 */
export const config: ToolConfig = {
  toolId: "bates-numbering",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "text",
      id: "prefix",
      label: { en: "Prefix", hi: "प्रीफ़िक्स" },
      hint: {
        en: "Placed before every number (e.g. case ID). Optional.",
        hi: "हर नंबर से पहले (जैसे केस आईडी)। वैकल्पिक।",
      },
      placeholder: { en: "DOC-", hi: "DOC-" },
      default: "DOC-",
    },
    {
      kind: "number",
      id: "startNumber",
      label: { en: "Start at", hi: "शुरुआती नंबर" },
      min: 1,
      max: 100000,
      step: 1,
      default: 1,
    },
    {
      kind: "select",
      id: "digits",
      label: { en: "Digits", hi: "अंकों की संख्या" },
      hint: {
        en: "Numbers are zero-padded to this width (7 → 0000007).",
        hi: "नंबर इतने अंकों तक शून्य से भरते हैं (7 → 0000007)।",
      },
      choices: [
        { value: "4", label: { en: "4 (0001)", hi: "4 (0001)" } },
        { value: "5", label: { en: "5 (00001)", hi: "5 (00001)" } },
        { value: "6", label: { en: "6 (000001)", hi: "6 (000001)" } },
        { value: "7", label: { en: "7 (0000001)", hi: "7 (0000001)" } },
        { value: "8", label: { en: "8 (00000001)", hi: "8 (00000001)" } },
      ],
      default: "6",
    },
    {
      kind: "select",
      id: "position",
      label: { en: "Position", hi: "स्थान" },
      choices: [
        {
          value: "bottom-right",
          label: { en: "Bottom right", hi: "नीचे दाएँ" },
        },
        {
          value: "bottom-center",
          label: { en: "Bottom center", hi: "नीचे बीच में" },
        },
        { value: "bottom-left", label: { en: "Bottom left", hi: "नीचे बाएँ" } },
        { value: "top-right", label: { en: "Top right", hi: "ऊपर दाएँ" } },
        { value: "top-center", label: { en: "Top center", hi: "ऊपर बीच में" } },
        { value: "top-left", label: { en: "Top left", hi: "ऊपर बाएँ" } },
      ],
      default: "bottom-right",
    },
    {
      kind: "number",
      id: "size",
      label: { en: "Font size", hi: "फ़ॉन्ट आकार" },
      min: 6,
      max: 24,
      step: 1,
      default: 9,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Numbering runs sequentially across the selected pages.",
        hi: "चुने पेजों पर क्रम से नंबर लगते हैं।",
      },
      default: "all",
    },
  ],
  chainToolIds: ["merge-pdf", "add-page-numbers", "add-stamps"],
  features: [
    {
      en: "Classic legal Bates stamp — prefix, padding and a start number you control.",
      hi: "क्लासिक लीगल बेट्स स्टैम्प — प्रीफ़िक्स, पैडिंग और शुरुआती नंबर आपके हाथ में।",
    },
    {
      en: "Numbers run sequentially across every page you pick — all, a range, or odd/even.",
      hi: "हर चुने पेज पर क्रम से नंबर — सब, कोई रेंज, या ऑड/ईवन।",
    },
    {
      en: "Six placement positions and a font size that stays readable after printing.",
      hi: "छह जगह लगाने का विकल्प और प्रिंट के बाद भी साफ़ पढ़ने लायक़ आकार।",
    },
    {
      en: "The rest of the page is untouched — content is not re-rendered.",
      hi: "बाक़ी पेज अछूता — कंटेंट दोबारा रेंडर नहीं होता।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is Bates numbering?",
        hi: "बेट्स नंबरिंग क्या है?",
      },
      a: {
        en: "It is the sequential page stamp used in legal discovery — every page gets a unique number like DOC-000042 so citations stay unambiguous in court and audits.",
        hi: "यह कानूनी कार्यों में इस्तेमाल होने वाला क्रमिक पेज स्टैम्प है — हर पेज को DOC-000042 जैसा अनोखा नंबर मिलता है, ताकि हवाले में कोई ग़लतफ़हमी न रहे।",
      },
    },
    {
      q: {
        en: "Can I continue numbering from a previous document?",
        hi: "क्या पिछले दस्तावेज़ से नंबर आगे बढ़ा सकते हैं?",
      },
      a: {
        en: "Yes — set the start number to wherever the earlier document ended (e.g. 0427) and keep the same prefix. The new file picks up exactly there.",
        hi: "हाँ — पिछली फ़ाइल जहाँ ख़त्म हुई थी वहीं से शुरुआती नंबर रखें (जैसे 0427) और वही प्रीफ़िक्स रखें। नई फ़ाइल ठीक वहीं से चलती है।",
      },
    },
    {
      q: {
        en: "Will it overwrite my existing page numbers?",
        hi: "क्या मौजूदा पेज नंबर मिट जाएँगे?",
      },
      a: {
        en: "No — the Bates stamp is added as a new layer on top; whatever is already printed on the page stays exactly as it was.",
        hi: "नहीं — बेट्स स्टैम्प नई परत के रूप में जुड़ता है; पेज पर जो पहले से छपा है वैसा ही रहता है।",
      },
    },
  ],
};
