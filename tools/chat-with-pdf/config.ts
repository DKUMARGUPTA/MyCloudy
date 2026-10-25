import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Chat with PDF (R8) — ask the document anything. Smallpdf keeps this
 * behind a premium paywall; DocoPDF ships it free.
 *
 * The FIRST (and only) DocoPDF tool with a server round-trip, and the
 * shape is the honest minimum: the PDF itself is extracted in a Web
 * Worker on the device; only a bounded, page-marked TEXT excerpt plus
 * the visible chat history ever POST to /api/chat. There is no run step
 * and no output file — like view-pdf, the workspace surface IS the tool
 * (viewerOnly), so the shell never builds a Run CTA.
 */
export const config: ToolConfig = {
  toolId: "chat-with-pdf",
  viewerOnly: true,
  landingSurface: true,
  howKeys: ["chat.how1", "chat.how2", "chat.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Ask anything about your PDF — summaries, key points, dates, numbers, explanations — with page citations like (p. 3) for every claim.",
      hi: "अपनी PDF के बारे में कुछ भी पूछें — सारांश, मुख्य बातें, तारीख़ें, आँकड़े, समझाना — हर जवाब के साथ पेज का हवाला जैसे (p. 3)।",
    },
    {
      en: "The AI answers only from your document and says so when something is not in it — no invented facts.",
      hi: "AI सिर्फ़ आपके दस्तावेज़ से जवाब देता है, और जो चीज़ नहीं है उसे साफ़ बता देता है — कोई बनावटी जवाब नहीं।",
    },
    {
      en: "Your file never leaves the device: text is extracted on your device and only that bounded excerpt is sent for the AI — never the PDF bytes.",
      hi: "आपकी फ़ाइल डिवाइस से बाहर नहीं जाती: टेक्स्ट आपके डिवाइस पर निकलता है और सिर्फ़ वही सीमित अंश AI के पास जाता है — PDF बाइट्स कभी नहीं।",
    },
    {
      en: "Works in English and Hindi — ask in Hindi, get Hindi answers.",
      hi: "अंग्रेज़ी और हिंदी दोनों में काम करता है — हिंदी में पूछिए, हिंदी में जवाब मिलेगा।",
    },
    {
      en: "Long documents stay honest: the middle is left out with a visible marker, and the AI says which pages it could not see.",
      hi: "लंबे दस्तावेज़ ईमानदार रहते हैं: बीच का हिस्सा साफ़ चिह्न के साथ छोड़ा जाता है, और AI बताता है कि कौन से पेज उसे नहीं दिखे।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is my PDF uploaded anywhere?",
        hi: "क्या मेरी PDF कहीं अपलोड होती है?",
      },
      a: {
        en: "No. The file is opened in your browser and its text is extracted on your device. Only that extracted text — trimmed to a bounded, page-marked excerpt — is sent to the AI to answer you. The PDF bytes themselves never leave your device, and nothing is stored on the server.",
        hi: "नहीं। फ़ाइल आपके ब्राउज़र में खुलती है और उसका टेक्स्ट आपके डिवाइस पर निकलता है। सिर्फ़ वही निकला टेक्स्ट — एक सीमित, पेज-चिह्नित अंश — AI के पास जवाब के लिए जाता है। PDF बाइट्स कभी डिवाइस से बाहर नहीं जातीं, और सर्वर पर कुछ भी सेव नहीं होता।",
      },
    },
    {
      q: {
        en: "Why does it say some pages were omitted?",
        hi: "यह क्यों कहता है कि कुछ पेज छोड़ दिए गए?",
      },
      a: {
        en: "The AI works within a context window. For very long documents DocoPDF sends the first pages, the last pages and an honest marker in between — and the AI is instructed to tell you when an answer would need the omitted middle.",
        hi: "AI एक निश्चित संदर्भ सीमा में काम करता है। बहुत लंबे दस्तावेज़ों में DocoPDF पहले पेज, आख़िरी पेज और बीच में एक ईमानदार चिह्न भेजता है — और AI को निर्देश है कि जब जवाब छोड़े हुए हिस्से की ज़रूरत हो तो वह साफ़ बता दे।",
      },
    },
    {
      q: {
        en: "My PDF is a scan and chat says there is no text — what now?",
        hi: "मेरी PDF स्कैन है और चैट कहती है टेक्स्ट नहीं है — अब क्या?",
      },
      a: {
        en: "Scanned pages are images, so there is nothing to extract. Use the one-tap button in the tool to open the same file in PDF OCR, recognize the text (English and Hindi), then chat about the result.",
        hi: "स्कैन किए पेज तस्वीर होते हैं, निकालने के लिए कुछ नहीं होता। टूल में दिए एक-टैप बटन से वही फ़ाइल PDF OCR में खोलें, टेक्स्ट पहचानें (अंग्रेज़ी और हिंदी), फिर उस पर बात करें।",
      },
    },
    {
      q: {
        en: "Are the AI answers guaranteed to be right?",
        hi: "क्या AI के जवाब हमेशा सही होते हैं?",
      },
      a: {
        en: "No AI is perfect. DocoPDF's model answers only from your document and cites pages, which keeps answers checkable — but you should still verify important claims against the cited page before relying on them.",
        hi: "कोई भी AI परफ़ेक्ट नहीं है। DocoPDF का मॉडल सिर्फ़ आपके दस्तावेज़ से जवाब देता है और पेज बताता है, जिससे जवाब जाँचे जा सकते हैं — फिर भी ज़रूरी बातों को भरोसा करने से पहले बताए पेज पर देख लें।",
      },
    },
  ],
};
