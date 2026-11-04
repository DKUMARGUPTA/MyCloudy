import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PSD to PDF (P3-c / R57) — Adobe Photoshop files → PDF, 100% on-device
 * (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone (accepts images — the worker
 * validates the 8BPS signature), options (page size / orientation /
 * margin), the worker reads the SAVED COMPOSITE (the flattened preview
 * Photoshop itself embeds) with our OWN pure decoder (raw + PackBits
 * RLE, RGB and Grayscale, alpha channel honoured) and places one page
 * per file on the OWN PDF engine.
 */
export const config: ToolConfig = {
  toolId: "psd-to-pdf",
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
        en: "A4 (210 × 297 mm), US Letter, or pages exactly the size of the artwork.",
        hi: "A4 (210 × 297 मिमी), US लेटर, या पेज बिल्कुल आर्टवर्क के आकार के।",
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
        en: "Auto follows each artwork's shape.",
        hi: "ऑटो हर आर्टवर्क की आकृति के हिसाब से।",
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
      en: "Photoshop .psd (and large-document .psb) files become PDF pages using the flattened composite Photoshop saves inside every file — no layers to interpret, no server involved.",
      hi: "Photoshop .psd (और बड़ी फ़ाइल .psb) हर फ़ाइल के भीतर बची फ़्लैट कंपोज़िट से PDF पेज बनती हैं — न लेयर खोलनी पड़ती हैं, न कोई सर्वर।",
    },
    {
      en: "Transparency is honoured: PSDs with an alpha channel embed as lossless PNG; flat RGB artwork embeds as high-quality JPEG.",
      hi: "ट्रांसपेरेंसी मानी जाती है: अल्फ़ा चैनल वाली PSD बिना नुकसान PNG में जुड़ती है; सादी RGB आर्टवर्क हाई-क्वालिटी JPEG में।",
    },
    {
      en: "Both composite compressions are read — uncompressed and PackBits RLE — for RGB and Grayscale, 8-bit depth.",
      hi: "कंपोज़िट के दोनों कंप्रेशन पढ़े जाते हैं — अनकंप्रेस्ड और PackBits RLE — RGB और ग्रेस्केल, 8-बिट डेप्थ के लिए।",
    },
    {
      en: "Everything happens on your device — your design files are never uploaded anywhere.",
      hi: "सब कुछ आपके डिवाइस पर होता है — आपकी डिज़ाइन फ़ाइलें कहीं अपलोड नहीं होतीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Do I get the individual layers?",
        hi: "क्या मुझे अलग-अलग लेयर मिलती हैं?",
      },
      a: {
        en: "No — and that is the honest answer. This tool renders the flattened composite image that Photoshop itself saves inside the file (what you see when you open it). Layers, layer masks and adjustment settings are not reconstructed. Export specific layers from Photoshop if you need them separately.",
        hi: "नहीं — और यही ईमानदार जवाब है। यह टूल उस फ़्लैट कंपोज़िट इमेज को रेंडर करता है जो Photoshop खुद फ़ाइल के भीतर बचाता है (खोलने पर जो दिखता है)। लेयर, लेयर-मास्क और अडजस्टमेंट सेटिंग दोबारा नहीं बनते। अलग लेयर चाहिए तो Photoshop से एक्सपोर्ट करें।",
      },
    },
    {
      q: {
        en: "Which PSDs are refused?",
        hi: "कौन सी PSD मना की जाती है?",
      },
      a: {
        en: "16-bit and 32-bit deep composites, and colour modes other than RGB/Grayscale (Bitmap, Indexed, CMYK, Lab, Multichannel), are refused with a clear message — faking a conversion would be worse. Re-save as 8-bit RGB from Photoshop for a perfect result.",
        hi: "16-बिट और 32-बिट डेप्थ कंपोज़िट, और RGB/ग्रेस्केल के अलावा कलर मोड (बिटमैप, इंडेक्स्ड, CMYK, लैब, मल्टीचैनल) साफ़ संदेश के साथ मना किए जाते हैं — झूठा कन्वर्ज़न इससे बुरा होता। पक्के नतीजे के लिए Photoshop से 8-बिट RGB में दोबारा सेव करें।",
      },
    },
    {
      q: {
        en: "Why is the PDF page the composite, not the canvas?",
        hi: "PDF पेज कंपोज़िट ही क्यों होता है, कैनवास क्यों नहीं?",
      },
      a: {
        en: "A composite pixel-for-pixel IS the artwork as Photoshop displays it — text, shapes, photos, effects, all baked. For print-ready sizing, pick A4 or US Letter with margins; for an exact pixel match pick “Fit to image”.",
        hi: "कंपोज़िट पिक्सेल-दर-पिक्सेल वही आर्टवर्क है जैसा Photoshop दिखाता है — टेक्स्ट, शेप, फ़ोटो, इफ़ेक्ट, सब जैसे हैं वैसे। प्रिंट-रेडी साइज़ के लिए A4 या US लेटर + मार्जिन चुनें; पिक्सेल-सटीक चाहिए तो “तस्वीर के अनुसार”।",
      },
    },
  ],
};
