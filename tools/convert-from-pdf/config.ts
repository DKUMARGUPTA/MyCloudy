import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Universal "Convert from PDF" hub (PRD §7.9): drop a PDF, pick a target
 * format, get routed to the exact tool — JPG/PNG/Text convert instantly on
 * the device, Office and web formats carry honest "Soon"/"Server" badges
 * until their phases ship. Viewer-style: no run step, no options; the
 * workspace surface (target grid) IS the product.
 */
export const config: ToolConfig = {
  toolId: "convert-from-pdf",
  viewerOnly: true,
  howKeys: ["convFrom.how1", "convFrom.how2", "convFrom.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "One PDF in, every target out — JPG, PNG, text, WEBP, TIFF, Word, Excel, PowerPoint, HTML, Markdown and more.",
      hi: "एक PDF अंदर, हर टारगेट बाहर — JPG, PNG, टेक्स्ट, WEBP, TIFF, वर्ड, एक्सल, पावरपॉइंट, HTML, मार्कडाउन और भी।",
    },
    {
      en: "JPG, PNG and text extraction run 100% on your device today — instant, offline-capable, never uploaded.",
      hi: "JPG, PNG और टेक्स्ट निकालना आज पूरी तरह डिवाइस पर चलता है — तुरंत, ऑफ़लाइन भी, कभी अपलोड नहीं।",
    },
    {
      en: "Honest badges everywhere: \"Soon\" shows the real roadmap phase; \"Server\" marks the targets that will need server processing.",
      hi: "हर जगह ईमानदार बैज: \"जल्द\" असली रोडमैप चरण दिखाता है; \"सर्वर\" उन टारगेट को मार्क करता है जिन्हें सर्वर चाहिए।",
    },
    {
      en: "Your PDF stays on the device — picking a target hands the very same file over, no re-selection and no upload.",
      hi: "आपकी PDF डिवाइस पर रहती है — टारगेट चुनते ही वही फ़ाइल सौंप दी जाती है, न दोबारा चुनना, न अपलोड।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which targets work today?",
        hi: "आज कौन से टारगेट चलते हैं?",
      },
      a: {
        en: "PDF to JPG, PDF to PNG and PDF to Text are live and fully on-device. Every other target shows its honest roadmap phase — Office exports and web formats arrive later, on the server where noted.",
        hi: "PDF से JPG, PDF से PNG और PDF से टेक्स्ट अभी लाइव हैं और पूरी तरह डिवाइस पर चलते हैं। बाक़ी हर टारगेट अपना ईमानदार रोडमैप चरण दिखाता है — ऑफ़िस एक्सपोर्ट और वेब फ़ॉर्मैट बाद में, जहाँ लिखा है वहाँ सर्वर पर आएँगे।",
      },
    },
    {
      q: {
        en: "Why do Word, Excel and PowerPoint need a server?",
        hi: "वर्ड, एक्सल और पावरपॉइंट को सर्वर क्यों चाहिए?",
      },
      a: {
        en: "Building real, editable Office files from a PDF needs layout and table reconstruction that only server-grade libraries do well. Those tools will ask before uploading and delete your file right after — with the badge, you always know where a job runs.",
        hi: "PDF से असली, एडिट करने लायक़ ऑफ़िस फ़ाइलें बनाने के लिए लेआउट और टेबल की दोबारा रचना चाहिए — यह सिर्फ़ सर्वर-दर्जे की लाइब्रेरी अच्छे से कर पाती हैं। वे टूल अपलोड से पहले पूछेंगे और काम के तुरंत बाद फ़ाइल डिलीट कर देंगे — बैज की वजह से आप हमेशा जानते हैं कि काम कहाँ हो रहा है।",
      },
    },
    {
      q: {
        en: "Is my scanned PDF handled?",
        hi: "क्या मेरी स्कैन की हुई PDF का इंतज़ा� है?",
      },
      a: {
        en: "For JPG, PNG and text, yes — pages render exactly as they are. Scanned pages have no text layer, so text extraction returns little; OCR arrives in a later phase and will be marked clearly when it does.",
        hi: "JPG, PNG और टेक्स्ट के लिए हाँ — पेज जैसे हैं वैसे ही बनते हैं। स्कैन किए पेजों में टेक्स्ट लेयर नहीं होती, इसलिए टेक्स्ट कम निकलता है; OCR बाद के चरण में आएगा और आते समय साफ़ चिह्नित होगा।",
      },
    },
  ],
};
