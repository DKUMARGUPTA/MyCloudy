import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Text to PDF (PRD §8.6) — plain .txt (or anything text-ish: .md, .csv,
 * .log) into a cleanly laid-out PDF. Reflow joins blank-line-separated
 * paragraphs; preserve keeps every line as typed. Devanagari blocks embed
 * the self-hosted Noto font; unsupported scripts fail with an honest error
 * instead of shipping tofu. Everything runs in the worker, on-device.
 */
export const config: ToolConfig = {
  toolId: "txt-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 10,
  howKeys: ["txt2pdf.how1", "txt2pdf.how2", "txt2pdf.how3"],
  chainToolIds: ["view-pdf", "merge-pdf", "add-page-numbers"],
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "Letter", hi: "Letter" } },
      ],
      default: "a4",
    },
    {
      kind: "number",
      id: "fontSize",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      min: 8,
      max: 24,
      step: 0.5,
      suffix: { en: "pt", hi: "pt" },
      default: 11,
    },
    {
      kind: "number",
      id: "lineHeight",
      label: { en: "Line height", hi: "लाइन-स्पेसिंग" },
      hint: {
        en: "1.15 is tight, 1.5 is comfortable, 2.0 is airy",
        hi: "1.15 तंग, 1.5 आरामदायक, 2.0 खुला",
      },
      min: 1.15,
      max: 2,
      step: 0.05,
      default: 1.5,
    },
    {
      kind: "number",
      id: "margin",
      label: { en: "Margin", hi: "मार्जिन" },
      min: 10,
      max: 40,
      step: 1,
      suffix: { en: "mm", hi: "mm" },
      default: 20,
    },
    {
      kind: "select",
      id: "mode",
      label: { en: "Layout", hi: "लेआउट" },
      hint: {
        en: "Reflow merges lines into paragraphs; preserve keeps every line break",
        hi: "Reflow लाइनों को पैराग्राफ़ में जोड़ता है; preserve हर लाइन-ब्रेक रखता है",
      },
      choices: [
        {
          value: "reflow",
          label: { en: "Reflow — clean paragraphs", hi: "Reflow — साफ़ पैराग्राफ़" },
        },
        {
          value: "preserve",
          label: { en: "Preserve — keep line breaks", hi: "Preserve — लाइन-ब्रेक रखें" },
        },
      ],
      default: "reflow",
    },
  ],
  features: [
    {
      en: "Reflow joins your lines into clean paragraphs — or keep every line break exactly as typed.",
      hi: "Reflow लाइनों को साफ़ पैराग्राफ़ में जोड़ता है — या हर लाइन-ब्रेक वैसा ही रखें।",
    },
    {
      en: "Pick page size, font size, line height and margins before you run.",
      hi: "चलाने से पहले पेज साइज़, फ़ॉन्ट साइज़, लाइन-स्पेसिंग और मार्जिन चुनें।",
    },
    {
      en: "Hindi and other Devanagari text works out of the box — the font is embedded right inside the PDF.",
      hi: "हिंदी और देवनागरी टेक्स्ट सीधे चलता है — फ़ॉन्ट PDF के अंदर ही जुड़ जाता है।",
    },
    {
      en: "Paragraphs never leave a lone line stranded at a page turn.",
      hi: "पैराग्राफ़ की कोई अकेली लाइन पेज के किनारे नहीं छूटती।",
    },
    {
      en: "Up to 10 files at once — each becomes its own PDF. Nothing is uploaded.",
      hi: "एक साथ 10 फ़ाइलें — हर एक की अपनी PDF। कुछ अपलोड नहीं होता।",
    },
  ],
  faq: [
    {
      q: {
        en: "What kind of files can I convert?",
        hi: "कैसी फ़ाइलें बदल सकते हैं?",
      },
      a: {
        en: "Any plain-text file: .txt, .md, .csv, .log and friends. The tool checks the content itself — if a file is actually binary (an image, a PDF, a zip), it tells you instead of producing garbage.",
        hi: "कोई भी सादा टेक्स्ट फ़ाइल: .txt, .md, .csv, .log वगैरह। टूल कंटेंट खुद जाँचता है — अगर फ़ाइल असल में बाइनरी निकली (तस्वीर, PDF, ज़िप) तो बेकार फ़ाइल बनाने की जगह साफ़ बता देता है।",
      },
    },
    {
      q: {
        en: "What is the difference between Reflow and Preserve?",
        hi: "Reflow और Preserve में क्या फ़र्क़ है?",
      },
      a: {
        en: "Reflow treats blank-line-separated blocks as paragraphs and re-wraps them for the page — best for prose. Preserve keeps every line break and indentation as typed, wrapping only lines that are too long — best for lists, logs and ASCII art.",
        hi: "Reflow खाली-लाइन से अलग हुए हिस्सों को पैराग्राफ़ मानकर पेज के हिसाब से जोड़ता है — गद्य के लिए। Preserve हर लाइन-ब्रेक और इंडेंट जस का तस रखता है, सिर्फ़ बहुत लंबी लाइनें मोड़ता है — लिस्ट, लॉग और ASCII आर्ट के लिए।",
      },
    },
    {
      q: {
        en: "Which languages can it render?",
        hi: "कौन-सी भाषाएँ रेंडर हो सकती हैं?",
      },
      a: {
        en: "All Latin-script languages (English, French, German…) plus Devanagari — Hindi, Marathi, Nepali, Sanskrit — with an embedded font, mixed in the same file. Other scripts (Arabic, Tamil, Chinese…) stop with an honest message instead of printing empty boxes.",
        hi: "सभी लैटिन-लिपि भाषाएँ (अंग्रेज़ी, फ़्रेंच, जर्मन…) और देवनागरी — हिंदी, मराठी, नेपाली, संस्कृत — एम्बेडेड फ़ॉन्ट के साथ, एक ही फ़ाइल में मिलाकर भी। बाक़ी लिपियाँ (अरबी, तमिल, चीनी…) खाली डिब्बे छापने की जगह साफ़ संदेश देकर रुक जाती हैं।",
      },
    },
  ],
};
