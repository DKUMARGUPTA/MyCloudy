import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to Word (RB1-b — the 68th tool, rebuilt). A no-file,
 * surface-first tool (create-pdf pattern): the surface renders on the
 * landing page in place of the DropZone and owns every control — the
 * PDF drop zone (magic-%PDF verified), the heading / table /
 * page-break switches, the Convert CTA that spawns the real Web
 * Worker, and the on-device download with a
 * pages/paragraphs/headings/tables summary.
 *
 * The worker extracts selectable text with pdf.js (same recipe as
 * pdf-to-txt), rebuilds paragraphs, detects heading tiers from
 * font-size clusters, detects tables from column gaps (consecutive
 * lines with matching column clusters become real bordered Word
 * tables — anything ambiguous stays text; detection never fabricates),
 * keeps bold runs, and packages a minimal valid
 * .docx with fflate — 100% on-device, EN + हिंदी.
 *
 * HONEST limits (mirrored in the FAQ): text + structure only.
 * Images and multi-column layouts come out as a plain text flow;
 * scanned PDFs need the OCR tool first; the .docx opens in Word,
 * Google Docs and LibreOffice.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-word",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  noFile: true,
  howKeys: ["p2w.how1", "p2w.how2", "p2w.how3"],
  minFiles: 0,
  maxFiles: 0,
  outputKind: "text",
  options: [],
  chainToolIds: ["convert-to-pdf"],
  features: [
    {
      en: "Real editable .docx — the PDF's selectable text becomes Word paragraphs you can retype, restyle and reuse, entirely on your device.",
      hi: "असली एडिटेबल .docx — PDF का चुनने योग्य टेक्स्ट Word पैराग्राफ़ बन जाता है जिसे आप बदल सकते हैं, पूरा काम आपके डिवाइस पर।",
    },
    {
      en: "Structure survives — lines merge back into paragraphs, font-size clusters become Heading 1 / Heading 2, detected tables become real bordered Word tables, bold runs stay bold, and page breaks are kept.",
      hi: "बनावट बनी रहती है — लाइनें वापस पैराग्राफ़ बनती हैं, फ़ॉन्ट-साइज़ के आधार पर हेडिंग 1 / हेडिंग 2 बनती हैं, पहचानी गई टेबलें बॉर्डर वाली असली Word टेबल बनती हैं, बोल्ड टेक्स्ट बोल्ड रहता है, पेज-ब्रेक बने रहते हैं।",
    },
    {
      en: "Hindi comes through clean — Devanagari text converts in UTF-8, and the file opens in Word, Google Docs or LibreOffice.",
      hi: "हिंदी साफ़ आती है — देवनागरी टेक्स्ट UTF-8 में बदलता है और फ़ाइल Word, Google Docs या LibreOffice में खुलती है।",
    },
    {
      en: "Honest conversion — you see pages, paragraphs, headings and tables counted before the download, and a standing note that images and multi-column layouts become a text flow.",
      hi: "ईमानदार रूपांतरण — डाउनलोड से पहले पेज, पैराग्राफ़, हेडिंग और टेबल की गिनती दिखती है, और यह भी लिखा रहता है कि इमेज और मल्टी-कॉलम लेआउट टेक्स्ट-प्रवाह बनते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the Word file look exactly like my PDF?",
        hi: "क्या Word फ़ाइल बिल्कुल मेरी PDF जैसी दिखेगी?",
      },
      a: {
        en: "No, and we say so up front: this is a text-and-structure conversion. Paragraphs, headings, bold text, page breaks and detected tables are rebuilt as editable Word content; images and multi-column layouts are simplified into a linear text flow. Nothing is silently lost — the summary card tells you exactly what was detected.",
        hi: "नहीं, और हम शुरू में ही बता देते हैं: यह टेक्स्ट और बनावट का रूपांतरण है। पैराग्राफ़, हेडिंग, बोल्ड टेक्स्ट, पेज-ब्रेक और पहचानी गई टेबलें एडिट करने योग्य Word कंटेंट बनते हैं; इमेज और मल्टी-कॉलम लेआउट सीधी टेक्स्ट-प्रवाह में सरल हो जाते हैं। कुछ भी चुपचाप नहीं ग़ायब होता — समरी कार्ड बताती है क्या पाया गया।",
      },
    },
    {
      q: {
        en: "My PDF is a scan — what happens?",
        hi: "मेरी PDF स्कैन है — क्या होगा?",
      },
      a: {
        en: "Scanned pages are images with no selectable text, so the tool stops with an honest \"no selectable text\" message instead of saving an empty file. Run the PDF OCR tool on the same file first (English and Hindi are supported), then convert the result here.",
        hi: "स्कैन किए पेज तस्वीरें हैं, उनमें चुनने योग्य टेक्स्ट नहीं होता, इसलिए टूल ख़ाली फ़ाइल बनाने की जगह साफ़ \"चुनने योग्य टेक्स्ट नहीं मिला\" संदेश देता है। पहले उसी फ़ाइल पर PDF OCR टूल चलाएँ (अंग्रेज़ी और हिंदी समर्थित), फिर नतीजा यहाँ बदलें।",
      },
    },
    {
      q: {
        en: "Which PDFs benefit from table detection?",
        hi: "टेबल पहचान किन PDF पर काम करती है?",
      },
      a: {
        en: "Clean, text-based PDFs whose tables have real horizontal gaps between the columns — reports, price lists, timetables, invoices. Scanned pages have no selectable text and need the OCR tool first. Detection never fabricates: rows only become a table when their column gaps line up, and anything it cannot confidently read stays as ordinary text.",
        hi: "साफ़, टेक्स्ट वाली PDF, जिनकी टेबल के कॉलम के बीच असली खाली जगह हो — रिपोर्ट, प्राइस-लिस्ट, समय-सारिणी, इनवॉइस। स्कैन किए पेजों में चुनने योग्य टेक्स्ट नहीं होता, उनके लिए पहले OCR टूल चलाएँ। पहचान कभी कुछ बनावटी नहीं बनाती: पंक्तियाँ तभी टेबल बनती हैं जब उनके कॉलम-गैप मिलते हों, और जो साफ़ पहचान में न आए वह साधारण टेक्स्ट ही रहता है।",
      },
    },
    {
      q: {
        en: "Which apps can open the .docx?",
        hi: "कौन-कौन सी ऐप्स .docx खोल सकती हैं?",
      },
      a: {
        en: "The output is a standard Office Open XML document — Microsoft Word (2007 and later), Google Docs, LibreOffice Writer and Pages all open it. Because it is a minimal, cleanly packaged file, it also converts reliably back to PDF with any converter.",
        hi: "आउटपुट एक स्टैंडर्ड Office Open XML दस्तावेज़ है — Microsoft Word (2007 और बाद के), Google Docs, LibreOffice Writer और Pages सब खोलते हैं। यह छोटी, साफ़ पैक की गई फ़ाइल है, इसलिए किसी भी कन्वर्टर से वापस PDF में भी ठीक बदलती है।",
      },
    },
    {
      q: {
        en: "How do headings, bold text and page breaks work?",
        hi: "हेडिंग, बोल्ड टेक्स्ट और पेज-ब्रेक कैसे काम करते हैं?",
      },
      a: {
        en: "The largest font-size cluster in the document becomes Heading 1 (usually the title), the next tier becomes Heading 2 — you can switch heading detection off to keep everything as plain paragraphs. Bold runs stay bold where the PDF's fonts say so. Page breaks can be preserved (a Word page break where each PDF page starts) or dropped for one continuous flow. Both switches live next to the Convert button.",
        hi: "दस्तावेज़ का सबसे बड़ा फ़ॉन्ट-साइज़ समूह हेडिंग 1 बनता है (आमतौर पर शीर्षक), अगला दरजा हेडिंग 2 — चाहें तो हेडिंग पहचान बंद करके सब सादे पैराग्राफ़ रख सकते हैं। बोल्ड टेक्स्ट वहीं बोल्ड रहता है जहाँ PDF के फ़ॉन्ट ऐसा कहते हैं। पेज-ब्रेक रखे जा सकते हैं (हर PDF पेज की शुरुआत पर Word पेज-ब्रेक) या हटाकर एक लगातार प्रवाह बनाया जा सकता है। दोनों स्विच Convert बटन के पास हैं।",
      },
    },
  ],
};
