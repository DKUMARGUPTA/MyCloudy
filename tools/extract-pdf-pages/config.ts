import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Extract PDF pages — PageGrid family preset "extract" (PRD §8.1):
 * build a new PDF from the selected pages, with the option
 * "one page = one file". The grid is the picker.
 */
export const config: ToolConfig = {
  toolId: "extract-pdf-pages",
  createWorker: () =>
    new Worker(new URL("../pagegrid/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "switch",
      id: "onePerPage",
      label: { en: "One page = one file", hi: "एक पेज = एक फ़ाइल" },
      hint: {
        en: "Off: all selected pages in a single PDF. On: one file per page.",
        hi: "बंद: चुने पेज एक PDF में। चालू: हर पेज अलग फ़ाइल।",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Pick pages on the grid — click, shift-click, Ctrl+A or type a range.",
      hi: "ग्रिड पर पेज चुनें — क्लिक, शिफ़्ट-क्लिक, Ctrl+A या रेंज लिखें।",
    },
    {
      en: "One new PDF from the selection, or one file per page.",
      hi: "चुने पेजों की एक PDF, या हर पेज अलग फ़ाइल।",
    },
    {
      en: "Multiple files download as a ZIP with individual options.",
      hi: "कई फ़ाइलें ZIP में या अलग-अलग डाउनलोड।",
    },
    {
      en: "Nothing is uploaded — the file never leaves your device.",
      hi: "कुछ भी अपलोड नहीं होता — फ़ाइल आपके डिवाइस पर रहती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I select the pages I want?",
        hi: "ज़रूरी पेज कैसे चुनें?",
      },
      a: {
        en: "Click a thumbnail, shift-click for a range, ctrl-click to add single pages, or type ranges like 1-3, 5 into the selection box.",
        hi: "थंबनेल पर क्लिक करें, रेंज के लिए शिफ़्ट-क्लिक, अलग पेज जोड़ने के लिए कंट्रोल-क्लिक, या बॉक्स में 1-3, 5 लिखें।",
      },
    },
    {
      q: {
        en: "What's the difference between the two modes?",
        hi: "दोनों मोड में क्या फ़र्क़ है?",
      },
      a: {
        en: "Off (default) creates one PDF containing exactly the selected pages. Turn \"One page = one file\" on to get a separate PDF per selected page, bundled as a ZIP.",
        hi: "बंद (डिफ़ॉल्ट) में चुने पेजों की एक PDF बनती है। \"एक पेज = एक फ़ाइल\" चालू करने पर हर पेज की अलग PDF मिलती है, ZIP में।",
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
  ],
};
