import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * XML to PDF (P3-b / R56) — data feeds and config files → a clean
 * table PDF, 100% on-device (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone, OptionsPanel (@attributes
 * toggle, orientation, page size, fit, zebra), the worker parses with
 * our own namespace-aware parser and auto-detects the shape —
 * repeated elements (RSS items, sitemap urls, product feeds) become
 * record tables, everything else becomes the flattened Path/Value
 * view — painted by the shared data-table painter on our OWN engine.
 */
export const config: ToolConfig = {
  toolId: "xml-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "switch",
      id: "attributes",
      label: { en: "Show attributes as @columns", hi: "एट्रिब्यूट @कॉलम में दिखाएँ" },
      hint: {
        en: "Attributes on each record element become leading @name columns — the XPath convention.",
        hi: "हर रिकॉर्ड एलिमेंट के एट्रिब्यूट शुरुआती @name कॉलम बनते हैं — XPath का रिवाज़।",
      },
      default: true,
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "ओरिएंटेशन" },
      hint: {
        en: "Landscape gives wide tables more room per column.",
        hi: "लैंडस्केप में चौड़ी टेबलों को हर कॉलम में ज़्यादा जगह मिलती है।",
      },
      choices: [
        { value: "portrait", label: { en: "Portrait", hi: "पोर्ट्रेट" } },
        { value: "landscape", label: { en: "Landscape", hi: "लैंडस्केप" } },
      ],
      default: "portrait",
    },
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "A4 (210 × 297 mm) or US Letter (8.5 × 11 in).",
        hi: "A4 (210 × 297 मिमी) या US लेटर (8.5 × 11 इंच)।",
      },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
      ],
      default: "a4",
    },
    {
      kind: "switch",
      id: "fit",
      label: { en: "Fit table to page width", hi: "टेबल पेज-चौड़ाई में फ़िट करें" },
      hint: {
        en: "Stretch or shrink the columns so the table exactly fills the printable width.",
        hi: "कॉलम खींचकर या सिकोड़कर टेबल प्रिंट-योग्य चौड़ाई में भर दे।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "zebra",
      label: { en: "Zebra striping", hi: "ज़ेबरा स्ट्राइप" },
      hint: {
        en: "A light background on alternate rows keeps wide tables readable.",
        hi: "हर दूसरी पंक्ति पर हल्का बैकग्राउंड चौड़ी टेबल को पढ़ने में आसान बनाता है।",
      },
      default: true,
    },
  ],
  chainToolIds: ["compress-pdf", "view-pdf"],
  features: [
    {
      en: "Data feeds become record tables — the tool finds the repeated element (RSS <item>, sitemap <url>, your own <product>) and lays every record out as a row with bold, repeating headers.",
      hi: "डेटा फ़ीड रिकॉर्ड टेबल बन जाते हैं — टूल दोहराए जाने वाले एलिमेंट को ढूँढता है (RSS का <item>, साइटमैप का <url>, आपका <product>) और हर रिकॉर्ड बोल्ड, दोहराए जाने वाले हेडर वाली पंक्ति बन जाता है।",
    },
    {
      en: "Config-style files (settings, POMs, app manifests) without repetition get the flattened view instead: every text leaf as a Path / Value row — nothing invented, nothing lost.",
      hi: "दोहराव न होने वाली कॉन्फ़िग-शैली फ़ाइलें (सेटिंग्स, POM, ऐप मैनिफ़ेस्ट) फ़्लैटन्ड व्यू पाती हैं: हर टेक्स्ट लीफ़ Path / Value पंक्ति — कुछ बनाया नहीं, कुछ खोया नहीं।",
    },
    {
      en: "Namespaces, CDATA, comments, DOCTYPE and every entity form (&amp; &#x20AC; …) are handled by our own parser — the same well-formedness engine that reads e-invoice UBL/CII dialects.",
      hi: "नेमस्पेस, CDATA, कमेंट, DOCTYPE और हर एंटिटी रूप (&amp; &#x20AC; …) हमारा अपना पार्सर संभालता है — वही वेल-फ़ॉर्म्डनेस इंजन जो ई-इनवॉइस की UBL/CII बोलियाँ पढ़ता है।",
    },
    {
      en: "Attributes become leading @name columns (the XPath convention), nested elements keep their compact XML — and Hindi text embeds the Noto font automatically.",
      hi: "एट्रिब्यूट शुरुआती @name कॉलम बनते हैं (XPath रिवाज़), नेस्टेड एलिमेंट अपना कॉम्पैक्ट XML रखते हैं — और हिन्दी टेक्स्ट पर Noto फ़ॉन्ट अपने-आप जुड़ता है।",
    },
    {
      en: "Your files never leave the device. Up to 5 XML files per run, 100 columns × 2,000 records each — the cut is reported, never silent.",
      hi: "आपकी फ़ाइलें डिवाइस से बाहर नहीं जातीं। एक बार में 5 XML फ़ाइलें, हर एक में 100 कॉलम × 2,000 रिकॉर्ड — कटौती की जानकारी मिलती है, चुपचाप नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "How does the tool pick the records?",
        hi: "टूल रिकॉर्ड कैसे चुनता है?",
      },
      a: {
        en: "It walks the tree and finds the deepest element that has two or more children sharing one name. Those repeated elements become the rows — an RSS feed's <item>s, a sitemap's <url>s. Their child elements become the columns (union in first-seen order) and their attributes become @columns. Text-only repeats use the element's own name as the single column.",
        hi: "यह पेड़ पर चलता है और सबसे गहरा वह एलिमेंट ढूँढता है जिसके दो या ज़्यादा बच्चे एक ही नाम के हों। वे दोहराए एलिमेंट पंक्तियाँ बनते हैं — RSS के <item>, साइटमैप के <url>। उनके चाइल्ड एलिमेंट कॉलम बनते हैं (पहली बार दिखने के क्रम में मिलन) और एट्रिब्यूट @कॉलम। सिर्फ़ टेक्स्ट वाले दोहराव एलिमेंट के अपने नाम का अकेला कॉलम बनते हैं।",
      },
    },
    {
      q: {
        en: "What if my XML has no repeated elements?",
        hi: "अगर मेरे XML में कोई दोहराया एलिमेंट नहीं है तो?",
      },
      a: {
        en: "Then it's a configuration-style document, and the tool renders the flattened view: every text leaf as a Path / Value row (root/settings/debug → true), which is exactly how such files are read. Attributes are skipped in that view — only element text is shown, honestly labelled.",
        hi: "तो वह कॉन्फ़िगरेशन-शैली का दस्तावेज़ है, और टूल फ़्लैटन्ड व्यू बनाता है: हर टेक्स्ट लीफ़ Path / Value पंक्ति (root/settings/debug → true) — जैसे ऐसी फ़ाइलें पढ़ी जाती हैं। उस व्यू में एट्रिब्यूट छूटते हैं — सिर्फ़ एलिमेंट टेक्स्ट दिखता है, साफ़ लेबल के साथ।",
      },
    },
    {
      q: {
        en: "Is this the same as the e-invoice XML tool?",
        hi: "क्या यह ई-इनवॉइस XML टूल जैसा ही है?",
      },
      a: {
        en: "No — XML Invoice to PDF reads specific invoicing dialects (UBL 2.1, CII) and renders a formatted invoice document with totals and tax blocks. This tool is format-agnostic: any well-formed XML becomes an honest data table. Same parsing engine, completely different output.",
        hi: "नहीं — XML Invoice to PDF विशेष इनवॉइसिंग बोलियाँ (UBL 2.1, CII) पढ़कर टोटल और टैक्स ब्लॉक वाला सजाया हुआ इनवॉइस दस्तावेज़ बनाता है। यह टूल फ़ॉर्मैट-अनजान है: कोई भी वेल-फ़ॉर्म्ड XML ईमानदार डेटा टेबल बनता है। पार्सिंग इंजन वही, आउटपुट बिल्कुल अलग।",
      },
    },
  ],
};
