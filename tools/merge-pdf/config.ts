import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Merge PDF (PRD §8.1) — combine 2–50 PDFs into one, on-device.
 *
 * Per-file page ranges, sort buttons and drag-reorder live in the custom
 * panel (tools/merge-pdf/panel.tsx); global options live in the schema
 * below. Deferred to their own rounds (noted in worklog): images-in-merge
 * (composes with the Images-to-PDF tool), per-file bookmarks (needs
 * low-level pdf-lib outline code — VERIFY before building), card-click
 * page-grid expand (PageGrid family round), per-file Unlock (qpdf round).
 */
export const config: ToolConfig = {
  toolId: "merge-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 2,
  maxFiles: 50,
  options: [
    {
      kind: "switch",
      id: "blankBetween",
      label: { en: "Blank page between files", hi: "फ़ाइलों के बीच ख़ाली पेज" },
      hint: {
        en: "Separates each file's pages with one empty page.",
        hi: "हर फ़ाइल के पेजों के बीच एक ख़ाली पेज जोड़ता है।",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "flatten",
      label: { en: "Flatten form fields", hi: "फ़ॉर्म फ़ील्ड फ़्लैटन करें" },
      hint: {
        en: "Best effort: locks filled values into the page. Some complex forms may keep their fields.",
        hi: "बेस्ट-एफ़र्ट: भरे हुए मान पेज में स्थिर हो जाते हैं। कुछ जटिल फ़ॉर्म फ़ील्ड बने रह सकते हैं।",
      },
      default: false,
    },
    {
      kind: "text",
      id: "outputName",
      label: { en: "Output name", hi: "आउटपुट का नाम" },
      placeholder: {
        en: "auto: <first file>-merged.pdf",
        hi: "ऑटो: <पहली फ़ाइल>-merged.pdf",
      },
      default: "",
    },
  ],
  features: [
    {
      en: "Combine up to 50 PDFs — drag, sort A→Z or by date, or use the arrow buttons.",
      hi: "50 तक PDF जोड़ें — खींचकर, A→Z या तारीख़ से क्रम लगाएँ, या तीर बटन इस्तेमाल करें।",
    },
    {
      en: "Pick pages per file (like 1-3, 5) so only what you need gets merged.",
      hi: "हर फ़ाइल के लिए पेज चुनें (जैसे 1-3, 5) — सिर्फ़ ज़रूरी पेज जुड़ेंगे।",
    },
    {
      en: "Optional blank page between files and one-click form flattening.",
      hi: "फ़ाइलों के बीच ख़ाली पेज और एक क्लिक में फ़ॉर्म फ़्लैटन का विकल्प।",
    },
    {
      en: "Everything happens on your device — even 100-page merges stay private.",
      hi: "सब कुछ आपके डिवाइस पर होता है — 100 पेज का मर्ज भी प्राइवेट रहता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is there a file-size limit for merging?",
        hi: "मर्ज करने के लिए फ़ाइल साइज़ की सीमा क्या है?",
      },
      a: {
        en: "Up to 50 PDFs, within the device limit (200 MB per file on desktop, 50 MB on mobile). Very large sets can hit phone memory limits — merge in batches if needed.",
        hi: "50 तक PDF, डिवाइस सीमा के भीतर (डेस्कटॉप पर 200 MB, मोबाइल पर 50 MB प्रति फ़ाइल)। बहुत बड़े सेट फ़ोन की मेमोरी सीमा छू सकते हैं — ज़रूरत पड़ने पर बैच में मर्ज करें।",
      },
    },
    {
      q: {
        en: "Can I merge only some pages of a file?",
        hi: "क्या किसी फ़ाइल के सिर्फ़ कुछ पेज मर्ज कर सकते हैं?",
      },
      a: {
        en: "Yes. In the options, each file has a Pages box — type ranges like 1-3, 5. Leave it empty to include the whole file.",
        hi: "हाँ। विकल्पों में हर फ़ाइल के लिए पेज बॉक्स है — 1-3, 5 जैसी रेंज लिखें। पूरी फ़ाइल शामिल करने के लिए ख़ाली छोड़ें।",
      },
    },
    {
      q: {
        en: "Do bookmarks and links survive the merge?",
        hi: "क्या बुकमार्क और लिंक मर्ज के बाद बचे रहते हैं?",
      },
      a: {
        en: "Page content, links and form fields carry over. Document-level bookmarks don't yet — that's on the roadmap along with a bookmark editor.",
        hi: "पेज कंटेंट, लिंक और फ़ॉर्म फ़ील्ड आ जाते हैं। दस्तावेज़-स्तर के बुकमार्क अभी नहीं — यह बुकमार्क एडिटर के साथ रोडमैप पर है।",
      },
    },
  ],
};
