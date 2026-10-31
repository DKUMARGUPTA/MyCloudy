import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add page labels (PHASE-1 Batch B): set the /PageLabels numbering your
 * PDF viewer shows — prefixes (“A-”, “Page ”), Roman numerals for front
 * matter, letters for appendices. The viewer's page box and page
 * thumbnails switch to these labels; printing programs honour them too.
 */
export const config: ToolConfig = {
  toolId: "add-page-labels",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "style",
      label: { en: "Numbering style", hi: "नंबरिंग स्टाइल" },
      choices: [
        { value: "decimal", label: { en: "1, 2, 3…", hi: "1, 2, 3…" } },
        { value: "roman-lower", label: { en: "i, ii, iii…", hi: "i, ii, iii…" } },
        { value: "roman-upper", label: { en: "I, II, III…", hi: "I, II, III…" } },
        { value: "letters-lower", label: { en: "a, b, c…", hi: "a, b, c…" } },
        { value: "letters-upper", label: { en: "A, B, C…", hi: "A, B, C…" } },
        { value: "none", label: { en: "No number — prefix only", hi: "कोई नंबर नहीं — सिर्फ़ उपसर्ग" } },
      ],
      default: "decimal",
    },
    {
      kind: "text",
      id: "prefix",
      label: { en: "Prefix", hi: "उपसर्ग" },
      hint: {
        en: "Shown before every label — e.g. “A-” gives A-1, A-2…",
        hi: "हर लेबल से पहले — जैसे “A-” से A-1, A-2…",
      },
      placeholder: { en: "A-", hi: "A-" },
      default: "",
    },
    {
      kind: "number",
      id: "start",
      label: { en: "Start number", hi: "शुरुआती नंबर" },
      min: 1,
      max: 999999,
      default: 1,
    },
    {
      kind: "switch",
      id: "coverUnlabeled",
      label: { en: "Leave the first page unlabelled", hi: "पहला पेज बिना लेबल छोड़ें" },
      hint: {
        en: "The classic “Cover, then i, ii, iii…” layout",
        hi: "क्लासिक “कवर, फिर i, ii, iii…” लेआउट",
      },
      default: false,
    },
  ],
  chainToolIds: ["view-pdf", "merge-pdf", "bookmark-pdf"],
  features: [
    {
      en: "Viewer-native page labels — the page box shows them, not plain 1..N.",
      hi: "व्यूअर के असली पेज लेबल — पेज बॉक्स में साधारण 1..N की जगह यही दिखते हैं।",
    },
    {
      en: "Prefix support: “A-”, “Page ”, “Exhibit ” — with 1..N or without numbers.",
      hi: "उपसर्ग सपोर्ट: “A-”, “Page ”, “Exhibit ” — नंबर के साथ या बिना।",
    },
    {
      en: "Roman numerals for front matter, letters for appendices.",
      hi: "शुरुआती हिस्से के लिए रोमन अंक, परिशिष्ट के लिए अक्षर।",
    },
    {
      en: "Classic “Cover, then i, ii, iii…” layout in one switch.",
      hi: "एक स्विच में क्लासिक “कवर, फिर i, ii, iii…” लेआउट।",
    },
    {
      en: "Content untouched — only the numbering metadata changes.",
      hi: "सामग्री जस की तस — सिर्फ़ नंबरिंग मेटाडेटा बदलता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Where do these labels appear?",
        hi: "ये लेबल कहाँ दिखते हैं?",
      },
      a: {
        en: "In every spec-following viewer's page box and thumbnails (Acrobat, Firefox, Chrome's PDF viewer, macOS Preview), and page-reference features like “go to page A-4” use them. The printed page content itself is not changed.",
        hi: "हर स्टैंडर्ड व्यूअर के पेज बॉक्स और थंबनेल में (Acrobat, Firefox, Chrome का PDF व्यूअर, macOS Preview), और “पेज A-4 पर जाएँ” जैसी सुविधाएँ इन्हें मानती हैं। छपे हुए पेज की सामग्री नहीं बदलती।",
      },
    },
    {
      q: {
        en: "Can I combine styles — Roman for front matter, numbers after?",
        hi: "क्या स्टाइल मिला सकते हैं — शुरू में रोमन, बाद में नंबर?",
      },
      a: {
        en: "This tool applies one style to the whole document (with an optional unlabelled cover). For multi-section schemes, run it on page subsets and merge the results, or ask for the advanced ranges feature.",
        hi: "यह टूल पूरे दस्तावेज़ पर एक स्टाइल लगाता है (कवर छोड़ने का विकल्प के साथ)। कई सेक्शन वाली स्कीम के लिए पेज-सबसेट पर चलाकर मिलाएँ, या एडवांस्ड रेंज फ़ीचर माँगें।",
      },
    },
    {
      q: {
        en: "Does this renumber the visible page content?",
        hi: "क्या यह दिखने वाले पेज कंटेंट के नंबर बदलता है?",
      },
      a: {
        en: "No — page labels are metadata the VIEWER uses. Text printed inside the pages stays exactly as it was (use Add page numbers for that).",
        hi: "नहीं — पेज लेबल वह मेटाडेटा है जो व्यूअर इस्तेमाल करता है। पेजों के अंदर छपा टेक्स्ट जस का तस रहता है (उसके लिए पेज नंबर लगाएँ टूल है)।",
      },
    },
  ],
};
