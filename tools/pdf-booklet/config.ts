import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF booklet (PHASE-1 Batch A): saddle-stitch imposition — rebuild the
 * document as landscape sheets carrying two portrait pages each, in the
 * imposition order print shops use. Print duplex (flip on SHORT edge),
 * stack the sheets, fold down the middle and staple: the pages read in
 * order as a little book.
 *
 * Schema-driven; the worker embeds each page once as a Form XObject on
 * OUR OWN engine and composes the imposed sheets.
 */
export const config: ToolConfig = {
  toolId: "pdf-booklet",
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
      id: "paper",
      label: { en: "Paper size", hi: "पेपर साइज़" },
      hint: {
        en: "The sheet you will print on — the booklet pages become half this size",
        hi: "जिस शीट पर प्रिंट करेंगे — बुकलेट के पेज इसके आधे साइज़ के बनते हैं",
      },
      choices: [
        { value: "a4", label: { en: "A4 → A5 booklet", hi: "A4 → A5 बुकलेट" } },
        {
          value: "letter",
          label: { en: "Letter → half-letter booklet", hi: "Letter → आधा-Letter बुकलेट" },
        },
        { value: "a3", label: { en: "A3 → A4 booklet", hi: "A3 → A4 बुकलेट" } },
        {
          value: "tabloid",
          label: { en: "Tabloid → Letter booklet", hi: "Tabloid → Letter बुकलेट" },
        },
        { value: "legal", label: { en: "Legal → half-legal booklet", hi: "Legal → आधा-Legal बुकलेट" } },
      ],
      default: "a4",
    },
    {
      kind: "number",
      id: "margin",
      label: { en: "Sheet margin", hi: "शीट मार्जिन" },
      suffix: { en: "mm", hi: "mm" },
      min: 0,
      max: 30,
      default: 0,
    },
    {
      kind: "number",
      id: "gap",
      label: { en: "Gap at the fold", hi: "फोल्ड पर गैप" },
      suffix: { en: "mm", hi: "mm" },
      min: 0,
      max: 30,
      default: 0,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages make the booklet — all, or a range like 1-12",
        hi: "बुकलेट कौन से पेजों का बने — सभी, या 1-12 जैसी रेंज",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["pages-per-sheet", "merge-pdf", "view-pdf"],
  features: [
    {
      en: "Real saddle-stitch imposition — the same order print shops use.",
      hi: "असली सैडल-स्टिच इम्पोज़िशन — वही क्रम जो प्रिंट शॉप इस्तेमाल करती हैं।",
    },
    {
      en: "A4 → A5 booklets, A3 → A4, Letter, Tabloid, Legal — five paper sizes.",
      hi: "A4 → A5 बुकलेट, A3 → A4, Letter, Tabloid, Legal — पाँच पेपर साइज़।",
    },
    {
      en: "Blank pages are auto-added so the sheet count always folds cleanly.",
      hi: "खाली पेज अपने आप जुड़ते हैं, ताकि शीट संख्या साफ़ फोल्ड हो।",
    },
    {
      en: "Print duplex “flip on short edge”, stack, fold, staple — done.",
      hi: "दोनों तरफ़ प्रिंट करें “छोटे किनारे पर पलटें”, जमा करें, मोड़ें, स्टेपल करें — तैयार।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I print the result correctly?",
        hi: "नतीजा सही तरीके से कैसे प्रिंट करूँ?",
      },
      a: {
        en: "Print the whole imposed file double-sided with “flip on short edge”, keep the sheets in order as they come out, fold the stack down the middle and staple near the fold. The pages then read in normal order.",
        hi: "पूरी इम्पोज़्ड फ़ाइल दोनों तरफ़ प्रिंट करें, “छोटे किनारे पर पलटें” मोड पर; शीट उसी क्रम में रखें जैसे निकलीं, पूरा ढेर बीच से मोड़ें और फोल्ड के पास स्टेपल करें। पेज फिर सामान्य क्रम में पढ़े जाएँगे।",
      },
    },
    {
      q: {
        en: "Why did my booklet gain blank pages?",
        hi: "मेरे बुकलेट में खाली पेज क्यों जुड़ गए?",
      },
      a: {
        en: "Booklets need a page count that is a multiple of 4 (each folded sheet carries 4 booklet pages). The tool adds blank pages at the end to reach the next multiple of 4 — trim or keep them as note space.",
        hi: "बुकलेट के पेज संख्या 4 का गुणज चाहिए (हर मुड़ी शीट में 4 बुकलेट पेज होते हैं)। टूल अंत में खाली पेज जोड़कर अगला 4 का गुणज बनाता है — हटा दें या नोट की जगह की तरह रखें।",
      },
    },
    {
      q: {
        en: "Can I make a booklet from just some pages?",
        hi: "क्या सिर्फ़ कुछ पेजों का बुकलेट बना सकते हैं?",
      },
      a: {
        en: "Yes — enter a range like 1-12 in Pages and only those pages are imposed; every other page is left out of the booklet entirely.",
        hi: "हाँ — पेज में 1-12 जैसी रेंज लिखें, सिर्फ़ उन्हीं पेजों की इम्पोज़िशन होगी; बाकी पेज बुकलेट में शामिल ही नहीं होंगे।",
      },
    },
  ],
};
