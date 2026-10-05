import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Split PDF (PRD §8.1) — 7 split modes, one PDF in, 1..N PDFs out.
 *
 * All controls (mode tabs, per-mode inputs, live preview with cut markers)
 * live in the custom panel (tools/split-pdf/panel.tsx); the options schema
 * is intentionally empty — the worker defaults every option defensively and
 * the panel owns the interactive values.
 *
 * Output naming (PRD): "<name>_part1.pdf"; odd/even → "<name>_odd/_even.pdf".
 * Multiple files are handed to the shared ResultView which offers the ZIP
 * download (fflate) plus individual downloads.
 */
export const config: ToolConfig = {
  toolId: "split-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Seven ways to split: ranges, every N pages, bookmarks, size, visual cut points, odd/even, or at blank pages.",
      hi: "सात तरीके: रेंज, हर N पेज, बुकमार्क, साइज़, विज़ुअल कट, odd/even या ख़ाली पेज पर।",
    },
    {
      en: "Live preview shows exactly which pages land in which file before you run anything.",
      hi: "चलाने से पहले लाइव प्रीव्यू दिखाता है कि कौन-सा पेज किस फ़ाइल में जाएगा।",
    },
    {
      en: "Multiple parts download as a ZIP with a list of individual files — naming stays clean (part1, part2…).",
      hi: "कई भाग ZIP में और अलग-अलग फ़ाइलों की सूची में मिलते हैं — नाम साफ़ रहते हैं (part1, part2…)।",
    },
    {
      en: "Everything happens on your device — your PDF never leaves the browser.",
      hi: "सब कुछ आपके डिवाइस पर होता है — आपकी PDF ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I write page ranges?",
        hi: "पेज रेंज कैसे लिखें?",
      },
      a: {
        en: "Like 1-5, 8, 10-end — commas separate ranges, and “end” means the last page. Each range becomes its own file (or turn that off to combine them into one).",
        hi: "1-5, 8, 10-end जैसे लिखें — कॉमा से रेंज अलग होती हैं और “end” का मतलब आख़िरी पेज। हर रेंज अपनी फ़ाइल बनती है (या बंद करके सब एक फ़ाइल में जोड़ें)।",
      },
    },
    {
      q: {
        en: "What does splitting by file size do?",
        hi: "साइज़ से बाँटने से क्या होता है?",
      },
      a: {
        en: "Pages are grouped so each part stays within the size you set (e.g. under 5 MB for email limits). The count in the preview is an estimate — the final parts are verified against real file sizes.",
        hi: "पेज ऐसे समूहों में बाँटे जाते हैं कि हर भाग आपकी सीमा के भीतर रहे (जैसे ईमेल के लिए 5 MB से कम)। प्रीव्यू की गिनती अनुमान है — असली भाग असली साइज़ से जाँचे जाते हैं।",
      },
    },
    {
      q: {
        en: "Can a single page be bigger than my size limit?",
        hi: "क्या एक पेज मेरी साइज़ सीमा से बड़ा हो सकता है?",
      },
      a: {
        en: "Rarely, yes — one high-resolution scan can exceed the limit on its own. That page simply becomes its own file; everything else stays within your limit.",
        hi: "कभी-कभी, हाँ — एक हाई-रेज़ोल्यूशन स्कैन अकेले ही सीमा पार कर सकता है। वह पेज अपनी अलग फ़ाइल बन जाता है; बाक़ी सब सीमा में रहता है।",
      },
    },
  ],
};
