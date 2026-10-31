import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove annotations (PHASE-1 Batch C): strip comments, highlights,
 * sticky notes, links and markups — clean the review residue off a
 * document before shipping it. Form fields can be kept or flattened
 * away with one switch.
 */
export const config: ToolConfig = {
  toolId: "remove-annotations",
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
      id: "keepForms",
      label: { en: "Keep form fields", hi: "फ़ॉर्म फ़ील्ड रखें" },
      hint: {
        en: "Unchecked removes fillable fields too",
        hi: "बंद रखने पर भरने योग्य फ़ील्ड भी हटते हैं",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "keepLinks",
      label: { en: "Keep internal links", hi: "अंदरूनी लिंक रखें" },
      hint: {
        en: "Table-of-contents and cross-reference links stay",
        hi: "विषय-सूची और क्रॉस-रेफ़रेंस लिंक बचे रहते हैं",
      },
      default: true,
    },
  ],
  chainToolIds: ["flatten-pdf", "sanitize-pdf", "view-pdf"],
  features: [
    {
      en: "Strip comments, highlights, sticky notes and markups in one pass.",
      hi: "टिप्पणियाँ, हाइलाइट, स्टिकी नोट और मार्कअप एक ही चलन में हटाएँ।",
    },
    {
      en: "Keep fillable form fields, or remove them too.",
      hi: "भरने योग्य फ़ॉर्म फ़ील्ड रखें, या उन्हें भी हटाएँ।",
    },
    {
      en: "Keep internal links — or scrub everything for a quiet document.",
      hi: "अंदरूनी लिंक रखें — या पूरी तरह साफ़ दस्तावेज़ के लिए सब मिटाएँ।",
    },
    {
      en: "Page content is untouched — only the annotation layer goes.",
      hi: "पेज की सामग्री जस की तस — सिर्फ़ एनोटेशन परत जाती है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What counts as an annotation?",
        hi: "एनोटेशन किसे गिनते हैं?",
      },
      a: {
        en: "Everything in the review layer: comments, highlights, underlines, sticky notes, drawings, stamps, attached notes and link boxes. The page's own text and images are NOT annotations — they stay.",
        hi: "समीक्षा परत की हर चीज़: टिप्पणियाँ, हाइलाइट, रेखांकन, स्टिकी नोट, बनावटें, स्टाम्प, जुड़े नोट और लिंक बॉक्स। पेज का अपना टेक्स्ट और तस्वीरें एनोटेशन नहीं हैं — वे रहती हैं।",
      },
    },
    {
      q: {
        en: "Will my form still be fillable?",
        hi: "क्या मेरा फ़ॉर्म अब भी भरा जा सकेगा?",
      },
      a: {
        en: "Yes if you leave “Keep form fields” on — text boxes, checkboxes and dropdowns stay live. Turn it off and the field widgets are removed too (the printed values on the page remain).",
        hi: "हाँ, अगर “फ़ॉर्म फ़ील्ड रखें” चालू रखें — टेक्स्ट बॉक्स, चेकबॉक्स और ड्रॉपडाउन चालू रहते हैं। बंद करें तो फ़ील्ड विजेट भी हटते हैं (पेज पर छपे मान रहते हैं)।",
      },
    },
    {
      q: {
        en: "Do I lose my highlights' text?",
        hi: "क्या हाइलाइट का टेक्स्ट भी जाता है?",
      },
      a: {
        en: "No — a highlight only MARKS existing text. Removing it keeps the text and loses just the coloured overlay.",
        hi: "नहीं — हाइलाइट सिर्फ़ मौजूदा टेक्स्ट को चिह्नित करता है। हटाने पर टेक्स्ट रहता है, सिर्फ़ रंगीन परत जाती है।",
      },
    },
  ],
};
