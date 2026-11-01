import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF → CBZ (PHASE-3 batch 3): the comic-book archive — every page as a
 * numbered JPEG inside a .cbz that comic readers open directly. DPI and
 * JPEG quality dials balance shelf size against crispness.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-cbz",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "zip",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      choices: [
        { value: "150", label: { en: "150 — phone reading", hi: "150 — फ़ोन पढ़ाई" } },
        { value: "200", label: { en: "200 — tablet", hi: "200 — टैबलेट" } },
        { value: "300", label: { en: "300 — archive quality", hi: "300 — आर्काइव क्वालिटी" } },
      ],
      default: "200",
    },
    {
      kind: "number",
      id: "quality",
      label: { en: "JPEG quality (%)", hi: "JPEG क्वालिटी (%)" },
      min: 50,
      max: 95,
      step: 5,
      default: 85,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["cbz-to-pdf", "view-pdf"],
  features: [
    {
      en: "The comic-reader standard — .cbz opens in CDisplayEx, YACReader, Panels and more.",
      hi: "कॉमिक-रीडर का स्टैंडर्ड — .cbz CDisplayEx, YACReader, Panels वग़ैरा में खुलता है।",
    },
    {
      en: "Every page a numbered JPEG (page-001.jpg …) — clean order in every reader.",
      hi: "हर पेज नंबर वाली JPEG (page-001.jpg …) — हर रीडर में साफ़ क्रम।",
    },
    {
      en: "DPI and JPEG quality dials — shrink the shelf or keep archive crispness.",
      hi: "DPI और JPEG क्वालिटी डायल — शेल्फ़ छोटी करें या आर्काइव जैसी तीखापन रखें।",
    },
    {
      en: "Convert the whole book or a chapter range.",
      hi: "पूरी किताब या सिर्फ़ एक अध्याय बदलें।",
    },
    {
      en: "Runs entirely on your device — your comics are never uploaded.",
      hi: "पूरा काम डिवाइस पर — आपकी कॉमिक्स कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is a CBZ file?",
        hi: "CBZ फ़ाइल क्या है?",
      },
      a: {
        en: "A ZIP archive of page images renamed .cbz — the simplest comic format there is. Readers treat it as an ordered picture book; every page is just a JPEG.",
        hi: "पेज-इमेज का ZIP आर्काइव जिसका नाम .cbz है — सबसे सरल कॉमिक फ़ॉर्मैट। रीडर इसे क्रम वाली तस्वीरों की किताब समझते हैं; हर पेज बस एक JPEG है।",
      },
    },
    {
      q: {
        en: "Which settings for reading on a phone?",
        hi: "फ़ोन पर पढ़ने के लिए कौन-सी सेटिंग?",
      },
      a: {
        en: "150 DPI with 80–85% quality keeps a typical 200-page comic around 30–60 MB and looks sharp on phone screens.",
        hi: "150 DPI और 80–85% क्वालिटी — 200 पेज की कॉमिक 30–60 MB में रहती है और फ़ोन स्क्रीन पर बिल्कुल साफ़।",
      },
    },
    {
      q: {
        en: "Is text still selectable in a CBZ?",
        hi: "CBZ में टेक्स्ट चुनने योग्य रहता है?",
      },
      a: {
        en: "No — pages are pictures, exactly like photographed paper comics. That is the format's nature and its simplicity.",
        hi: "नहीं — पेज तस्वीरें हैं, ठीक कैमरे से छवि कॉमिक जैसी। यही फ़ॉर्मैट की फ़ितरत और उसकी सादगी है।",
      },
    },
  ],
};
