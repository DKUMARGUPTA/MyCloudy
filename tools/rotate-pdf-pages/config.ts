import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rotate PDF pages — the first live tool (Phase 2 demo of the full
 * config + ToolShell + worker pipeline). Runs 100% on the device.
 *
 * Panel note: this tool needs no custom Panel — the shared OptionsPanel
 * renders the schema below. Custom panels arrive with the Phase 3 tools
 * that need interactive previews.
 */
export const config: ToolConfig = {
  toolId: "rotate-pdf-pages",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 10,
  options: [
    {
      kind: "select",
      id: "direction",
      label: { en: "Direction", hi: "दिशा" },
      default: "right",
      choices: [
        { value: "right", label: { en: "90° clockwise", hi: "90° दाईं ओर" } },
        {
          value: "left",
          label: { en: "90° counter-clockwise", hi: "90° बाईं ओर" },
        },
        { value: "180", label: { en: "180°", hi: "180°" } },
      ],
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      default: "all",
      placeholder: { en: "all, or e.g. 1-3, 5", hi: "all या जैसे 1-3, 5" },
      hint: {
        en: "Leave on “all” to rotate every page.",
        hi: "हर पेज घुमाने के लिए “all” छोड़ें।",
      },
    },
  ],
  features: [
    {
      en: "Rotate all pages at once, or pick exact ranges like 1-3, 5.",
      hi: "सारे पेज एक साथ घुमाएँ, या 1-3, 5 जैसे पेज चुनें।",
    },
    {
      en: "Fixes sideways phone scans in one tap.",
      hi: "तिरछे फ़ोन-स्कैन एक टैप में ठीक करें।",
    },
    {
      en: "Nothing is uploaded — the file never leaves your device.",
      hi: "कुछ भी अपलोड नहीं होता — फ़ाइल आपके डिवाइस पर रहती है।",
    },
    {
      en: "Works offline once the page has loaded.",
      hi: "पेज एक बार खुलने के बाद ऑफ़लाइन भी चलता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Are my files uploaded anywhere?",
        hi: "क्या मेरी फ़ाइल कहीं अपलोड होती है?",
      },
      a: {
        en: "No. This tool runs entirely in your browser with Web Workers. There is no server involved, so the file physically cannot leave your device.",
        hi: "नहीं। यह टूल पूरी तरह आपके ब्राउज़र में Web Workers से चलता है। कोई सर्वर शामिल नहीं है, इसलिए फ़ाइल आपके डिवाइस से बाहर जा ही नहीं सकती।",
      },
    },
    {
      q: {
        en: "Will rotating reduce the quality?",
        hi: "क्या घुमाने से क्वालिटी गिरती है?",
      },
      a: {
        en: "No. Rotation only changes the page angle stored in the PDF — text, images and vectors are untouched, so nothing is re-compressed.",
        hi: "नहीं। घुमाने से सिर्फ़ पेज का कोण बदलता है — टेक्स्ट, तस्वीरें और वेक्टर जस के तस रहते हैं, कुछ भी दोबारा कंप्रेस नहीं होता।",
      },
    },
    {
      q: {
        en: "Can I rotate only some pages?",
        hi: "क्या सिर्फ़ कुछ पेज घुमा सकते हैं?",
      },
      a: {
        en: "Yes — type ranges like 1-3, 5 in the Pages field. Everything else keeps its current orientation.",
        hi: "हाँ — पेज फ़ील्ड में 1-3, 5 जैसी रेंज लिखें। बाक़ी पेज जैसे थे वैसे ही रहेंगे।",
      },
    },
  ],
};
