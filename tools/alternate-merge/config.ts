import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Alternate & merge (PHASE-1 Batch B): interleave pages from two or more
 * PDFs — A1, B1, A2, B2… — the classic double-sided-scan combiner
 * (fronts in one file, backs in the other).
 *
 * Schema-driven; the worker runs a round-robin plan through the engine's
 * multi-document merge (organizeMerge) — one parse per input.
 */
export const config: ToolConfig = {
  toolId: "alternate-merge",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 2,
  maxFiles: 10,
  options: [
    {
      kind: "select",
      id: "lead",
      label: { en: "Which file leads", hi: "कौन-सी फ़ाइल पहले" },
      hint: {
        en: "The first page of the output comes from this file",
        hi: "आउटपुट का पहला पेज इसी फ़ाइल से आएगा",
      },
      choices: [
        {
          value: "first",
          label: { en: "First file", hi: "पहली फ़ाइल" },
        },
        {
          value: "second",
          label: { en: "Second file", hi: "दूसरी फ़ाइल" },
        },
      ],
      default: "first",
    },
    {
      kind: "select",
      id: "tail",
      label: { en: "Leftover pages", hi: "बचे हुए पेज" },
      hint: {
        en: "What happens when one file runs out of pages",
        hi: "जब एक फ़ाइल के पेज ख़त्म हो जाएँ तो क्या हो",
      },
      choices: [
        {
          value: "keep",
          label: { en: "Keep them at the end", hi: "अंत में जोड़ें" },
        },
        {
          value: "drop",
          label: { en: "Leave them out", hi: "छोड़ दें" },
        },
      ],
      default: "keep",
    },
  ],
  chainToolIds: ["rearrange-pdf-pages", "merge-pdf", "view-pdf"],
  features: [
    {
      en: "Interleave pages A1, B1, A2, B2… from two or more PDFs.",
      hi: "दो या ज़्यादा PDF से पेज इस तरह बुनें: A1, B1, A2, B2…।",
    },
    {
      en: "The double-sided scan fixer — fronts in one file, backs in the other.",
      hi: "दो-तरफ़ा स्कैन का इलाज — एक फ़ाइल में अगले पेज, दूसरी में पिछले।",
    },
    {
      en: "Choose which file leads and what happens to leftover pages.",
      hi: "चुनें कौन-सी फ़ाइल पहले चले और बचे पेजों का क्या हो।",
    },
    {
      en: "Up to 10 files combed in one run — originals never modified.",
      hi: "एक बार में 10 तक फ़ाइलें बुनें — असली फ़ाइलें नहीं बदलतीं।",
    },
    {
      en: "Runs entirely on your device — files never leave your browser.",
      hi: "पूरा काम डिवाइस पर — फ़ाइलें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "When would I use this instead of Merge?",
        hi: "Merge की जगह यह कब इस्तेमाल करूँ?",
      },
      a: {
        en: "Merge stacks whole files. Alternating merge COMBS them page by page — exactly what a double-sided scan needs: the fronts file and the backs file weave back into reading order.",
        hi: "Merge पूरी फ़ाइलें जमा करता है। यह टूल उन्हें पेज-दर-पेज बुनता है — बिल्कुल वही जो दो-तरफ़ा स्कैन को चाहिए: अगले-पेज वाली फ़ाइल और पिछले-पेज वाली फ़ाइल पढ़ने के क्रम में उलझ जाती हैं।",
      },
    },
    {
      q: {
        en: "My scans came out backs-first — can I fix that?",
        hi: "मेरा स्कैन पीछे वाले पेज पहले निकले — ठीक कर सकते हैं?",
      },
      a: {
        en: "Yes — set “Which file leads” to the SECOND file so the backs comb in first, or pre-reverse that file with the Reverse tool and then alternate.",
        hi: "हाँ — “कौन-सी फ़ाइल पहले” को दूसरी फ़ाइल पर रखें ताकि पिछले पेज पहले बुनें, या उस फ़ाइल को Reverse टूल से पलटकर फिर बुनें।",
      },
    },
    {
      q: {
        en: "What if the files have different page counts?",
        hi: "अगर फ़ाइलों में पेज संख्या अलग हो तो?",
      },
      a: {
        en: "The comb runs until the longest file is done. By default the extra pages are appended in order at the end; you can also choose to leave them out.",
        hi: "बुनाई तक चलती है जब तक सबसे लंबी फ़ाइल पूरी न हो जाए। डिफ़ॉल्ट में ज़्यादा पेज अंत में क्रम से जुड़ जाते हैं; चाहें तो उन्हें छोड़ भी सकते हैं।",
      },
    },
  ],
};
