import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Scan to PDF (PRD §8.4, create) — camera capture with auto edge
 * detection, perspective correction, scanner filters and multi-page
 * reordering; photos from the gallery ride the same pipeline. The custom
 * surface renders on the LANDING too (landingSurface) so the camera is
 * reachable without uploading a file first — mobile is the primary use
 * case. Everything runs on-device.
 */
export const config: ToolConfig = {
  toolId: "scan-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  landingSurface: true,
  minFiles: 0,
  maxFiles: 30,
  howKeys: ["scan.how1", "scan.how2", "scan.how3"],
  chainToolIds: ["compress-pdf", "lock-pdf", "sign-pdf", "merge-pdf", "split-pdf"],
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
          label: { en: "Fit to scan", hi: "स्कैन के अनुसार" },
        },
      ],
      default: "a4",
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
      default: "none",
    },
    {
      kind: "select",
      id: "quality",
      label: { en: "Scan quality", hi: "स्कैन क्वालिटी" },
      hint: {
        en: "Long edge of each page — higher means bigger files.",
        hi: "हर पेज का लंबा किनारा — ज़्यादा मतलब बड़ी फ़ाइल।",
      },
      choices: [
        {
          value: "standard",
          label: { en: "Standard (1600px)", hi: "स्टैंडर्ड (1600px)" },
        },
        { value: "high", label: { en: "High (2400px)", hi: "हाई (2400px)" } },
      ],
      default: "standard",
    },
  ],
  features: [
    {
      en: "Point the camera and the page is detected automatically — corners, edges and perspective are straightened into a flat scan.",
      hi: "कैमरा घुमाइए, पेज अपने आप पहचाना जाता है — कोने, किनारे और पर्स्पेक्टिव सीधा करके सपाट स्कैन बनता है।",
    },
    {
      en: "Scanner filters on every page: Original, Magic color, B&W (crisp text) and Grayscale — try them live before saving.",
      hi: "हर पेज पर स्कैनर फ़िल्टर: Original, Magic color, B&W (साफ़ टेक्स्ट) और Grayscale — सेव करने से पहले लाइव आज़माइए।",
    },
    {
      en: "Multi-page sessions: keep capturing and the pages stack up; drag to reorder, tap to fix corners or re-filter later.",
      hi: "मल्टी-पेज सेशन: लगातार कैप्चर करते रहिए, पेज जुड़ते जाते हैं; खींचकर क्रम बदलें, कोने ठीक करें या फ़िल्टर बदलें।",
    },
    {
      en: "No camera? Add photos from the gallery — they get the same edge detection, filters and perspective fix.",
      hi: "कैमरा नहीं? गैलरी से तस्वीरें जोड़ें — उन पर भी वही किनारा पहचान, फ़िल्टर और पर्स्पेक्टिव सुधार।",
    },
    {
      en: "100% on-device — the camera stream and photos never leave the browser.",
      hi: "100% डिवाइस पर — कैमरा स्ट्रीम और तस्वीरें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: { en: "How does the edge detection work?", hi: "किनारा पहचान कैसे काम करती है?" },
      a: {
        en: "Each photo is analysed on your device: the page is separated from the background, its four corners are found, and a perspective transform flattens it — the same idea as dedicated scanner apps. When the page can't be found confidently (low contrast, page fills the frame), the corners stay editable so you can drag them yourself.",
        hi: "हर तस्वीर आपके डिवाइस पर जाँची जाती है: पेज पृष्ठभूमि से अलग होता है, उसके चार कोने मिलते हैं, और पर्स्पेक्टिव ट्रांसफ़ॉर्म उसे सपाट कर देता है — जैसे डेडिकेटेड स्कैनर ऐप्स में होता है। पेज भरोसे से न मिले तो (कम कंट्रास्ट, पेज पूरा फ़्रेम भर दे) कोने एडिट करने योग्य रहते हैं — खुद खींचकर ठीक कर लें।",
      },
    },
    {
      q: { en: "Which filter should I pick?", hi: "कौन सा फ़िल्टर चुनें?" },
      a: {
        en: "Magic color is the safe default for documents — it whitens the paper and boosts contrast. B&W gives the smallest files and the crispest text for printed pages. Grayscale softens photos and colored stamps. Original keeps the photo exactly as captured.",
        hi: "दस्तावेज़ों के लिए Magic color सबसे सुरक्षित है — काग़ज़ सफ़ेद और कंट्रास्ट बेहतर करता है। B&W सबसे छोटी फ़ाइल और छपे पेजों के लिए सबसे साफ़ टेक्स्ट देता है। Grayscale तस्वीरों और रंगीन मुहरों को नरम करता है। Original तस्वीर जैसी है वैसी ही रखता है।",
      },
    },
    {
      q: { en: "Can I scan more pages later?", hi: "बाद में और पेज जोड़ सकते हैं?" },
      a: {
        en: "Yes — open the camera again from the workspace, or add photos from the gallery; every new photo goes through the same detection and joins the page list. Up to 30 pages per PDF. Need more? Scan twice and merge the results with Merge PDF.",
        hi: "हाँ — वर्कस्पेस से दोबारा कैमरा खोलें, या गैलरी से तस्वीरें जोड़ें; हर नई तस्वीर उसी पहचान से गुज़रकर पेज सूची में जुड़ती है। एक PDF में 30 तक पेज। ज़्यादा चाहिए? दो बार स्कैन करें और नतीजे Merge PDF से जोड़ लें।",
      },
    },
    {
      q: {
        en: "Does the camera upload anything?",
        hi: "कैमरा कुछ अपलोड करता है?",
      },
      a: {
        en: "No. The camera stream is read only by this page in your browser — capture, corner detection, filters and the PDF all happen on the device. Nothing is sent, saved or logged. If that ever changes, this tool will say so in a badge.",
        hi: "नहीं। कैमरा स्ट्रीम सिर्फ़ आपके ब्राउज़र में इसी पेज़ को दिखती है — कैप्चर, कोना पहचान, फ़िल्टर और PDF सब डिवाइस पर होते हैं। कुछ न भेजा, न सेव, न लॉग होता। अगर कभी बदले तो टूल बैज में साफ़ बताएगा।",
      },
    },
  ],
};
