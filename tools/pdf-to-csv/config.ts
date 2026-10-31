import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to CSV (P3-a / R55) — tabular PDF → plain CSV. The same honest
 * extraction as PDF to Excel (bordered tables read cell-for-cell from
 * their rule lines, borderless pages from position clustering) with a
 * lightweight CSV emit: comma / semicolon / tab, one stacked file or one
 * per page. 100% on-device, zero network.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-csv",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["pdf-to-excel", "pdf-to-json", "pdf-to-txt"],
  options: [
    {
      kind: "select",
      id: "delimiter",
      label: { en: "Delimiter", hi: "डेलिमिटर" },
      hint: {
        en: "Comma is the universal default; semicolon opens cleanly in European Excel; tab writes a .tsv.",
        hi: "कॉमा सबसे आम है; सेमीकोलन यूरोपीय एक्सेल में सीधा खुलता है; टैब से .tsv फ़ाइल बनती है।",
      },
      choices: [
        { value: "comma", label: { en: "Comma ( , )", hi: "कॉमा ( , )" } },
        { value: "semicolon", label: { en: "Semicolon ( ; )", hi: "सेमीकोलन ( ; )" } },
        { value: "tab", label: { en: "Tab — .tsv", hi: "टैब — .tsv" } },
      ],
      default: "comma",
    },
    {
      kind: "select",
      id: "mode",
      label: { en: "Output", hi: "आउटपुट" },
      hint: {
        en: "Single file stacks every page with a Page column first; per-page gives one CSV per PDF page.",
        hi: "सिंगल फ़ाइल में हर पेज, पहले कॉलम पेज नंबर के साथ; प्रति-पेज में हर पेज की अपनी CSV।",
      },
      choices: [
        { value: "single", label: { en: "Single file — with Page column", hi: "एक फ़ाइल — पेज कॉलम के साथ" } },
        { value: "per-page", label: { en: "One file per page", hi: "हर पेज की अलग फ़ाइल" } },
      ],
      default: "single",
    },
    {
      kind: "switch",
      id: "ruled",
      label: { en: "Read ruled tables from their borders", hi: "बॉर्डर वाली टेबल सीमाओं से पढ़ें" },
      hint: {
        en: "Pages that draw real border lines (invoices, statements) come out as exact cell grids — no guessing from spacing. Pages without borders fall back to position clustering.",
        hi: "जिन पेजों पर असली बॉर्डर लाइनें हैं (इनवॉइस, स्टेटमेंट) वे एकदम सटीक सेल-ग्रिड बनते हैं — स्पेसिंग से अंदाज़ा नहीं। बिना बॉर्डर वाले पेज पोज़िशन क्लस्टरिंग पर चलते हैं।",
      },
      default: true,
    },
  ],
  features: [
    {
      en: "Tabular PDFs become plain CSV — the format every script, database bulk loader and spreadsheet takes without asking.",
      hi: "टेबल वाली PDF सीधी CSV बन जाती है — वह फ़ॉर्मैट जो हर स्क्रिप्ट, डेटाबेस और स्प्रेडशीट बिना पूछे ले लेता है।",
    },
    {
      en: "Bordered tables are read cell-for-cell from their own rule lines; borderless pages fall back to position clustering — the same honest extraction as PDF to Excel.",
      hi: "बॉर्डर वाली टेबलें अपनी रूल-लाइनों से सेल-दर-सेल पढ़ी जाती हैं; बिना बॉर्डर वाले पेज पोज़िशन क्लस्टरिंग पर चलते हैं — वही ईमानदार एक्स्ट्रैक्शन जो PDF to Excel में है।",
    },
    {
      en: "Comma, semicolon or tab delimited — the tab variant downloads as .tsv. Quoting follows RFC 4180, so commas and line breaks inside a cell never break the file.",
      hi: "कॉमा, सेमीकोलन या टैब — टैब वाली फ़ाइल .tsv मिलती है। कोटिंग RFC 4180 के मुताबिक, इसलिए सेल के अंदर का कॉमा या लाइन-ब्रेक फ़ाइल कभी नहीं तोड़ता।",
    },
    {
      en: "One stacked CSV with a leading Page column, or one file per page — whichever your pipeline prefers. Up to 5 PDFs per run.",
      hi: "पेज कॉलम से शुरू होती एक स्टैक्ड CSV, या हर पेज की अलग फ़ाइल — जैसा आपकी पाइपलाइन चाहे। एक बार में 5 PDF तक।",
    },
    {
      en: "Your document never leaves the device — extraction and export happen in your browser. Zero uploads, zero API keys.",
      hi: "आपका दस्तावेज़ डिवाइस से बाहर नहीं जाता — एक्स्ट्रैक्शन और एक्सपोर्ट ब्राउज़र में होते हैं। कोई अपलोड नहीं, कोई API की नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "When should I use this instead of PDF to Excel?",
        hi: "PDF to Excel के बजाय इसे कब इस्तेमाल करूँ?",
      },
      a: {
        en: "When a script, database or data pipeline — not a human — reads the result. CSV needs no library to parse, loads with one command, and the tab variant (.tsv) survives even the messiest text fields. For formulas-friendly review and styling, PDF to Excel is the better stop.",
        hi: "जब नतीजा इंसान नहीं, बल्कि स्क्रिप्ट, डेटाबेस या पाइपलाइन पढ़े। CSV पार्स करने के लिए कोई लाइब्रेरी नहीं माँगता, एक कमांड में लोड होता है, और टैब वाला (.tsv) सबसे गड़बड़ टेक्स्ट भी सह लेता है। इंसानी समीक्षा और स्टाइलिंग के लिए PDF to Excel बेहतर है।",
      },
    },
    {
      q: {
        en: "Why do some rows have empty cells?",
        hi: "कुछ पंक्तियों में सेल ख़ाली क्यों होते हैं?",
      },
      a: {
        en: "The grid is rebuilt from positions: a cell is empty when the page genuinely has nothing at that row-column crossing. Dense, aligned tables come out cleanest; tangled layouts may need a quick tidy-up in your spreadsheet.",
        hi: "ग्रिड पोज़िशन से बनती है: जहाँ पेज पर उस पंक्ति-कॉलम के चौराहे पर सचमुच कुछ नहीं है, वहाँ सेल ख़ाली रहती है। सधे-संगठित टेबलें सबसे साफ़ आती हैं; उलझे लेआउट में स्प्रेडशीट में थोड़ी सफ़ाई करनी पड़ सकती है।",
      },
    },
    {
      q: {
        en: "Why does my scanned PDF fail?",
        hi: "मेरी स्कैन की हुई PDF क्यों असफल होती है?",
      },
      a: {
        en: "Scanned pages are images — there is no text to read. Run the file through PDF OCR first, then convert the text version here. The tool refuses honestly instead of shipping an empty CSV.",
        hi: "स्कैन किए पेज तस्वीरें हैं — पढ़ने को टेक्स्ट ही नहीं होता। पहले फ़ाइल को PDF OCR से निकालिए, फिर वही टेक्स्ट वर्ज़न यहाँ बदलें। यह टूल ख़ाली CSV देने के बजाय ईमानदारी से मना करता है।",
      },
    },
  ],
};
