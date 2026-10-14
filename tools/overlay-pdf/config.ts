import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Overlay PDF config (PRD §8.3 "Overlay").
 *
 * All controls (position, size, opacity, rotation, behind-content, page
 * mapping) live in the custom panel — the split-tool pattern: the options
 * schema is intentionally empty, the panel owns the interactive values and
 * the worker defaults defensively.
 *
 * The run composites the overlay as REAL embedded PDF pages (pdf-lib
 * embedPdf + drawPage) — vector content, selectable text and the overlay's
 * own transparency survive; nothing is rasterized.
 */
export const config: ToolConfig = {
  toolId: "overlay-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 2,
  maxFiles: 2,
  options: [],
  chainToolIds: ["view-pdf", "compress-pdf", "lock-pdf"],
  howKeys: ["overlay.how1", "overlay.how2", "overlay.how3"],
  features: [
    {
      en: "Drop a base PDF and an overlay PDF — letterheads, approval stamps, form grids, anything.",
      hi: "बेस PDF और ओवरले PDF डालें — लेटरहेड, अप्रूवल स्टैम्प, फ़ॉर्म ग्रिड, कुछ भी।",
    },
    {
      en: "Real PDF layering, not a picture trick: the overlay rides in as an embedded page — vector sharp at every zoom.",
      hi: "असली PDF लेयरिंग, तस्वीर का खेल नहीं: ओवरले एम्बेडेड पेज की तरह जुड़ता है — हर ज़ूम पर वेक्टर-साफ़।",
    },
    {
      en: "9-position grid, size as % of the page, opacity and rotation — with a live composite preview before you run.",
      hi: "9-स्थिति ग्रिड, पेज के % में आकार, ओपैसिटी और झुकाव — रन से पहले लाइव कंपोज़िट प्रीव्यू के साथ।",
    },
    {
      en: "Page mapping that fits your case: overlay page 1 on every page, matching page numbers, or cycling through all of them.",
      hi: "आपके केस के हिसाब से पेज मैपिंग: हर पेज पर ओवरले पेज 1, नंबर मिलाकर, या सबको बारी-बारी।",
    },
    {
      en: "Choose which base pages get it — all, first, odd, even or a custom range.",
      hi: "चुनें कि बेस के कौन से पेज लें — सभी, पहला, ऑड, ईवन या कोई रेंज।",
    },
    {
      en: "Draw the overlay over the content or behind it. Everything runs on your device — no uploads.",
      hi: "ओवरले कंटेंट के ऊपर रखें या पीछे। सब आपके डिवाइस पर चलता है — कुछ अपलोड नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between the two files?",
        hi: "दोनों फ़ाइलों में क्या फ़र्क़ है?",
      },
      a: {
        en: "The first file is the base — its pages stay as they are. The second is the overlay: its pages are drawn on top of the base pages. Add the base first, then the overlay.",
        hi: "पहली फ़ाइल बेस है — उसके पेज वैसे ही रहते हैं। दूसरी ओवरले है: उसके पेज बेस पेजों के ऊपर बनते हैं। पहले बेस जोड़ें, फिर ओवरले।",
      },
    },
    {
      q: {
        en: "Which overlay page lands on which base page?",
        hi: "ओवरले का कौन सा पेज बेस के किस पेज पर लगता है?",
      },
      a: {
        en: "“First page” (default) stamps overlay page 1 on every chosen base page — the classic letterhead. “Match by number” puts overlay page 1 on base page 1, page 2 on page 2, and skips base pages the overlay doesn’t have. “Cycle” repeats the overlay pages in order.",
        hi: "“पहला पेज” (डिफ़ॉल्ट) हर चुने पेज पर ओवरले का पेज 1 लगाता है — क्लासिक लेटरहेड। “नंबर से मिलाएँ” ओवरले पेज 1 को बेस पेज 1 पर, पेज 2 को पेज 2 पर रखता है, और जिन बेस पेजों के लिए ओवरले में पेज नहीं उन्हें छोड़ देता है। “बारी-बारी” ओवरले पेज क्रम से दोहराता है।",
      },
    },
    {
      q: {
        en: "Can the overlay go behind the base content?",
        hi: "क्या ओवरले बेस कंटेंट के पीछे रख सकते हैं?",
      },
      a: {
        en: "Yes — turn on “Place behind content”. The overlay moves into the page’s bottom drawing layer, so the base text and images stay fully readable on top. Perfect for stationery backgrounds.",
        hi: "हाँ — “कंटेंट के पीछे रखें” चालू करें। ओवरले पेज की निचली लेयर में चला जाता है, इसलिए ऊपर का टेक्स्ट-इमेज पूरा पढ़ने लायक़ रहता है। स्टेशनरी बैकग्राउंड के लिए बढ़िया।",
      },
    },
    {
      q: {
        en: "Does transparency in the overlay PDF survive?",
        hi: "क्या ओवरले PDF की पारदर्शिता बनी रहती है?",
      },
      a: {
        en: "Yes — the overlay is embedded as a real PDF page, so semi-transparent fills, alpha and overlapping content stay exactly as designed. The opacity slider adds one more layer of control on top.",
        hi: "हाँ — ओवरले असली PDF पेज की तरह एम्बेड होता है, इसलिए अर्ध-पारदर्शी भराव, अल्फ़ा और ओवरलैपिंग कंटेंट बिल्कुल वैसे ही रहते हैं। ओपैसिटी स्लायडर ऊपर से एक और कंट्रोल देता है।",
      },
    },
  ],
};
