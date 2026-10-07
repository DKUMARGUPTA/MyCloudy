import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Crop PDF (PRD §8.2): visual crop box drag with before/after preview,
 * numeric margins in pt/mm/in, auto-detect content edges, and page
 * targeting (all / odd / even / skip first / range). Custom panel + drag
 * surface own every interactive value (split-tool pattern — schema stays
 * empty, worker defaults defensively).
 */
export const config: ToolConfig = {
  toolId: "crop-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["pdf-to-jpg", "pdf-to-png", "add-watermark", "merge-pdf"],
  features: [
    {
      en: "Drag a crop box directly on the page — 8 handles, rule-of-thirds guides, live size label.",
      hi: "पेज पर सीधे क्रॉप बॉक्स खींचें — 8 हैंडल, थर्ड्स गाइड, लाइव साइज़ लेबल।",
    },
    {
      en: "Prefer numbers? Type exact margins in points, millimetres or inches.",
      hi: "नंबर पसंद हैं? पॉइंट, मिलीमीटर या इंच में सटीक मार्जिन लिखें।",
    },
    {
      en: "Auto-detect finds the content on the page and snaps the box to it.",
      hi: "ऑटो-डिटेक्ट पेज का कंटेंट ढूँढ़कर बॉक्स वहीं सेट कर देता है।",
    },
    {
      en: "Before / after preview shows exactly how the cropped page will look.",
      hi: "पहले / बाद प्रीव्यू में क्रॉप के बाद पेज ठीक वैसा ही दिखता है।",
    },
    {
      en: "Apply to all pages, odd or even, skip the first, or any range — rotated pages included.",
      hi: "सभी पेज, विषम या सम, पहला छोड़कर या कोई रेंज — घुमे हुए पेज भी।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is the content outside the crop box deleted?",
        hi: "क्या क्रॉप बॉक्स के बाहर का कंटेंट मिट जाता है?",
      },
      a: {
        en: "Cropping sets the PDF's CropBox — the area outside is no longer shown on screen or printed, but the data stays in the file. If you need it truly gone, rasterize the cropped result later.",
        hi: "क्रॉप करने से PDF का CropBox सेट होता है — बाहर का हिस्सा स्क्रीन या प्रिंट में नहीं दिखता, पर डेटा फ़ाइल में रहता है। उसे पूरी तरह हटाना हो तो बाद में क्रॉप रिज़ल्ट रास्टराइज़ करें।",
      },
    },
    {
      q: {
        en: "What does auto-detect do?",
        hi: "ऑटो-डिटेक्ट क्या करता है?",
      },
      a: {
        en: "It scans the page you are previewing, finds the edges of the actual content, and snaps the crop box to it with a small breathing gap of about 6 points.",
        hi: "यह जिस पेज का प्रीव्यू देख रहे हैं उसे स्कैन करके असली कंटेंट किनारे ढूँढता है और लगभग 6 पॉइंट का गैप छोड़कर बॉक्स वहीं सेट कर देता है।",
      },
    },
    {
      q: {
        en: "Do the margins apply the same to every page?",
        hi: "क्या मार्जिन हर पेज पर एक जैसे लगते हैं?",
      },
      a: {
        en: "Yes — the same distance from each page's own edges. Pages smaller than the margins are clamped safely, and pages rotated 90°, 180° or 270° are handled correctly.",
        hi: "हाँ — हर पेज के अपने किनारों से उतनी ही दूरी। मार्जिन से छोटे पेज सुरक्षित रूप से एडजस्ट हो जाते हैं, और 90°, 180° या 270° घुमे पेज भी सही हैंडल होते हैं।",
      },
    },
  ],
};
