import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Ask PDF (chat-with-pdf, P2 / R54) — REBUILT self-dependent: BM25 smart
 * search, 100% on-device. No LLM, no provider, no network — the document
 * is extracted and indexed in a Web Worker in the browser, queries rank
 * passages by classic Okapi BM25, results are exact sentences with page
 * badges and term highlights. Search-grade, honestly named. Smallpdf
 * keeps AI chat behind a premium paywall; DocoPDF ships honest search
 * free. The workspace surface IS the tool (viewerOnly) — no run step,
 * no output file.
 */
export const config: ToolConfig = {
  toolId: "chat-with-pdf",
  viewerOnly: true,
  landingSurface: true,
  howKeys: ["ask.how1", "ask.how2", "ask.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["summarize-pdf", "prepare-pdf-for-ai", "ocr-pdf"],
  features: [
    {
      en: "Instant answers with receipts: every result is an exact sentence from your document, with its page badge — never rewritten, never invented.",
      hi: "प्रमाण के साथ तुरंत जवाब: हर नतीजा आपके दस्तावेज़ का असली वाक्य है, अपने पेज बैज के साथ — दोबारा लिखा नहीं, बनाया नहीं गया।",
    },
    {
      en: "BM25 — the ranking algorithm behind search engines — finds the passages that matter for your question, in milliseconds, entirely in your browser.",
      hi: "BM25 — सर्च इंजनों के पीछे वाला रैंकिंग एल्गोरिद्म — आपके सवाल के लिए ज़रूरी हिस्से मिलीसेकंड में ढूँढता है, पूरा आपके ब्राउज़र में।",
    },
    {
      en: "Search terms light up inside every result, so you see the context around each match — not just a line number.",
      hi: "खोजे गए शब्द हर नतीजे के अंदर उजले होते हैं, ताकि हर मैच के आस-पास का संदर्भ दिखे — सिर्फ़ लाइन नंबर नहीं।",
    },
    {
      en: "Works with English and Hindi (Devanagari) documents — ask in either language, the words find their matches.",
      hi: "अंग्रेज़ी और हिन्दी (देवनागरी) दस्तावेज़ दोनों चलते हैं — किसी भी भाषा में पूछिए, शब्द अपने मैच ढूँढ लेते हैं।",
    },
    {
      en: "Your file never leaves the device: extraction, indexing and search all happen in your browser. Zero uploads, zero API keys, zero accounts.",
      hi: "आपकी फ़ाइल डिवाइस से बाहर नहीं जाती: एक्स्ट्रैक्शन, इंडेक्सिंग और खोज तीनों आपके ब्राउज़र में। न अपलोड, न API की, न अकाउंट।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is this an AI chat?",
        hi: "क्या यह AI चैट है?",
      },
      a: {
        en: "No — and that is the honest part. This is smart search: the BM25 algorithm ranks your document's passages against your question and shows the best matches verbatim. Nothing is generated, so nothing can be hallucinated. For a one-tap digest of the whole file, use Summarize PDF; for feeding the document to an AI stack, use Prepare PDF for AI.",
        hi: "नहीं — और यही ईमानदारी है। यह स्मार्ट सर्च है: BM25 एल्गोरिद्म आपके सवाल के मुक़ाबले दस्तावेज़ के हिस्सों को रैंक करता है और सबसे अच्छे मैच जैसे हैं वैसे दिखाता है। कुछ भी बनाया नहीं जाता, इसलिए बनावटी जवाब का सवाल ही नहीं। पूरी फ़ाइल के झटपट सार के लिए Summarize PDF लें; AI सिस्टम को दस्तावेज़ देने के लिए Prepare PDF for AI।",
      },
    },
    {
      q: {
        en: "How should I phrase my search?",
        hi: "खोज कैसे लिखूँ?",
      },
      a: {
        en: "Use the exact words you expect in the document — names, dates, amounts, technical terms. BM25 rewards word matches, so \"GST rate FY 2024\" beats \"what are the taxes\". Common filler words in English and Hindi are ignored automatically.",
        hi: "वही शब्द लिखिए जो दस्तावेज़ में मिलने की उम्मीद है — नाम, तारीख़ें, रक़म, तकनीकी शब्द। BM25 शब्द-मैच पर काम करता है, इसलिए \"GST दर 2024\" बेहतर है \"कौन से टैक्स हैं\" से। अंग्रेज़ी और हिन्दी के आम जोड़ने वाले शब्द अपने आप छोड़ दिए जाते हैं।",
      },
    },
    {
      q: {
        en: "My scanned PDF says no text — what now?",
        hi: "मेरी स्कैन PDF में टेक्स्ट नहीं बताता — अब क्या?",
      },
      a: {
        en: "Scanned pages are images, so there are no words to search. The tool detects this honestly and points you to PDF OCR — recognize the text first, then search the result here.",
        hi: "स्कैन किए पेज तस्वीरें हैं, खोजने को शब्द नहीं होते। यह टूल यह ईमानदारी से पकड़ता है और आपको PDF OCR की ओर भेजता है — पहले टेक्स्ट पहचानिए, फिर उसी नतीजे को यहाँ खोजिए।",
      },
    },
  ],
};
