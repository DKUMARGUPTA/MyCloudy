import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * XML → PDF (PHASE-3 batch 3): a nesting-aware pretty-printer — tags
 * indented by depth, attributes kept, text nodes on their own lines —
 * rendered as a colourised Courier document. Sitemap, config, RSS and
 * API dumps become reviewable.
 */
export const config: ToolConfig = {
  toolId: "xml-to-pdf",
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
      en: "Nesting-aware pretty-print — every tag indented by its depth.",
      hi: "नेस्टिंग-जागरूक प्रिंट — हर टैग अपनी गहराई के हिसाब से इंडेंट।",
    },
    {
      en: "Declarations, comments and attributes all survive intact.",
      hi: "डिक्लेरेशन, कमेंट और एट्रिब्यूट सब जस के तस बचते हैं।",
    },
    {
      en: "Tags tinted apart from text — structure jumps out while reading.",
      hi: "टैग टेक्स्ट से अलग रंग में — पढ़ते ही ढाँचा सामने आता है।",
    },
    {
      en: "Long attribute lines wrap cleanly; A4 or Letter, either orientation.",
      hi: "लंबी एट्रिब्यूट लाइनें साफ़ लपेटती हैं; A4 या लेटर, दोनों दिशाएँ।",
    },
    {
      en: "Up to 10 files in one run — nothing leaves your device.",
      hi: "एक रन में 10 फ़ाइलें — कुछ भी डिवाइस से बाहर नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does it validate the XML?",
        hi: "क्या यह XML की जाँच करता है?",
      },
      a: {
        en: "It checks the file is plausibly XML (starts with '<') and formats honestly from there — it does not run a full schema validation. Need strict checks? Use a validator first.",
        hi: "यह जाँचता है कि फ़ाइल XML जैसी है ('<' से शुरू) और वहीं से ईमानदार फ़ॉर्मैटिंग करता है — पूरी स्कीमा जाँच नहीं। सख़्त जाँच चाहिए तो पहले कोई वैलिडेटर चलाएँ।",
      },
    },
    {
      q: {
        en: "Namespaces and CDATA?",
        hi: "नेमस्पेस और CDATA?",
      },
      a: {
        en: "Kept exactly as written — namespaces stay on their tags and CDATA blocks print as-is on their own lines.",
        hi: "जैसा लिखा है वैसा ही रहता है — नेमस्पेस टैग पर बने रहते हैं और CDATA ब्लॉक अपनी लाइनों पर जस का तस छपते हैं।",
      },
    },
    {
      q: {
        en: "Why Courier for XML?",
        hi: "XML के लिए Courier ही क्यों?",
      },
      a: {
        en: "Monospaced text keeps columns of attributes aligned — the way every serious XML editor shows it.",
        hi: "मोनोस्पेस टेक्स्ट में एट्रिब्यूट के कॉलम सीधे रहते हैं — जैसे हर असली XML एडिटर दिखाता है।",
      },
    },
  ],
};
