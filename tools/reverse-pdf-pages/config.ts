import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Reverse PDF pages — one tap flips the whole reading order (last page
 * first). The classic fix for scanners that feed back-to-front and for
 * "read from the end" documents. 100% on-device own-engine rebuild.
 */
export const config: ToolConfig = {
  toolId: "reverse-pdf-pages",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["rotate-pdf-pages", "rearrange-pdf-pages", "merge-pdf"],
  features: [
    {
      en: "One tap reverses the whole document — last page becomes first.",
      hi: "एक टैप में पूरा दस्तावेज़ उल्टा — आख़िरी पेज पहला बन जाता है।",
    },
    {
      en: "Perfect for scanners that feed pages back-to-front.",
      hi: "उल्टी तरफ़ से पन्ने डालने वाले स्कैनर के लिए बिल्कुल सही।",
    },
    {
      en: "Page content is preserved byte-exact — nothing is re-rendered.",
      hi: "पेज कंटेंट बाइट-एक्ज़ैक्ट बचा रहता है — कुछ भी दोबारा रेंडर नहीं होता।",
    },
    {
      en: "Works on huge files — pages are copied, never decoded.",
      hi: "बड़ी फ़ाइलों पर भी — पेज कॉपी होते हैं, डिकोड कभी नहीं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I reverse only part of a document?",
        hi: "क्या दस्तावेज़ का कुछ हिस्सा ही उल्टा कर सकते हैं?",
      },
      a: {
        en: "Not with this tool — it reverses the whole file. For partial reordering, use Rearrange pages, where you drag any page anywhere.",
        hi: "इस टूल से नहीं — यह पूरी फ़ाइल उल्टी करता है। आंशिक क्रम बदलने के लिए पेज क्रम बदलें टूल लें, जहाँ कोई भी पेज कहीं भी खींच सकते हैं।",
      },
    },
    {
      q: {
        en: "Will the output keep my bookmarks?",
        hi: "क्या आउटपुट में बुकमार्क बचे रहेंगे?",
      },
      a: {
        en: "Page content is copied byte-exact, but an outline tree pointing at old positions would mislead, so bookmarks are dropped for honesty — the pages themselves are untouched.",
        hi: "पेज कंटेंट बाइट-एक्ज़ैक्ट कॉपी होता है, पर पुराने स्थानों की ओर इशारा करता आउटलाइन भ्रम पैदा करेगा, इसलिए ईमानदारी से बुकमार्क हटा दिए जाते हैं — पेज खुद अछूते रहते हैं।",
      },
    },
    {
      q: {
        en: "Is the reversed file still a valid PDF?",
        hi: "क्या उल्टी फ़ाइल अब भी वैध PDF है?",
      },
      a: {
        en: "Yes — the file is rebuilt through our own PDF engine with the same structure, so every viewer opens it exactly like the original.",
        hi: "हाँ — फ़ाइल हमारे अपने PDF इंजन से उसी संरचना में बनती है, हर व्यूअर इसे असली जैसे ही खोलता है।",
      },
    },
  ],
};
