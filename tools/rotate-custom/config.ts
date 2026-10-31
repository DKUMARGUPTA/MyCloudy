import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rotate PDF by custom angle (P1-c) — any fraction of a degree, not just
 * the 90° steps of Rotate PDF pages. Straightens tilted scans (−3°, +2.5°)
 * or turns pages to any orientation. Selected pages are re-drawn through
 * the own-engine form-embed route (crop-box Form XObject + rotation
 * matrix on an exact bounding-box sheet); unselected pages are copied
 * byte-identically with their links and form fields intact.
 */
export const config: ToolConfig = {
  toolId: "rotate-custom",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "number",
      id: "angle",
      label: { en: "Angle (degrees)", hi: "कोण (डिग्री)" },
      hint: {
        en: "Clockwise, any fraction — e.g. 2.5 straightens a tilted scan. Use Rotate PDF pages for plain 90° turns (it keeps links).",
        hi: "दक्षिणावर्त, कोई भी भिन्न — जैसे 2.5 तिरछे स्कैन को सीधा करता है। सादे 90° के लिए Rotate PDF pages बेहतर है (लिंक बचते हैं)।",
      },
      min: -180,
      max: 180,
      step: 0.1,
      suffix: { en: "°", hi: "°" },
      default: 0,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Only the selected pages turn — the rest are copied untouched.",
        hi: "सिर्फ़ चुने पेज घूमते हैं — बाक़ी जस के तस कॉपी होते हैं।",
      },
      default: "all",
    },
  ],
  chainToolIds: ["rotate-pdf-pages", "merge-pdf", "view-pdf"],
  features: [
    {
      en: "Any angle — 2.5° to fix a tilted scan, 45° for a creative layout, not just 90° steps.",
      hi: "कोई भी कोण — तिरछे स्कैन के लिए 2.5°, क्रिएटिव लेआउट के लिए 45°, सिर्फ़ 90° के क़दम नहीं।",
    },
    {
      en: "The page grows to the exact rotated bounding box — nothing is cropped, nothing sticks out.",
      hi: "पेज ठीक घुमे हुए बाउंडिंग बॉक्स जितना बढ़ जाता है — न कुछ कटता है, न बाहर निकलता है।",
    },
    {
      en: "Pick the pages — the rest are copied byte-identically with links and form fields intact.",
      hi: "पेज चुनें — बाक़ी बाइट-दर-बाइट कॉपी होते हैं, लिंक और फ़ॉर्म फ़ील्ड सुरक्षित।",
    },
    {
      en: "Vector text stays vector — pages are re-placed, never rasterized.",
      hi: "टेक्स्ट वेक्टर ही रहता है — पेज दोबारा बैठाए जाते हैं, रास्टर नहीं होते।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why does the page get bigger after rotating?",
        hi: "घुमाने के बाद पेज बड़ा क्यों हो जाता है?",
      },
      a: {
        en: "A rectangle turned by an angle no longer fits its old box. The new page is the exact rotated bounding box, so every bit of content stays visible — like turning a photo on a larger sheet.",
        hi: "कोण से घुमा आयत अपने पुराने बॉक्स में फिट नहीं रहता। नया पेज ठीक उतना ही घुमा हुआ बाउंडिंग बॉक्स होता है, ताकि कंटेंट पूरा दिखे — बड़े काग़ज़ पर फ़ोटो घुमाने जैसा।",
      },
    },
    {
      q: {
        en: "What happens to links and form fields on the rotated pages?",
        hi: "घुमाए गए पेजों के लिंक और फ़ॉर्म फ़ील्ड का क्या होता है?",
      },
      a: {
        en: "Honest answer: rotated pages keep their visual content but drop interactive annotations (links, fields) — that is how page re-placement works in every engine. Pages you did NOT select keep everything. For plain 90° turns use Rotate PDF pages, which rotates in place and keeps links.",
        hi: "ईमानदार जवाब: घुमे पेज का दिखने वाला कंटेंट रहता है, पर इंटरैक्टिव एनोटेशन (लिंक, फ़ील्ड) हट जाते हैं — हर इंजन में पेज दोबारा बैठाने पर ऐसा ही होता है। जो पेज आपने नहीं चुना उसका सब कुछ रहता है। सादे 90° के लिए Rotate PDF pages इस्तेमाल करें — वह जगह पर ही घुमाता है और लिंक रखता है।",
      },
    },
    {
      q: {
        en: "Can it auto-detect the tilt of a scan?",
        hi: "क्या यह स्कैन का झुकाव ख़ुद पहचान लेता है?",
      },
      a: {
        en: "Not yet — you set the angle by eye (start with ±1–3° and re-run if needed). Automatic skew detection is on the roadmap as its own tool.",
        hi: "अभी नहीं — कोण आँख से तय करें (±1–3° से शुरू करें, ज़रूरत हो तो दोबारा)। ऑटो स्क्यू डिटेक्शन रोडमैप पर अलग टूल के रूप में है।",
      },
    },
  ],
};
