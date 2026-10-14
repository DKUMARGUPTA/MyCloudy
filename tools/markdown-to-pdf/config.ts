import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Markdown to PDF (PRD §8.6) — READMEs and notes rendered to a clean PDF:
 * headings h1-h6, bold/italic/inline code, ordered + nested lists, code
 * blocks on gray backgrounds, blockquotes with a bar, rules, and links as
 * blue text with numbered footnotes plus a Links section at the end. The
 * mdast parser runs inside the worker; the layout engine is shared with
 * txt-to-pdf (tools/txt-to-pdf/text-layout.ts). Device-only.
 */
export const config: ToolConfig = {
  toolId: "markdown-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  howKeys: ["md2pdf.how1", "md2pdf.how2", "md2pdf.how3"],
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
      id: "bodySize",
      label: { en: "Body size", hi: "बॉडी साइज़" },
      choices: [
        { value: "10", label: { en: "10 pt — compact", hi: "10 pt — एकदम संकरा" } },
        { value: "11", label: { en: "11 pt — comfortable", hi: "11 pt — आरामदायक" } },
        { value: "12", label: { en: "12 pt — large", hi: "12 pt — बड़ा" } },
      ],
      default: "11",
    },
    {
      kind: "select",
      id: "monoSize",
      label: { en: "Code size", hi: "कोड साइज़" },
      choices: [
        { value: "8", label: { en: "8 pt", hi: "8 pt" } },
        { value: "9", label: { en: "9 pt", hi: "9 pt" } },
        { value: "10", label: { en: "10 pt", hi: "10 pt" } },
      ],
      default: "9",
    },
    {
      kind: "select",
      id: "theme",
      label: { en: "Theme", hi: "थीम" },
      choices: [
        { value: "clean", label: { en: "Clean — white paper", hi: "Clean — सफ़ेद काग़ज़" } },
        {
          value: "warm",
          label: { en: "Warm paper — cream background", hi: "Warm paper — क्रीम बैकग्राउंड",
          },
        },
      ],
      default: "clean",
    },
  ],
  features: [
    {
      en: "Headings, lists and code blocks rendered as real typography — not a screenshot.",
      hi: "हेडिंग, लिस्ट और कोड-ब्लॉक असली टाइपोग्राफ़ी में — स्क्रीनशॉट नहीं।",
    },
    {
      en: "Bold, italic, inline code, blockquotes and rules, with clean page breaks that never strand a heading.",
      hi: "बोल्ड, इटैलिक, इनलाइन कोड, कोट और रूल — हेडिंग पेज के आख़िर में अटकती नहीं।",
    },
    {
      en: "Links stay clickable-looking in blue, with numbered footnotes and a Links list at the end.",
      hi: "लिंक नीले रंग में रहते हैं — नंबर वाले फुटनोट और आख़िर में लिंक-सूची के साथ।",
    },
    {
      en: "Hindi markdown works too — Devanagari is embedded straight into the PDF.",
      hi: "हिंदी मार्कडाउन भी चलता है — देवनागरी फ़ॉन्ट PDF के अंदर ही जुड़ता है।",
    },
    {
      en: "Warm paper theme for long reads. Everything happens on your device.",
      hi: "लंबी रीडिंग के लिए Warm paper थीम। सब कुछ आपके डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is supported — and what is not?",
        hi: "क्या चलता है — और क्या नहीं?",
      },
      a: {
        en: "Supported: headings, paragraphs, bold, italic, inline code, links, ordered and nested lists, code blocks, blockquotes and rules. Not yet: images (their alt text shows in brackets), raw HTML blocks and GFM tables (they fall back to plain text) and syntax coloring inside code.",
        hi: "चलता है: हेडिंग, पैराग्राफ़, बोल्ड, इटैलिक, इनलाइन कोड, लिंक, क्रमांकित और नेस्टेड लिस्ट, कोड-ब्लॉक, कोट और रूल। अभी नहीं: तस्वीरें (उनका alt टेक्स्ट कोष्ठक में दिखता है), रॉ HTML और GFM टेबल (सादा टेक्स्ट में गिरते हैं) और कोड में रंग।",
      },
    },
    {
      q: {
        en: "Why are links footnotes instead of clickable?",
        hi: "लिंक क्लिक करने लायक़ क्यों नहीं, फुटनोट क्यों?",
      },
      a: {
        en: "Keeping everything on-device means we draw text ourselves; reliable link annotations come later. For now every link prints in blue with a [1]-style marker, and the exact URLs are listed in a Links section on the last page — nothing is lost when printed.",
        hi: "सब कुछ डिवाइस पर रखने का मतलब है कि हम टेक्स्ट खुद बनाते हैं; भरोसेमंद क्लिक-एबल लिंक बाद में आएँगे। फ़िलहाल हर लिंक नीला छपता है [1] मार्कर के साथ, और सही URL आख़िरी पेज की Links सूची में होते हैं — प्रिंट करने पर भी कुछ नहीं खोता।",
      },
    },
    {
      q: {
        en: "Does bold Hindi text turn bold?",
        hi: "बोल्ड हिंदी टेक्स्ट बोल्ड होता है?",
      },
      a: {
        en: "Not yet, honestly. Latin text has real bold and italic; Devanagari currently embeds one regular Noto font, so **Hindi emphasis** renders as regular text. The words never break or turn into boxes — that trade was deliberate.",
        hi: "अभी नहीं, साफ़ बता दें। लैटिन टेक्स्ट में असली बोल्ड-इटैलिक है; देवनागरी में फ़िलहाल एक रेगुलर Noto फ़ॉन्ट जुड़ता है, इसलिए **हिंदी इम्फ़ेसिस** रेगुलर दिखता है। शब्द कभी नहीं टूटते या डिब्बे नहीं बनते — यही जान-बूझकर चुनी गई समझौता है।",
      },
    },
  ],
};
