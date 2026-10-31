import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Prepare PDF for AI (PHASE-2): export the document as a LlamaIndex-ready
 * JSON — one text document per page (or one for the whole file), each
 * carrying clean metadata. Feed the file straight to LlamaIndex's
 * JSONReader and your RAG pipeline is ready.
 */
export const config: ToolConfig = {
  toolId: "prepare-pdf-for-ai",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "granularity",
      label: { en: "Granularity", hi: "विभाजन" },
      hint: {
        en: "One document per page (best retrieval) or one for the whole file",
        hi: "हर पेज एक दस्तावेज़ (बेहतर रिट्रीवल) या पूरी फ़ाइल का एक",
      },
      choices: [
        { value: "page", label: { en: "Per page", hi: "प्रति पेज" } },
        { value: "document", label: { en: "Whole document", hi: "पूरा दस्तावेज़" } },
      ],
      default: "page",
    },
    {
      kind: "switch",
      id: "includeMetadata",
      label: { en: "Include document metadata", hi: "दस्तावेज़ मेटाडेटा शामिल करें" },
      hint: {
        en: "Title, author, dates ride every chunk's metadata",
        hi: "शीर्षक, लेखक, तारीख़ें हर चंक के मेटाडेटा में",
      },
      default: true,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["pdf-to-markdown", "pdf-to-txt", "search-pdf"],
  features: [
    {
      en: "LlamaIndex-ready JSON — one { text, metadata } document per page.",
      hi: "LlamaIndex-तैयार JSON — हर पेज का एक { text, metadata } दस्तावेज़।",
    },
    {
      en: "Per-page or whole-document granularity — pick what your pipeline wants.",
      hi: "प्रति-पेज या पूरे-दस्तावेज़ विभाजन — अपनी पाइपलाइन जो माँगे।",
    },
    {
      en: "Clean metadata on every chunk: file, page id, totals, title, author.",
      hi: "हर चंक पर साफ़ मेटाडेटा: फ़ाइल, पेज आईडी, कुल संख्या, शीर्षक, लेखक।",
    },
    {
      en: "Flow-layout text extraction — paragraphs keep their reading order.",
      hi: "फ़्लो-लेआउट टेक्स्ट निकासी — पैराग्राफ पढ़ने का क्रम रखते हैं।",
    },
    {
      en: "Runs entirely on your device — the document never leaves for “AI”.",
      hi: "पूरा काम डिवाइस पर — दस्तावेज़ “AI” के लिए कहीं नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I use the output with LlamaIndex?",
        hi: "नतीजे को LlamaIndex के साथ कैसे इस्तेमाल करूँ?",
      },
      a: {
        en: "Point LlamaIndex's JSONReader at the downloaded file: each array entry loads as a Document with text and metadata already set — no PDF parser, no layout guessing, straight into your index.",
        hi: "LlamaIndex के JSONReader को डाउनलोड की फ़ाइल पर लगाएँ: ऐरे की हर एंट्री Document बन जाती है — text और metadata पहले से सेट, बिना PDF पार्सर, बिना लेआउट अंदाज़ा, सीधे आपके इंडेक्स में।",
      },
    },
    {
      q: {
        en: "Does this send my PDF to an AI service?",
        hi: "क्या यह मेरी PDF किसी AI सेवा को भेजता है?",
      },
      a: {
        en: "Never. The tool only extracts and structures the text ON YOUR DEVICE. What you do with the JSON afterwards — which LLM, which cloud — is entirely your choice.",
        hi: "कभी नहीं। टूल सिर्फ़ टेक्स्ट निकालकर ढाँचे में रखता है, आपके डिवाइस पर। JSON के आगे क्या करते हैं — कौन-सा LLM, कौन-सा क्लाउड — वह पूरी तरह आपका फ़ैसला है।",
      },
    },
    {
      q: {
        en: "What about scanned PDFs?",
        hi: "स्कैन की PDF का क्या?",
      },
      a: {
        en: "Scanned pages have no selectable text, so their documents come out empty with page metadata intact. Run the OCR tool first, then prepare for AI on the OCR'd copy.",
        hi: "स्कैन पेजों में चुनने योग्य टेक्स्ट नहीं होता, इसलिए उनके दस्तावेज़ खाली निकलते हैं — पेज मेटाडेटा सही रहता है। पहले OCR टूल चलाएँ, फिर OCR वाली कॉपी से तैयार करें।",
      },
    },
  ],
};
