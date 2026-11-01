import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Timestamp PDF (PHASE-3 batch 2): stamp the current date/time onto every
 * selected page — receipt-style proof of when a document was processed.
 * Local timezone, four formats, nine placements, colour/size/opacity
 * dials. StampContext (the page-numbers/watermark pipeline) on OUR OWN
 * engine.
 */
export const config: ToolConfig = {
  toolId: "timestamp-pdf",
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
      id: "format",
      label: { en: "Format", hi: "फ़ॉर्मैट" },
      choices: [
        { value: "datetime", label: { en: "26 Jan 2026, 14:30:05", hi: "26 जन 2026, 14:30:05" } },
        { value: "date", label: { en: "26 Jan 2026", hi: "26 जन 2026" } },
        { value: "time", label: { en: "14:30:05", hi: "14:30:05" } },
        { value: "iso", label: { en: "2026-01-26T14:30:05+05:30 (ISO)", hi: "2026-01-26T14:30:05+05:30 (ISO)" } },
      ],
      default: "datetime",
    },
    {
      kind: "text",
      id: "prefix",
      label: { en: "Label before the timestamp (optional)", hi: "टाइमस्टैम्प से पहले लेबल (वैकल्पिक)" },
      placeholder: { en: "e.g. Processed on", hi: "जैसे: प्रोसेस्ड on" },
      default: "",
    },
    {
      kind: "select",
      id: "position",
      label: { en: "Placement", hi: "जगह" },
      choices: [
        { value: "top-left", label: { en: "Top left", hi: "ऊपर बाएँ" } },
        { value: "top-center", label: { en: "Top center", hi: "ऊपर बीच" } },
        { value: "top-right", label: { en: "Top right", hi: "ऊपर दाएँ" } },
        { value: "middle-left", label: { en: "Middle left", hi: "बीच बाएँ" } },
        { value: "middle-center", label: { en: "Middle center", hi: "बीच में" } },
        { value: "middle-right", label: { en: "Middle right", hi: "बीच दाएँ" } },
        { value: "bottom-left", label: { en: "Bottom left", hi: "नीचे बाएँ" } },
        { value: "bottom-center", label: { en: "Bottom center", hi: "नीचे बीच" } },
        { value: "bottom-right", label: { en: "Bottom right", hi: "नीचे दाएँ" } },
      ],
      default: "bottom-right",
    },
    {
      kind: "number",
      id: "size",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      min: 7,
      max: 24,
      step: 1,
      default: 9,
    },
    {
      kind: "select",
      id: "color",
      label: { en: "Colour", hi: "रंग" },
      choices: [
        { value: "gray", label: { en: "Gray", hi: "स्लेटी" } },
        { value: "black", label: { en: "Black", hi: "काला" } },
        { value: "red", label: { en: "Red", hi: "लाल" } },
        { value: "blue", label: { en: "Blue", hi: "नीला" } },
        { value: "green", label: { en: "Green", hi: "हरा" } },
      ],
      default: "gray",
    },
    {
      kind: "number",
      id: "opacity",
      label: { en: "Opacity (%)", hi: "अपारदर्शिता (%)" },
      min: 30,
      max: 100,
      step: 5,
      default: 70,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["bates-numbering", "add-page-numbers", "view-pdf"],
  features: [
    {
      en: "Receipt-style proof — the exact moment each page was processed, stamped in your local timezone.",
      hi: "रसीद जैसा सबूत — हर पेज कब प्रोसेस हुआ, आपकी लोकल टाइमज़ोन में ठप्पा।",
    },
    {
      en: "Four formats: full date-time, date only, time only, or strict ISO 8601.",
      hi: "चार फ़ॉर्मैट: पूरी तारीख़-समय, सिर्फ़ तारीख़, सिर्फ़ समय, या सख़्त ISO 8601।",
    },
    {
      en: "Nine placements, five colours, size and opacity dials — subtle footer or loud corner.",
      hi: "नौ जगहें, पाँच रंग, साइज़-अपारदर्शिता डायल — हल्का फ़ुटर या चमकीला कोना।",
    },
    {
      en: "Optional label before the stamp — 'Verified on', 'Scanned on', anything.",
      hi: "ठप्पे से पहले लेबल — 'Verified on', 'Scanned on', जो चाहें।",
    },
    {
      en: "Vector text on the original pages — text stays selectable, file stays light. Runs on your device.",
      hi: "मूल पेजों पर वेक्टर टेक्स्ट — चुनने योग्यता बनी रहती है, फ़ाइल हल्की रहती है। सब डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "Whose clock does the timestamp use?",
        hi: "टाइमस्टैम्प किसकी घड़ी से आता है?",
      },
      a: {
        en: "Your device's clock and timezone, captured the moment you press run — no server involved, no network call, nothing to trust but your own machine.",
        hi: "आपके डिवाइस की घड़ी और टाइमज़ोन, रन दबाते ही — न सर्वर, न नेटवर्क कॉल, भरोसा सिर्फ़ अपनी मशीन पर।",
      },
    },
    {
      q: {
        en: "Is this a certified / trusted timestamp?",
        hi: "क्या यह प्रमाणित / भरोसेमंद टाइमस्टैम्प है?",
      },
      a: {
        en: "No — it records your device's time, like writing the date on a paper receipt. Courts and regulators that need provable time need a qualified electronic timestamp or digital signature service instead.",
        hi: "नहीं — यह आपके डिवाइस का समय लिखता है, काग़ज़ की रसीद पर तारीख़ लिखने जैसा। अदालत या रेगुलेटर को साबित समय चाहिए तो क्वालिफ़ाइड इलेक्ट्रॉनिक टाइमस्टैम्प या डिजिटल हस्ताक्षर सेवा चाहिए।",
      },
    },
    {
      q: {
        en: "Can I stamp pages of many PDFs at once?",
        hi: "एक साथ कई PDF के पेजों पर लगा सकते हैं?",
      },
      a: {
        en: "Yes — up to 20 files. Each file gets its own stamped copy in the results, all stamped within the same run.",
        hi: "हाँ — 20 फ़ाइलों तक। हर फ़ाइल की अपनी ठप्पा-लगी कॉपी नतीजों में आती है, सब एक ही रन में।",
      },
    },
  ],
};
