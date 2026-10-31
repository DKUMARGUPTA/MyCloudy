import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Reverse PDF pages (PHASE-1 Batch A): flip the reading order of every
 * page — last page first. Batch-capable (up to 20 PDFs, one output per
 * input) for scanned stacks read back-to-front.
 *
 * Schema-driven (no custom surface): no options, the run always reverses
 * the WHOLE document. The shared worker rebuilds each file from the
 * reversed page plan on OUR OWN engine — no re-rendering, content stays
 * byte-exact.
 */
export const config: ToolConfig = {
  toolId: "reverse-pages",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 20,
  options: [],
  chainToolIds: ["rotate-pdf-pages", "rearrange-pdf-pages", "merge-pdf"],
  features: [
    {
      en: "Flip the whole document — the last page becomes page 1.",
      hi: "पूरा दस्तावेज़ पलटें — आख़िरी पेज पहला पेज बन जाता है।",
    },
    {
      en: "Batch: reverse up to 20 PDFs in one run, one output each.",
      hi: "बैच: एक बार में 20 तक PDF पलटें, हर एक का अपना आउटपुट।",
    },
    {
      en: "Text, images and vectors are untouched — only the page order changes.",
      hi: "टेक्स्ट, तस्वीरें और वेक्टर जस के तस रहते हैं — सिर्फ़ क्रम बदलता है।",
    },
    {
      en: "Perfect for back-to-front scans and reversed fax stacks.",
      hi: "उल्टे स्कैन और उल्टे फ़ैक्स ढेर के लिए बिल्कुल सही।",
    },
    {
      en: "Runs entirely on your device — files never leave your browser.",
      hi: "पूरा काम आपके डिवाइस पर — फ़ाइलें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does reversing re-encode my PDF?",
        hi: "क्या पलटने से मेरी PDF दोबारा एनकोड होती है?",
      },
      a: {
        en: "No. The pages are copied in reverse order with their content untouched — nothing is re-compressed or re-rendered, so quality is exactly the same.",
        hi: "नहीं। पेज उलटे क्रम में कॉपी होते हैं, उनकी सामग्री जस की तस रहती है — कुछ भी दोबारा कंप्रेस या रेंडर नहीं होता, क्वालिटी बिल्कुल वही रहती है।",
      },
    },
    {
      q: {
        en: "Can I reverse only part of a document?",
        hi: "क्या सिर्फ़ आधे दस्तावेज़ के पेज पलट सकते हैं?",
      },
      a: {
        en: "This tool reverses the whole file. For partial reordering — moving or flipping just some pages — use the Organize tool, which gives you a live page grid with drag, delete and duplicate.",
        hi: "यह टूल पूरी फ़ाइल पलटता है। आधे-अधूरे क्रम बदलने के लिए — सिर्फ़ कुछ पेज हिलाने या पलटने के लिए — Organize टूल इस्तेमाल करें, जिसमें खींचने, हटाने और डुप्लिकेट करने वाली लाइव पेज-ग्रिड मिलती है।",
      },
    },
    {
      q: {
        en: "Are my files uploaded anywhere?",
        hi: "क्या मेरी फ़ाइलें कहीं अपलोड होती हैं?",
      },
      a: {
        en: "No. This tool runs entirely in your browser with Web Workers. There is no server involved, so the file physically cannot leave your device.",
        hi: "नहीं। यह टूल पूरी तरह आपके ब्राउज़र में Web Workers से चलता है। कोई सर्वर शामिल नहीं है, इसलिए फ़ाइल आपके डिवाइस से बाहर जा ही नहीं सकती।",
      },
    },
  ],
};
