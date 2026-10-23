import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Universal "Convert from PDF" hub (PRD §7.9): drop a PDF, pick a target
 * format, get routed to the exact tool — all twelve targets (JPG, PNG, WEBP,
 * TIFF, SVG, text, Word, Excel, PowerPoint, HTML, Markdown, ODT) are live
 * and convert entirely on the device. Viewer-style: no run step, no
 * options; the workspace surface (target grid) IS the product.
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
      en: "One PDF in, every target out — JPG, PNG, WEBP, TIFF, SVG, text, Word, Excel, PowerPoint, HTML, Markdown and ODT.",
      hi: "एक PDF अंदर, हर टारगेट बाहर — JPG, PNG, WEBP, TIFF, SVG, टेक्स्ट, वर्ड, एक्सल, पावरपॉइंट, HTML, मार्कडाउन और ODT।",
    },
    {
      en: "Everything runs 100% on your device — instant, offline-capable, never uploaded.",
      hi: "सब कुछ 100% आपके डिवाइस पर चलता है — तुरंत, ऑफ़लाइन भी, कभी अपलोड नहीं।",
    },
    {
      en: "Every target is live today — the on-device badge is the honest contract: no servers, nothing waiting for a later phase.",
      hi: "हर टारगेट आज लाइव है — डिवाइस-पर बैज सच्चा वादा है: कोई सर्वर नहीं, किसी बाद के चरण का इंतज़ार नहीं।",
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
        en: "All twelve — JPG, PNG, WEBP, TIFF, SVG, text, Word, Excel, PowerPoint, HTML, Markdown and ODT are live and fully on-device. Nothing here waits for a server or a later phase.",
        hi: "बारहों — JPG, PNG, WEBP, TIFF, SVG, टेक्स्ट, वर्ड, एक्सल, पावरपॉइंट, HTML, मार्कडाउन और ODT सब लाइव हैं और पूरी तरह डिवाइस पर चलते हैं। यहाँ किसी को सर्वर या बाद के चरण का इंतज़ार नहीं करना पड़ता।",
      },
    },
    {
      q: {
        en: "Do the Word, Excel and PowerPoint exports need a server?",
        hi: "क्या वर्ड, एक्सल और पावरपॉइंट एक्सपोर्ट को सर्वर चाहिए?",
      },
      a: {
        en: "No — they're rebuilt right here on your device from the PDF's own text and layout, and they work offline. They're honest rule-based conversions (each tool notes what carries over and what doesn't), not pixel-perfect desktop-Office replicas — but nothing is ever uploaded.",
        hi: "नहीं — वे PDF के अपने टेक्स्ट और लेआउट से यहीं आपके डिवाइस पर बनते हैं और ऑफ़लाइन चलते हैं। ये ईमानदार नियम-आधारित रूपांतरण हैं (हर टूल बताता है क्या आता है, क्या नहीं), पिक्सेल-सटीक डेस्कटॉप-ऑफ़िस प्रतिकृतियाँ नहीं — लेकिन कुछ भी कभी अपलोड नहीं होता।",
      },
    },
    {
      q: {
        en: "Is my scanned PDF handled?",
        hi: "क्या मेरी स्कैन की हुई PDF का इंतज़ाम है?",
      },
      a: {
        en: "Image targets render scanned pages exactly as they are. Scans have no text layer, so text, Office and web exports return little — run the PDF OCR tool on the file first, then convert the recognised version here.",
        hi: "इमेज टारगेट स्कैन किए पेज वैसे ही बनाते हैं जैसे वे हैं। स्कैन में टेक्स्ट लेयर नहीं होती, इसलिए टेक्स्ट, ऑफ़िस और वेब एक्सपोर्ट कम देते हैं — पहले उस फ़ाइल पर PDF OCR टूल चलाएँ, फिर पहचाना हुआ वर्ज़न यहाँ बदलें।",
      },
    },
  ],
};
