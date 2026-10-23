import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * HTML to PDF (RB2-d — the 74th tool). HTML → clean vector PDF, 100%
 * on-device (a Web Worker tokenizes the markup and paints it with
 * pdf-lib), EN + हिंदी.
 *
 * The surface (tools/html-to-pdf/surface.tsx) owns the input flow: a
 * drop zone that sniffs the tag/doctype shape of .html/.htm files, a
 * live title/blocks/words/≈pages summary from the same parser the
 * worker uses, page-size + margin + font-size + show-links toggles,
 * and the Convert button that spawns the worker (word-to-pdf
 * pattern). The shell CTA runs the same worker through the standard
 * pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - this is CONTENT extraction, not a browser engine: CSS layout and
 *    styling (columns, floats, colours, fonts) are not applied;
 *  - scripts, SVG and images are not carried beyond alt text in
 *    brackets; form controls are dropped;
 *  - complex nested tables approximate (inner tables hoist as their
 *    own grid right before the outer one);
 *  - Hindi bold renders regular (the Noto OFL face ships Regular
 *    only — hierarchy comes from size).
 */
export const config: ToolConfig = {
  toolId: "html-to-pdf",
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
        en: "A4 outside North America, US Letter for the US/Canada",
        hi: "उत्तरी अमेरिका के बाहर A4, अमेरिका/कनाडा के लिए US लेटर",
      },
      choices: [
        { value: "a4", label: { en: "A4 (210 × 297 mm)", hi: "A4 (210 × 297 मिमी)" } },
        {
          value: "letter",
          label: { en: "US Letter (8.5 × 11 in)", hi: "US लेटर (8.5 × 11 इंच)" },
        },
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
    {
      kind: "select",
      id: "baseFontSize",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      hint: {
        en: "Body text 10 / 11 / 12.5 pt — headings scale with it",
        hi: "मुख्य टेक्स्ट 10 / 11 / 12.5 pt — शीर्षक इसी अनुपात में बदलते हैं",
      },
      choices: [
        { value: "small", label: { en: "Small (10 pt)", hi: "छोटा (10 pt)" } },
        { value: "normal", label: { en: "Normal (11 pt)", hi: "सामान्य (11 pt)" } },
        { value: "large", label: { en: "Large (12.5 pt)", hi: "बड़ा (12.5 pt)" } },
      ],
      default: "normal",
    },
    {
      kind: "switch",
      id: "showLinks",
      label: { en: "Show link addresses", hi: "लिंक पते दिखाएँ" },
      hint: {
        en: "Print the href after each link text, footnote-style",
        hi: "हर लिंक टेक्स्ट के बाद उसका पता छापें (फ़ुटनोट शैली)",
      },
      default: false,
    },
  ],
  howKeys: ["html.how1", "html.how2", "html.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn saved web pages and .html files into PDFs entirely on your device — the markup is tokenized and re-painted inside your browser, so the page never touches a server.",
      hi: "सेव किए वेबपेज और .html फ़ाइलों को PDF बनाएँ — पूरी तरह आपके डिवाइस पर। मार्कअप यहीं आपके ब्राउज़र में खुलता और बनता है, पेज कभी सर्वर तक जाता ही नहीं।",
    },
    {
      en: "Real selectable text, never a screenshot: headings h1–h6, paragraphs with bold, italic and underline, nested bullet and numbered lists, blockquotes with an accent bar, <pre> code blocks on a gray background and bordered tables all become true vector text.",
      hi: "असली चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं: h1–h6 शीर्षक, बोल्ड-इटैलिक-रेखांकित पैराग्राफ़, नेस्टेड बुलेट व नंबर सूचियाँ, एक्सेंट-पट्टी वाले कोट, ग्रे पृष्ठभूमि पर <pre> कोड ब्लॉक और किनारों वाली टेबलें — सब सच्ची वेक्टर टेक्स्ट बनती हैं।",
    },
    {
      en: "English pages export with the built-in Helvetica and Courier (no font embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset — अंग्रेज़ी और हिंदी दोनों।",
      hi: "अंग्रेज़ी पेज बिल्ट-इन Helvetica और Courier से निकलते हैं (कोई फ़ॉन्ट एम्बेड नहीं, छोटी फ़ाइल); कोई भी देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है — अंग्रेज़ी और हिंदी दोनों।",
    },
    {
      en: "A4 or US Letter, normal or narrow margins, three font sizes, optional link addresses, and a live title/blocks/words/≈pages summary before you convert — honest counts from the same parser the PDF uses.",
      hi: "A4 या US लेटर, सामान्य या सँकरे मार्जिन, तीन फ़ॉन्ट साइज़, वैकल्पिक लिंक पते, और बदलने से पहले शीर्षक/ब्लॉक/शब्द/≈पेज का लाइव ब्यौरा — उसी पार्सर से ईमानदार गिनती जिससे PDF बनता है।",
    },
    {
      en: "Honest about what it is: a content extractor, not a browser engine. CSS layout, scripts, SVG art and images are not applied — the text, structure and tables you saved are what print.",
      hi: "अपने बारे में ईमानदार: यह कंटेंट एक्स्ट्रैक्टर है, ब्राउज़र इंजन नहीं। CSS लेआउट, स्क्रिप्ट, SVG कला और तस्वीरें नहीं लगतीं — आपका सेव किया टेक्स्ट, ढाँचा और टेबलें ही छपती हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will my page look exactly like it does in the browser?",
        hi: "क्या मेरा पेज ब्राउज़र जैसा हूबहू दिखेगा?",
      },
      a: {
        en: "No — and that is the honest answer. This tool extracts CONTENT, not pixels: headings, paragraphs, bold/italic/underline, lists, quotes, code blocks and tables are re-typeset as clean vector text. CSS layout and styling — columns, floats, colours, web fonts, background images — are not applied, and scripts never run. What you get is a readable, selectable, printable document of everything you saved.",
        hi: "नहीं — और यही ईमानदार जवाब है। यह टूल कंटेंट निकालता है, पिक्सेल नहीं: शीर्षक, पैराग्राफ़, बोल्ड-इटैलिक-रेखांकन, सूचियाँ, कोट, कोड ब्लॉक और टेबलें साफ़ वेक्टर टेक्स्ट में नए सिरे से छपती हैं। CSS लेआउट और स्टाइलिंग — कॉलम, फ़्लोट, रंग, वेब फ़ॉन्ट, बैकग्राउंड तस्वीरें — नहीं लगते, और स्क्रिप्ट कभी नहीं चलतीं। जो मिलता है वह आपके सेव किए हर शब्द का पढ़ने, चुनने और प्रिंट करने लायक दस्तावेज़ है।",
      },
    },
    {
      q: {
        en: "What happens to scripts, images and forms?",
        hi: "स्क्रिप्ट, तस्वीरें और फ़ॉर्म का क्या होता है?",
      },
      a: {
        en: "Scripts and stylesheets are dropped whole — their code never enters the PDF. Images are not embedded; a picture with alt text prints as that alt text in brackets. Form controls (inputs, selects, buttons) are skipped. SVG art and iframes are skipped too. The document's <title> becomes the suggested file name, and link targets can be printed after each link with the \"Show link addresses\" option.",
        hi: "स्क्रिप्ट और स्टाइलशीट पूरी की पूरी छोड़ दी जाती हैं — उनका कोड PDF में कभी नहीं जाता। तस्वीरें एम्बेड नहीं होतीं; alt टेक्स्ट वाली तस्वीर उसी टेक्स्ट को कोष्ठक में छापती है। फ़ॉर्म कंट्रोल (इनपुट, सिलेक्ट, बटन) छोड़ दिए जाते हैं। SVG कला और iframe भी नहीं आते। दस्तावेज़ का <title> फ़ाइल नाम बन जाता है, और \"लिंक पते दिखाएँ\" विकल्प से हर लिंक के बाद उसका पता छप सकता है।",
      },
    },
    {
      q: {
        en: "Does it work with Hindi pages?",
        hi: "हिंदी पेजों के साथ चलता है?",
      },
      a: {
        en: "Yes. Any Devanagari character switches the whole PDF to the embedded Noto Sans Devanagari subset, so हिंदी paragraphs, lists, quotes and table cells render and stay selectable. Latin-only pages use the built-in Helvetica instead — nothing is embedded and the files stay tiny. One honest limit: the Noto face ships Regular only, so bold Hindi text renders at the same weight (headings still stand out through size).",
        hi: "हाँ। कोई भी देवनागरी अक्षर आते ही पूरी PDF एम्बेडेड Noto Sans Devanagari सबसेट पर चली जाती है, इसलिए हिंदी पैराग्राफ़, सूचियाँ, कोट और टेबल कोशिकाँ छपती और चुनने योग्य रहती हैं। सिर्फ़ लैटिन वाले पेज बिल्ट-इन Helvetica से निकलते हैं — कुछ एम्बेड नहीं होता, फ़ाइलें छोटी रहती हैं। एक ईमानदार सीमा: Noto फ़ेस में केवल Regular है, इसलिए बोल्ड हिंदी टेक्स्ट सामान्य मोटाई में छपता है (शीर्षक आकार से अलग दिखते हैं)।",
      },
    },
    {
      q: {
        en: "Where is my page processed, and what are the limits?",
        hi: "मेरा पेज कहाँ प्रोसेस होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread reads the file, tokenizes it and paints the PDF; nothing is uploaded, no sign-up, no watermark. One .html/.htm file at a time, up to 20 MB. Very large pages are capped honestly: 20,000 blocks and 200 × 200 table cells are converted, and the summary tells you when that happened. Complex nested tables approximate: an inner table prints as its own grid right before the outer one.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड फ़ाइल पढ़ती, उसे टोकनाइज़ करती और PDF बनाती है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। एक बार में एक .html/.htm फ़ाइल, 20 MB तक। बहुत बड़े पेज ईमानदारी से सीमित होते हैं: 20,000 ब्लॉक और 200 × 200 टेबल कोशिकाँ तक बदलते हैं, और सारांश बता देता है कि ऐसा हुआ। जटिल नेस्टेड टेबलें सन्निकट होती हैं: भीतरी टेबल बाहरी टेबल से ठीक पहले अपनी अलग ग्रिड बन जाती है।",
      },
    },
  ],
};
