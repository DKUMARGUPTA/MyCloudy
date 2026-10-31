import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * View PDF metadata (PHASE-1 Batch B): read every document fact —
 * title, author, dates, producer, page count, PDF version, file size,
 * encryption state, XMP presence — and hand it back as a tidy text
 * report you can copy or download. Read-only: the PDF is never
 * rewritten.
 */
export const config: ToolConfig = {
  toolId: "view-metadata",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 20,
  options: [],
  chainToolIds: ["remove-pdf-metadata", "change-pdf-doc-info", "sanitize-pdf"],
  features: [
    {
      en: "Every /Info field: title, author, subject, keywords, dates, producer, creator.",
      hi: "हर /Info फ़ील्ड: शीर्षक, लेखक, विषय, कीवर्ड, तारीख़ें, प्रोड्यूसर, क्रिएटर।",
    },
    {
      en: "Document facts: page count, PDF version, file size, encryption, XMP presence.",
      hi: "दस्तावेज़ तथ्य: पेज संख्या, PDF वर्ज़न, फ़ाइल साइज़, एन्क्रिप्शन, XMP मौजूदगी।",
    },
    {
      en: "Batch: report up to 20 files in one run, one report each.",
      hi: "बैच: एक बार में 20 तक फ़ाइलों की रिपोर्ट, हर एक की अपनी।",
    },
    {
      en: "Read-only — your PDF is parsed, never rewritten or uploaded.",
      hi: "सिर्फ़ पढ़ना — आपकी PDF पढ़ी जाती है, कभी दोबारा लिखी या अपलोड नहीं।",
    },
    {
      en: "Download or copy the report as plain text.",
      hi: "रिपोर्ट सादे टेक्स्ट में डाउनलोड या कॉपी करें।",
    },
  ],
  faq: [
    {
      q: {
        en: "What metadata can a PDF carry?",
        hi: "PDF में कौन-सा मेटाडेटा हो सकता है?",
      },
      a: {
        en: "Two layers: the /Info dictionary (title, author, subject, keywords, creation/modification dates, the software that made it) and XMP — an XML block cameras and Adobe tools write. This report shows both, plus hard facts like page count and version.",
        hi: "दो परतें: /Info डिक्शनरी (शीर्षक, लेखक, विषय, कीवर्ड, बनाने/बदलने की तारीख़ें, बनाने वाला सॉफ़्टवेयर) और XMP — एक XML ब्लॉक जो कैमरे और Adobe टूल लिखते हैं। यह रिपोर्ट दोनों दिखाती है, साथ में पेज संख्या और वर्ज़न जैसे ठोस तथ्य।",
      },
    },
    {
      q: {
        en: "I see fields I want gone — what next?",
        hi: "मुझे कुछ फ़ील्ड हटानी हैं — आगे क्या करूँ?",
      },
      a: {
        en: "Use Remove PDF metadata to strip everything, Change document info to rewrite selected fields, or Sanitize PDF to also pull XMP while removing active content.",
        hi: "सब कुछ मिटाने के लिए PDF मेटाडेटा हटाएँ, चुने फ़ील्ड बदलने के लिए दस्तावेज़ जानकारी बदलें, या XMP सहित सब हटाने के लिए PDF सैनिटाइज़ करें।",
      },
    },
    {
      q: {
        en: "Does viewing metadata change my file?",
        hi: "क्या मेटाडेटा देखने से फ़ाइल बदलती है?",
      },
      a: {
        en: "No — the report is generated in memory and offered as a separate text file. Your PDF is not touched.",
        hi: "नहीं — रिपोर्ट मेमोरी में बनकर अलग टेक्स्ट फ़ाइल के रूप में मिलती है। आपकी PDF नहीं छूई जाती।",
      },
    },
  ],
};
