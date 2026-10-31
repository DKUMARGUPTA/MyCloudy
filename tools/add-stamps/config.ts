import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add stamps — big one-word rubber stamps (APPROVED, DRAFT, CONFIDENTIAL…)
 * at any of six positions, with size, color, opacity and rotation.
 * Own-engine StampContext, 100% on-device.
 */
export const config: ToolConfig = {
  toolId: "add-stamps",
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
      id: "text",
      label: { en: "Stamp text", hi: "स्टैम्प टेक्स्ट" },
      choices: [
        { value: "APPROVED", label: { en: "APPROVED", hi: "APPROVED" } },
        { value: "DRAFT", label: { en: "DRAFT", hi: "DRAFT" } },
        {
          value: "CONFIDENTIAL",
          label: { en: "CONFIDENTIAL", hi: "CONFIDENTIAL" },
        },
        { value: "REVIEWED", label: { en: "REVIEWED", hi: "REVIEWED" } },
        { value: "PAID", label: { en: "PAID", hi: "PAID" } },
        { value: "URGENT", label: { en: "URGENT", hi: "URGENT" } },
        { value: "COPY", label: { en: "COPY", hi: "COPY" } },
        { value: "custom", label: { en: "Custom…", hi: "अपना टेक्स्ट…" } },
      ],
      default: "APPROVED",
    },
    {
      kind: "text",
      id: "customText",
      label: { en: "Custom text", hi: "अपना टेक्स्ट" },
      hint: {
        en: "Latin letters, digits and common symbols (up to 32 chars).",
        hi: "लैटिन अक्षर, अंक और आम चिह्न (32 अक्षर तक)।",
      },
      placeholder: { en: "e.g. FINAL v2", hi: "जैसे FINAL v2" },
      default: "",
      showWhen: { id: "text", equals: "custom" },
    },
    {
      kind: "select",
      id: "position",
      label: { en: "Position", hi: "स्थान" },
      choices: [
        { value: "center", label: { en: "Center", hi: "बीच में" } },
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
      kind: "select",
      id: "color",
      label: { en: "Color", hi: "रंग" },
      choices: [
        { value: "red", label: { en: "Red", hi: "लाल" } },
        { value: "green", label: { en: "Green", hi: "हरा" } },
        { value: "blue", label: { en: "Blue", hi: "नीला" } },
        { value: "black", label: { en: "Black", hi: "काला" } },
      ],
      default: "red",
    },
    {
      kind: "number",
      id: "size",
      label: { en: "Font size", hi: "फ़ॉन्ट आकार" },
      min: 12,
      max: 96,
      step: 1,
      default: 36,
    },
    {
      kind: "number",
      id: "opacity",
      label: { en: "Opacity %", hi: "पारदर्शिता %" },
      min: 5,
      max: 100,
      step: 5,
      default: 25,
    },
    {
      kind: "select",
      id: "rotate",
      label: { en: "Rotation", hi: "झुकाव" },
      choices: [
        { value: "0", label: { en: "None", hi: "बिना झुकाव" } },
        { value: "-45", label: { en: "Tilt left 45°", hi: "बाएँ 45°" } },
        { value: "45", label: { en: "Tilt right 45°", hi: "दाएँ 45°" } },
        { value: "-30", label: { en: "Tilt left 30°", hi: "बाएँ 30°" } },
        { value: "30", label: { en: "Tilt right 30°", hi: "दाएँ 30°" } },
      ],
      default: "-45",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      default: "all",
    },
  ],
  chainToolIds: ["bates-numbering", "add-watermark", "merge-pdf"],
  features: [
    {
      en: "Rubber-stamp classics — APPROVED, DRAFT, CONFIDENTIAL — or your own word.",
      hi: "रबर-स्टैम्प क्लासिक — APPROVED, DRAFT, CONFIDENTIAL — या अपना शब्द।",
    },
    {
      en: "Tilt it, size it, fade it — the stamp reads as a mark, never a hijack.",
      hi: "झुकाइए, बड़ा-छोटा कीजिए, हल्का कीजिए — स्टैम्प निशान लगे, पेज नहीं।",
    },
    {
      en: "Place it at the center or any corner, on all pages or a range.",
      hi: "बीच में या किसी कोने में, सभी पेजों पर या किसी रेंज पर।",
    },
    {
      en: "Real PDF text — stays crisp at any zoom and prints sharp.",
      hi: "असली PDF टेक्स्ट — किसी भी ज़ूम पर तेज़, प्रिंट में साफ़।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I stamp my own word?",
        hi: "क्या अपना शब्द लिख सकते हैं?",
      },
      a: {
        en: "Yes — choose “Custom…” and type up to 32 characters. Latin letters, digits and common symbols are supported by the embedded font.",
        hi: "हाँ — “अपना टेक्स्ट…” चुनकर 32 अक्षर तक लिखें। एम्बेडेड फ़ॉन्ट लैटिन अक्षर, अंक और आम चिह्न समझता है।",
      },
    },
    {
      q: {
        en: "Will the stamp hide the text under it?",
        hi: "क्या स्टैम्प नीचे का टेक्स्ट ढक देगा?",
      },
      a: {
        en: "By default it is semi-transparent (25%), so content stays readable through it. You can raise opacity up to a fully solid stamp.",
        hi: "डिफ़ॉल्ट रूप से यह 25% पारदर्शी है, ताकि नीचे का कंटेंट पढ़ा जा सके। आप इसे पूरी तरह गहरा भी कर सकते हैं।",
      },
    },
    {
      q: {
        en: "Is this the same as a watermark?",
        hi: "क्या यह वॉटरमार्क जैसा ही है?",
      },
      a: {
        en: "They are cousins — stamps are bold, one-word, usually tilted marks; the Add watermark tool offers tiling, logos and behind-content placement instead.",
        hi: "ये मिलते-जुलते हैं — स्टैम्प बोल्ड, एक-शब्द, आम तौर पर तिरछे निशान हैं; वॉटरमार्क टूल में टाइलिंग, लोगो और कंटेंट के पीछे रखने जैसे विकल्प हैं।",
      },
    },
  ],
};
