import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to SVG (RB4-a) — every selected page becomes a standalone vector
 * .svg: text stays selectable <text>, shapes become <rect>/<path> with
 * the page CTM applied, embedded images are re-encoded as base64 PNG.
 * The operator-list walk is a documented honest subset (no gradients,
 * approximated clipping, font substitution) — the surface says so.
 *
 * Options: page range + an "include images" switch. There is no DPI —
 * SVG is vector and scales losslessly (the hint says exactly that).
 * Multiple pages become multiple outputs (ZIP via the shared ResultView).
 */
export const config: ToolConfig = {
  toolId: "pdf-to-svg",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["svg-to-pdf", "images-to-pdf", "rasterize-pdf"],
  howKeys: ["psvg.how1", "psvg.how2", "psvg.how3"],
  options: [
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
      kind: "switch",
      id: "includeImages",
      label: { en: "Embed images", hi: "इमेज शामिल करें" },
      hint: {
        en: "Embedded photos are re-encoded as base64 PNG inside the SVG",
        hi: "एम्बेड की तस्वीरें SVG के अंदर base64 PNG बनकर शामिल होती हैं",
      },
      default: true,
    },
  ],
  features: [
    {
      en: "True vector pages — text becomes selectable <text>, shapes become <rect>/<path>, and the viewBox matches the page's exact point size. No DPI, no pixels, no quality loss at any zoom.",
      hi: "असली वेक्टर पेज — टेक्स्ट चुनने योग्य <text> बनता है, आकृतियाँ <rect>/<path> बनती हैं, और viewBox पेज के पक्के पॉइंट साइज़ से मेल खाता है। न कोई DPI, न पिक्सल, न किसी ज़ूम पर गुणवत्ता का नुकसान।",
    },
    {
      en: "Text stays selectable and searchable — that's the SVG advantage over raster exports. Font size, position, fill colour and bold/italic are carried over from the PDF's own drawing operators.",
      hi: "टेक्स्ट चुनने योग्य और खोजने योग्य रहता है — रास्टर एक्सपोर्ट की तुलना में SVG की खूबी। फ़ॉन्ट साइज़, जगह, रंग और बोल्ड/इटैलिक PDF के अपने ड्रॉइंग ऑपरेटरों से आते हैं।",
    },
    {
      en: "Export everything or just “1-3, 7” — each page downloads as its own .svg, with a one-click ZIP for the whole set.",
      hi: "सब कुछ या सिर्फ़ “1-3, 7” — हर पेज अपनी अलग .svg फ़ाइल बनता है, और पूरे सेट के लिए एक-क्लिक ZIP।",
    },
    {
      en: "Optional image embedding — embedded photos are re-encoded as base64 PNG and placed at their exact page geometry, or skipped for a lean text-and-shapes vector.",
      hi: "इमेज शामिल करना आपकी मर्ज़ी — एम्बेड तस्वीरें base64 PNG बनकर अपनी पक्की जगह पर आती हैं, या हटाकर हल्की टेक्स्ट-आकृति वेक्टर फ़ाइल बनती है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the SVG look exactly like the PDF?",
        hi: "क्या SVG बिल्कुल PDF जैसी दिखेगी?",
      },
      a: {
        en: "Very close, but not pixel-identical — and we say so honestly. Text, rectangles, lines, curves, fills and embedded images are translated to real SVG elements at their original coordinates. However, fonts are substituted by family name (your system's Helvetica/Noto renders the glyphs), so widths and complex-script shaping like Devanagari conjuncts can differ slightly from the embedded PDF fonts.",
        hi: "बहुत क़रीब, लेकिन पिक्सेल-दर-पिक्सेल नहीं — और हम यह ईमानदारी से बताते हैं। टेक्स्ट, आयत, लाइनें, कर्व, भराव और एम्बेड इमेज असली SVG एलिमेंट बनकर अपनी असली जगह पर आते हैं। लेकिन फ़ॉन्ट नाम से बदले जाते हैं (आपके सिस्टम का Helvetica/Noto ग्लिफ़ बनाता है), इसलिए चौड़ाई और देवनागरी जैसी जुड़ी लिपि थोड़ी अलग दिख सकती है।",
      },
    },
    {
      q: {
        en: "What is not converted?",
        hi: "क्या नहीं बदलता?",
      },
      a: {
        en: "The honest subset: gradient fills and patterns are omitted, clipping is approximated away, image masks are skipped, Type3 fonts are approximated, and text painted in stroke-only or clipped modes renders filled. Nothing fails silently — the tool's explainer lists these limits before you run, and everything else (text, paths, images) converts at full fidelity.",
        hi: "ईमानदार सीमाएँ: ग्रेडिएंट भराव और पैटर्न हटाए जाते हैं, क्लिपिंग का अनुमान लगाया जाता है, इमेज मास्क छोड़े जाते हैं, Type3 फ़ॉन्ट अनुमानित होते हैं, और सिर्फ़-स्ट्रोक या क्लिप मोड में लिखा टेक्स्ट भरकर दिखता है। कुछ चुपचाप नहीं ग़ायब होता — रन से पहले ये सीमाएँ टूल में लिखी रहती हैं, बाकी सब (टेक्स्ट, पाथ, इमेज) पूरी बेफ़िक्री बदलता है।",
      },
    },
    {
      q: {
        en: "Why is there no DPI setting?",
        hi: "DPI की सेटिंग क्यों नहीं है?",
      },
      a: {
        en: "Because SVG is vector — the viewBox is the page's size in points and every element is geometry, so the file renders crisply at any zoom or print size. DPI only matters for raster exports like JPG, PNG and TIFF; pick those tools when you need pixels.",
        hi: "क्योंकि SVG वेक्टर है — viewBox पेज का साइज़ पॉइंट में होता है और हर एलिमेंट ज्यामिति है, इसलिए फ़ाइल किसी भी ज़ूम या प्रिंट साइज़ पर साफ़ दिखती है। DPI सिर्फ़ JPG, PNG, TIFF जैसे रास्टर एक्सपोर्ट के लिए ज़रूरी है; पिक्सल चाहिए तो वे टूल चुनें।",
      },
    },
    {
      q: {
        en: "My PDF is a scan — what will the SVG contain?",
        hi: "मेरी PDF स्कैन है — SVG में क्या होगा?",
      },
      a: {
        en: "Scanned pages are one big photo, so with “Embed images” on the photo is re-encoded as a base64 PNG inside the SVG (large but faithful); with it off you get the page's vector container, which is usually near-empty. For a pixel-perfect raster copy use PDF to PNG instead.",
        hi: "स्कैन किए पेज एक बड़ी तस्वीर हैं, इसलिए “इमेज शामिल करें” चालू होने पर तस्वीर SVG के अंदर base64 PNG बन जाती है (बड़ी लेकिन वफ़ादार); बंद होने पर पेज का वेक्टर कंटेनर मिलता है जो आमतौर पर लगभग ख़ाली होता है। पिक्सेल-दर-पिक्सेल कॉपी के लिए PDF to PNG इस्तेमाल करें।",
      },
    },
  ],
};
