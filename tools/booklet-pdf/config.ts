import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Booklet PDF — rearrange pages into saddle-stitch booklet order: print
 * double-sided, fold, staple — instant booklet. Extra pages are padded
 * with blanks so the count always fits the fold. 100% on-device
 * own-engine rebuild.
 */
export const config: ToolConfig = {
  toolId: "booklet-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["pages-per-sheet", "merge-pdf", "add-page-numbers"],
  features: [
    {
      en: "Pages come out in fold-and-staple order — one print away from a booklet.",
      hi: "पेज फोल्ड-और-स्टेपल क्रम में — एक प्रिंट में बुकलेट।",
    },
    {
      en: "Missing pages are padded with blanks — any page count works.",
      hi: "कम पेज ख़ाली पेजों से पूरे होते हैं — कोई भी गिनती चलेगी।",
    },
    {
      en: "Page content is preserved byte-exact — only the order changes.",
      hi: "पेज कंटेंट बाइट-एक्ज़ैक्ट बचा रहता है — बस क्रम बदलता है।",
    },
    {
      en: "Print settings are spelled out on the result page — no guessing.",
      hi: "प्रिंट सेटिंग नतीजे के पेज पर लिखी मिलती है — अंदाज़ा नहीं लगाना।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I print the booklet?",
        hi: "बुकलेट कैसे प्रिंट करें?",
      },
      a: {
        en: "Print double-sided with “2 pages per sheet” and flip on the SHORT edge. Stack the sheets, fold in the middle, staple — done. The result page repeats these exact settings.",
        hi: "दोतरफ़ा प्रिंट करें, “2 pages per sheet” चुनें और SHORT edge पर फ़्लिप करें। शीट इकट्ठी करके बीच से मोड़ें, स्टेपल करें — बस। नतीजे के पेज पर यही सेटिंग दोबारा लिखी है।",
      },
    },
    {
      q: {
        en: "Why did my document get extra blank pages?",
        hi: "मेरे दस्तावेज़ में अतिरिक्त ख़ाली पेज क्यों आए?",
      },
      a: {
        en: "Booklets need a page count divisible by 4 (each sheet holds 4 booklet pages once folded). Blanks are added at the END so nothing of yours is lost.",
        hi: "बुकलेट के लिए गिनती 4 के गुणज में चाहिए (मुड़ी हुई हर शीट में 4 पेज बनते हैं)। ख़ाली पेज अंत में जुड़ते हैं, ताकि आपकी कोई चीज़ न छूटे।",
      },
    },
    {
      q: {
        en: "Can I make an A5 booklet from A4 pages?",
        hi: "A4 पेजों से A5 बुकलेट बना सकते हैं?",
      },
      a: {
        en: "Yes — the printer does the sizing: keep “2 pages per sheet” on and it scales two pages onto one side. For manual control, run Pages per sheet (N-up) first, then Booklet.",
        hi: "हाँ — साइज़िंग प्रिंटर करता है: “2 pages per sheet” चालू रखें, वह दो पेज एक तरफ़ समा देगा। ख़ुद कंट्रोल करना हो तो पहले 'एक शीट में कई पेज' चलाएँ, फिर बुकलेट।",
      },
    },
  ],
};
