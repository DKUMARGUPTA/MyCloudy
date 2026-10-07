import type { ToolConfig } from "@/lib/tools/config-types";
import { getLogoFile } from "./logo-store";

/**
 * Add watermark (PRD §8.2): text or logo stamp on the chosen pages of a
 * single PDF. The custom panel + preview surface own every interactive
 * value (split-tool pattern — schema stays empty, worker defaults
 * defensively); the logo rides the run as an in-memory asset.
 */
export const config: ToolConfig = {
  toolId: "add-watermark",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  collectAssets: () => {
    const logo = getLogoFile();
    return logo ? [logo] : [];
  },
  chainToolIds: ["pdf-to-jpg", "pdf-to-png", "merge-pdf"],
  features: [
    {
      en: "Text or your own logo — with size, color, opacity, rotation and a 9-position grid.",
      hi: "टेक्स्ट या अपना लोगो — आकार, रंग, पारदर्शिता, झुकाव और 9-स्थिति ग्रिड के साथ।",
    },
    {
      en: "Tile mode repeats the mark across the whole page in a diagonal pattern.",
      hi: "टाइल मोड पूरे पेज पर तिरछे नमूने में निशान दोहराता है।",
    },
    {
      en: "Place it over the content, or behind it — real PDF layering, not a picture trick.",
      hi: "कंटेंट के ऊपर या पीछे रखें — असली PDF लेयरिंग, तस्वीर का खेल नहीं।",
    },
    {
      en: "All pages, odd, even, a range, or everything except the first page.",
      hi: "सभी पेज, ऑड, ईवन, कोई रेंज, या पहले के अलावा सब।",
    },
    {
      en: "Live preview shows the exact result before you run anything — on your device only.",
      hi: "लाइव प्रीव्यू चलाने से पहले ही सटीक नतीजा दिखाता है — सब आपके डिवाइस पर।",
    },
    {
      en: "Runs entirely on your device — the PDF and the logo are never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF और लोगो कहीं अपलोड नहीं होते।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I use my company logo?",
        hi: "क्या मैं अपनी कंपनी का लोगो लगा सकता हूँ?",
      },
      a: {
        en: "Yes — switch to “Logo” in the options and pick a PNG or JPG. Other picture formats are converted automatically on your device.",
        hi: "हाँ — विकल्पों में “लोगो” चुनें और PNG या JPG लें। बाक़ी फ़ॉर्मैट डिवाइस पर ही बदल जाते हैं।",
      },
    },
    {
      q: {
        en: "Can the watermark go behind the text?",
        hi: "क्या वॉटरमार्क टेक्स्ट के पीछे रख सकते हैं?",
      },
      a: {
        en: "Turn on “Place behind content”. The mark is moved into the page’s bottom drawing layer, so text and images stay fully readable on top.",
        hi: "“कंटेंट के पीछे रखें” चालू करें। निशान पेज की निचली लेयर में चला जाता है, इसलिए ऊपर का टेक्स्ट पूरा पढ़ने लायक़ रहता है।",
      },
    },
    {
      q: {
        en: "Does it support Hindi watermark text?",
        hi: "हिंदी टेक्स्ट से वॉटरमार्क बनता है?",
      },
      a: {
        en: "Not yet — built-in PDF fonts cover Latin letters and numbers only. Custom Hindi fonts are planned for a later phase, and we tell you honestly instead of saving a broken file.",
        hi: "अभी नहीं — PDF के बिल्ट-इन फ़ॉन्ट सिर्फ़ लैटिन अक्षर-अंक समझते हैं। हिंदी फ़ॉन्ट बाद के चरण में आएँगे; ग़लत फ़ाइल बनाने की जगह हम साफ़ बता देते हैं।",
      },
    },
  ],
};
