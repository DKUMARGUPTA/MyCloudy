import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * JSON → PDF (PHASE-3 batch 3): validate, pretty-print and colourise —
 * keys, strings and punctuation tinted in Courier, 2-space indent, page
 * numbers of your choosing. API responses and config dumps become
 * reviewable documents.
 */
export const config: ToolConfig = {
  toolId: "json-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 10,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      choices: [
        { value: "portrait", label: { en: "Portrait", hi: "पोर्ट्रेट" } },
        { value: "landscape", label: { en: "Landscape", hi: "लैंडस्केप" } },
      ],
      default: "portrait",
    },
    {
      kind: "number",
      id: "fontSize",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      min: 6,
      max: 14,
      step: 1,
      default: 9,
    },
    {
      kind: "switch",
      id: "colorize",
      label: { en: "Syntax colouring", hi: "सिंटैक्स रंग" },
      default: true,
    },
  ],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Validates first — broken JSON gets an honest error, not a broken PDF.",
      hi: "पहले जाँच — टूटा JSON ईमानदार एरर देता है, टूटी PDF नहीं।",
    },
    {
      en: "Pretty-printed with 2-space indent — nested structures become readable.",
      hi: "2-स्पेस इंडेंट से सजाया — नेस्टेड ढाँचा पढ़ने योग्य बन जाता है।",
    },
    {
      en: "Syntax colouring: keys, strings and punctuation each get their tint.",
      hi: "सिंटैक्स रंग: की, स्ट्रिंग और चिह्न — सबका अपना रंग।",
    },
    {
      en: "Long lines wrap cleanly; A4 or Letter, portrait or landscape.",
      hi: "लंबी लाइनें साफ़ लपेटती हैं; A4 या लेटर, पोर्ट्रेट या लैंडस्केप।",
    },
    {
      en: "Up to 10 files in one run — everything on your device.",
      hi: "एक रन में 10 फ़ाइलें — सब कुछ आपके डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "What happens with invalid JSON?",
        hi: "ग़लत JSON पर क्या होता है?",
      },
      a: {
        en: "The run stops with a clear error naming the file — no half-rendered output. Fix the JSON and try again.",
        hi: "रन साफ़ एरर के साथ रुकता है, फ़ाइल का नाम बताते हुए — आधा आउटपुट नहीं। JSON ठीक करके दोबारा चलाएँ।",
      },
    },
    {
      q: {
        en: "How big can the JSON be?",
        hi: "JSON कितना बड़ा हो सकता है?",
      },
      a: {
        en: "Up to 200 rendered pages per file (roughly 20k pretty-printed lines). Beyond that the run honestly reports the cap.",
        hi: "हर फ़ाइल में 200 पेज तक (क़रीब 20 हज़ार लाइनें)। उसके आगे रन सीमा साफ़ बताता है।",
      },
    },
    {
      q: {
        en: "Can I turn the colours off?",
        hi: "रंग बंद कर सकते हैं?",
      },
      a: {
        en: "Yes — the Syntax colouring switch renders plain black Courier, ideal for thermal printers and strict archives.",
        hi: "हाँ — सिंटैक्स रंग बंद करने पर सादा काला Courier, थर्मल प्रिंटर और सख़्त आर्काइव के लिए।",
      },
    },
  ],
};
