import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Summarize PDF (R11, tool #100) — one-tap structured TL;DR with page
 * citations, free (Smallpdf/IlovePDF keep this premium). The third
 * DocoPDF tool with a server round-trip, same honest shape as chat and
 * translate: text is extracted on-device by the shared chat worker; ONLY
 * the bounded excerpt + option codes ever POST to /api/summarize — never
 * file bytes. Nothing is stored, nothing is logged.
 *
 * Like chat-with-pdf, the workspace surface IS the tool (viewerOnly) —
 * no run step, no output blob from the pipeline; the summary renders
 * on-screen and exports to PDF / Markdown / plain text from the surface.
 */
export const config: ToolConfig = {
  toolId: "summarize-pdf",
  viewerOnly: true,
  landingSurface: true,
  howKeys: ["summarize.how1", "summarize.how2", "summarize.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["chat-with-pdf", "translate-pdf", "ocr-pdf", "view-pdf"],
  features: [
    {
      en: "A structured summary in one tap — TL;DR, key points, action items — with the page citation like (p. 3) behind every claim.",
      hi: "एक टैप में ढाँचे वाला सारांश — TL;DR, मुख्य बातें, करने के काम — हर बात के साथ पेज का हवाला जैसे (p. 3)।",
    },
    {
      en: "Choose the language (English or Hindi) and the depth (brief, standard, detailed) — then regenerate instantly without re-uploading.",
      hi: "भाषा (अंग्रेज़ी या हिन्दी) और गहराई (संक्षिप्त, सामान्य, विस्तृत) चुनिए — फिर बिना दोबारा अपलोड किए तुरंत नया सारांश बनाइए।",
    },
    {
      en: "Download the summary as a clean PDF, Markdown or plain text — perfect for reports, notes and email digests.",
      hi: "सारांश को साफ़ PDF, Markdown या प्लेन टेक्स्ट में डाउनलोड करें — रिपोर्ट, नोट्स और ईमेल के लिए बिल्कुल सही।",
    },
    {
      en: "Your file never leaves the device: text is extracted on your device and only the bounded excerpt is sent for the AI — never the PDF bytes.",
      hi: "आपकी फ़ाइल डिवाइस से बाहर नहीं जाती: टेक्स्ट आपके डिवाइस पर निकलता है और सिर्फ़ वही सीमित अंश AI के पास जाता है — PDF बाइट्स कभी नहीं।",
    },
    {
      en: "The AI summarizes only from your document and cites the page for every claim — no invented facts.",
      hi: "AI सिर्फ़ आपके दस्तावेज़ से सारांश बनाता है और हर बात का पेज बताता है — कोई बनावटी बात नहीं।",
    },
    {
      en: "Scans are detected honestly and pointed to PDF OCR first; very long documents are summarized head+tail with a visible omitted-pages note.",
      hi: "स्कैन ईमानदारी से पहचाने जाते हैं और पहले PDF OCR की ओर भेजे जाते हैं; बहुत लंबे दस्तावेज़ का आगे+पीछे का सारांश बनता है और छोड़े पेजों की सूचनी साफ़ दिखती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is my PDF uploaded anywhere?",
        hi: "क्या मेरी PDF कहीं अपलोड होती है?",
      },
      a: {
        en: "No. The file is opened in your browser and its text is extracted on your device. Only that bounded excerpt — never the PDF itself — is sent for summarization, and nothing is stored on the server.",
        hi: "नहीं। फ़ाइल आपके ब्राउज़र में खुलती है और उसका टेक्स्ट आपके डिवाइस पर निकलता है। सिर्फ़ वही सीमित अंश — PDF कभी नहीं — सारांश के लिए जाता है, और सर्वर पर कुछ सेव नहीं होता।",
      },
    },
    {
      q: {
        en: "What is the difference between brief, standard and detailed?",
        hi: "संक्षिप्त, सामान्य और विस्तृत में क्या फ़र्क़ है?",
      },
      a: {
        en: "Brief is about 120-180 words: TL;DR + key points. Standard (280-420 words) adds a Details section. Detailed (480-750 words) goes deeper into numbers, dates and definitions. All three cite pages.",
        hi: "संक्षिप्त लगभग 120-180 शब्द: TL;DR + मुख्य बातें। सामान्य (280-420 शब्द) में विवरण खंड जुड़ता है। विस्तृत (480-750 शब्द) आँकड़ों, तारीख़ों और परिभाषाओं में गहरा जाता है। तीनों में पेज के हवाले होते हैं।",
      },
    },
    {
      q: {
        en: "How long can the document be?",
        hi: "दस्तावेज़ कितना लंबा हो सकता है?",
      },
      a: {
        en: "Up to 200 pages and about 48,000 characters of text in one run. Longer documents are summarized from the beginning and end, and the file card honestly shows how many middle pages were left out.",
        hi: "एक बार में 200 पेज और लगभग 48,000 अक्षर तक। इससे लंबे दस्तावेज़ का सारांश शुरुआत और अंत से बनता है, और फ़ाइल कार्ड पर साफ़ दिखता है कि बीच के कितने पेज छूटे।",
      },
    },
    {
      q: {
        en: "Can I get the summary in Hindi?",
        hi: "क्या सारांश हिन्दी में मिल सकता है?",
      },
      a: {
        en: "Yes — pick हिन्दी before summarizing and the whole summary (TL;DR, key points, action items, details) is written in Hindi with real Devanagari, including the exported PDF.",
        hi: "हाँ — सारांश बनाने से पहले हिन्दी चुनें और पूरा सारांश (TL;DR, मुख्य बातें, करने के काम, विवरण) हिन्दी में असली देवनागरी के साथ लिखा जाएगा — निर्यात की गई PDF भी।",
      },
    },
  ],
};
