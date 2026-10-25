import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Images to PDF (PRD §8.6) — the flagship create tool of the ImageGrid
 * family. The interactive card grid (tools/imagegrid/image-grid-surface)
 * owns order + rotation; this schema carries the page-assembly options.
 *
 * JPG/PNG embed the ORIGINAL bytes when unrotated (zero quality loss);
 * WEBP/GIF/HEIC are transcoded on-device, HEIC only where the browser
 * can decode it (honest error otherwise).
 */
export const config: ToolConfig = {
  toolId: "images-to-pdf",
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  createWorker: () =>
    new Worker(new URL("../imagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 50,
  chainToolIds: ["ocr-pdf", "compress-pdf", "merge-pdf", "sign-pdf"],
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "Letter", hi: "लेटर" } },
        {
          value: "fit",
          label: { en: "Fit to image", hi: "तस्वीर के अनुसार" },
        },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      hint: {
        en: "Auto follows each image's shape",
        hi: "ऑटो हर तस्वीर की आकृति के हिसाब से",
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
      kind: "select",
      id: "layout",
      label: { en: "Images per page", hi: "प्रति पेज तस्वीरें" },
      choices: [
        { value: "one", label: { en: "One", hi: "एक" } },
        { value: "two", label: { en: "Two (side by side)", hi: "दो (साथ-साथ)" } },
      ],
      default: "one",
    },
    {
      kind: "select",
      id: "background",
      label: { en: "Background", hi: "बैकग्राउंड" },
      choices: [
        { value: "white", label: { en: "White", hi: "सफ़ेद" } },
        { value: "soft", label: { en: "Soft", hi: "हल्का" } },
        { value: "dark", label: { en: "Dark", hi: "गहरा" } },
      ],
      default: "white",
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
      en: "JPG, PNG, WEBP — and HEIC where your browser can decode it — into one clean PDF.",
      hi: "JPG, PNG, WEBP — और जहाँ ब्राउज़र डिकोड कर सके, HEIC — एक साफ़ PDF में।",
    },
    {
      en: "Drag to reorder, rotate any photo 90°, fix the classic IMG_101/IMG_100 mess with A→Z sort.",
      hi: "खींचकर क्रम बदलें, कोई भी तस्वीर 90° घुमाएँ, A→Z से IMG_101/IMG_100 वाली गड़बड़ ठीक करें।",
    },
    {
      en: "A4, Letter or fit-to-image pages, margins, two-per-page grid, background colour and page numbers.",
      hi: "A4, लेटर या तस्वीर-अनुसार पेज, मार्जिन, दो-प्रति-पेज ग्रिड, बैकग्राउंड रंग और पेज नंबर।",
    },
    {
      en: "Unrotated JPG/PNG files are embedded byte-for-byte — no re-compression, no quality loss.",
      hi: "बिना घुमाई गई JPG/PNG फ़ाइलें जस की तस जुड़ती हैं — दोबारा कंप्रेस नहीं, क्वालिटी बरक़रार।",
    },
    {
      en: "Everything happens on your device — your photos never leave the browser.",
      hi: "सब कुछ आपके डिवाइस पर होता है — तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will my photos lose quality?",
        hi: "क्या तस्वीरों की क्वालिटी गिरेगी?",
      },
      a: {
        en: "No — unrotated JPG and PNG files are embedded exactly as they are, byte for byte. Only rotated photos (and WEBP/GIF/HEIC conversions) are re-encoded once, at high quality.",
        hi: "नहीं — बिना घुमाई JPG/PNG फ़ाइलें बिल्कुल वैसी ही जुड़ती हैं। सिर्फ़ घुमाई गई तस्वीरें (और WEBP/GIF/HEIC बदलाव) एक बार, हाई क्वालिटी पर दोबारा एनकोड होती हैं।",
      },
    },
    {
      q: {
        en: "My HEIC photos from iPhone are failing — why?",
        hi: "iPhone की HEIC तस्वीरें क्यों नहीं बन रहीं?",
      },
      a: {
        en: "HEIC decoding depends on your browser: Safari reads iPhone photos natively, some Chrome setups cannot. If it fails, convert to JPG first (Photos → Export, or any converter) — everything else works the same.",
        hi: "HEIC डिकोडिंग ब्राउज़र पर निर्भर है: Safari iPhone तस्वीरें सीधे पढ़ता है, कुछ Chrome सेटअप नहीं कर पाते। अगर न बने, तो पहले JPG में बदलें (Photos → Export या कोई कन्वर्टर) — बाक़ी सब वैसा ही चलेगा।",
      },
    },
    {
      q: {
        en: "How do I get one small page per photo?",
        hi: "हर तस्वीर का अपना छोटा पेज कैसे मिले?",
      },
      a: {
        en: "Choose “Fit to image” with margin “None” — every page becomes exactly the photo's size, no borders at all.",
        hi: "“तस्वीर के अनुसार” + मार्जिन “कोई नहीं” चुनें — हर पेज बिल्कुल तस्वीर के आकार का होगा, बिना किनारों के।",
      },
    },
  ],
};
