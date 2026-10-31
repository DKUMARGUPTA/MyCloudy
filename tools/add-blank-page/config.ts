import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add blank page (PHASE-1 Batch A): insert one or more empty pages at the
 * start, the end, or after any page. The blank matches a chosen size —
 * page 1 of the document, the largest page, or a standard paper size.
 *
 * Schema-driven; the worker builds the plan on OUR OWN engine using the
 * organize writer's native blank entries (no raster, no fonts — truly
 * empty pages).
 */
export const config: ToolConfig = {
  toolId: "add-blank-page",
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
      id: "position",
      label: { en: "Where to insert", hi: "कहाँ जोड़ें" },
      choices: [
        { value: "start", label: { en: "At the start", hi: "शुरुआत में" } },
        { value: "end", label: { en: "At the end", hi: "अंत में" } },
        {
          value: "after",
          label: { en: "After a page…", hi: "किसी पेज के बाद…" },
        },
      ],
      default: "end",
    },
    {
      kind: "number",
      id: "afterPage",
      label: { en: "After page", hi: "इस पेज के बाद" },
      hint: {
        en: "Insert after this page number",
        hi: "इस पेज नंबर के बाद जोड़ें",
      },
      min: 1,
      max: 5000,
      default: 1,
      showWhen: { id: "position", equals: "after" },
    },
    {
      kind: "number",
      id: "count",
      label: { en: "How many pages", hi: "कितने पेज" },
      min: 1,
      max: 100,
      default: 1,
    },
    {
      kind: "select",
      id: "size",
      label: { en: "Blank page size", hi: "खाली पेज का साइज़" },
      choices: [
        {
          value: "page1",
          label: { en: "Match page 1", hi: "पेज 1 जैसा" },
        },
        {
          value: "largest",
          label: { en: "Match the largest page", hi: "सबसे बड़े पेज जैसा" },
        },
        {
          value: "a4",
          label: { en: "A4", hi: "A4" },
        },
        {
          value: "letter",
          label: { en: "US Letter", hi: "US Letter" },
        },
      ],
      default: "page1",
    },
  ],
  chainToolIds: ["merge-pdf", "view-pdf", "pages-per-sheet"],
  features: [
    {
      en: "Insert blank pages at the start, the end, or right after any page.",
      hi: "खाली पेज शुरुआत में, अंत में या किसी भी पेज के ठीक बाद जोड़ें।",
    },
    {
      en: "Add up to 100 pages in one run — great for note space or section breaks.",
      hi: "एक बार में 100 तक पेज जोड़ें — नोट्स की जगह या सेक्शन ब्रेक के लिए।",
    },
    {
      en: "The blank matches page 1, the largest page, A4 or US Letter.",
      hi: "खाली पेज पेज 1, सबसे बड़े पेज, A4 या US Letter जैसा हो सकता है।",
    },
    {
      en: "Truly empty pages — no hidden text, no fonts, nothing to bloat the file.",
      hi: "बिल्कुल खाली पेज — कोई छिपा टेक्स्ट नहीं, कोई फ़ॉन्ट नहीं, फ़ाइल भारी नहीं होती।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Where exactly can the blank pages go?",
        hi: "खाली पेज ठीक कहाँ जोड़े जा सकते हैं?",
      },
      a: {
        en: "Anywhere: before page 1, after the last page, or after any page number you pick — for example “after page 3” puts the blanks between pages 3 and 4.",
        hi: "कहीं भी: पेज 1 से पहले, आख़िरी पेज के बाद, या आपके चुने किसी भी पेज नंबर के बाद — जैसे “पेज 3 के बाद” खाली पेज 3 और 4 के बीच आएँगे।",
      },
    },
    {
      q: {
        en: "What size are the blank pages?",
        hi: "खाली पेज किस साइज़ के होते हैं?",
      },
      a: {
        en: "By default each blank matches page 1 of your document, so it blends in. You can also match the largest page (handy for mixed-size scans) or force A4 / US Letter.",
        hi: "डिफ़ॉल्ट रूप से हर खाली पेज आपके दस्तावेज़ के पेज 1 जैसा होता है, ताकि वह घुल-मिल जाए। आप सबसे बड़े पेज जैसा (मिक्स-साइज़ स्कैन के लिए) या A4 / US Letter भी चुन सकते हैं।",
      },
    },
    {
      q: {
        en: "Will this add hidden content to my file?",
        hi: "क्या इससे मेरी फ़ाइल में कुछ छिपा हुआ जुड़ता है?",
      },
      a: {
        en: "No — the blanks are truly empty PDF pages with no content stream bloat, no fonts and no metadata. Your original pages are copied untouched.",
        hi: "नहीं — खाली पेज सच में खाली PDF पेज हैं: न भारी कंटेंट स्ट्रीम, न फ़ॉन्ट, न मेटाडेटा। आपके असली पेज जस के तस कॉपी होते हैं।",
      },
    },
  ],
};
