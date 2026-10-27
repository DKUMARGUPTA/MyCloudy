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
  chainToolIds: ["ocr-pdf", "edit-pdf", "compress-pdf", "sign-pdf", "merge-pdf"],
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
      kind: "switch",
      id: "autoStraighten",
      label: {
        en: "Auto-straighten text",
        hi: "टेक्स्ट अपने आप सीधा करें",
      },
      hint: {
        en: "Detects tilted text lines (0.3°–5°) and straightens them. Photos and blank pages are left untouched.",
        hi: "तिरछी टेक्स्ट लाइनें (0.3°–5°) पहचानकर सीधी करता है। तस्वीरें और खाली पेज वैसे ही रहते हैं।",
      },
      default: true,
    },
    {
      kind: "text",
      id: "docName",
      label: { en: "Document name", hi: "दस्तावेज़ का नाम" },
      placeholder: {
        en: "scan (automatic)",
        hi: "scan (अपने आप)",
      },
      hint: {
        en: "Name for the downloaded PDF. Leave empty to name it automatically.",
        hi: "डाउनलोड होने वाली PDF का नाम। खाली छोड़ें तो नाम अपने आप रखा जाता है।",
      },
      default: "",
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
      en: "Point the camera and the page is detected automatically — corners, edges and perspective are straightened into a flat scan, with a live outline that tracks the page.",
      hi: "कैमरा घुमाइए, पेज अपने आप पहचाना जाता है — कोने, किनारे और पर्स्पेक्टिव सीधा करके सपाट स्कैन बनता है, और लाइव आउटलाइन पेज को फ़ॉलो करती है।",
    },
    {
      en: "Eight scanner filters with live thumbnails — Original, Magic color, Vivid, Soft tone, B&W, Grayscale, Sharp black and OCR black — plus brightness/contrast dials on every page.",
      hi: "आठ स्कैनर फ़िल्टर लाइव थंबनेल के साथ — Original, Magic color, Vivid, Soft tone, B&W, Grayscale, Sharp black और OCR black — साथ हर पेज पर ब्राइटनेस/कॉन्ट्रास्ट डायल।",
    },
    {
      en: "Auto-capture mode holds the shutter until the page locks still, the composition grid frames your shot, and presets (Document, Photo, ID card, Book, Signature) set the whole look in one tap.",
      hi: "ऑटो-कैप्चर मोड पेज स्थिर होने तक शटर रोकता है, कंपोज़िशन ग्रिड शॉट संवारता है, और प्रीसेट (Document, Photo, ID card, Book, Signature) एक टैप में पूरी लुक सेट करते हैं।",
    },
    {
      en: "Double-sided ID-card mode: with the ID card preset, flip on Double-sided and shoot the front, then the back — both sides land on one PDF page, photocopy style, printed at the same size.",
      hi: "दो-तरफ़ा आईडी-कार्ड मोड: ID card प्रीसेट के साथ Double-sided चालू करें और पहले आगे की साइड, फिर पीछे की साइड खींचें — दोनों एक ही PDF पेज पर आती हैं, फ़ोटोकॉपी जैसे, एक ही साइज़ में छपती हैं।",
    },
    {
      en: "Text pages straighten themselves (tilt up to 5° is corrected), and finished scans chain straight to OCR, editing, signing or compressing — every next step keeps your pages.",
      hi: "टेक्स्ट पेज अपने आप सीधे हो जाते हैं (5° तक का झुकाव ठीक होता है), और तैयार स्कैन सीधे OCR, एडिटिंग, साइनिंग या कंप्रेशन से जुड़ते हैं — अगला कदम आपके पेज बनाए रखता है।",
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
      q: {
        en: "How do I scan both sides of an ID card?",
        hi: "आईडी कार्ड की दोनों साइड कैसे स्कैन करें?",
      },
      a: {
        en: "Pick the ID card preset, then switch on Double-sided. The camera tells you which side is next — shoot the front, flip the card, shoot the back. Each pair becomes one PDF page with the front on top and the back below it, both printed at the same size like a photocopy. You can still fix corners, filters and rotation for each side, and the remove-back button turns a pair back into a single-sided page.",
        hi: "ID card प्रीसेट चुनें, फिर Double-sided चालू करें। कैमरा बताता रहता है कि अगली कौन सी साइड है — पहले आगे की साइड खींचें, कार्ड पलटें, पीछे की साइड खींचें। हर जोड़ी एक PDF पेज बनती है: आगे की साइड ऊपर, पीछे की नीचे, दोनों एक ही साइज़ में, फ़ोटोकॉपी जैसे। हर साइड के कोने, फ़िल्टर और रोटेशन आप बदल सकते हैं, और पीछे-की-साइड-हटाएँ बटन जोड़ी को वापस सिंगल-साइड पेज बना देता है।",
      },
    },
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
        en: "Magic color is the safe default for documents — it whitens the paper and boosts contrast. Vivid makes product boxes and colour pages pop. Soft tone is gentle for long reading. B&W and Sharp black give the smallest files and the crispest text (Sharp black adds edge sharpening before the cut). OCR black cleans the background for text extraction. Grayscale softens photos and coloured stamps. Original keeps the photo exactly as captured.",
        hi: "दस्तावेज़ों के लिए Magic color सबसे सुरक्षित है — काग़ज़ सफ़ेद और कॉन्ट्रास्ट बेहतर करता है। Vivid प्रोडक्ट बॉक्स और रंगीन पेज चमकाता है। Soft tone लंबे पढ़ने के लिए हल्का है। B&W और Sharp black सबसे छोटी फ़ाइल और सबसे साफ़ टेक्स्ट देते हैं (Sharp black काट से पहले एज़ शार्प करता है)। OCR black टेक्स्ट निकालने के लिए बैकग्राउंड साफ़ करता है। Grayscale तस्वीरों और रंगीन मुहरों को नरम करता है। Original तस्वीर जैसी है वैसी रखता है।",
      },
    },
    {
      q: {
        en: "What do the presets do?",
        hi: "प्रीसेट क्या करते हैं?",
      },
      a: {
        en: "A preset is a starting point, not a promise: Document applies Magic color, A4 pages and auto-straighten; Photo and ID card keep colours untouched with page size fitted to the scan; Book applies Magic color with fitted pages; Signature switches to OCR black for a high-contrast copy. Every page stays fully editable afterwards.",
        hi: "प्रीसेट शुरुआती पॉइंट है, जादू नहीं: Document मैजिक कलर, A4 पेज और ऑटो-स्ट्रेटन लगाता है; Photo और ID card रंग वैसे रखते हैं और पेज साइज़ स्कैन के अनुसार; Book मैजिक कलर और फ़िटेड पेज; Signature ऑटो-स्ट्रेटन के साथ हाई-कॉन्ट्रास्ट कॉपी के लिए OCR black लगाता है। बाद में हर पेज पूरी तरह एडिट योग्य रहता है।",
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
