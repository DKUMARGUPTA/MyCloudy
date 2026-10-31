import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Duplex collate (PHASE-1 Batch C): arrange pages for manual
 * double-sided printing on a printer WITHOUT duplex support — output
 * the odd pages first, then the even pages in REVERSE order, so one
 * flip of the stack prints the backs in perfect alignment.
 */
export const config: ToolConfig = {
  toolId: "duplex-collate",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "mode",
      label: { en: "Arrangement", hi: "इंतज़ाम" },
      choices: [
        {
          value: "manual",
          label: { en: "Odd pages, then even reversed — manual duplex", hi: "विषम पेज, फिर सम उलटे — मैनुअल डुप्लेक्स" },
        },
        {
          value: "odd-even",
          label: { en: "Odd pages, then even in order", hi: "विषम पेज, फिर सम क्रम में" },
        },
        {
          value: "even-odd",
          label: { en: "Even pages, then odd in order", hi: "सम पेज, फिर विषम क्रम में" },
        },
      ],
      default: "manual",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages take part — all, or a range like 1-10",
        hi: "कौन से पेज शामिल हों — सभी, या 1-10 जैसी रेंज",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["pdf-booklet", "pages-per-sheet", "merge-pdf"],
  features: [
    {
      en: "Manual duplex made easy — print once, flip the stack, print again.",
      hi: "मैनुअल डुप्लेक्स आसान — एक बार प्रिंट करें, ढेर पलटें, दोबारा प्रिंट करें।",
    },
    {
      en: "Even pages come out reversed — the flip lands every back on its front.",
      hi: "सम पेज उलटे निकलते हैं — पलटने पर हर पिछला पेज अपने अगले पर ठीक बैठता है।",
    },
    {
      en: "Three arrangements: manual-duplex, odd-then-even, even-then-odd.",
      hi: "तीन इंतज़ाम: मैनुअल-डुप्लेक्स, विषम-फिर-सम, सम-फिर-विषम।",
    },
    {
      en: "Pick a page range — collate just the chapter you're printing.",
      hi: "पेज रेंज चुनें — सिर्फ़ वही अध्याय कोलेट करें जो प्रिंट कर रहे हैं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I print double-sided with this?",
        hi: "इससे दो तरफ़ा प्रिंट कैसे करूँ?",
      },
      a: {
        en: "Choose the default arrangement, print ALL pages, then take the stack as it came out (do NOT reorder), flip it over and put it back in the tray, and print again on the other side of the same stack.",
        hi: "डिफ़ॉल्ट इंतज़ाम चुनकर सारे पेज प्रिंट करें, ढेर जैसा निकला वैसा ही रखें (क्रम मत बदलें), उसे पलटकर ट्रे में वापस रखें, और उसी ढेर की दूसरी तरफ़ दोबारा प्रिंट करें।",
      },
    },
    {
      q: {
        en: "Why are the even pages reversed?",
        hi: "सम पेज उलटे क्यों होते हैं?",
      },
      a: {
        en: "When you flip the printed stack, the last sheet becomes the first — reversed evens land back-to-back with their fronts automatically. That's the whole trick of manual duplex.",
        hi: "जब छपा ढेर पलटते हैं, आख़िरी शीट पहली बन जाती है — उलटे सम पेज अपने-आप अपने अगले पेज के साथ पीठ-से-पीठ बैठ जाते हैं। मैनुअल डुप्लेक्स का पूरा जुगत यही है।",
      },
    },
    {
      q: {
        en: "My printer flips on the long edge — which mode do I use?",
        hi: "मेरा प्रिंटर लंबे किनारे पर पलटता है — कौन सा मोड लूँ?",
      },
      a: {
        en: "That's automatic duplex — you don't need this tool at all; print double-sided directly. This tool is for single-sided printers where YOU flip the paper.",
        hi: "वह ऑटोमैटिक डुप्लेक्स है — आपको यह टूल चाहिए ही नहीं; सीधे दो तरफ़ा प्रिंट करें। यह टूल उन सिंगल-साइड प्रिंटरों के लिए है जहाँ काग़ज़ आप पलटते हैं।",
      },
    },
  ],
};
