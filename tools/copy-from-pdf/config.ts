import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Copy from PDF (PRD §7.1, §8.1 table) — click paragraphs on the page
 * and copy them to the clipboard as text, Markdown or CSV; embedded
 * text is read instantly. The run exports the whole file as .txt / .md,
 * with on-device OCR for scanned pages (auto / always / off).
 */
export const config: ToolConfig = {
  toolId: "copy-from-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  howKeys: ["copyFrom.how1", "copyFrom.how2", "copyFrom.how3"],
  options: [
    {
      kind: "select",
      id: "format",
      label: { en: "Export file", hi: "एक्सपोर्ट फ़ाइल" },
      hint: {
        en: "The run button saves the whole document; the page view copies to the clipboard",
        hi: "रन बटन पूरा दस्तावेज़ सेव करता है; पेज व्यू क्लिपबोर्ड पर कॉपी करता है",
      },
      choices: [
        { value: "txt", label: { en: "Text (.txt)", hi: "टेक्स्ट (.txt)" } },
        {
          value: "md",
          label: { en: "Markdown (.md)", hi: "Markdown (.md)" },
        },
      ],
      default: "txt",
    },
    {
      kind: "select",
      id: "ocrMode",
      label: { en: "Scanned pages", hi: "स्कैन पेज" },
      hint: {
        en: "Auto runs OCR only on pages without selectable text",
        hi: "Auto सिर्फ़ उन्हीं पेजों पर OCR चलाता है जिनमें टेक्स्ट नहीं है",
      },
      choices: [
        { value: "auto", label: { en: "Auto — OCR scans only", hi: "ऑटो — सिर्फ़ स्कैन पर OCR" } },
        {
          value: "always",
          label: { en: "Always OCR every page", hi: "हर पेज पर हमेशा OCR" },
        },
        { value: "off", label: { en: "Off — embedded text only", hi: "बंद — सिर्फ़ जुड़ा टेक्स्ट" } },
      ],
      default: "auto",
    },
    {
      kind: "select",
      id: "lang",
      label: { en: "OCR language", hi: "OCR भाषा" },
      hint: {
        en: "Used when OCR runs — English + Hindi covers mixed pages",
        hi: "OCR चलने पर उपयोग होती है — English + Hindi मिली-जुली पेजों के लिए",
      },
      choices: [
        {
          value: "eng+hi",
          label: { en: "English + Hindi", hi: "अंग्रेज़ी + हिंदी" },
        },
        { value: "eng", label: { en: "English", hi: "अंग्रेज़ी" } },
        { value: "hi", label: { en: "Hindi", hi: "हिंदी" } },
      ],
      default: "eng+hi",
    },
    {
      kind: "select",
      id: "layout",
      label: { en: "Text layout", hi: "टेक्स्ट लेआउट" },
      hint: {
        en: "Flow merges lines into clean paragraphs; lines keeps every break",
        hi: "Flow पैराग्राफ़ बनाता है; lines हर लाइन-ब्रेक रखता है",
      },
      choices: [
        {
          value: "flow",
          label: { en: "Flow — clean paragraphs", hi: "Flow — साफ़ पैराग्राफ़" },
        },
        {
          value: "lines",
          label: { en: "Lines — keep line breaks", hi: "Lines — लाइन-ब्रेक रखें" },
        },
      ],
      default: "flow",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
    {
      kind: "switch",
      id: "pageMarks",
      label: { en: "Mark page breaks", hi: "पेज-ब्रेक चिह्नित करें" },
      hint: {
        en: "Adds ───── Page N ───── between pages when exporting several",
        hi: "कई पेज हों तो बीच में ───── Page N ───── जोड़ता है",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Click any paragraph, list or heading on the page — copy just that, nothing else.",
      hi: "पेज पर कोई भी पैराग्राफ़, लिस्ट या हेडिंग क्लिक करें — वही कॉपी हो, और कुछ नहीं।",
    },
    {
      en: "Copy as clean text, Markdown (headings and bullets) or CSV (columns from gaps).",
      hi: "साफ़ टेक्स्ट, Markdown (हेडिंग-बुलेट) या CSV (गैप से कॉलम) में कॉपी करें।",
    },
    {
      en: "Text from normal PDFs is read instantly — no OCR wait, no model download.",
      hi: "सामान्य PDF का टेक्स्ट तुरंत निकलता है — न OCR का इंतज़ार, न मॉडल डाउनलोड।",
    },
    {
      en: "Scanned pages are detected automatically and recognized on-device when you export.",
      hi: "एक्सपोर्ट के वक़्त स्कैन पेज अपने आप पहचान कर डिवाइस पर ही पढ़े जाते हैं।",
    },
    {
      en: "English and Hindi OCR built in; models download once, then work offline.",
      hi: "अंग्रेज़ी और हिंदी OCR शामिल; मॉडल एक बार डाउनलोड, फिर ऑफ़लाइन।",
    },
    {
      en: "100% on-device — the file never uploads, the clipboard never leaves.",
      hi: "100% डिवाइस पर — फ़ाइल कहीं अपलोड नहीं, क्लिपबोर्ड बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I copy just one paragraph or table?",
        hi: "सिर्फ़ एक पैराग्राफ़ या टेबल कैसे कॉपी करूँ?",
      },
      a: {
        en: "Upload the PDF and click the paragraphs you need on the preview — each click highlights the block. Then pick a format and press Copy. Selected blocks copy in reading order, even across pages.",
        hi: "PDF अपलोड करें और प्रीव्यू पर ज़रूरी पैराग्राफ़ क्लिक करें — हर क्लिक ब्लॉक को हाइलाइट करता है। फिर फ़ॉर्मैट चुनकर कॉपी दबाएँ। चुने ब्लॉक पढ़ने के क्रम में कॉपी होते हैं, पेजों के पार भी।",
      },
    },
    {
      q: {
        en: "Can it copy tables as CSV?",
        hi: "क्या टेबल CSV में कॉपी हो सकती है?",
      },
      a: {
        en: "Pick the CSV format, select the table area's blocks and copy — wide gaps inside a line become columns, every visual line becomes a row. Perfect for aligned tables; tricky multi-line layouts may need a quick tidy-up after pasting.",
        hi: "CSV फ़ॉर्मैट चुनें, टेबल के ब्लॉक सेलेक्ट करके कॉपी करें — लाइन के भीतर बड़े गैप कॉलम बनते हैं, हर लाइन एक रो बनती है। सीधी-सपाट टेबल के लिए बढ़िया; उलझे लेआउट पर पेस्ट के बाद थोड़ी सफ़ाई करनी पड़ सकती है।",
      },
    },
    {
      q: {
        en: "What about scanned PDFs?",
        hi: "स्कैन की हुई PDF का क्या?",
      },
      a: {
        en: "Scanned pages have no clickable text, so the page view shows an honest notice. Press the run button with Scanned pages set to Auto or Always — every page is recognized on-device (English + Hindi) and exported as a .txt or .md file.",
        hi: "स्कैन पेजों में क्लिक करने लायक़ टेक्स्ट नहीं होता, इसलिए पेज व्यू में साफ़ सूचना दिखती है। स्कैन पेज को ऑटो या हमेशा रखकर रन बटन दबाएँ — हर पेज डिवाइस पर पढ़ा जाता है (अंग्रेज़ी + हिंदी) और .txt या .md फ़ाइल बनती है।",
      },
    },
    {
      q: {
        en: "Does a password-protected PDF work?",
        hi: "पासवर्ड-वाली PDF चलती है?",
      },
      a: {
        en: "No — DocoPDF never asks for or stores passwords. Unlock the file first with Unlock PDF, then copy from it.",
        hi: "नहीं — DocoPDF पासवर्ड नहीं माँगता और न संभालता। पहले Unlock PDF से फ़ाइल खोलें, फिर उसमें से कॉपी करें।",
      },
    },
  ],
  chainToolIds: ["txt-to-pdf", "markdown-to-pdf", "ocr-pdf"],
};
