import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Multi-tool PDF (PHASE-5) — the unified page-grid workbench: select,
 * drag-reorder, rotate, delete, duplicate and insert blank pages across
 * up to 20 files, every operation with undo, one organized output per
 * file. The GridSurface preset "multi" (all family actions unlocked),
 * the shared PageGrid worker, our own engine.
 */
export const config: ToolConfig = {
  toolId: "multi-tool-pdf",
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
      en: "Every page operation in one place — reorder, rotate, delete, duplicate, blank pages.",
      hi: "हर पेज काम एक जगह — क्रम बदलें, घुमाएँ, हटाएँ, डुप्लिकेट करें, ख़ाली पेज जोड़ें।",
    },
    {
      en: "Drag pages into place, or move a whole selection with the arrows.",
      hi: "पेज खींचकर जगह लगाएँ, या पूरी सलेक्शन तीरों से घसीटें।",
    },
    {
      en: "Undo every mistake (Ctrl+Z) — redo too — as deep as you need.",
      hi: "हर ग़लती Ctrl+Z से वापस — दोबारा करना भी — जितनी देर चाहें।",
    },
    {
      en: "Batch: up to 20 PDFs, each with its own edited grid, one output per file.",
      hi: "बैच: 20 तक PDF, हर एक का अपना एडिटेड ग्रिड, हर फ़ाइल का अपना आउटपुट।",
    },
    {
      en: "Runs entirely on your device — files never leave your browser.",
      hi: "पूरा काम डिवाइस पर — फ़ाइलें ब्राउज़र से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from the separate rotate / rearrange / remove tools?",
        hi: "यह अलग-अलग घुमाने / क्रम / हटाने वाले टूल्स से कैसे अलग है?",
      },
      a: {
        en: "Those tools each expose one operation. This workbench unlocks all of them together — rotate a page, delete another, duplicate a third, drag everything into place, then run once. Same engine, same outputs, fewer round-trips.",
        hi: "वे टूल्स एक-एक काम देते हैं। यह वर्कबेंच सब एक साथ खोलता है — एक पेज घुमाएँ, दूसरा हटाएँ, तीसरा डुप्लिकेट करें, सब खींचकर जमाएँ, फिर एक बार रन। इंजन वही, आउटपुट वही, चक्कर कम।",
      },
    },
    {
      q: {
        en: "Can I work on several PDFs in one session?",
        hi: "एक सेशन में कई PDF पर काम कर सकते हैं?",
      },
      a: {
        en: "Yes — add up to 20 files, switch between them in the list, and each keeps its own edits. One run saves every file with its changes applied, one output per input.",
        hi: "हाँ — 20 तक फ़ाइलें जोड़ें, सूची में उनके बीच जाएँ, हर एक के अपने बदलाव रहते हैं। एक रन में हर फ़ाइल अपने बदलावों के साथ सेव होती है, हर इनपुट का अपना आउटपुट।",
      },
    },
    {
      q: {
        en: "What happens if I delete every page by accident?",
        hi: "ग़लती से सारे पेज हटा दूँ तो?",
      },
      a: {
        en: "The run button honestly disables until at least one page remains — and Ctrl+Z brings everything back step by step.",
        hi: "जब तक कम से कम एक पेज बचे, रन बटन ईमानदारी से बंद रहता है — और Ctrl+Z सब कुछ क़दम-दर-क़दम लौटा देता है।",
      },
    },
  ],
};
