import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to Text (PRD §8.6) — every selected page's selectable text, extracted
 * on-device. Flow layout rebuilds paragraphs (gap heuristics + dehyphenation);
 * lines layout keeps the visual line breaks. Page markers optional.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-txt",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["txt-to-pdf", "markdown-to-pdf"],
  options: [
    {
      kind: "select",
      id: "layout",
      label: { en: "Layout", hi: "लेआउट" },
      hint: {
        en: "Flow merges lines into clean paragraphs; lines keeps every break",
        hi: "Flow पैराग्राफ़ बनाता है; lines हर लाइन-ब्रेक रखता है",
      },
      choices: [
        {
          value: "flow",
          label: { en: "Flow — clean paragraphs", hi: "Flow — साफ़ पैराग्राफ़" },
        },
        {
          value: "lines",
          label: { en: "Lines — keep line breaks", hi: "Lines — लाइन-ब्रेक रखें" },
        },
      ],
      default: "flow",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
    {
      kind: "switch",
      id: "pageMarks",
      label: { en: "Mark page breaks", hi: "पेज-ब्रेक चिह्नित करें" },
      hint: {
        en: "Adds ───── Page N ───── between pages when exporting several",
        hi: "कई पेज हों तो बीच में ───── Page N ───── जोड़ता है",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Reading flow rebuilds paragraphs — hyphenated line breaks merge back into words.",
      hi: "Reading flow पैराग्राफ़ बनाता है — टूटे शब्द वापस जुड़ जाते हैं।",
    },
    {
      en: "See the first page's text live in the panel before you run anything.",
      hi: "चलाने से पहले पैराग्राफ़ में पहले पेज का टेक्स्ट दिखता है।",
    },
    {
      en: "Export everything or just “1-3, 7” — optional page markers keep references easy.",
      hi: "सब कुछ या सिर्फ़ “1-3, 7” — चाहें तो पेज नंबर भी साथ रहें।",
    },
    {
      en: "Plain UTF-8 .txt — opens everywhere, from editors to spreadsheets.",
      hi: "सादा UTF-8 .txt — एडिटर से लेकर स्प्रेडशीट तक हर जगह चलता है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: { en: "What is the difference between Flow and Lines?", hi: "Flow और Lines में क्या फ़र्क़ है?" },
      a: {
        en: "Flow joins lines into paragraphs, so text reads like an article and reflows in any editor. Lines keeps each visual line exactly where it was — better for forms, tables and code.",
        hi: "Flow लाइनों को पैराग्राफ़ में जोड़ता है, इसलिए टेक्स्ट लेख जैसा पढ़ता है। Lines हर लाइन वैसी ही रखता है — फ़ॉर्म, टेबल और कोड के लिए बेहतर।",
      },
    },
    {
      q: { en: "My PDF is a scan — why is the result empty?", hi: "मेरी PDF स्कैन है — नतीजा खाली क्यों?" },
      a: {
        en: "Scanned pages are images; there is no text to select. DocoPDF tells you this instead of saving an empty file. OCR for scans is planned for a later phase.",
        hi: "स्कैन किए पेज तस्वीर होते हैं; उनमें चुनने लायक़ टेक्स्ट नहीं होता। DocoPDF खाली फ़ाइल की जगह साफ़ बता देता है। स्कैन के लिए OCR बाद के चरण में आएगा।",
      },
    },
    {
      q: { en: "Does it keep Hindi text?", hi: "हिंदी टेक्स्ट सही रहता है?" },
      a: {
        en: "Yes — extraction is Unicode-aware, so Devanagari and other scripts come out exactly as they appear, in UTF-8.",
        hi: "हाँ — निकासना Unicode-aware है, देवनागरी और बाक़ी लिपियाँ UTF-8 में जस की तस निकलती हैं।",
      },
    },
  ],
};
