import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * JSON to PDF (P3-b / R56) — structured data → a clean table PDF,
 * 100% on-device (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone, OptionsPanel (orientation,
 * page size, fit, zebra), the worker auto-detects the JSON's shape —
 * array of objects becomes a keyed table, an array of arrays a
 * header-less grid, a plain object a Key/Value table, NDJSON lines
 * are read line-by-line — and paints each file as its own table with
 * the shared data-table painter on our OWN PDF engine.
 */
export const config: ToolConfig = {
  toolId: "json-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [
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
      en: "Your JSON becomes the table it always described — arrays of objects turn into keyed tables with the union of every field, bold headers and real selectable text.",
      hi: "आपका JSON वही टेबल बन जाता है जिसका वर्णन वह करता था — ऑब्जेक्ट की शृंखला हर फ़ील्ड के मिलने से कुंजी-युक्त टेबल बनती है, बोल्ड हेडर और असली चुनने योग्य टेक्स्ट के साथ।",
    },
    {
      en: "Every shape is honoured: keyed records, arrays of arrays (header-less grid), plain value lists, single objects (Key/Value table) and lone scalars — nothing is guessed, nothing is faked.",
      hi: "हर आकृति मानी जाती है: कुंजी-युक्त रिकॉर्ड, शृंखलाओं की शृंखला (बिना हेडर ग्रिड), सादी वैल्यू सूचियाँ, एकल ऑब्जेक्ट (Key/Value टेबल) और अकेला स्केलर — कुछ भी अंदाज़े से नहीं, कुछ नक़ली नहीं।",
    },
    {
      en: "NDJSON / JSON-Lines logs (one value per line) are detected and read line-by-line when the whole document won't parse. Nested objects and arrays render as their compact JSON text inside the cell.",
      hi: "NDJSON / JSON-Lines लॉग (हर लाइन एक वैल्यू) पहचानकर लाइन-दर-लाइन पढ़े जाते हैं जब पूरा दस्तावेज़ पार्स न हो। नेस्टेड ऑब्जेक्ट और शृंखलाएँ सेल के अंदर अपने कॉम्पैक्ट JSON टेक्स्ट में आते हैं।",
    },
    {
      en: "Hindi and mixed data print properly — Devanagari text or ₹ amounts embed the Noto font automatically.",
      hi: "हिन्दी और मिश्रित डेटा सही छपता है — देवनागरी टेक्स्ट या ₹ राशि पर Noto फ़ॉन्ट अपने-आप जुड़ जाता है।",
    },
    {
      en: "Your data never leaves the device. Up to 5 JSON files per run, 100 columns × 2,000 rows each — beyond that the cut is reported, never silent.",
      hi: "आपका डेटा डिवाइस से बाहर नहीं जाता। एक बार में 5 JSON फ़ाइलें, हर एक में 100 कॉलम × 2,000 पंक्तियाँ — उसके आगे कटौती की जानकारी मिलती है, चुपचाप नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "How are the columns decided?",
        hi: "कॉलम कैसे तय होते हैं?",
      },
      a: {
        en: "For an array of objects, the header is the union of every key across all records, in first-seen order — an object missing a field gets an empty cell, exactly like a spreadsheet. An array of arrays becomes a header-less grid because JSON carries no column names for it. A single object renders as a Key/Value table.",
        hi: "ऑब्जेक्ट की शृंखला के लिए हेडर सभी रिकॉर्ड के हर कुंजी का मिलन है, पहली बार दिखने के क्रम में — जिस ऑब्जेक्ट में कोई फ़ील्ड नहीं है उसका सेल खाली रहता है, ठीक स्प्रेडशीट की तरह। शृंखलाओं की शृंखला बिना हेडर ग्रिड बनती है क्योंकि JSON में उसके कॉलम-नाम नहीं होते। एकल ऑब्जेक्ट Key/Value टेबल बनता है।",
      },
    },
    {
      q: {
        en: "What happens to nested objects?",
        hi: "नेस्टेड ऑब्जेक्ट का क्या होता है?",
      },
      a: {
        en: "They stay visible: a nested object or array prints as its compact JSON text inside the cell (like {\"city\":\"Pune\"}), so no data is lost to the flattening. If you want a deeper table, transform the JSON first or use the records shape.",
        hi: "वे दिखते रहते हैं: नेस्टेड ऑब्जेक्ट या शृंखला सेल के अंदर अपने कॉम्पैक्ट JSON टेक्स्ट में छपती है (जैसे {\"city\":\"Pune\"}), इसलिए फ़्लैटनिंग से कोई डेटा नहीं खोता। गहरी टेबल चाहिए तो पहले JSON बदलें या रिकॉर्ड आकृति इस्तेमाल करें।",
      },
    },
    {
      q: {
        en: "My file is JSON-Lines, not one JSON value. Will it work?",
        hi: "मेरी फ़ाइल JSON-Lines है, एक JSON वैल्यू नहीं। क्या चलेगी?",
      },
      a: {
        en: "Yes — when the document fails to parse as one JSON value but every non-blank line parses on its own (and there are at least two), the lines are read as a stream and their values become the rows. If even one line is broken, the tool refuses with an honest parse error instead of guessing.",
        hi: "हाँ — जब दस्तावेज़ एक JSON वैल्यू की तरह पार्स नहीं होता पर हर ग़ैर-खाली लाइन अपने-आप पार्स हो जाती है (और कम-से-कम दो हैं), तो लाइनें स्ट्रीम की तरह पढ़ी जाती हैं और उनकी वैल्यू पंक्तियाँ बनती हैं। एक भी लाइन टूटी हो तो टूल अंदाज़े की जगह ईमानदार पार्स एरर देता है।",
      },
    },
  ],
};
