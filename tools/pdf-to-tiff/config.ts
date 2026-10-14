import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to TIFF (PRD §7.2 / §8.6) — archive/fax-grade output from the
 * clean-room tiff-writer: baseline RGB 8-bit, LZW (default) or
 * uncompressed, DPI stamped into X/YResolution, and every page chained
 * into ONE multi-page TIFF (the scanner/archive convention) with a
 * switch for separate per-page files.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-tiff",
  createWorker: () =>
    new Worker(new URL("../pdf-to-images/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 5,
  // The TIFF round-trip closes here: scans produced by PDF to TIFF can
  // go straight back through the clean-room TIFF reader.
  chainToolIds: ["tiff-to-pdf"],
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      hint: {
        en: "Scanners and printers read this from the file",
        hi: "स्कैनर और प्रिंटर इसे फ़ाइल से पढ़ते हैं",
      },
      choices: [
        { value: "72", label: { en: "72 — screen", hi: "72 — स्क्रीन" } },
        { value: "150", label: { en: "150 — balanced", hi: "150 — संतुलित" } },
        { value: "300", label: { en: "300 — print", hi: "300 — प्रिंट" } },
        { value: "600", label: { en: "600 — archive", hi: "600 — आर्काइव" } },
      ],
      default: "300",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
    {
      kind: "select",
      id: "compression",
      label: { en: "Compression", hi: "कंप्रेशन" },
      hint: {
        en: "LZW is lossless and opens everywhere; None is for strict legacy systems",
        hi: "LZW बिना नुक़सान और हर जगह खुलता है; None सख़्त पुराने सिस्टम के लिए",
      },
      choices: [
        { value: "lzw", label: { en: "LZW — lossless (recommended)", hi: "LZW — लॉसलेस (सुझाया गया)" } },
        { value: "none", label: { en: "None — uncompressed", hi: "None — बिना कंप्रेशन" } },
      ],
      default: "lzw",
    },
    {
      kind: "switch",
      id: "multipage",
      label: { en: "Combine into one multi-page TIFF", hi: "एक मल्टी-पेज TIFF बनाएँ" },
      hint: {
        en: "All pages in a single .tiff — turn off for separate files per page",
        hi: "सारे पेज एक ही .tiff में — अलग-अलग फ़ाइलों के लिए बंद करें",
      },
      default: true,
    },
  ],
  features: [
    {
      en: "Archive-grade TIFF pages — lossless pixels, no JPG artefacts, ever.",
      hi: "आर्काइव-दर्जे के TIFF पेज — बिना नुक़सान पिक्सेल, कोई JPG दाग़ नहीं।",
    },
    {
      en: "One multi-page .tiff for the whole document — the scanner and archive convention.",
      hi: "पूरे दस्तावेज़ के लिए एक मल्टी-पेज .tiff — स्कैनर और आर्काइव का स्टैंडर्ड।",
    },
    {
      en: "LZW lossless compression that opens in every viewer, or plain uncompressed.",
      hi: "LZW लॉसलेस कंप्रेशन जो हर व्यूअर में खुलता है, या सादा बिना कंप्रेशन।",
    },
    {
      en: "Your chosen DPI is written into the file — scanners and printers see it.",
      hi: "आपका चुना DPI फ़ाइल में दर्ज होता है — स्कैनर और प्रिंटर उसे पहचानते हैं।",
    },
    {
      en: "On-device rendering — your PDF never leaves the browser.",
      hi: "डिवाइस पर रेंडरिंग — आपकी PDF ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: { en: "What is a multi-page TIFF?", hi: "मल्टी-पेज TIFF क्या है?" },
      a: {
        en: "A single .tiff file that holds every page — the standard scanner and archive format. Viewer software flips through it like a document. Turn the switch off if you need one file per page.",
        hi: "एक ही .tiff फ़ाइल जिसमें सारे पेज हों — स्कैनर और आर्काइव का स्टैंडर्ड। व्यूअर सॉफ़्टवेयर उसे दस्तावेज़ की तरह पलटता है। हर पेज की अलग फ़ाइल चाहिए तो स्विच बंद करें।",
      },
    },
    {
      q: { en: "LZW or None?", hi: "LZW या None?" },
      a: {
        en: "LZW shrinks the file losslessly and every modern viewer — Windows Photos, macOS Preview, Photoshop — reads it. Keep None only for strict legacy systems that demand raw pixels.",
        hi: "LZW फ़ाइल को बिना नुक़सान छोटा करता है और हर आधुनिक व्यूअर — Windows Photos, macOS Preview, Photoshop — उसे पढ़ता है। None सिर्फ़ उन सख़्त पुराने सिस्टम के लिए रखें जिन्हें कच्चे पिक्सेल चाहिए।",
      },
    },
    {
      q: { en: "Why TIFF instead of JPG or PNG?", hi: "JPG या PNG की जगह TIFF क्यों?" },
      a: {
        en: "Publishing, scanning and fax workflows expect TIFF: exact pixels, a DPI stamp in the file, and many pages in one document. For photos for the web pick PDF to WEBP; for screenshots pick PNG.",
        hi: "प्रकाशन, स्कैनिंग और फ़ैक्स काम TIFF माँगते हैं: सटीक पिक्सेल, फ़ाइल में DPI दर्ज, और कई पेज एक दस्तावेज़ में। वेब की तस्वीरों के लिए PDF से WEBP चुनें; स्क्रीनशॉट के लिए PNG।",
      },
    },
  ],
};
