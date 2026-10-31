import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Sanitize PDF — the one-tap privacy clean before you share a file:
 * comments/links/form fields, hidden page data, document metadata and
 * embedded JavaScript are all stripped, leaving only clean page content.
 * 100% on-device own-engine rebuild.
 */
export const config: ToolConfig = {
  toolId: "sanitize-pdf",
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
      id: "annotations",
      label: { en: "Remove annotations", hi: "एनोटेशन हटाएँ" },
      hint: {
        en: "Comments, highlights, links and form fields — page content stays.",
        hi: "टिप्पणियाँ, हाइलाइट, लिंक और फ़ॉर्म फ़ील्ड — पेज कंटेंट रहेगा।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "hiddenData",
      label: { en: "Remove hidden page data", hi: "छिपा पेज डेटा हटाएँ" },
      hint: {
        en: "Private page add-ons apps leave behind (PieceInfo, page metadata).",
        hi: "ऐप्स के छोड़े पेज ऐड-ऑन (PieceInfo, पेज मेटाडेटा)।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "scripts",
      label: { en: "Remove scripts & actions", hi: "स्क्रिप्ट और ऐक्शन हटाएँ" },
      hint: {
        en: "Embedded JavaScript, auto-run actions — the rebuilt file has none.",
        hi: "जुड़ी जावास्क्रिप्ट, ऑटो-रन ऐक्शन — नई फ़ाइल में कुछ नहीं।",
      },
      default: true,
    },
  ],
  chainToolIds: ["lock-pdf", "compress-pdf", "repair-pdf"],
  features: [
    {
      en: "One tap strips comments, links, form fields and hidden page data.",
      hi: "एक टैप में टिप्पणियाँ, लिंक, फ़ॉर्म फ़ील्ड और छिपा डेटा साफ़।",
    },
    {
      en: "Document metadata (author, dates, app trails) never survives the rebuild.",
      hi: "दस्तावेज़ मेटाडेटा (लेखक, तारीख़ें, ऐप निशान) नई फ़ाइल में पहुँचता ही नहीं।",
    },
    {
      en: "Embedded JavaScript and auto-run actions are dropped — safe to open anywhere.",
      hi: "जुड़ी जावास्क्रिप्ट और ऑटो-रन ऐक्शन हट जाते हैं — कहीं भी खोलने लायक।",
    },
    {
      en: "Batch up to 5 files in one run — one clean output per file.",
      hi: "एक बार में 5 फ़ाइलें — हर फ़ाइल का अपना साफ़ आउटपुट।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference from Remove metadata?",
        hi: "'मेटाडेटा हटाएँ' से यह कैसे अलग है?",
      },
      a: {
        en: "Remove metadata only cleans the document info. Sanitize goes further: comments, highlights, links, form fields, hidden page data AND metadata — everything invisible that could leak, in one rebuild.",
        hi: "'मेटाडेटा हटाएँ' सिर्फ़ दस्तावेज़ की जानकारी साफ़ करता है। सैनिटाइज़ आगे जाता है: टिप्पणियाँ, हाइलाइट, लिंक, फ़ॉर्म फ़ील्ड, छिपा पेज डेटा और मेटाडेटा — एक ही बार में सब।",
      },
    },
    {
      q: {
        en: "Will my visible text and images stay the same?",
        hi: "क्या दिखने वाला टेक्स्ट और चित्र वैसे ही रहेंगे?",
      },
      a: {
        en: "Yes — page content streams are copied byte-exact. Only the invisible layer (annotations, scripts, metadata) is removed.",
        hi: "हाँ — पेज कंटेंट बाइट-एक्ज़ैक्ट कॉपी होता है। सिर्फ़ अदृश्य परत (एनोटेशन, स्क्रिप्ट, मेटाडेटा) हटती है।",
      },
    },
    {
      q: {
        en: "Does sanitizing remove passwords?",
        hi: "क्या सैनिटाइज़ पासवर्ड हटा देता है?",
      },
      a: {
        en: "No — password-protected files are refused with a clear message; unlock first, then sanitize.",
        hi: "नहीं — पासवर्ड वाली फ़ाइल साफ़ संदेश के साथ अस्वीकार होती है; पहले अनलॉक करें, फिर सैनिटाइज़।",
      },
    },
  ],
};
