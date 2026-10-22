import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * EPUB to PDF (RB3-a — the 75th tool). EPUB ebooks → PDF, 100%
 * on-device (a Web Worker unzips the OCF package and repaints the
 * chapters with pdf-lib), EN + हिंदी.
 *
 * The surface (tools/epub-to-pdf/surface.tsx) owns the input flow: a
 * drop zone that sniffs the ZIP magic of .epub files, a live
 * title/author/chapters/≈pages book summary from the same parser the
 * worker uses, page-size + margins + font-size + TOC/cover/page-number
 * toggles, and the Convert button that spawns the worker
 * (html-to-pdf pattern). The shell CTA runs the same worker through
 * the standard pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - DRM-protected books are rejected (META-INF/encryption.xml);
 *  - CSS styling is approximated — this reflows text, it does not
 *    reproduce the reader's typography (fixed-layout EPUBs render as
 *    ordinary reflowable text);
 *  - images beyond the cover are not carried (alt text prints in
 *    brackets);
 *  - Hindi bold renders regular (the Noto OFL face ships Regular
 *    only — hierarchy comes from size).
 */
export const config: ToolConfig = {
  toolId: "epub-to-pdf",
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
        en: "Normal 56 pt, narrow 28 pt, wide 80 pt on every side",
        hi: "सामान्य 56 pt, सँकरा 28 pt, चौड़ा 80 pt हर तरफ़",
      },
      choices: [
        { value: "normal", label: { en: "Normal (56 pt)", hi: "सामान्य (56 pt)" } },
        { value: "narrow", label: { en: "Narrow (28 pt)", hi: "सँकरा (28 pt)" } },
        { value: "wide", label: { en: "Wide (80 pt)", hi: "चौड़ा (80 pt)" } },
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
      id: "includeToc",
      label: { en: "Table of contents page", hi: "विषय-सूची पेज" },
      hint: {
        en: "Chapter titles with exact page numbers, right after the cover",
        hi: "अध्याय शीर्षक सटीक पेज नंबरों के साथ, कवर के ठीक बाद",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "includeCover",
      label: { en: "Cover page", hi: "कवर पेज" },
      hint: {
        en: "The book's PNG/JPG cover image on page 1, when present",
        hi: "किताब की PNG/JPG कवर तस्वीर पेज 1 पर, जब मौजूद हो",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "pageNumbers",
      label: { en: "Page numbers", hi: "पेज नंबर" },
      hint: {
        en: "A centered folio in the bottom margin of every content page",
        hi: "हर कंटेंट पेज के निचले मार्जिन में बीच का अंक",
      },
      default: true,
    },
  ],
  howKeys: ["epub.how1", "epub.how2", "epub.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Convert EPUB ebooks into PDFs entirely on your device — the ZIP package is unzipped, the OPF spine is followed chapter by chapter, and every page is repainted inside your browser. Nothing is uploaded, ever.",
      hi: "EPUB ईबुक को PDF बनाएँ — पूरी तरह आपके डिवाइस पर। ZIP पैकेज यहीं खुलता है, OPF स्पाइन अध्याय-दर-अध्याय चलता है और हर पेज आपके ब्राउज़र में बनता है। कुछ भी अपलोड नहीं होता।",
    },
    {
      en: "Real book structure, not screenshots: the cover image, an optional table-of-contents page with exact page numbers, each chapter starting on a fresh page, headings, bold/italic text, nested lists, quotes, code blocks and tables — all true selectable vector text.",
      hi: "असली किताब जैसा ढाँचा, स्क्रीनशॉट नहीं: कवर तस्वीर, सटीक पेज नंबरों वाला वैकल्पिक विषय-सूची पेज, हर अध्याय नए पेज से, शीर्षक, बोल्ड-इटैलिक टेक्स्ट, नेस्टेड सूचियाँ, कोट, कोड ब्लॉक और टेबलें — सब सच्ची चुनने योग्य वेक्टर टेक्स्ट।",
    },
    {
      en: "English books export with the built-in Helvetica and Courier (no font embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset — अंग्रेज़ी और हिंदी दोनों किताबें।",
      hi: "अंग्रेज़ी किताबें बिल्ट-इन Helvetica और Courier से निकलती हैं (कोई फ़ॉन्ट एम्बेड नहीं, छोटी फ़ाइल); कोई भी देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है — अंग्रेज़ी और हिंदी दोनों किताबें।",
    },
    {
      en: "The book's own metadata travels with it: dc:title and dc:creator become the PDF's title and author, and A4 / US Letter, three margins, three font sizes, TOC, cover and page numbers are your call — with a live title/author/chapters/≈pages summary before you convert.",
      hi: "किताब का मेटाडेटा साथ चलता है: dc:title और dc:creator PDF के शीर्षक और लेखक बनते हैं, और A4 / US लेटर, तीन मार्जिन, तीन फ़ॉन्ट साइज़, विषय-सूची, कवर व पेज नंबर आपके हाथ में — बदलने से पहले शीर्षक/लेखक/अध्याय/≈पेज का लाइव ब्यौरा।",
    },
    {
      en: "Honest about what it is: a reflower, not a reader engine. DRM-protected books are rejected outright; CSS styling is approximated; fixed-layout EPUBs render as ordinary reflowable text; images beyond the cover print as their alt text.",
      hi: "अपने बारे में ईमानदार: यह रीफ़्लो करने वाला है, रीडर इंजन नहीं। DRM वाली किताबें सीधे अस्वीकार; CSS स्टाइलिंग सन्निकट; फ़िक्स्ड-लेआउट EPUB सामान्य रीफ़्लो टेक्स्ट जैसी छपती है; कवर के अलावा तस्वीरें अपना alt टेक्स्ट छापती हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the PDF look exactly like my e-reader renders the book?",
        hi: "क्या PDF बिल्कुल वैसी दिखेगी जैसी ई-रीडर पर किताब दिखती है?",
      },
      a: {
        en: "No — and that is the honest answer. This tool REFLOWS the book onto fresh pages: chapter order, headings, bold/italic, lists, quotes, code blocks and tables are faithfully repainted as clean vector text, but CSS styling (fonts, colours, drop caps, columns) is approximated, and fixed-layout EPUBs (comics, picture books) render as ordinary reflowable text. What you get is a readable, printable, fully selectable document.",
        hi: "नहीं — और यही ईमानदार जवाब है। यह टूल किताब को नए पेजों पर रीफ़्लो करता है: अध्याय क्रम, शीर्षक, बोल्ड-इटैलिक, सूचियाँ, कोट, कोड ब्लॉक और टेबलें सच्चे वेक्टर टेक्स्ट में वैसे ही छपती हैं, पर CSS स्टाइलिंग (फ़ॉन्ट, रंग, ड्रॉप कैप्स, कॉलम) सन्निकट होती है और फ़िक्स्ड-लेआउट EPUB (कॉमिक्स, चित्र-किताबें) सामान्य रीफ़्लो टेक्स्ट जैसी छपती है। जो मिलता है वह पढ़ने, प्रिंट और चुनने लायक पूरा दस्तावेज़ है।",
      },
    },
    {
      q: {
        en: "Can it open DRM-protected EPUBs?",
        hi: "क्या DRM वाली EPUB खुल सकती है?",
      },
      a: {
        en: "No — and it says so instead of failing mysteriously. Any book carrying META-INF/encryption.xml (Adobe DRM, and also packages with obfuscated fonts) is rejected with a clear message; decrypting protected books is not something this on-device tool does. Copy your own DRM-free EPUBs and they convert fine.",
        hi: "नहीं — और यह टूल रहस्यमय तरीके से फेल नहीं होता, बल्कि साफ़ बताता है। META-INF/encryption.xml वाली कोई भी किताब (Adobe DRM, और ऑब्फ़स्केटेड फ़ॉन्ट वाले पैकेज भी) स्पष्ट संदेश के साथ अस्वीकृत होती है; सुरक्षित किताबों का डिक्रिप्शन इस ऑन-डिवाइस टूल का काम नहीं। अपनी DRM-मुक्त EPUB लें, वे ठीक बनती हैं।",
      },
    },
    {
      q: {
        en: "Does it work with Hindi books?",
        hi: "हिंदी किताबों के साथ चलता है?",
      },
      a: {
        en: "Yes. Any Devanagari character switches the whole PDF to the embedded Noto Sans Devanagari subset, so हिंदी chapters, headings, lists and table cells render and stay selectable — and the Hindi table of contents (विषय-सूची) comes out in Hindi too. Latin-only books use the built-in Helvetica instead — nothing is embedded and the files stay tiny. One honest limit: the Noto face ships Regular only, so bold Hindi text renders at the same weight (headings still stand out through size).",
        hi: "हाँ। कोई भी देवनागरी अक्षर आते ही पूरी PDF एम्बेडेड Noto Sans Devanagari सबसेट पर चली जाती है, इसलिए हिंदी अध्याय, शीर्षक, सूचियाँ और टेबल कोशिकाँ छपती और चुनने योग्य रहती हैं — और हिंदी विषय-सूची भी हिंदी में बनती है। सिर्फ़ लैटिन किताबें बिल्ट-इन Helvetica से निकलती हैं — कुछ एम्बेड नहीं, फ़ाइलें छोटी। एक ईमानदार सीमा: Noto फ़ेस में केवल Regular है, इसलिए बोल्ड हिंदी सामान्य मोटाई में छपता है (शीर्षक आकार से अलग दिखते हैं)।",
      },
    },
    {
      q: {
        en: "Where is my book processed, and what are the limits?",
        hi: "मेरी किताब कहाँ प्रोसेस होती है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread unzips the package, follows the OPF spine and paints the PDF; nothing is uploaded, no sign-up, no watermark. One DRM-free .epub at a time, up to 20 MB. Images beyond the cover are not carried (alt text prints in brackets), spine items that are not XHTML (images, CSS, fonts) are skipped with honest accounting, and very large books are capped at 500 chapters / 60,000 blocks — the summary tells you when that happened.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड पैकेज खोलती, OPF स्पाइन चलाती और PDF बनाती है; कुछ अपलोड नहीं, न साइन-अप, न वॉटरमार्क। एक बार में एक DRM-मुक्त .epub, 20 MB तक। कवर के अलावा तस्वीरें नहीं आतीं (alt टेक्स्ट कोष्ठक में छपता है), स्पाइन की ग़ैर-XHTML मदें (तस्वीरें, CSS, फ़ॉन्ट) ईमानदारी से छोड़ी जाती हैं, और बहुत बड़ी किताबें 500 अध्याय / 60,000 ब्लॉक पर सीमित होती हैं — सारांश बता देता है कि ऐसा हुआ।",
      },
    },
  ],
};
