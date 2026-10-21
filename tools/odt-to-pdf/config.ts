import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * OpenDocument to PDF (RB2-b — the 72nd tool). ODT text + ODS
 * spreadsheets → clean vector PDF, 100% on-device (a Web Worker
 * unzips the OpenDocument package and paints it with pdf-lib),
 * EN + हिंदी.
 *
 * The surface (tools/odt-to-pdf/surface.tsx) owns the input flow: a
 * drop zone that sniffs the PK ZIP magic of the .odt/.ods, a live
 * kind/blocks/words/pages summary from the same parser the worker
 * uses, page-size + margin toggles, and the Convert button that spawns
 * the worker (word-to-pdf pattern). The shell CTA runs the same worker
 * through the standard pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - .odt (text) and .ods (spreadsheets) only — .odp presentations
 *    and .odg drawings are rejected up front with a clear message;
 *  - images, drawings/frames, headers/footers, footnotes and
 *    annotations are not carried over;
 *  - complex character/paragraph styles approximate (bold, italic and
 *    font-size survive; colours, columns and page styles do not);
 *  - Hindi bold renders as regular (the Noto OFL face ships Regular
 *    only — hierarchy comes from size).
 */
export const config: ToolConfig = {
  toolId: "odt-to-pdf",
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
        en: "A4 is the LibreOffice default outside North America",
        hi: "A4 उत्तरी अमेरिका के बाहर LibreOffice का डिफ़ॉल्ट है",
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
  howKeys: ["odt.how1", "odt.how2", "odt.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn .odt documents and .ods spreadsheets into clean PDFs entirely on your device — the OpenDocument package is unzipped and re-painted inside your browser, so the file never touches a server.",
      hi: ".odt दस्तावेज़ों और .ods स्प्रेडशीट को साफ़ PDF बनाएँ — पूरी तरह आपके डिवाइस पर। ओपनडॉक्यूमेंट पैकेज यहीं आपके ब्राउज़र में खुलता और बनता है, फ़ाइल कभी सर्वर तक जाती ही नहीं।",
    },
    {
      en: "Real selectable text, never a screenshot: headings (outline levels 1–6), bold, italic, font sizes, nested bullet lists and bordered tables become true vector text you can search and copy — spreadsheets flow as fit-to-width grids, one page block per sheet.",
      hi: "असली चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं: शीर्षक (आउटलाइन स्तर 1–6), बोल्ड, इटैलिक, फ़ॉन्ट आकार, नेस्टेड बुलेट सूचियाँ और किनारे वाली टेबलें सच्ची वेक्टर टेक्स्ट बनती हैं — स्प्रेडशीट चौड़ाई-अनुसार ग्रिड में बहती हैं, हर शीट का अपना पेज-ब्लॉक।",
    },
    {
      en: "English documents export with the built-in Helvetica (no font embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset — अंग्रेज़ी और हिंदी दोनों।",
      hi: "अंग्रेज़ी दस्तावेज़ बिल्ट-इन Helvetica से निकलते हैं (कोई फ़ॉन्ट एम्बेड नहीं, छोटी फ़ाइल); कोई भी देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है — अंग्रेज़ी और हिंदी दोनों।",
    },
    {
      en: "A4 or US Letter, normal or narrow margins, and a live kind/blocks/words/pages summary before you convert — honest counts from the same parser the PDF uses. .odp presentations and .odg drawings are rejected with a clear message, never mangled.",
      hi: "A4 या US लेटर, सामान्य या सँकरे मार्जिन, और बदलने से पहले प्रकार/ब्लॉक/शब्द/पेज का लाइव ब्यौरा — उसी पार्सर से ईमानदार गिनती जिससे PDF बनता है। .odp प्रेज़ेंटेशन और .odg ड्रॉइंग साफ़ संदेश के साथ अस्वीकृत होती हैं, कभी बिगड़ती नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which OpenDocument files are supported — and which are rejected?",
        hi: "कौन सी ओपनडॉक्यूमेंट फ़ाइलें चलती हैं — और कौन सी अस्वीकृत होती हैं?",
      },
      a: {
        en: "Text documents (.odt) and spreadsheets (.ods), including the template variants (.ott/.ots). Presentations (.odp) and drawings (.odg) exist in the wild but need completely different parsers — the tool checks the package and rejects them up front with a clear message instead of producing garbage. The ZIP signature is verified too, so a renamed file can't sneak through.",
        hi: "टेक्स्ट दस्तावेज़ (.odt) और स्प्रेडशीट (.ods), टेम्पलेट रूप (.ott/.ots) समेत। प्रेज़ेंटेशन (.odp) और ड्रॉइंग (.odg) दुनिया में मिलती हैं, पर उनके लिए बिल्कुल अलग पार्सर चाहिए — टूल पैकेज जाँचकर उन्हें शुरू में ही साफ़ संदेश के साथ अस्वीकार करता है, कचरा बनाता नहीं। ZIP हस्ताक्षर भी जाँचा जाता है, इसलिए नाम बदली फ़ाइल चुपचाप नहीं निकल सकती।",
      },
    },
    {
      q: {
        en: "What exactly survives the conversion — and what doesn't?",
        hi: "रूपांतरण में क्या बचता है — और क्या नहीं?",
      },
      a: {
        en: "Kept: paragraphs with bold, italic and font sizes, Heading 1–6 hierarchy, bullet lists with nesting, tables with measured columns and hairline borders, and complete spreadsheets as fit-to-width grids. Simplified or dropped: images and drawings, headers and footers, footnotes, comments/annotations, colours and multi-column layouts. Complex styles approximate honestly. Everything that IS drawn is real selectable text — we never rasterize your words.",
        hi: "बचता है: बोल्ड, इटैलिक और फ़ॉन्ट आकार वाले पैराग्राफ़, Heading 1–6 क्रम, नेस्टिंग वाली बुलेट सूचियाँ, मापे हुए कॉलम और पतली किनारों वाली टेबलें, और पूरी स्प्रेडशीट चौड़ाई-अनुसार ग्रिड में। सरल या छूटा: तस्वीरें और ड्रॉइंग, हेडर-फ़ुटर, फ़ुटनोट, टिप्पणियाँ, रंग और कई कॉलम वाले लेआउट। जटिल स्टाइल ईमानदारी से सरल होते हैं। जो कुछ भी छपता है वह असली चुनने योग्य टेक्स्ट है — आपके शब्दों की तस्वीर कभी नहीं बनती।",
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
        en: "Where is my document processed, and what are the limits?",
        hi: "मेरा दस्तावेज़ कहाँ प्रोसेस होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread unzips the package and paints the PDF; nothing is uploaded, no sign-up, no watermark. Size limit 50 MB on mobile / 200 MB on desktop, one file at a time. Very long documents are capped honestly: 500 paragraphs, 800 blocks and 50 × 30 table cells for text; 10 sheets, 500 rows and 100 columns for spreadsheets — and the summary tells you when that happened.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड पैकेज खोलता और PDF बनाता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। आकार सीमा मोबाइल पर 50 MB / डेस्कटॉप पर 200 MB, एक बार में एक फ़ाइल। बहुत लंबे दस्तावेज़ ईमानदारी से सीमित होते हैं: टेक्स्ट के लिए 500 पैराग्राफ़, 800 ब्लॉक और 50 × 30 टेबल कोशिकाँ; स्प्रेडशीट के लिए 10 शीट, 500 पंक्तियाँ और 100 कॉलम — और सारांश बता देता है कि ऐसा हुआ।",
      },
    },
  ],
};
