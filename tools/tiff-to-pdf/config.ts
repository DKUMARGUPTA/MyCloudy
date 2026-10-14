import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * TIFF to PDF — ImageGrid preset over the shared images→PDF worker, built
 * on the clean-room TIFF reader (tools/imgconv/tiff.ts): LZW (both width
 * rhythms), PackBits, Deflate, G3/G4 fax, palette/gray/RGB/CMYK, 1-16
 * bit, strips and tiles, big- and little-endian, multi-page IFD chains.
 */
export const config: ToolConfig = {
  toolId: "tiff-to-pdf",
  createWorker: () =>
    new Worker(new URL("../imagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 50,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  chainToolIds: ["ocr-pdf", "compress-pdf"],
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "“Fit” uses the TIFF's own DPI — a 300-DPI A4 scan lands at exactly A4",
        hi: "“तस्वीर के अनुसार” TIFF का अपना DPI लगाता है — 300-DPI का A4 स्कैन बिल्कुल A4 बनता है",
      },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "Letter", hi: "लेटर" } },
        { value: "fit", label: { en: "Fit to image", hi: "तस्वीर के अनुसार" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      hint: {
        en: "Auto follows each page's shape",
        hi: "ऑटो हर पेज की आकृति के हिसाब से",
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
    {
      kind: "pages",
      id: "pages",
      label: { en: "TIFF pages", hi: "TIFF पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8- — per file",
        hi: "सब, या रेंज जैसे 1-3, 5, 8- — हर फ़ाइल के हिसाब से",
      },
      default: "all",
    },
    {
      kind: "switch",
      id: "pageNumbers",
      label: { en: "Add page numbers", hi: "पेज नंबर जोड़ें" },
      default: false,
    },
  ],
  features: [
    {
      en: "Every page of a multi-page TIFF becomes one PDF page, in order.",
      hi: "मल्टी-पेज TIFF का हर पेज क्रम से PDF का एक पेज बनता है।",
    },
    {
      en: "Reads LZW, uncompressed, PackBits, Deflate and G3/G4 fax TIFFs — the archive and scanner standards.",
      hi: "LZW, बिना कंप्रेशन, PackBits, Deflate और G3/G4 फ़ैक्स TIFF पढ़ता है — आर्काइव और स्कैनर के स्टैंडर्ड।",
    },
    {
      en: "The scan's own DPI sizes “fit” pages — a 300-DPI A4 scan lands at exactly A4.",
      hi: "“फ़िट” पेज स्कैन के अपने DPI से बनते हैं — 300-DPI का A4 स्कैन बिल्कुल A4 निकलता है।",
    },
    {
      en: "Pick pages with ranges like 1-3, 5 — handy for 100-page fax files.",
      hi: "1-3, 5 जैसी रेंज से पेज चुनें — 100 पेज की फ़ैक्स फ़ाइलों के लिए आसान।",
    },
    {
      en: "Decoded on your device — the scan never leaves the browser.",
      hi: "आपके डिवाइस पर डिकोड — स्कैन ब्राउज़र से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: { en: "What is a multi-page TIFF?", hi: "मल्टी-पेज TIFF क्या है?" },
      a: {
        en: "A single .tiff file that holds many pages — the scanner and archive convention. Every page becomes a PDF page, in order. Use the “TIFF pages” option to pick just some of them.",
        hi: "एक ही .tiff फ़ाइल जिसमें कई पेज हों — स्कैनर और आर्काइव का स्टैंडर्ड। हर पेज क्रम से PDF पेज बनता है। सिर्फ़ कुछ चाहिए तो “TIFF पेज” विकल्प इस्तेमाल करें।",
      },
    },
    {
      q: { en: "My TIFF has a fax or palette format — will it work?", hi: "मेरी TIFF फ़ैक्स या पैलेट वाली है — चलेगी?" },
      a: {
        en: "Almost certainly. The reader handles LZW, uncompressed, PackBits, Deflate, G3 and G4 fax, grayscale, palette, RGB and CMYK — little- and big-endian, 1 to 16 bits per sample.",
        hi: "लगभग पक्का। रीडर LZW, बिना कंप्रेशन, PackBits, Deflate, G3/G4 फ़ैक्स, ग्रेस्केल, पैलेट, RGB और CMYK पढ़ता है — दोनों endian, 1 से 16 बिट प्रति सैंपल।",
      },
    },
    {
      q: { en: "Why is my PDF big?", hi: "PDF बड़ी क्यों है?" },
      a: {
        en: "TIFF stores exact pixels; the PDF embeds each page as a high-quality image. Fax and line-art pages stay crisp PNG; photo pages are JPEG at 0.92. Run Compress PDF afterwards if you need it lighter.",
        hi: "TIFF में सटीक पिक्सेल होते हैं; PDF हर पेज हाई-क्वालिटी तस्वीर के रूप में जोड़ती है। फ़ैक्स और लाइन-आर्ट पेज साफ़ PNG रहते हैं; फ़ोटो पेज 0.92 पर JPEG। हल्की चाहिए तो बाद में Compress PDF चलाएँ।",
      },
    },
  ],
};
