import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Flatten PDF (PRD §8.4, Optimize — id FIXED, category optimize).
 *
 * Schema-driven options; every id matches what the worker reads
 * (tools/flatten-pdf/worker.ts): scope ("both" | "forms" | "annotations")
 * and pages (annotation pass only — pdf-lib's form flatten is doc-wide,
 * which the hint states honestly). The engine behind both is
 * tools/flatten-pdf/engine.ts (pure pdf-lib, smoke-locked geometry).
 */
export const config: ToolConfig = {
  toolId: "flatten-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "compress-pdf", "lock-pdf"],
  options: [
    {
      kind: "select",
      id: "scope",
      label: { en: "What to flatten", hi: "क्या फ़्लैटन करें" },
      hint: {
        en: "Forms bakes filled values into the page; annotations merges notes, stamps and highlights into the content.",
        hi: "फ़ॉर्म भरे मान पेज में स्थिर करता है; टिप्पणियाँ नोट्स, स्टैम्प और हाइलाइट को कंटेंट में मिला देती हैं।",
      },
      choices: [
        {
          value: "both",
          label: { en: "Forms + annotations", hi: "फ़ॉर्म + टिप्पणियाँ" },
        },
        { value: "forms", label: { en: "Forms only", hi: "सिर्फ़ फ़ॉर्म" } },
        {
          value: "annotations",
          label: { en: "Annotations only", hi: "सिर्फ़ टिप्पणियाँ" },
        },
      ],
      default: "both",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Applies to the annotation pass only — pdf-lib flattens form fields across the whole document.",
        hi: "सिर्फ़ टिप्पणियों पर लागू — pdf-lib फ़ॉर्म फ़ील्ड पूरे दस्तावेज़ में फ़्लैटन करता है।",
      },
      default: "all",
    },
  ],
  features: [
    {
      en: "Bakes filled form fields into the page so nobody can edit the values — perfect before printing or archiving.",
      hi: "भरे फ़ॉर्म मान पेज में स्थिर कर देता है — प्रिंट या आर्काइव से पहले बिल्कुल सही।",
    },
    {
      en: "Merges annotations — notes, stamps, highlights — into the page content exactly where you see them.",
      hi: "टिप्पणियाँ — नोट्स, स्टैम्प, हाइलाइट — वहीं पेज कंटेंट में मिला देता है जहाँ दिखती हैं।",
    },
    {
      en: "Choose forms only, annotations only, or both — and pick the pages for the annotation pass.",
      hi: "सिर्फ़ फ़ॉर्म, सिर्फ़ टिप्पणियाँ या दोनों चुनें — और टिप्पणियों के लिए पेज भी।",
    },
    {
      en: "Non-editable output that prints and opens the same everywhere — no viewer needed to draw the layers.",
      hi: "नॉन-एडिटेबल आउटपुट हर जगह एक जैसा प्रिंट और खुलता है — लेयर बनाने के लिए व्यूअर की ज़रूरत नहीं।",
    },
    {
      en: "Nothing is uploaded — the PDF is flattened entirely on your device.",
      hi: "कुछ भी अपलोड नहीं होता — पूरी PDF आपके डिवाइस पर ही फ़्लैटन होती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What does flattening actually do to a PDF?",
        hi: "फ़्लैटन करने से PDF में असल में क्या होता है?",
      },
      a: {
        en: "Form fields and annotations are drawn permanently into the page content. The interactive layers are then removed — values can no longer be changed, and notes or stamps become part of the page itself.",
        hi: "फ़ॉर्म फ़ील्ड और टिप्पणियाँ स्थायी रूप से पेज कंटेंट में बना दी जाती हैं। इंटरैक्टिव लेयर हट जाती है — मान बदले नहीं जा सकते और नोट्स या स्टैम्प पेज का हिस्सा बन जाते हैं।",
      },
    },
    {
      q: {
        en: "Why flatten before printing or sharing?",
        hi: "प्रिंट या शेयर करने से पहले फ़्लैटन क्यों?",
      },
      a: {
        en: "Some printers and older viewers skip form fields or draw annotations differently. A flattened PDF looks identical everywhere — the safe format for government portals, printing shops and archival copies.",
        hi: "कुछ प्रिंटर और पुराने व्यूअर फ़ॉर्म फ़ील्ड छोड़ देते हैं या टिप्पणियाँ अलग दिखाते हैं। फ़्लैटन PDF हर जगह एक जैसी दिखती है — सरकारी पोर्टल, प्रिंट शॉप और आर्काइव के लिए सुरक्षित फ़ॉर्मैट।",
      },
    },
    {
      q: {
        en: "What if my PDF has nothing to flatten?",
        hi: "अगर मेरी PDF में फ़्लैटन करने को कुछ नहीं हो तो?",
      },
      a: {
        en: "That is normal, not an error — a PDF without form fields or annotations is already flat. You get the file back unchanged, with a clear note that there was nothing to flatten.",
        hi: "यह आम बात है, ग़लती नहीं — बिना फ़ॉर्म फ़ील्ड या टिप्पणियों वाली PDF पहले से फ़्लैट होती है। फ़ाइल जैसी है वैसी ही वापस मिलती है, साफ़ लिखे के साथ कि फ़्लैटन करने को कुछ नहीं था।",
      },
    },
    {
      q: {
        en: "Can I undo a flatten later?",
        hi: "क्या फ़्लैटन बाद में वापस लिया जा सकता है?",
      },
      a: {
        en: "No — flattening is one-way, so keep your original file. DocoPDF writes a new “-flattened” copy and never touches the file you gave it.",
        hi: "नहीं — फ़्लैटन एकतरफ़ा है, इसलिए अपनी मूल फ़ाइल रखें। DocoPDF नई “-flattened” कॉपी बनाता है और आपकी दी हुई फ़ाइल को छूता नहीं।",
      },
    },
  ],
};
