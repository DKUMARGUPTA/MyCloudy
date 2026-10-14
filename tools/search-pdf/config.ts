import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Search PDFs config (PRD §7.5/§8.5).
 *
 * All controls (query, text/regex mode, case, whole words, context size)
 * live in the custom panel — the split-pdf precedent: the options schema is
 * intentionally empty, the panel owns the interactive values and the worker
 * defaults + normalizes every option defensively via resolveSearchOptions.
 *
 * The run writes ONE human-readable report file ("search-results.txt");
 * the interactive part — the live first-file preview with jump-to-viewer —
 * is the workspace surface.
 */
export const config: ToolConfig = {
  toolId: "search-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 20,
  options: [],
  // "Jump to the match's page" — the report chains into the viewer.
  chainToolIds: ["view-pdf"],
  features: [
    {
      en: "Search plain text or a full regular expression, across up to 20 PDFs at once.",
      hi: "साधारण टेक्स्ट या पूरा regex — एक साथ 20 तक PDF में खोजें।",
    },
    {
      en: "Case-sensitive and whole-word options, plus a live preview that shows matches as you type.",
      hi: "केस-सेंसिटिव और पूरे-शब्द विकल्प, और लाइव प्रीव्यू जो टाइपते ही मैच दिखाता है।",
    },
    {
      en: "Every match comes with page number and context — jump straight into the viewer at that page.",
      hi: "हर मैच के साथ पेज नंबर और संदर्भ — उसी पेज पर सीधे व्यूअर में जाएँ।",
    },
    {
      en: "The run writes one clean report file listing every match in every file.",
      hi: "चलाने पर एक साफ़ रिपोर्ट फ़ाइल बनती है जिसमें हर फ़ाइल के सारे मैच होते हैं।",
    },
    {
      en: "Devanagari text (Hindi) searches correctly — everything happens on your device.",
      hi: "देवनागरी (हिंदी) टेक्स्ट सही खोजा जाता है — सब कुछ आपके डिवाइस पर ही।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I search with a regular expression?",
        hi: "क्या regex से खोज सकते हैं?",
      },
      a: {
        en: "Yes — switch Match type to Regex and type any JavaScript regular expression, like \\d{4} for years or invoice\\s*#?\\d+. Case sensitivity still applies.",
        hi: "हाँ — Match type को Regex करें और कोई भी JavaScript regex लिखें, जैसे सालों के लिए \\d{4}। केस सेंसिटिविटी लागू रहती है।",
      },
    },
    {
      q: {
        en: "Why does the preview only show the first file?",
        hi: "प्रीव्यू सिर्फ़ पहली फ़ाइल क्यों दिखाता है?",
      },
      a: {
        en: "The preview searches the first file live so you stay fast while typing. Press the run button and every file is searched — the report lists each match with its page number.",
        hi: "प्रीव्यू पहली फ़ाइल में लाइव खोजता है ताकि टाइपिंग तेज़ रहे। रन दबाने पर सभी फ़ाइलों में खोज होती है — रिपोर्ट में हर मैच अपने पेज नंबर के साथ होता है।",
      },
    },
    {
      q: {
        en: "What about scanned PDFs?",
        hi: "स्कैन की PDF का क्या?",
      },
      a: {
        en: "A scan has no selectable text until it is OCR'd, so it shows no matches. Run it through the PDF OCR tool first — it lays an invisible text layer under the scan — then search here.",
        hi: "स्कैन में OCR होने तक कोई चुनने लायक़ टेक्स्ट नहीं होता, इसलिए मैच नहीं दिखते। पहले PDF OCR टूल से उसे खोजने योग्य बनाएँ — फिर यहाँ खोजें।",
      },
    },
  ],
};
