import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rearrange PDF pages — PageGrid family preset "rearrange" (PRD §8.1).
 * Drag thumbnails into a new order (keyboard move buttons too), full
 * undo/redo. Shared PageGrid worker rebuilds the output.
 *
 * BATCH (R2-a): up to 20 PDFs at once — each file keeps its own edited
 * order (one grid per file in the surface), one output per input.
 */
export const config: ToolConfig = {
  toolId: "rearrange-pdf-pages",
  createWorker: () =>
    new Worker(new URL("../pagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 20,
  options: [],
  features: [
    {
      en: "Drag page thumbnails into any new order.",
      hi: "थंबनेल खींचकर कोई भी नया क्रम बनाएँ।",
    },
    {
      en: "Batch: add up to 20 PDFs — each file keeps its own page order, one output per file.",
      hi: "बैच: 20 तक PDF जोड़ें — हर फ़ाइल का अपना पेज क्रम रहता है, हर फ़ाइल का अपना आउटपुट।",
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
        en: "Can I reorder several PDFs in one go?",
        hi: "क्या एक साथ कई PDF का क्रम बदल सकते हैं?",
      },
      a: {
        en: "Yes — add up to 20 files. Click a file in the list to edit its page grid, switch to the next, and run once: every file is saved in its own order, one output per file.",
        hi: "हाँ — 20 तक फ़ाइलें जोड़ें। सूची में फ़ाइल पर क्लिक करके उसकी पेज-ग्रिड एडिट करें, फिर अगली पकड़ें — और एक बार चलाएँ: हर फ़ाइल अपने क्रम में सेव होती है, हर फ़ाइल का अपना आउटपुट।",
      },
    },
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
