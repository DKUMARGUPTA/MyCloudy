import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Sanitize PDF (PHASE-1 Batch A): remove active content that antivirus
 * suites, mail filters and security policies flag — document JavaScript,
 * embedded files, external/trigger actions and (optionally) metadata —
 * while keeping every page, font and image byte-exact.
 *
 * Schema-driven switches; the worker runs object-graph surgery on OUR
 * OWN engine (rewriteDocument replacements + deletions).
 */
export const config: ToolConfig = {
  toolId: "sanitize-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "switch",
      id: "stripJavaScript",
      label: { en: "Remove document JavaScript", hi: "दस्तावेज़ JavaScript हटाएँ" },
      hint: {
        en: "Scripts that run when the PDF is opened",
        hi: "स्क्रिप्ट जो PDF खुलने पर चलती हैं",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "stripEmbeddedFiles",
      label: { en: "Remove embedded files", hi: "जुड़ी फ़ाइलें हटाएँ" },
      hint: {
        en: "Attachments hidden inside the PDF",
        hi: "PDF के अंदर छिपी अटैचमेंट",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "stripActions",
      label: { en: "Remove external & trigger actions", hi: "बाहरी और ट्रिगर एक्शन हटाएँ" },
      hint: {
        en: "Open-actions, launch/URI links, form submits",
        hi: "ओपन-एक्शन, लॉन्च/URI लिंक, फ़ॉर्म सबमिट",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "stripMetadata",
      label: { en: "Remove metadata", hi: "मेटाडेटा हटाएँ" },
      hint: {
        en: "XMP metadata and document info (author, dates)",
        hi: "XMP मेटाडेटा और दस्तावेज़ जानकारी (लेखक, तारीख़ें)",
      },
      default: false,
    },
  ],
  chainToolIds: ["lock-pdf", "view-pdf", "remove-pdf-metadata"],
  features: [
    {
      en: "One click removes JavaScript, hidden attachments and trigger actions.",
      hi: "एक क्लिक में JavaScript, छिपी अटैचमेंट और ट्रिगर एक्शन हटाएँ।",
    },
    {
      en: "Every page, font and image stays byte-exact — only the active content goes.",
      hi: "हर पेज, फ़ॉन्ट और तस्वीर बिल्कुल वैसी ही रहती है — सिर्फ़ एक्टिव कंटेंट जाता है।",
    },
    {
      en: "Internal links keep working; external launch/URI actions are cut.",
      hi: "अंदरूनी लिंक चलते रहते हैं; बाहरी लॉन्च/URI एक्शन कट जाते हैं।",
    },
    {
      en: "Optionally strip XMP metadata and document info too.",
      hi: "चाहें तो XMP मेटाडेटा और दस्तावेज़ जानकारी भी हटाएँ।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly gets removed?",
        hi: "ठीक क्या हटाया जाता है?",
      },
      a: {
        en: "Document JavaScript (scripts that run on open), files embedded inside the PDF, and active actions: open-actions, launch/URI links, movie and sound triggers, form submits. Internal links and bookmarks keep working. Optionally the XMP metadata and document info go too.",
        hi: "दस्तावेज़ JavaScript (खुलने पर चलने वाली स्क्रिप्ट), PDF के अंदर जुड़ी फ़ाइलें, और एक्टिव एक्शन: ओपन-एक्शन, लॉन्च/URI लिंक, मूवी-साउंड ट्रिगर, फ़ॉर्म सबमिट। अंदरूनी लिंक और बुकमार्क चलते रहते हैं। चाहें तो XMP मेटाडेटा और दस्तावेज़ जानकारी भी हट जाती है।",
      },
    },
    {
      q: {
        en: "Why sanitize a PDF at all?",
        hi: "PDF सैनिटाइज करने की ज़रूरत क्यों?",
      },
      a: {
        en: "Mail servers and antivirus policies often reject PDFs that carry JavaScript or embedded files — even harmless ones. Sanitizing produces a quiet, static document that passes those filters, which is also what many government upload portals require.",
        hi: "मेल सर्वर और एंटीवायरस नीतियाँ अकसर ऐसी PDF मना कर देती हैं जिनमें JavaScript या जुड़ी फ़ाइलें हों — भले ही वे निर्दोष हों। सैनिटाइज़ करने से एक शांत, स्टैटिक दस्तावेज़ बनता है जो उन फ़िल्टरों से गुज़रता है — कई सरकारी अपलोड पोर्टल भी यही माँगते हैं।",
      },
    },
    {
      q: {
        en: "My PDF is password-protected — can I sanitize it?",
        hi: "मेरी PDF पासवर्ड वाली है — क्या उसे सैनिटाइज कर सकते हैं?",
      },
      a: {
        en: "Unlock it first (Remove PDF password), then sanitize. Encrypted documents are refused here because rewriting an encrypted graph safely requires the keys.",
        hi: "पहले अनलॉक करें (PDF पासवर्ड हटाएँ), फिर सैनिटाइज़ करें। एन्क्रिप्टेड दस्तावेज़ यहाँ मना हैं, क्योंकि एन्क्रिप्टेड ग्राफ़ को सुरक्षित दोबारा लिखने के लिए कुंजियाँ चाहिए।",
      },
    },
  ],
};
