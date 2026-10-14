import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Copy from PDF (PRD §7.1, §8.1 table) — pull text out of any PDF,
 * including scans. Embedded text is read directly (instant); pages
 * without selectable text fall back to on-device OCR — automatically in
 * Auto mode, for every page in Always mode, never in Fast mode.
 */
export const config: ToolConfig = {
  toolId: "copy-from-pdf",
  createWorker: () =>
    new Worker(new URL("../ocr/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  options: [
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
      label: { en: "Layout", hi: "लेआउट" },
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
      en: "Text from normal PDFs is read instantly — no OCR wait, no model download.",
      hi: "सामान्य PDF का टेक्स्ट तुरंत निकलता है — न OCR का इंतज़ार, न मॉडल डाउनलोड।",
    },
    {
      en: "Scanned pages are detected automatically and recognized on-device — the file never uploads.",
      hi: "स्कैन पेज अपने आप पहचाने जाते हैं और डिवाइस पर ही पढ़े जाते हैं — फ़ाइल कहीं अपलोड नहीं होती।",
    },
    {
      en: "English and Hindi OCR built in; models download once, then work offline.",
      hi: "अंग्रेज़ी और हिंदी OCR शामिल; मॉडल एक बार डाउनलोड, फिर ऑफ़लाइन।",
    },
    {
      en: "Flow layout rebuilds paragraphs — copy-paste into any editor reads like the original.",
      hi: "Flow लेआउट पैराग्राफ़ बनाता है — किसी भी एडिटर में पेस्ट करने पर मूल जैसा पढ़ा जाता है।",
    },
    {
      en: "Page ranges and page markers keep citations easy.",
      hi: "पेज रेंज और पेज मार्कर — हवाले देना आसान।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between Auto and Always OCR?",
        hi: "ऑटो और हमेशा OCR में क्या फ़र्क़ है?",
      },
      a: {
        en: "Auto reads embedded text where it exists and only runs OCR on pages that have none — the fastest honest result. Always re-recognizes every page with OCR, useful when a PDF's embedded text is broken or mismatched.",
        hi: "ऑटो जहाँ टेक्स्ट मौजूद है वहीं पढ़ता है, सिर्फ़ खाली पेजों पर OCR चलाता है — सबसे तेज़ ईमानदार नतीजा। हमेशा हर पेज को OCR से दोबारा पढ़ता है — तब उपयोगी जब PDF का जुड़ा टेक्स्ट खराब हो।",
      },
    },
    {
      q: {
        en: "Can it copy tables as CSV?",
        hi: "क्या टेबल CSV में कॉपी हो सकती है?",
      },
      a: {
        en: "Table-aware CSV export is on the roadmap — today you get the text of the page in clean reading order, and tables come through as aligned lines.",
        hi: "टेबल-जागरूक CSV एक्सपोर्ट रोडमैप पर है — आज आपको पेज का टेक्स्ट साफ़ पढ़ने के क्रम में मिलता है, और टेबलें सीधी लाइनों में आती हैं।",
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
  chainToolIds: ["txt-to-pdf", "markdown-to-pdf"],
};
