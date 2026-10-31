import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Extract attachments (PHASE-3): pull every file embedded inside a PDF
 * back out — contracts, source sheets, originals the sender tucked in.
 * One output per embedded file.
 */
export const config: ToolConfig = {
  toolId: "extract-attachments",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [],
  features: [
    {
      en: "Pull every embedded file out of the PDF — byte-exact.",
      hi: "PDF के अंदर जुड़ी हर फ़ाइल बाहर निकालें — बिल्कुल वैसी ही।",
    },
    {
      en: "One output per attachment, named the way it was embedded.",
      hi: "हर अटैचमेंट का अपना आउटपुट, वही नाम जो अंदर था।",
    },
    {
      en: "Batch: check up to 5 PDFs in one run.",
      hi: "बैच: एक बार में 5 तक PDF जाँचें।",
    },
    {
      en: "No attachments? You get an honest message, not empty files.",
      hi: "अटैचमेंट नहीं हैं? ईमानदार सूचना मिलेगी, खाली फ़ाइलें नहीं।",
    },
    {
      en: "Runs entirely on your device — nothing is uploaded.",
      hi: "पूरा काम डिवाइस पर — कुछ भी अपलोड नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which PDFs have attachments?",
        hi: "किन PDF में अटैचमेंट होते हैं?",
      },
      a: {
        en: "Any PDF can carry embedded files — look for a paperclip in your viewer. Word-to-PDF exports, signed contracts and evidence bundles often hide their originals inside.",
        hi: "कोई भी PDF अंदर फ़ाइल रख सकती है — व्यूअर में क्लिप आइकन देखें। Word से बनी PDF, हस्ताक्षरित अनुबंध और सबूतों के बंडल अकसर अपनी मूल फ़ाइलें अंदर छुपाते हैं।",
      },
    },
    {
      q: {
        en: "Are the extracted files identical to the originals?",
        hi: "क्या निकली फ़ाइलें मूल जैसी होती हैं?",
      },
      a: {
        en: "Yes — embedded files are stored as exact bytes, and this tool writes them back out untouched.",
        hi: "हाँ — जुड़ी फ़ाइलें असली बाइट्स में रहती हैं, और यह टूल उन्हें जस का तस बाहर लिखता है।",
      },
    },
    {
      q: {
        en: "What if the PDF has no attachments?",
        hi: "अगर PDF में कोई अटैचमेंट न हो?",
      },
      a: {
        en: "The run stops with a clear note — no confusing empty downloads.",
        hi: "चलना साफ़ सूचना के साथ रुकता है — कोई उलझन भरी खाली डाउनलोड नहीं।",
      },
    },
  ],
};
