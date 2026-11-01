import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Table of contents (PHASE-3 batch 2): generate a TOC page (dot leaders,
 * right-aligned page numbers, Unicode titles) from the existing bookmarks
 * or one-entry-per-page, insert it at the start or end, and (optionally)
 * write a matching clickable bookmarks tree that opens the outline panel.
 */
export const config: ToolConfig = {
  toolId: "table-of-contents",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  chainToolIds: ["bookmark-pdf", "view-pdf", "compress-pdf"],
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "source",
      label: { en: "Build entries from", hi: "एंट्री किससे बनाएँ" },
      choices: [
        { value: "bookmarks", label: { en: "Existing bookmarks (keeps nesting)", hi: "मौजूदा बुकमार्क (नेस्टिंग बनी रहती है)" } },
        { value: "pages", label: { en: "Every page (first line as title)", hi: "हर पेज (पहली पंक्ति शीर्षक)" } },
      ],
      default: "bookmarks",
    },
    {
      kind: "text",
      id: "title",
      label: { en: "TOC heading", hi: "विषय-सूची शीर्षक" },
      placeholder: { en: "Table of Contents", hi: "विषय-सूची" },
      default: "Table of Contents",
    },
    {
      kind: "select",
      id: "position",
      label: { en: "Insert at", hi: "कहाँ जोड़ें" },
      choices: [
        { value: "start", label: { en: "Start (before page 1)", hi: "शुरुआत (पेज 1 से पहले)" } },
        { value: "end", label: { en: "End (last page)", hi: "अंत (आख़िरी पेज)" } },
      ],
      default: "start",
    },
    {
      kind: "number",
      id: "fontSize",
      label: { en: "Entry font size", hi: "एंट्री फ़ॉन्ट साइज़" },
      min: 8,
      max: 14,
      step: 1,
      default: 11,
    },
    {
      kind: "switch",
      id: "dotLeaders",
      label: { en: "Dot leaders", hi: "बिंदु वाली रेखा" },
      default: true,
    },
    {
      kind: "switch",
      id: "addBookmarks",
      label: { en: "Also write clickable bookmarks", hi: "क्लिक करने योग्य बुकमार्क भी लिखें" },
      default: true,
    },
  ],
  features: [
    {
      en: "A real TOC page — heading, entries, dot leaders, right-aligned page numbers.",
      hi: "असली विषय-सूची पेज — शीर्षक, एंट्री, बिंदु रेखा, दाईं ओर पेज नंबर।",
    },
    {
      en: "Build from existing bookmarks (nesting kept) or one entry per page.",
      hi: "मौजूदा बुकमार्क से (नेस्टिंग सहित) या हर पेज की एक एंट्री।",
    },
    {
      en: "Clickable bookmarks tree written too — the outline panel opens on the output.",
      hi: "क्लिक करने योग्य बुकमार्क ट्री भी — आउटपुट पर आउटलाइन पैनल खुलता है।",
    },
    {
      en: "Hindi and mixed-language titles render correctly — Unicode throughout.",
      hi: "हिंदी और मिश्रित भाषा के शीर्षक सही दिखते हैं — पूरा यूनिकोड।",
    },
    {
      en: "Insert before page 1 or at the end; numbering matches the final file.",
      hi: "पेज 1 से पहले या अंत में जुड़ता है; नंबरिंग अंतिम फ़ाइल से मेल खाती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "The page numbers point where, exactly?",
        hi: "पेज नंबर ठीक कहाँ इशारा करते हैं?",
      },
      a: {
        en: "At the physical pages of the OUTPUT file — the same numbers your PDF viewer's page box shows. When the TOC is inserted at the start, entries are shifted so everything lines up.",
        hi: "आउटपुट फ़ाइल के असली पेजों पर — वही नंबर जो व्यूअर का पेज बॉक्स दिखाता है। विषय-सूची शुरू में जुड़ने पर एंट्री शिफ़्ट हो जाती हैं ताकि सब कुछ मेल खाए।",
      },
    },
    {
      q: {
        en: "My PDF has no bookmarks — what then?",
        hi: "मेरी PDF में बुकमार्क नहीं हैं — तब?",
      },
      a: {
        en: "Switch 'Build entries from' to 'Every page' — each page gets an entry titled by its first text line. Or build a proper outline first with Bookmark PDF, then come back.",
        hi: "'एंट्री किससे बनाएँ' को 'हर पेज' पर रखें — हर पेज की एंट्री उसकी पहली पंक्ति के नाम से। या पहले बुकमार्क टूल से ठीक आउटलाइन बनाकर लौटें।",
      },
    },
    {
      q: {
        en: "Are the TOC rows themselves clickable?",
        hi: "क्या विषय-सूची की पंक्तियाँ खुद क्लिक करने योग्य हैं?",
      },
      a: {
        en: "The bookmarks tree is the clickable layer (it jumps to pages in every viewer). The printed TOC page is reference typography — honest, printable, and identical everywhere.",
        hi: "क्लिक करने योग्य परत बुकमार्क ट्री है (हर व्यूअर में पेज पर ले जाती है)। छपी हुई विषय-सूची संदर्भ का टाइपोग्राफ़ी है — ईमानदार, छापने लायक, हर जगह एक जैसी।",
      },
    },
  ],
};
