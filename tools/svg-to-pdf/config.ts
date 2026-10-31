import type { ToolConfig } from "@/lib/tools/config-types";
import { FIT_MODE_OPTION } from "../imagegrid/fit-mode-option";
import { getSvgRastersInOrder } from "../imagegrid/svg-raster";

/**
 * SVG to PDF — ImageGrid preset over the shared images→PDF worker.
 *
 * Web Workers cannot rasterise SVG (Chrome/Firefox reject SVG blobs in
 * createImageBitmap), so the grid surface rasterises every SVG on the
 * main thread while its card preview loads (crisp PNG at print
 * resolution, alpha kept) and this config hands the rasters to the
 * worker as run assets — collectAssets is the add-watermark logo-store
 * pattern. The worker embeds each raster and sizes "fit" pages by the
 * SVG's own CSS pixels (96 DPI → points × 0.75).
 */
export const config: ToolConfig = {
  toolId: "svg-to-pdf",
  createWorker: () =>
    new Worker(new URL("../imagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 50,
  howKeys: ["imgc.how1", "imgc.how2", "imgc.how3"],
  collectAssets: () => getSvgRastersInOrder(),
  chainToolIds: ["compress-pdf", "view-pdf", "merge-pdf"],
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "Letter", hi: "लेटर" } },
        { value: "fit", label: { en: "Fit to graphic", hi: "ग्राफ़िक के अनुसार" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
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
    FIT_MODE_OPTION,
  ],
  features: [
    {
      en: "Vector art becomes print-crisp PDF pages — rasterised at high resolution, never blurry.",
      hi: "वेक्टर आर्ट प्रिंट-जैसी साफ़ PDF पेज बनती है — हाई रेज़ोल्यूशन रास्टर, धुँधली कभी नहीं।",
    },
    {
      en: "Keep transparency (logos, icons, line art) or lay pages out on A4/Letter with margins.",
      hi: "ट्रांसपेरेंसी रहती है (लोगो, आइकन, लाइन-आर्ट) या A4/लेटर पेज पर मार्जिन के साथ।",
    },
    {
      en: "Drag to reorder, rotate any graphic 90°, fix the order with A→Z sort.",
      hi: "खींचकर क्रम बदलें, किसी भी ग्राफ़िक को घुमाएँ, A→Z से क्रम ठीक करें।",
    },
    {
      en: "Runs entirely on your device — your graphics never leave the browser.",
      hi: "पूरा काम डिवाइस पर — आपकी फ़ाइलें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "Is my SVG embedded as vectors?", hi: "मेरा SVG वेक्टर के रूप में जुड़ता है?" },
      a: {
        en: "No — the graphic is rasterised once at high resolution (about 290 DPI on an A4 page) and embedded as a crisp PNG page. Text and shapes look sharp on screen and in print, but they are pixels, not selectable vectors.",
        hi: "नहीं — ग्राफ़िक एक बार हाई रेज़ोल्यूशन (A4 पेज पर लगभग 290 DPI) पर रास्टर होकर साफ़ PNG पेज के रूप में जुड़ता है। स्क्रीन और प्रिंट में तेज़ दिखता है, पर वो पिक्सेल हैं, चुनने योग्य वेक्टर नहीं।",
      },
    },
    {
      q: { en: "My SVG shows no size — what then?", hi: "मेरे SVG में साइज़ नहीं है — तब?" },
      a: {
        en: "Graphics without width/height fall back to a default canvas size. Open the file in any editor and add a viewBox or explicit dimensions for an exact fit.",
        hi: "बिना width/height वाले ग्राफ़िक डिफ़ॉल्ट साइज़ पर बनते हैं। सही फ़िट के लिए फ़ाइल को किसी एडिटर में खोलकर viewBox या साइज़ जोड़ दें।",
      },
    },
    {
      q: { en: "Can I mix SVG with JPG or PNG photos?", hi: "SVG के साथ JPG या PNG मिला सकते हैं?" },
      a: {
        en: "Yes — this tool accepts all common image formats, exactly like Images to PDF.",
        hi: "हाँ — यह टूल सभी आम इमेज फ़ॉर्मैट लेता है, बिल्कुल Images to PDF की तरह।",
      },
    },
  ],
};
