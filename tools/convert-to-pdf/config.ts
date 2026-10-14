import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Universal "Convert to PDF" hub (PRD §7.8): drop ANY file, its type is
 * detected from magic bytes, and the surface routes to the right tool —
 * live targets convert instantly on the device, the rest carry honest
 * "Soon"/"Server" badges. A viewer-style tool: no run step, no options —
 * the workspace surface (target grid) IS the product.
 */
export const config: ToolConfig = {
  toolId: "convert-to-pdf",
  viewerOnly: true,
  howKeys: ["conv.how1", "conv.how2", "conv.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Drop literally anything — the type is read from the file's own bytes (magic numbers), never from its name.",
      hi: "कुछ भी डालें — टाइप फ़ाइल के अपने बाइट्स से पहचाना जाता है (मैजिक नंबर), नाम से कभी नहीं।",
    },
    {
      en: "Smart routing: the detected type picks the exact tool for you — JPG, PNG, WEBP, HEIC, GIF, BMP, TIFF, SVG, text, HTML and Office files.",
      hi: "स्मार्ट रूटिंग: पहचाना टाइप सही टूल खुद चुनता है — JPG, PNG, WEBP, HEIC, GIF, BMP, TIFF, SVG, टेक्स्ट, HTML और ऑफ़िस फ़ाइलें।",
    },
    {
      en: "Live targets (images to PDF) convert 100% on your device, instantly — no upload, no queue.",
      hi: "लाइव टारगेट (तस्वीरें → PDF) पूरी तरह आपके डिवाइस पर, तुरंत बदलते हैं — न अपलोड, न क़तार।",
    },
    {
      en: "Honest badges on everything else: \"Soon\" shows the real roadmap phase, \"Server\" marks formats that will need server processing.",
      hi: "बाक़ी सब पर ईमानदार बैज: \"जल्द\" असली रोडमैप चरण दिखाता है, \"सर्वर\" उन फ़ॉर्मैट को मार्क करता है जिन्हें सर्वर चाहिए।",
    },
    {
      en: "Your file stays on the device the whole time it is here — clicking a target hands it over directly, no re-selection.",
      hi: "फ़ाइल यहाँ रहते हुए पूरे समय डिवाइस पर रहती है — टारगेट पर क्लिक करते ही सीधे उसी को सौंप दिया जाता है, दोबारा चुनना नहीं पड़ता।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which files convert today?",
        hi: "आज कौन सी फ़ाइलें बदलती हैं?",
      },
      a: {
        en: "Images — JPG, PNG, WEBP, HEIC, GIF, BMP — go to PDF right now, entirely on your device. Text and Office formats are routed to their tools with an honest \"coming soon\" badge until those phases ship.",
        hi: "तस्वीरें — JPG, PNG, WEBP, HEIC, GIF, BMP — अभी PDF बनती हैं, पूरी तरह डिवाइस पर। टेक्स्ट और ऑफ़िस फ़ॉर्मैट अपने टूल तक जाते हैं, \"जल्द आ रहा है\" के ईमानदार बैज के साथ — जब तक वे चरण आते हैं।",
      },
    },
    {
      q: {
        en: "Why does my Word file say \"coming soon\"?",
        hi: "मेरी वर्ड फ़ाइल \"जल्द आ रहा है\" क्यों कहती है?",
      },
      a: {
        en: "Converting DOCX faithfully needs LibreOffice on a server — doing it half-way in the browser would break layouts. That ships in a later phase; until then the badge tells you the truth instead of pretending.",
        hi: "DOCX को ईमानदारी से बदलने के लिए सर्वर पर LibreOffice चाहिए — ब्राउज़र में अधूरा काम लेआउट तोड़ देता। वह बाद के चरण में आएगा; तब तक बैज ढूँग बताने की जगह सच बताता है।",
      },
    },
    {
      q: {
        en: "Can a renamed file trick the routing?",
        hi: "क्या नाम बदली फ़ाइल रूटिंग को बहका सकती है?",
      },
      a: {
        en: "No. Detection reads the file's first bytes, so a PNG renamed \"report.docx\" is still detected — and routed — as a PNG. The name is only used to tell ZIP-based formats (like DOCX vs XLSX) apart, where the bytes alone cannot.",
        hi: "नहीं। पहचान फ़ाइल के पहले बाइट्स से होती है — PNG का नाम \"report.docx\" रखने पर भी वह PNG ही पहचानी जाती है। नाम सिर्फ़ ZIP-आधारित फ़ॉर्मैटों (DOCX बनाम XLSX) में फ़र्क़ करने के लिए है, जहाँ बाइट्स अकेले नहीं बता सकते।",
      },
    },
  ],
};
