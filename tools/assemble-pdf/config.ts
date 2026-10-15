import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Assemble PDF (PRD §8.1) — multi-document workspace, on-device.
 *
 * The surface (tools/assemble-pdf/surface.tsx) shows every document as
 * a column; pages drag between documents and new document columns can
 * be created. The options below decide what the worker builds from the
 * edited columns: one merged PDF (optionally zipper-interleaved for
 * front/back scans, optionally reversed) or one PDF per document with
 * the result view's "Download all (ZIP)".
 */
export const config: ToolConfig = {
  toolId: "assemble-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 20,
  options: [
    {
      kind: "select",
      id: "outputMode",
      label: { en: "Save as", hi: "सेव करें" },
      hint: {
        en: "One merged PDF, or every document separately (ZIP download included).",
        hi: "एक मर्ज PDF, या हर दस्तावेज़ अलग से (ZIP डाउनलोड शामिल)।",
      },
      choices: [
        {
          value: "merge",
          label: { en: "One merged PDF", hi: "एक मर्ज PDF" },
        },
        {
          value: "separate",
          label: {
            en: "Separate PDFs (ZIP)",
            hi: "अलग PDF (ZIP)",
          },
        },
      ],
      default: "merge",
    },
    {
      kind: "switch",
      id: "zipper",
      label: { en: "Zipper merge", hi: "ज़िपर मर्ज" },
      hint: {
        en: "Alternate pages from each document — perfect for front/back scans: 1A, 1B, 2A, 2B…",
        hi: "हर दस्तावेज़ के पेज बारी-बारी — फ्रंट/बैक स्कैन के लिए: 1A, 1B, 2A, 2B…",
      },
      default: false,
      showWhen: { id: "outputMode", equals: "merge" },
    },
    {
      kind: "switch",
      id: "reverse",
      label: { en: "Reverse page order", hi: "पेज क्रम उलटें" },
      hint: {
        en: "Last page first in the merged output. To flip one document only, use its column's reverse button.",
        hi: "मर्ज आउटपुट में आख़िरी पेज पहले। सिर्फ़ एक दस्तावेज़ उलटने के लिए उसके कॉलम का रिवर्स बटन इस्तेमाल करें।",
      },
      default: false,
      showWhen: { id: "outputMode", equals: "merge" },
    },
    {
      kind: "text",
      id: "outputName",
      label: { en: "Merged file name", hi: "मर्ज फ़ाइल का नाम" },
      placeholder: {
        en: "auto: <first document>-assembled.pdf",
        hi: "ऑटो: <पहला दस्तावेज़>-assembled.pdf",
      },
      default: "",
      showWhen: { id: "outputMode", equals: "merge" },
    },
  ],
  features: [
    {
      en: "Every document side by side — drag pages between documents with your mouse, finger or keyboard.",
      hi: "हर दस्तावेज़ साथ-साथ — पेज माउस, उंगली या कीबोर्ड से खींचकर दूसरे दस्तावेज़ में डालें।",
    },
    {
      en: "Create new document columns and build exactly the file set you need.",
      hi: "नए दस्तावेज़ कॉलम बनाएँ और ठीक वही फ़ाइल सेट तैयार करें जो चाहिए।",
    },
    {
      en: "Zipper merge alternates pages — the classic fix for front/back scans.",
      hi: "ज़िपर मर्ज पेज बारी-बारी लगाता है — फ्रंट/बैक स्कैन का क्लासिक हल।",
    },
    {
      en: "Save as one merged PDF, or as separate PDFs with a one-tap ZIP download.",
      hi: "एक मर्ज PDF के रूप में सेव करें, या अलग PDF के रूप में — एक टैप में ZIP डाउनलोड।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I move a page to another document?",
        hi: "पेज दूसरे दस्तावेज़ में कैसे ले जाऊँ?",
      },
      a: {
        en: "Drag the page onto the other document's column. Without a mouse, use the ← / → buttons on the page, or lift it with Space and move with the arrow keys.",
        hi: "पेज को खींचकर दूसरे दस्तावेज़ के कॉलम पर छोड़ें। माउस न हो तो पेज के ← / → बटन इस्तेमाल करें, या Space से उठाकर तीर कुंजियों से खिसकाएँ।",
      },
    },
    {
      q: {
        en: "What is zipper merge for?",
        hi: "ज़िपर मर्ज किस काम का है?",
      },
      a: {
        en: "Scanning a stack double-sided gives one file of fronts and one of backs. Zipper merge alternates them — 1A, 1B, 2A, 2B — back into reading order. If the backs came out reversed, reverse that column first with its ↺ button.",
        hi: "दोतरफ़ा स्कैन में एक फ़ाइल आगे के पेजों की और एक पीछे की बनती है। ज़िपर मर्ज उन्हें बारी-बारी — 1A, 1B, 2A, 2B — पढ़ने के क्रम में ले आता है। पीछे वाले उलटे आएं तो पहले उस कॉलम का ↺ बटन दबाएँ।",
      },
    },
    {
      q: {
        en: "Can I keep the documents separate instead of merging?",
        hi: "क्या मर्ज करने की जगह दस्तावेज़ अलग रख सकते हैं?",
      },
      a: {
        en: "Yes — choose \"Separate PDFs (ZIP)\" in the options. Every document column becomes its own PDF, and the result view offers individual downloads plus Download all (ZIP).",
        hi: "हाँ — विकल्पों में \"अलग PDF (ZIP)\" चुनें। हर दस्तावेज़ कॉलम अपनी PDF बनता है, और नतीजे में अलग-अलग डाउनलोड के साथ सबका ZIP मिलता है।",
      },
    },
  ],
};
