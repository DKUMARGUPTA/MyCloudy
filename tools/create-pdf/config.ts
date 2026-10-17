import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create PDF (PRD §7.3) — instant ready-made paper & planner PDFs. A
 * no-file, surface-first tool (write-pdf pattern): the surface renders
 * directly on the landing page in place of the DropZone and owns every
 * control — the template cards, the paper options, the live preview and
 * the Create PDF CTA that spawns the tool's real Web Worker (progress →
 * on-device download). No document is ever needed.
 */
export const config: ToolConfig = {
  toolId: "create-pdf",
  noFile: true,
  howKeys: ["create.how1", "create.how2", "create.how3"],
  minFiles: 0,
  maxFiles: 0,
  outputKind: "pdf",
  options: [],
  chainToolIds: ["write-pdf", "edit-pdf", "view-pdf"],
  features: [
    {
      en: "Six ready-to-print templates — blank pages, ruled notes, graph and dot grid, Cornell notes and a weekly planner",
      hi: "छह तैयार-प्रिंट टेम्पलेट — ख़ाली पेज, रूल्ड नोट्स, ग्राफ़ व डॉट ग्रिड, कॉर्नेल नोट्स और साप्ताहिक प्लानर",
    },
    {
      en: "Real paper choices — A4, Letter, A5 or Legal, portrait or landscape, with none, narrow or normal margins",
      hi: "असली काग़ज़ी विकल्प — A4, लेटर, A5 या लीगल, पोर्ट्रेट या लैंडस्केप, मार्जिन कोई नहीं, सँकरा या सामान्य",
    },
    {
      en: "Fine control — college, wide or narrow ruling, 5 mm or 2.5 mm squares, the red margin rule and the Cornell header line",
      hi: "बारीक कंट्रोल — कॉलेज, वाइड या नैरो रूलिंग, 5 mm या 2.5 mm वर्ग, लाल मार्जिन लाइन और कॉर्नेल हेडर लाइन",
    },
    {
      en: "The weekly planner comes with Monday-to-Sunday rows in Hindi or English and a notes area — one week per page",
      hi: "साप्ताहिक प्लानर में सोमवार से रविवार तक की पंक्तियाँ हिंदी या अंग्रेज़ी में और टिप्पणियों की जगह — हर पेज पर एक हफ़्ता",
    },
    {
      en: "Live preview, up to 50 pages in one go, and everything is generated on your device — nothing is uploaded",
      hi: "लाइव प्रीव्यू, एक बार में 50 तक पेज, और सब कुछ आपके डिवाइस पर ही बनता है — कुछ भी अपलोड नहीं होता",
    },
  ],
  faq: [
    {
      q: {
        en: "Do I need a document to use this tool?",
        hi: "क्या इस टूल के लिए कोई दस्तावेज़ चाहिए?",
      },
      a: {
        en: "No. This tool creates paper from scratch — you pick a template and options, and the PDF is generated instantly. To write a letter or a report, use Write PDF; this one is for printable paper.",
        hi: "नहीं। यह टूल काग़ज़ शुरू से बनाता है — आप टेम्पलेट और विकल्प चुनते हैं और PDF तुरंत बन जाती है। पत्र या रिपोर्ट लिखने के लिए Write PDF देखें; यह छपने लायक़ काग़ज़ के लिए है।",
      },
    },
    {
      q: {
        en: "What line and grid sizes are available?",
        hi: "लाइन और ग्रिड के कौन-कौन से आकार हैं?",
      },
      a: {
        en: "Ruled paper comes in college (7.1 mm), wide (8.7 mm) and narrow (6.35 mm) spacing — the same pitches as real notebooks. Graph paper offers 5 mm and 2.5 mm squares, and the dot grid is 5 mm.",
        hi: "रूल्ड पेज में कॉलेज (7.1 mm), वाइड (8.7 mm) और नैरो (6.35 mm) स्पेसिंग है — बिल्कुल असली नोटबुक जैसी। ग्राफ़ पेपर में 5 mm और 2.5 mm वर्ग हैं, और डॉट ग्रिड 5 mm का है।",
      },
    },
    {
      q: {
        en: "Can I print these directly?",
        hi: "क्या इन्हें सीधे प्रिंट कर सकते हैं?",
      },
      a: {
        en: "Yes. The PDFs are exact vector pages in your chosen paper size — print at 100% scale (no \"fit to page\") so the spacing stays true. The planner repeats the same week on every page so you can print a term's worth in one go.",
        hi: "हाँ। PDF आपके चुने आकार में पूरे वेक्टर पेज हैं — 100% स्केल पर प्रिंट करें (\"fit to page\" नहीं) ताकि स्पेसिंग सही रहे। प्लानर में हर पेज पर वही हफ़्ता दोहराता है, तो एक बार में पूरे साल के लिए छाप सकते हैं।",
      },
    },
  ],
};
