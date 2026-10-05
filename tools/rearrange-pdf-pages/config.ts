import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rearrange PDF pages — PageGrid family preset "rearrange" (PRD §8.1).
 * Drag thumbnails into a new order (keyboard move buttons too), full
 * undo/redo. Shared PageGrid worker rebuilds the output.
 */
export const config: ToolConfig = {
  toolId: "rearrange-pdf-pages",
  createWorker: () =>
    new Worker(new URL("../pagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Drag page thumbnails into any new order.",
      hi: "थंबनेल खींचकर कोई भी नया क्रम बनाएँ।",
    },
    {
      en: "Keyboard-friendly: move buttons, arrow keys and full undo/redo.",
      hi: "कीबोर्ड से भी — मूव बटन, ऐरो कीज़ और पूरा वापस लाना/दोहराना।",
    },
    {
      en: "Rotate, duplicate, delete or insert blank pages while you sort.",
      hi: "क्रम बदलते समय घुमाएँ, प्रतिलिपि बनाएँ, हटाएँ या ख़ाली पेज जोड़ें।",
    },
    {
      en: "Nothing is uploaded — the file never leaves your device.",
      hi: "कुछ भी अपलोड नहीं होता — फ़ाइल आपके डिवाइस पर रहती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I reorder pages?",
        hi: "पेजों का क्रम कैसे बदलें?",
      },
      a: {
        en: "Drag any thumbnail to a new spot, or select pages and use the move buttons. Every move is undoable with Ctrl+Z.",
        hi: "कोई भी थंबनेल खींचकर नई जगह रखें, या पेज चुनकर मूव बटन इस्तेमाल करें। हर बदलाव Ctrl+Z से वापस हो सकता है।",
      },
    },
    {
      q: {
        en: "Are my files uploaded anywhere?",
        hi: "क्या मेरी फ़ाइल कहीं अपलोड होती है?",
      },
      a: {
        en: "No. Everything runs in your browser with Web Workers — the file never leaves your device.",
        hi: "नहीं। सब कुछ आपके ब्राउज़र में Web Workers से चलता है — फ़ाइल डिवाइस से बाहर नहीं जाती।",
      },
    },
    {
      q: {
        en: "Does reordering re-compress my PDF?",
        hi: "क्या क्रम बदलने से PDF दोबारा कंप्रेस होती है?",
      },
      a: {
        en: "No. Pages are copied as-is into the new order — content, quality and size stay the same.",
        hi: "नहीं। पेज जस के तस नए क्रम में कॉपी होते हैं — कंटेंट, क्वालिटी और साइज़ वही रहते हैं।",
      },
    },
  ],
};
