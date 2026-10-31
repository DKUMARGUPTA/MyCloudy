import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add page labels — the logical numbering layer (i, ii, iii, then 1, 2,
 * 3…) viewers show in the page box. Own-engine catalog rewrite with an
 * inline /PageLabels number tree, 100% on-device.
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
      id: "scheme",
      label: { en: "Numbering style", hi: "नंबरिंग स्टाइल" },
      choices: [
        { value: "D", label: { en: "1, 2, 3…", hi: "1, 2, 3…" } },
        { value: "r", label: { en: "i, ii, iii…", hi: "i, ii, iii…" } },
        { value: "R", label: { en: "I, II, III…", hi: "I, II, III…" } },
        { value: "a", label: { en: "a, b, c…", hi: "a, b, c…" } },
        { value: "A", label: { en: "A, B, C…", hi: "A, B, C…" } },
      ],
      default: "D",
    },
    {
      kind: "text",
      id: "prefix",
      label: { en: "Prefix", hi: "प्रीफ़िक्स" },
      hint: {
        en: "Shown before every label, e.g. “Page ” → Page 1, Page 2. Optional.",
        hi: "हर लेबल से पहले, जैसे “Page ” → Page 1, Page 2। वैकल्पिक।",
      },
      placeholder: { en: "e.g. Page ", hi: "जैसे Page " },
      default: "",
    },
    {
      kind: "number",
      id: "startNumber",
      label: { en: "Start at", hi: "शुरुआती नंबर" },
      min: 1,
      max: 1000,
      step: 1,
      default: 1,
    },
  ],
  chainToolIds: ["add-page-numbers", "bates-numbering", "bookmark-pdf"],
  features: [
    {
      en: "Sets the logical labels viewers show — “iii (7 of 42)” instead of bare numbers.",
      hi: "व्यूअर में दिखने वाले लॉजिकल लेबल सेट करता है — “iii (7 of 42)” जैसे, बिना नंबर के बजाय।",
    },
    {
      en: "Five styles — plain numbers, roman (i, ii / I, II) or letters (a, b / A, B).",
      hi: "पाँच स्टाइल — सादे नंबर, रोमन (i, ii / I, II) या अक्षर (a, b / A, B)।",
    },
    {
      en: "Optional prefix and start number — “Page 5, Page 6…” is one fill away.",
      hi: "वैकल्पिक प्रीफ़िक्स और शुरुआती नंबर — “Page 5, Page 6…” एक भराई दूर है।",
    },
    {
      en: "Nothing is stamped on the pages — the printed layout is untouched.",
      hi: "पेजों पर कुछ छपता नहीं — प्रिंट लेआउट बिल्कुल अछूता।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference from page numbers?",
        hi: "पेज नंबर से यह कैसे अलग है?",
      },
      a: {
        en: "Page numbers are printed on the page itself; page labels live in the PDF's structure and appear in the viewer's page box, page thumbnails and links — the printed page stays untouched.",
        hi: "पेज नंबर पेज पर छपते हैं; पेज लेबल PDF की संरचना में रहते हैं और व्यूअर के पेज बॉक्स, थंबनेल और लिंक में दिखते हैं — छपा पेज अछूता रहता है।",
      },
    },
    {
      q: {
        en: "Where will I see the labels?",
        hi: "लेबल कहाँ दिखेंगे?",
      },
      a: {
        en: "In Acrobat, Chrome, Edge, Firefox and most viewers — usually in the page-count area (“iv (4 of 30)”) and in the thumbnails panel.",
        hi: "Acrobat, Chrome, Edge, Firefox और ज़्यादातर व्यूअर में — आम तौर पर पेज-गिनती वाली जगह (“iv (4 of 30)”) और थंबनेल पैनल में।",
      },
    },
    {
      q: {
        en: "Can the first pages be roman and the rest decimal?",
        hi: "क्या शुरू के पेज रोमन और बाक़ी डेसिमल रख सकते हैं?",
      },
      a: {
        en: "This tool applies one style to the whole document — that covers the common single-scheme case. Multi-scheme labelling (front matter i, ii, then 1, 2) is on the roadmap.",
        hi: "यह टूल पूरे दस्तावेज़ पर एक ही स्टाइल लगाता है — आम केस के लिए काफ़ी। मल्टी-स्कीम लेबलिंग (आगे i, ii, फिर 1, 2) रोडमैप पर है।",
      },
    },
  ],
};
