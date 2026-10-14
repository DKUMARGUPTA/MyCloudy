import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Extract PDF images config (PRD §7.1/§8.1).
 *
 * The options schema holds what the worker reads: the minimum-size filter
 * (longer side) and the output format. The interactive part — the embedded
 * image grid with per-image selection — lives in the surface, which writes
 * the same `minSize` option (single source of truth) plus the serialized
 * `selected` key list the worker honors.
 */
export const config: ToolConfig = {
  toolId: "extract-images",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "minSize",
      label: { en: "Minimum size", hi: "न्यूनतम साइज़" },
      hint: {
        en: "Skips small icons and textures — the grid preview uses the same filter.",
        hi: "छोटे आइकन और टेक्सचर छोड़ता है — ग्रिड प्रीव्यू भी यही फ़िल्टर लगाता है।",
      },
      choices: [
        { value: "0", label: { en: "All sizes", hi: "सभी साइज़" } },
        { value: "128", label: { en: "128 px+", hi: "128 px+" } },
        { value: "256", label: { en: "256 px+", hi: "256 px+" } },
        { value: "512", label: { en: "512 px+", hi: "512 px+" } },
      ],
      default: "128",
    },
    {
      kind: "select",
      id: "format",
      label: { en: "Save as", hi: "सेव करें" },
      hint: {
        en: "JPG keeps photos compact (quality 90); PNG keeps transparency.",
        hi: "JPG फ़ोटो छोटी रखता है (क्वालिटी 90); PNG पारदर्शिता रखता है।",
      },
      choices: [
        { value: "png", label: { en: "PNG", hi: "PNG" } },
        { value: "jpg", label: { en: "JPG", hi: "JPG" } },
      ],
      default: "png",
    },
  ],
  // Image outputs must chain to image-accepting tools (never a PDF-only one).
  chainToolIds: ["images-to-pdf", "png-to-pdf", "jpg-to-pdf"],
  features: [
    {
      en: "Every embedded image in the file — photos, logos, illustrations — pulled out as separate PNG or JPG files.",
      hi: "फ़ाइल की हर जुड़ी तस्वीर — फ़ोटो, लोगो, इलस्ट्रेशन — अलग PNG या JPG फ़ाइलों में निकलती है।",
    },
    {
      en: "A grid preview shows what will be extracted before you run anything; untick anything you don't need.",
      hi: "चलाने से पहले ग्रिड प्रीव्यू दिखाता है क्या निकलेगा; जो नहीं चाहिए उसका टिक हटा दें।",
    },
    {
      en: "Filter out small icons and textures with one tap, so you only get the real images.",
      hi: "एक टैप में छोटे आइकन-टेक्सचर हटा लें, ताकि सिर्फ़ असली तस्वीरें मिलें।",
    },
    {
      en: "Download everything at once as a ZIP, or pick individual files.",
      hi: "सब कुछ एक साथ ZIP में डाउनलोड करें, या अलग-अलग फ़ाइलें चुनें।",
    },
    {
      en: "The same image painted on many pages is extracted exactly once.",
      hi: "कई पेजों पर दोहराई गई तस्वीर सिर्फ़ एक बार निकलती है।",
    },
    {
      en: "Everything happens on your device — the PDF never leaves your browser.",
      hi: "सब कुछ आपके डिवाइस पर ही — PDF ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why do almost no images show up for my scanned document?",
        hi: "मेरे स्कैन किए दस्तावेज़ में तस्वीरें क्यों नहीं दिखतीं?",
      },
      a: {
        en: "A scan is usually one big photo of the whole page, not separate embedded images. Use PDF to JPG instead — it renders every page as an image.",
        hi: "स्कैन आमतौर पर पूरे पेज की एक ही बड़ी तस्वीर होता है, अलग-अलग जुड़ी तस्वीरें नहीं। इसके लिए PDF से JPG इस्तेमाल करें — वह हर पेज को तस्वीर बना देता है।",
      },
    },
    {
      q: {
        en: "What does the minimum-size filter do?",
        hi: "न्यूनतम साइज़ फ़िल्टर क्या करता है?",
      },
      a: {
        en: "It skips images whose longer side is below the chosen pixels, which removes tiny icons, dots and textures. Set it to \"All sizes\" to keep everything.",
        hi: "जिन तस्वीरों की लंबी भुजा चुने पिक्सेल से छोटी है वे छोड़ दी जाती हैं — इससे नन्हे आइकन, बिंदु और टेक्सचर हट जाते हैं। सब रखने के लिए \"सभी साइज़\" चुनें।",
      },
    },
    {
      q: {
        en: "Do the extracted images keep their original quality?",
        hi: "क्या निकली तस्वीरों की असली क्वालिटी बनी रहती है?",
      },
      a: {
        en: "Yes — each image is decoded from the PDF and re-encoded once: PNG is lossless, JPG uses quality 90. Nothing is upscaled or watermarked.",
        hi: "हाँ — हर तस्वीर PDF से डिकोड होकर एक बार दोबारा सेव होती है: PNG लॉसलेस है, JPG क्वालिटी 90 पर। न कुछ बड़ा किया जाता है, न वॉटरमार्क लगता है।",
      },
    },
  ],
};
