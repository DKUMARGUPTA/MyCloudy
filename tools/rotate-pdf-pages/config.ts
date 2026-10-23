import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Rotate PDF pages — PageGrid family preset "rotate" (PRD §8.1).
 *
 * Rebased on the shared interactive grid: rotate all / selected / odd /
 * even via the scope segmented control, 90° left/right per page or scope,
 * live thumbnail rotation, full undo/redo. All options live in the grid
 * surface; the schema is intentionally empty and the shared PageGrid
 * worker rebuilds the output from the serialized page list.
 *
 * BATCH (ENH-2): the family's multi-file member — up to 20 PDFs at once,
 * each with its own edited grid (the surface keeps one grid per file and
 * the worker rebuilds every file from its own list — iLovePDF/Smallpdf
 * batch-rotate parity). One output per input file.
 */
export const config: ToolConfig = {
  toolId: "rotate-pdf-pages",
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
      en: "Rotate all, selected, odd or even pages — or single pages right on the thumbnail.",
      hi: "सभी, चुने, विषम या सम पेज घुमाएँ — या सीधे थंबनेल पर एक पेज।",
    },
    {
      en: "Batch: add up to 20 PDFs — each file keeps its own rotations, one output per file.",
      hi: "बैच: 20 तक PDF जोड़ें — हर फ़ाइल के अपने रोटेशन रहते हैं, हर फ़ाइल का अपना आउटपुट।",
    },
    {
      en: "Live grid with real page thumbnails that turn as you rotate.",
      hi: "असली थंबनेल वाली लाइव ग्रिड — घुमाते ही पेज दिखता है।",
    },
    {
      en: "Full undo/redo, zoom and drag reorder while you fix sideways scans.",
      hi: "पूरा वापस लाना/दोहराना, ज़ूम और खींचकर क्रम बदलना।",
    },
    {
      en: "Nothing is uploaded — files never leave your device.",
      hi: "कुछ भी अपलोड नहीं होता — फ़ाइलें आपके डिवाइस से बाहर नहीं जातीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Are my files uploaded anywhere?",
        hi: "क्या मेरी फ़ाइल कहीं अपलोड होती है?",
      },
      a: {
        en: "No. This tool runs entirely in your browser with Web Workers. There is no server involved, so the file physically cannot leave your device.",
        hi: "नहीं। यह टूल पूरी तरह आपके ब्राउज़र में Web Workers से चलता है। कोई सर्वर शामिल नहीं है, इसलिए फ़ाइल आपके डिवाइस से बाहर जा ही नहीं सकती।",
      },
    },
    {
      q: {
        en: "Can I rotate several PDFs in one go?",
        hi: "क्या एक साथ कई PDF घुमा सकते हैं?",
      },
      a: {
        en: "Yes — add up to 20 files. Click a file in the list to edit its page grid (rotate, reorder, delete), switch to the next, and run once: every file is saved with its own rotations, one output per file.",
        hi: "हाँ — 20 तक फ़ाइलें जोड़ें। सूची में फ़ाइल पर क्लिक करके उसकी पेज-ग्रिड एडिट करें (घुमाना, क्रम, हटाना), फिर अगली पकड़ें — और एक बार चलाएँ: हर फ़ाइल अपने रोटेशन के साथ सेव होती है, हर फ़ाइल का अपना आउटपुट।",
      },
    },
    {
      q: {
        en: "Will rotating reduce the quality?",
        hi: "क्या घुमाने से क्वालिटी गिरती है?",
      },
      a: {
        en: "No. Rotation only changes the page angle stored in the PDF — text, images and vectors are untouched, so nothing is re-compressed.",
        hi: "नहीं। घुमाने से सिर्फ़ पेज का कोण बदलता है — टेक्स्ट, तस्वीरें और वेक्टर जस के तस रहते हैं।",
      },
    },
    {
      q: {
        en: "Can I undo a rotation?",
        hi: "क्या घुमाना वापस ले सकते हैं?",
      },
      a: {
        en: "Yes — every grid action (rotate, delete, duplicate, reorder) supports undo with Ctrl+Z and redo with Ctrl+Shift+Z.",
        hi: "हाँ — ग्रिड का हर एक्शन Ctrl+Z से वापस और Ctrl+Shift+Z से दोबारा किया जा सकता है।",
      },
    },
  ],
};
