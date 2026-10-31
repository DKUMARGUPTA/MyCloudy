import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Alternate merge — interleave two PDFs page by page (A1, B1, A2, B2…).
 * The classic fix for front/back scans split into two files. Own-engine
 * organizeMerge, 100% on-device.
 */
export const config: ToolConfig = {
  toolId: "alternate-merge",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 2,
  maxFiles: 2,
  options: [
    {
      kind: "select",
      id: "lead",
      label: { en: "First page comes from", hi: "पहला पेज किसका" },
      hint: {
        en: "The two files are woven page by page from whichever leads.",
        hi: "दोनों फ़ाइलें पेज-दर-पेज बुनी जाती हैं, आगे वाली फ़ाइल से शुरू।",
      },
      choices: [
        { value: "first", label: { en: "First file", hi: "पहली फ़ाइल" } },
        { value: "second", label: { en: "Second file", hi: "दूसरी फ़ाइल" } },
      ],
      default: "first",
    },
    {
      kind: "select",
      id: "tail",
      label: { en: "When one file runs out", hi: "जब एक फ़ाइल ख़त्म हो जाए" },
      choices: [
        {
          value: "append",
          label: {
            en: "Keep the remaining pages at the end",
            hi: "बचे पेज आख़िर में जुड़ें",
          },
        },
        {
          value: "blank",
          label: {
            en: "Pad with blanks (stay in rhythm)",
            hi: "खाली पेज भरें (क्रम बना रहे)",
          },
        },
      ],
      default: "append",
    },
  ],
  chainToolIds: ["merge-pdf", "split-pdf", "rearrange-pdf-pages"],
  features: [
    {
      en: "Weaves two files page by page — front scan, back scan, done.",
      hi: "दो फ़ाइलें पेज-दर-पेज बुनता है — आगे का स्कैन, पीछे का स्कैन, बस।",
    },
    {
      en: "Choose which file leads, so page 1 is truly page 1.",
      hi: "चुनें कौन-सी फ़ाइल आगे चले, ताकि पेज 1 सच में पेज 1 हो।",
    },
    {
      en: "Different page counts? Leftovers join at the end, or blank-pad to keep the rhythm.",
      hi: "पेज संख्या अलग? बचे हुए आख़िर में जुड़ते हैं, या खाली पेज क्रम बनाए रखते हैं।",
    },
    {
      en: "Page content is copied byte-exact — nothing is re-rendered.",
      hi: "पेज कंटेंट बाइट-एक्ज़ैक्ट कॉपी होता है — कुछ भी दोबारा रेंडर नहीं।",
    },
    {
      en: "Runs entirely on your device — the PDFs are never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "When would I need this?",
        hi: "कब काम आता है?",
      },
      a: {
        en: "Duplex scanning often produces two files — fronts and backs. Alternate merge weaves them back into one correctly ordered document in seconds.",
        hi: "दोतरफ़ा स्कैन अक्सर दो फ़ाइलें बनाता है — आगे और पीछे के पेज। आल्टरनेट मर्ज उन्हें सही क्रम में एक दस्तावेज़ बुन देता है।",
      },
    },
    {
      q: {
        en: "My scans have different page counts — what happens?",
        hi: "मेरे दोनों स्कैन में पेज संख्या अलग है — फिर?",
      },
      a: {
        en: "Pick “keep the remaining pages at the end” and the longer file's leftovers are appended after the weave. Blank-pad keeps the A-B rhythm instead — useful before double-sided printing.",
        hi: "“बचे पेज आख़िर में जुड़ें” चुनें तो लंबी फ़ाइल के बचे पेज बुनाई के बाद जुड़ते हैं। खाली पेज भरने से A-B का क्रम बना रहता है — दोतरफ़ा प्रिंट से पहले फ़ायदेमंद।",
      },
    },
    {
      q: {
        en: "Does it matter which file is “first”?",
        hi: "क्या पहली-दूसरी फ़ाइल का क्रम मायने रखता है?",
      },
      a: {
        en: "Yes — the first file's page 1 becomes the document's page 1. If your backs scanned first, just set the lead to the second file.",
        hi: "हाँ — पहली फ़ाइल का पेज 1 दस्तावेज़ का पेज 1 बनता है। अगर पीछे के पेज पहले स्कैन हुए हैं, तो दूसरी फ़ाइल को आगे कर दें।",
      },
    },
  ],
};
