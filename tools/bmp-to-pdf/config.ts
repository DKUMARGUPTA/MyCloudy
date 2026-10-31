import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * BMP to PDF (P3-c / R57) — Windows/OS2 bitmaps → PDF, 100% on-device
 * (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone (accepts images — the worker
 * validates the BM signature itself), options (page size / orientation /
 * margin), the worker decodes BMPs with our OWN pure decoder (headers
 * CORE→V5, BI_RGB/RLE8/RLE4/BITFIELDS, 1–32-bit, top-down + bottom-up)
 * and embeds each as one page — palette/alpha images lossless PNG,
 * photos JPEG 0.92 — on the OWN PDF engine.
 */
export const config: ToolConfig = {
  toolId: "bmp-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 20,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "A4 (210 × 297 mm), US Letter, or pages exactly the size of the image.",
        hi: "A4 (210 × 297 मिमी), US लेटर, या पेज बिल्कुल तस्वीर के आकार के।",
      },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
        { value: "fit", label: { en: "Fit to image", hi: "तस्वीर के अनुसार" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      hint: {
        en: "Auto follows each image's shape.",
        hi: "ऑटो हर तस्वीर की आकृति के हिसाब से।",
      },
      choices: [
        { value: "auto", label: { en: "Auto", hi: "ऑटो" } },
        { value: "portrait", label: { en: "Portrait", hi: "पोर्ट्रेट" } },
        { value: "landscape", label: { en: "Landscape", hi: "लैंडस्केप" } },
      ],
      default: "auto",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margin", hi: "मार्जिन" },
      choices: [
        { value: "none", label: { en: "None", hi: "कोई नहीं" } },
        { value: "small", label: { en: "Small", hi: "छोटा" } },
        { value: "big", label: { en: "Big", hi: "बड़ा" } },
      ],
      default: "small",
    },
  ],
  chainToolIds: ["compress-pdf", "merge-pdf", "view-pdf"],
  features: [
    {
      en: "Windows BMP files — 24-bit photos, 256-colour palette art, RLE-compressed, even top-down OS/2 layouts — into one clean PDF.",
      hi: "Windows BMP फ़ाइलें — 24-बिट फ़ोटो, 256-रंग पैलेट आर्ट, RLE-कंप्रेस्ड, यहाँ तक कि टॉप-डाउन OS/2 लेआउट — एक साफ़ PDF में।",
    },
    {
      en: "The decoder is ours and runs entirely on your device — old scans and screenshots never leave the browser.",
      hi: "डिकोडर हमारा अपना है और पूरा आपके डिवाइस पर चलता है — पुराने स्कैन और स्क्रीनशॉट ब्राउज़र से बाहर नहीं जाते।",
    },
    {
      en: "Palette images and images with transparency embed losslessly as PNG; photo-style bitmaps embed as high-quality JPEG.",
      hi: "पैलेट वाली और ट्रांसपेरेंसी वाली तस्वीरें बिना नुकसान PNG में जुड़ती हैं; फ़ोटो जैसी बिटमैप हाई-क्वालिटी JPEG में।",
    },
    {
      en: "Honest limits: images beyond 40 megapixels are refused with a clear message instead of freezing the tab.",
      hi: "ईमानदार सीमाएँ: 40 मेगापिक्सेल से बड़ी तस्वीरें साफ़ संदेश के साथ मना की जाती हैं, टैब जमने के बजाय।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which BMP variants are supported?",
        hi: "BMP के कौन से वेरिएंट समर्थित हैं?",
      },
      a: {
        en: "All the common ones: uncompressed (BI_RGB) 1/4/8/16/24/32-bit, RLE8 and RLE4 compressed files, BI_BITFIELDS colour masks with alpha, and both bottom-up and top-down row order. The rare BMPs with an embedded JPEG or PNG inside (BI_JPEG/BI_PNG) are honestly refused.",
        hi: "आम सभी: अनकंप्रेस्ड (BI_RGB) 1/4/8/16/24/32-बिट, RLE8 और RLE4 कंप्रेस्ड फ़ाइलें, अल्फ़ा सहित BI_BITFIELDS कलर मास्क, और बॉटम-अप व टॉप-डाउन दोनों रो ऑर्डर। भीतर जुड़ा JPEG/PNG वाली दुर्लभ BMP (BI_JPEG/BI_PNG) ईमानदारी से मना की जाती हैं।",
      },
    },
    {
      q: {
        en: "Why is my 32-bit BMP's fourth channel ignored?",
        hi: "मेरी 32-बिट BMP का चौथा चैनल क्यों नज़रअंदाज़ होता है?",
      },
      a: {
        en: "Plain 32-bit BI_RGB files keep that byte reserved — browsers and image editors treat it the same way. When the file actually declares an alpha mask (BI_BITFIELDS/ALPHABITFIELDS or V4/V5 headers), transparency is honoured and the page embeds lossless PNG.",
        hi: "सादी 32-बिट BI_RGB फ़ाइलों में वह बाइट रिज़र्व्ड रहती है — ब्राउज़र और इमेज एडिटर भी यही मानते हैं। जब फ़ाइल सच में अल्फ़ा मास्क बताती है (BI_BITFIELDS/ALPHABITFIELDS या V4/V5 हेडर), ट्रांसपेरेंसी मानी जाती है और पेज बिना नुकसान PNG में जुड़ता है।",
      },
    },
    {
      q: {
        en: "BMP files are huge — is there a limit?",
        hi: "BMP फ़ाइलें बड़ी होती हैं — कोई सीमा है?",
      },
      a: {
        en: "Each image may be up to 40 megapixels (about 160 MB of pixel data) — anything larger is refused honestly, because decoding it could exhaust the browser's memory. Convert oversized files in smaller crops, or run Compress PDF on the result.",
        hi: "हर तस्वीर 40 मेगापिक्सेल तक (करीब 160 MB पिक्सेल डेटा) — इससे बड़ी ईमानदारी से मना की जाती है, क्योंकि डिकोड करने में ब्राउज़र की मेमोरी ख़त्म हो सकती है। बड़ी फ़ाइलों को छोटे टुकड़ों में बदलें, या नतीजे पर Compress PDF चलाएँ।",
      },
    },
  ],
};
