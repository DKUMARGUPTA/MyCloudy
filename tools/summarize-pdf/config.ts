import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Summarize PDF (P2 / R54) — REBUILT self-dependent: TextRank extractive
 * summarization 100% on-device. No LLM, no provider, no network — the
 * sentences in the summary are verbatim from the document, ranked by an
 * unsupervised graph algorithm, each with its page citation. Standard run
 * pipeline: upload → length/format → run → Markdown/TXT report.
 */
export const config: ToolConfig = {
  toolId: "summarize-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "length",
      label: { en: "Summary depth", hi: "सारांश की गहराई" },
      hint: {
        en: "How many of the top-ranked sentences to include — from a quick TL;DR to a detailed digest.",
        hi: "टॉप-रैंक वाक्यों में से कितने लेने हैं — झटपट TL;DR से लेकर विस्तृत सार तक।",
      },
      choices: [
        { value: "brief", label: { en: "Brief — quick TL;DR", hi: "संक्षिप्त — झटपट TL;DR" } },
        { value: "standard", label: { en: "Standard — balanced", hi: "सामान्य — संतुलित" } },
        { value: "detailed", label: { en: "Detailed — full digest", hi: "विस्तृत — पूरा सार" } },
      ],
      default: "standard",
    },
    {
      kind: "select",
      id: "format",
      label: { en: "Report format", hi: "रिपोर्ट फ़ॉर्मैट" },
      hint: {
        en: "Markdown keeps the headings and emphasis; plain text pastes anywhere.",
        hi: "Markdown में हेडिंग और ज़ोर बने रहते हैं; प्लेन टेक्स्ट कहीं भी पेस्ट हो जाता है।",
      },
      choices: [
        { value: "md", label: { en: "Markdown (.md)", hi: "Markdown (.md)" } },
        { value: "txt", label: { en: "Plain text (.txt)", hi: "प्लेन टेक्स्ट (.txt)" } },
      ],
      default: "md",
    },
  ],
  chainToolIds: ["chat-with-pdf", "prepare-pdf-for-ai", "pdf-to-txt"],
  features: [
    {
      en: "A real summary in one tap — TL;DR plus key points, every sentence lifted verbatim from your document with its page citation like (p. 3).",
      hi: "एक टैप में असली सारांश — TL;DR और मुख्य बातें, हर वाक्य आपके दस्तावेज़ से जैसा है वैसा ही, अपने पेज हवाले जैसे (p. 3) के साथ।",
    },
    {
      en: "TextRank ranking — the same unsupervised graph algorithm search engines use for extractive summarization — running entirely in your browser. No AI service, no account, no upload.",
      hi: "TextRank रैंकिंग — वही अनसुपरवाइज़्ड ग्राफ़ एल्गोरिद्म जो सर्च इंजन एक्स्ट्रैक्टिव सारांश के लिए इस्तेमाल करते हैं — पूरा आपके ब्राउज़र में। न कोई AI सर्विस, न अकाउंट, न अपलोड।",
    },
    {
      en: "Three depths — brief for a quick TL;DR, standard for a balanced digest, detailed when you need the whole shape of the document.",
      hi: "तीन गहराई — झटपट TL;DR के लिए संक्षिप्त, संतुलित सार के लिए सामान्य, और पूरी जानकारी चाहिए तो विस्तृत।",
    },
    {
      en: "Works with English and Hindi (Devanagari) documents — sentence boundaries and stopwords understand both scripts.",
      hi: "अंग्रेज़ी और हिन्दी (देवनागरी) दस्तावेज़ दोनों चलते हैं — वाक्य की सीमा और स्टॉपवर्ड दोनों लिपियाँ समझते हैं।",
    },
    {
      en: "Download as clean Markdown or plain text — ready for notes, reports and email digests. Your file never leaves the device.",
      hi: "साफ़ Markdown या प्लेन टेक्स्ट में डाउनलोड — नोट्स, रिपोर्ट और ईमेल के लिए तैयार। आपकी फ़ाइल डिवाइस से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is this an AI summary?",
        hi: "क्या यह AI सारांश है?",
      },
      a: {
        en: "It is an extractive summary, and we say so plainly: an algorithm (TextRank) scores every sentence by how central it is to the document, then picks the best ones — verbatim. Nothing is rewritten, paraphrased or invented. That also means it works fully offline, free and private.",
        hi: "यह एक्स्ट्रैक्टिव सारांश है, और हम साफ़ कहते हैं: एक एल्गोरिद्म (TextRank) हर वाक्य को दस्तावेज़ में उसकी ज़रूरत के हिसाब से अंक देता है और सबसे अच्छे वाक्य चुनता है — जैसे हैं वैसे ही। कुछ दोबारा लिखा या बनाया नहीं जाता। इसी से यह पूरी तरह ऑफ़लाइन, मुफ़्त और निजी चलता है।",
      },
    },
    {
      q: {
        en: "How are the sentences picked?",
        hi: "वाक्य कैसे चुने जाते हैं?",
      },
      a: {
        en: "TextRank builds a graph where two sentences connect when they share meaningful words, then runs power iteration (like PageRank for sentences). The sentences most connected to the rest of the document rise to the top. Reading order is restored afterwards, so the summary reads naturally.",
        hi: "TextRank एक ग्राफ़ बनाता है जहाँ दो वाक्य जुड़ते हैं जब उनमें सार्थक शब्द साझा हों, फिर पावर इटरेशन चलाता है (वाक्यों के लिए PageRank जैसा)। जो वाक्य दस्तावेज़ से सबसे जुड़े होते हैं वे ऊपर आते हैं। बाद में पढ़ने का क्रम वापस लग जाता है, ताकि सारांश सहज पढ़ा जाए।",
      },
    },
    {
      q: {
        en: "My scanned PDF fails — why?",
        hi: "मेरी स्कैन की PDF असफल हो जाती है — क्यों?",
      },
      a: {
        en: "Scanned pages are images with no selectable text, so there is nothing to rank. Run the file through PDF OCR first, then summarize the OCR result. The tool refuses honestly instead of shipping an empty summary.",
        hi: "स्कैन किए पेज तस्वीरें हैं, उनमें चुनने लायक़ टेक्स्ट नहीं होता, रैंक करने को कुछ नहीं मिलता। पहले फ़ाइल को PDF OCR से निकालिए, फिर उसी नतीजे का सारांश बनाइए। यह टूल ख़ाली सारांश देने के बजाय ईमानदारी से मना करता है।",
      },
    },
  ],
};
