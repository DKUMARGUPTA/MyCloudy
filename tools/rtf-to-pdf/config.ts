import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * RTF to PDF (RB2-c — the 73rd tool). RTF → clean vector PDF, 100%
 * on-device (a Web Worker tokenizes the control words and paints with
 * pdf-lib), EN + हिंदी.
 *
 * The surface (tools/rtf-to-pdf/surface.tsx) owns the input flow: a drop
 * zone that sniffs the {\rtf magic of the file, a live paragraph/word/
 * page-dims/est-pages summary from the same parser the worker uses,
 * page-size (auto / A4 / Letter) + margin (auto / normal / narrow)
 * toggles, and the Convert button that spawns the worker (word-to-pdf
 * pattern). The shell CTA runs the same worker through the standard
 * pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - images/pictures are not carried;
 *  - tables flatten to text lines (cells → tab-separated);
 *  - complex styles approximate (borders, columns, headers/footers drop);
 *  - Hindi bold renders regular (the Noto OFL face ships Regular only).
 */
export const config: ToolConfig = {
  toolId: "rtf-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "Auto keeps the size written inside the RTF (\\paperw\\paperh)",
        hi: "ऑटो RTF के अंदर लिखा साइज़ रखता है (\\paperw\\paperh)",
      },
      choices: [
        {
          value: "auto",
          label: { en: "Auto (from file)", hi: "ऑटो (फ़ाइल से)" },
        },
        { value: "a4", label: { en: "A4 (210 × 297 mm)", hi: "A4 (210 × 297 मिमी)" } },
        { value: "letter", label: { en: "US Letter (8.5 × 11 in)", hi: "US लेटर (8.5 × 11 इंच)" } },
      ],
      default: "auto",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margins", hi: "मार्जिन" },
      hint: {
        en: "Auto keeps the margins written inside the RTF",
        hi: "ऑटो RTF के अंदर लिखे मार्जिन रखता है",
      },
      choices: [
        { value: "auto", label: { en: "Auto (from file)", hi: "ऑटो (फ़ाइल से)" } },
        { value: "normal", label: { en: "Normal (56 pt)", hi: "सामान्य (56 pt)" } },
        { value: "narrow", label: { en: "Narrow (28 pt)", hi: "सँकरा (28 pt)" } },
      ],
      default: "auto",
    },
  ],
  howKeys: ["rtfp.how1", "rtfp.how2", "rtfp.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn .rtf files into clean PDFs entirely on your device — the control words are tokenized and re-painted inside your browser, so the document never touches a server.",
      hi: ".rtf फ़ाइलों को साफ़ PDF बनाएँ — पूरी तरह आपके डिवाइस पर। कंट्रोल-वर्ड यहीं आपके ब्राउज़र में पढ़े और छपते हैं, दस्तावेज़ कभी सर्वर तक जाता ही नहीं।",
    },
    {
      en: "Real selectable text, never a screenshot: headings, bold, italic, underline, font sizes, colours, tab stops, left/centre/right alignment and page breaks become true vector text you can search and copy.",
      hi: "असली चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं: शीर्षक, बोल्ड, इटैलिक, अंडरलाइन, फ़ॉन्ट आकार, रंग, टैब-स्टॉप, बाएँ/मध्य/दाएँ संरेखण और पेज-ब्रेक सच्ची वेक्टर टेक्स्ट बनते हैं — जिन्हें आप सर्च और कॉपी कर सकते हैं।",
    },
    {
      en: "The page size and margins written inside your RTF are honoured (\u005cpaperw, margins in twips) — or override with A4 / US Letter and normal / narrow in one tap.",
      hi: "आपके RTF के अंदर लिखा पेज साइज़ और मार्जिन माना जाता है (twips में) — या एक टैप में A4 / US लेटर और सामान्य / सँकरा चुन लें।",
    },
    {
      en: "English documents export with the built-in Helvetica family (no font embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset — English और हिंदी दोनों।",
      hi: "अंग्रेज़ी दस्तावेज़ बिल्ट-इन Helvetica परिवार से निकलते हैं (कोई फ़ॉन्ट एम्बेड नहीं, छोटी फ़ाइल); कोई भी देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है — English और हिंदी दोनों।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly survives the conversion — and what doesn't?",
        hi: "रूपांतरण में क्या बचता है — और क्या नहीं?",
      },
      a: {
        en: "Kept: paragraphs with bold, italic, underline, font sizes, text colours from the colour table, left/centre/right alignment, tab stops, forced and automatic page breaks, and the document's own page size and margins. Dropped or simplified: images and pictures are not carried at all, tables flatten to text lines (cells become tab-separated), headers/footers and footnotes drop, and complex styles (borders, columns, fancy lists) approximate. Everything that IS drawn is real selectable text — we never rasterize your words.",
        hi: "बचता है: बोल्ड, इटैलिक, अंडरलाइन, फ़ॉन्ट आकार, कलर-टेबल से टेक्स्ट रंग, बाएँ/मध्य/दाएँ संरेखण, टैब-स्टॉप, ज़बरदस्ती और स्वतः पेज-ब्रेक, और दस्तावेज़ का अपना पेज साइज़ व मार्जिन वाले पैराग्राफ़। छूटा या सरल: तस्वीरें बिल्कुल नहीं आतीं, टेबलें टेक्स्ट पंक्तियों में समतल हो जाती हैं (कोशिकाँ टैब से अलग), हेडर-फ़ुटर और फ़ुटनोट छूटते हैं, और जटिल स्टाइल (बॉर्डर, कॉलम, फैंसी सूचियाँ) अनुमानित रहते हैं। जो कुछ भी छपता है वह असली चुनने योग्य टेक्स्ट है — आपके शब्दों की तस्वीर कभी नहीं बनती।",
      },
    },
    {
      q: {
        en: "Does it work with Hindi documents?",
        hi: "हिंदी दस्तावेज़ों के साथ चलता है?",
      },
      a: {
        en: "Yes. RTF stores Hindi as \\uNNNN? unicode escapes — any Devanagari character switches the PDF to the embedded Noto Sans Devanagari subset, so हिंदी paragraphs render and stay selectable. Latin-only documents use the built-in Helvetica family instead — nothing is embedded and the files stay tiny. One honest limit: the Noto face ships Regular only, so bold Hindi text renders at the same weight (headings still stand out through size).",
        hi: "हाँ। RTF हिंदी को \\uNNNN? यूनिकोड एस्केप में रखता है — कोई भी देवनागरी अक्षर आते ही PDF एम्बेडेड Noto Sans Devanagari सबसेट पर चला जाता है, इसलिए हिंदी पैराग्राफ़ छपते और चुनने योग्य रहते हैं। सिर्फ़ लैटिन वाले दस्तावेज़ बिल्ट-इन Helvetica परिवार से निकलते हैं — कुछ एम्बेड नहीं होता, फ़ाइलें छोटी रहती हैं। एक ईमानदार सीमा: Noto फ़ेस में केवल Regular है, इसलिए बोल्ड हिंदी टेक्स्ट सामान्य मोटाई में छपता है (शीर्षक आकार से अलग दिखते हैं)।",
      },
    },
    {
      q: {
        en: "Why is my file rejected — and what about old Word formats?",
        hi: "मेरी फ़ाइल क्यों नहीं चलती — और पुराने वर्ड फ़ॉर्मैट का क्या?",
      },
      a: {
        en: "The tool checks the literal {\\rtf signature up front, so a renamed text or binary file can never sneak through — it is honestly rejected. True .docx (Word 2007+) files are ZIP-based and belong to Word to PDF; the RTF flavour (.rtf, saved by Word's “Save as RTF”, WordPad, LibreOffice, TextEdit) is plain text and is exactly what this tool parses.",
        hi: "टूल शुरू में ही {\\rtf हस्ताक्षर जाँचता है, इसलिए नाम-बदली टेक्स्ट या बाइनेरी फ़ाइल चुपचाप नहीं निकल सकती — ईमानदारी से नकार दी जाती है। असली .docx (Word 2007+) फ़ाइलें ZIP-आधारित हैं और “Word to PDF” टूल की हैं; RTF स्वरूप (.rtf — वर्ड का “Save as RTF”, WordPad, LibreOffice, TextEdit) सादा टेक्स्ट है और यही इस टूल पढ़ता है।",
      },
    },
    {
      q: {
        en: "Where is my document processed, and what are the limits?",
        hi: "मेरा दस्तावेज़ कहाँ प्रोसेस होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread tokenizes the control words and paints the PDF; nothing is uploaded, no sign-up, no watermark. Size limit 50 MB on mobile / 200 MB on desktop, one file at a time. Very long or pathological documents are capped honestly: 5,000 paragraphs, 64-deep group nesting and a total token cap are converted, and the summary tells you when that happened.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड कंट्रोल-वर्ड पढ़ता और PDF बनाता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। आकार सीमा मोबाइल पर 50 MB / डेस्कटॉप पर 200 MB, एक बार में एक फ़ाइल। बहुत लंबे या ख़राब दस्तावेज़ ईमानदारी से सीमित होते हैं: 5,000 पैराग्राफ़, 64-स्तर ग्रुप और कुल टोकन सीमा तक बदलते हैं, और सारांश बता देता है कि ऐसा हुआ।",
      },
    },
  ],
};
