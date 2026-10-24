import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Word to PDF (RB1-a — the 67th tool, rebuild). DOCX → clean vector PDF,
 * 100% on-device (a Web Worker unzips the OOXML and paints it with
 * pdf-lib), EN + हिंदी.
 *
 * The surface (tools/word-to-pdf/surface.tsx) owns the input flow: a
 * drop zone that sniffs the PK ZIP magic of the .docx, a live
 * paragraph/table/word summary from the same parser the worker uses,
 * page-size + margin toggles, and the Convert button that spawns the
 * worker (create-invoice pattern). The shell CTA runs the same worker
 * through the standard pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - .docx only — the pre-2007 binary .doc format is NOT a ZIP and is
 *    rejected up front;
 *  - embedded PNG/JPEG images ARE carried (≤50, anchored to their
 *    paragraph — audit R4-a); headers, footers, footnotes, text boxes
 *    and multi-column layouts are still not carried over;
 *  - numbered lists print as bullets; justify renders as left-aligned;
 *  - Hindi bold renders as regular (the Noto OFL face ships Regular
 *    only — hierarchy comes from size).
 */
export const config: ToolConfig = {
  toolId: "word-to-pdf",
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
        en: "A4 is the Word default outside North America",
        hi: "A4 उत्तरी अमेरिका के बाहर वर्ड का डिफ़ॉल्ट है",
      },
      choices: [
        { value: "a4", label: { en: "A4 (210 × 297 mm)", hi: "A4 (210 × 297 मिमी)" } },
        { value: "letter", label: { en: "US Letter (8.5 × 11 in)", hi: "US लेटर (8.5 × 11 इंच)" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margins", hi: "मार्जिन" },
      hint: {
        en: "Normal 56 pt, narrow 28 pt on every side",
        hi: "सामान्य 56 pt, सँकरा 28 pt हर तरफ़",
      },
      choices: [
        { value: "normal", label: { en: "Normal (56 pt)", hi: "सामान्य (56 pt)" } },
        { value: "narrow", label: { en: "Narrow (28 pt)", hi: "सँकरा (28 pt)" } },
      ],
      default: "normal",
    },
  ],
  howKeys: ["w2p.how1", "w2p.how2", "w2p.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn .docx files into clean PDFs entirely on your device — the OOXML is unzipped and re-painted inside your browser, so the document never touches a server.",
      hi: ".docx फ़ाइलों को साफ़ PDF बनाएँ — पूरी तरह आपके डिवाइस पर। OOXML यहीं आपके ब्राउज़र में खुलता और बनता है, दस्तावेज़ कभी सर्वर तक जाता ही नहीं।",
    },
    {
      en: "Real selectable text, never a screenshot: headings (Title + Heading 1–3), bold, font sizes, alignment, bullet lists and bordered tables become true vector text you can search and copy.",
      hi: "असली चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं: शीर्षक (Title + Heading 1–3), बोल्ड, फ़ॉन्ट आकार, संरेखण, बुलेट सूचियाँ और किनारे वाली टेबलें सच्ची वेक्टर टेक्स्ट बनती हैं — जिन्हें आप सर्च और कॉपी कर सकते हैं।",
    },
    {
      en: "English documents export with the built-in Helvetica (no font embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset — अंग्रेज़ी और हिंदी दोनों।",
      hi: "अंग्रेज़ी दस्तावेज़ बिल्ट-इन Helvetica से निकलते हैं (कोई फ़ॉन्ट एम्बेड नहीं, छोटी फ़ाइल); कोई भी देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है — अंग्रेज़ी और हिंदी दोनों।",
    },
    {
      en: "A4 or US Letter, normal or narrow margins, page breaks honoured (explicit and automatic), and a live paragraph/table/word summary before you convert — honest counts from the same parser the PDF uses.",
      hi: "A4 या US लेटर, सामान्य या सँकरे मार्जिन, पेज-ब्रेक का पूरा सम्मान (स्पष्ट और स्वतः), और बदलने से पहले पैराग्राफ़/टेबल/शब्दों का लाइव ब्यौरा — उसी पार्सर से ईमानदार गिनती जिससे PDF बनता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly survives the conversion — and what doesn't?",
        hi: "रूपांतरण में क्या बचता है — और क्या नहीं?",
      },
      a: {
        en: "Kept: paragraphs with bold, font sizes, left/center/right alignment, Heading 1–3 and Title hierarchy, bullet lists with nesting, tables with measured columns and hairline borders, explicit page breaks — and embedded images: PNG/JPEG pictures inside the document are carried into the PDF at their spot (up to 50; other formats and table-cell pictures are counted as skipped). Simplified or dropped: headers and footers, footnotes, text boxes, multi-column layouts, and numbered lists print as bullets. Everything that IS drawn as text is real selectable text — we never rasterize your words.",
        hi: "बचता है: बोल्ड और फ़ॉन्ट आकार वाले पैराग्राफ़, बाएँ/मध्य/दाएँ संरेखण, Heading 1–3 और Title क्रम, नेस्टिंग वाली बुलेट सूचियाँ, मापे हुए कॉलम और पतली किनारों वाली टेबलें, स्पष्ट पेज-ब्रेक — और एम्बेडेड तस्वीरें: दस्तावेज़ के अंदर की PNG/JPEG तस्वीरें अपनी जगह पर PDF में आती हैं (50 तक; अन्य फ़ॉर्मैट और टेबल-सेल तस्वीरें छोड़ी गिनी जाती हैं)। सरल या छूटा: हेडर-फ़ुटर, फ़ुटनोट, टेक्स्ट-बॉक्स, कई कॉलम वाले लेआउट, और नंबर वाली सूचियाँ बुलेट बन जाती हैं। जो कुछ भी टेक्स्ट के रूप में छपता है वह असली चुनने योग्य टेक्स्ट है — आपके शब्दों की तस्वीर कभी नहीं बनती।",
      },
    },
    {
      q: {
        en: "Does it work with Hindi documents?",
        hi: "हिंदी दस्तावेज़ों के साथ चलता है?",
      },
      a: {
        en: "Yes. Any Devanagari character switches the PDF to the embedded Noto Sans Devanagari subset, so हिंदी paragraphs, bullets and table cells render and stay selectable. Latin-only documents use the built-in Helvetica instead — nothing is embedded and the files stay tiny. One honest limit: the Noto face ships Regular only, so bold Hindi text renders at the same weight (headings still stand out through size).",
        hi: "हाँ। कोई भी देवनागरी अक्षर आते ही PDF एम्बेडेड Noto Sans Devanagari सबसेट पर चला जाता है, इसलिए हिंदी पैराग्राफ़, बुलेट और टेबल कोशिकाँ छपती और चुनने योग्य रहती हैं। सिर्फ़ लैटिन वाले दस्तावेज़ बिल्ट-इन Helvetica से निकलते हैं — कुछ एम्बेड नहीं होता, फ़ाइलें छोटी रहती हैं। एक ईमानदार सीमा: Noto फ़ेस में केवल Regular है, इसलिए बोल्ड हिंदी टेक्स्ट सामान्य मोटाई में छपता है (शीर्षक आकार से अलग दिखते हैं)।",
      },
    },
    {
      q: {
        en: "Why is my old .doc file rejected?",
        hi: "मेरी पुरानी .doc फ़ाइल क्यों नहीं चलती?",
      },
      a: {
        en: "The pre-2007 .doc format is a binary compound file, not the ZIP-based .docx this tool unpacks — converting it would need a completely different parser. Open the file in Word, Google Docs or LibreOffice and re-save as .docx (takes seconds), then convert here. The tool checks the ZIP signature up front, so a renamed file can't sneak through.",
        hi: "2007 से पहले का .doc फ़ॉर्मैट बाइनेरी कंपाउंड फ़ाइल है, इस टूल की ZIP-आधारित .docx नहीं — उसे बदलने के लिए बिल्कुल अलग पार्सर चाहिए। फ़ाइल को Word, Google Docs या LibreOffice में खोलकर .docx के रूप में सेव कर लें (सेकंडों का काम), फिर यहाँ बदलें। टूल शुरू में ही ZIP हस्ताक्षर जाँचता है, इसलिए नाम बदली फ़ाइल चुपचाप नहीं निकल सकती।",
      },
    },
    {
      q: {
        en: "Where is my document processed, and what are the limits?",
        hi: "मेरा दस्तावेज़ कहाँ प्रोसेस होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread unzips the file and paints the PDF; nothing is uploaded, no sign-up, no watermark. Size limit 50 MB on mobile / 200 MB on desktop, one file at a time. Very long documents are capped honestly: 500 paragraphs, 800 blocks and 50 × 30 table cells are converted, and the summary tells you when that happened. .docx only — .doc is not supported.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड फ़ाइल खोलता और PDF बनाता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। आकार सीमा मोबाइल पर 50 MB / डेस्कटॉप पर 200 MB, एक बार में एक फ़ाइल। बहुत लंबे दस्तावेज़ ईमानदारी से सीमित होते हैं: 500 पैराग्राफ़, 800 ब्लॉक और 50 × 30 टेबल कोशिकाँ तक बदलते हैं, और सारांश बता देता है कि ऐसा हुआ। केवल .docx — .doc समर्थित नहीं है।",
      },
    },
  ],
};
