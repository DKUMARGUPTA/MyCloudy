import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Change PDF page size (PRD §8.3): "A3/A4/A5/Letter/Legal/custom mm; scale
 * content (fit/fill/none); unify mixed sizes." Schema-driven options — every
 * id matches what the worker reads via PGSZ_IDS
 * (tools/change-pdf-page-size/engine.ts): size, customW/customH (mm, shown
 * for "custom"), orientation (auto follows each page's own shape), scale
 * (fit / fill / none), pages. The custom panel (panel.tsx) renders the LIVE
 * before/after preview + the mixed-size inventory from the same values;
 * the worker is the pdf-lib authority.
 */
export const config: ToolConfig = {
  toolId: "change-pdf-page-size",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "compress-pdf", "pages-per-sheet", "add-page-numbers"],
  options: [
    {
      kind: "select",
      id: "size",
      label: { en: "New page size", hi: "नई पेज साइज़" },
      hint: {
        en: "The paper size every selected page becomes",
        hi: "जिस पेपर साइज़ में चुने पेज बदलेंगे",
      },
      choices: [
        { value: "a3", label: { en: "A3", hi: "A3" } },
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "a5", label: { en: "A5", hi: "A5" } },
        { value: "letter", label: { en: "US Letter", hi: "US Letter" } },
        { value: "legal", label: { en: "US Legal", hi: "US Legal" } },
        { value: "tabloid", label: { en: "Tabloid", hi: "Tabloid" } },
        {
          value: "custom",
          label: { en: "Custom (mm)", hi: "कस्टम (mm)" },
        },
      ],
      default: "a4",
    },
    {
      kind: "number",
      id: "customW",
      label: { en: "Custom width", hi: "कस्टम चौड़ाई" },
      hint: {
        en: "Short side in millimetres (10–2000)",
        hi: "छोटा साइड मिलीमीटर में (10–2000)",
      },
      min: 10,
      max: 2000,
      step: 1,
      suffix: { en: "mm", hi: "mm" },
      default: 210,
      showWhen: { id: "size", equals: "custom" },
    },
    {
      kind: "number",
      id: "customH",
      label: { en: "Custom height", hi: "कस्टम लंबाई" },
      hint: {
        en: "Long side in millimetres (10–2000)",
        hi: "लंबा साइड मिलीमीटर में (10–2000)",
      },
      min: 10,
      max: 2000,
      step: 1,
      suffix: { en: "mm", hi: "mm" },
      default: 297,
      showWhen: { id: "size", equals: "custom" },
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      hint: {
        en: "Auto keeps each page's own portrait/landscape shape",
        hi: "ऑटो हर पेज की अपनी पोर्ट्रेट/लैंडस्केप दिशा रखता है",
      },
      choices: [
        {
          value: "auto",
          label: { en: "Auto (per page)", hi: "ऑटो (हर पेज)" },
        },
        {
          value: "portrait",
          label: { en: "Portrait", hi: "पोर्ट्रेट" },
        },
        {
          value: "landscape",
          label: { en: "Landscape", hi: "लैंडस्केप" },
        },
      ],
      default: "auto",
    },
    {
      kind: "select",
      id: "scale",
      label: { en: "Content scaling", hi: "कंटेंट स्केलिंग" },
      hint: {
        en: "How the page content lands on the new paper",
        hi: "नए पेपर पर कंटेंट कैसे बैठता है",
      },
      choices: [
        {
          value: "fit",
          label: { en: "Fit — whole page visible", hi: "फ़िट — पूरा पेज दिखे" },
        },
        {
          value: "fill",
          label: { en: "Fill — crop edges if needed", hi: "फ़िल — किनारे कट सकते हैं" },
        },
        {
          value: "none",
          label: { en: "Keep original size", hi: "मूल साइज़ रखें" },
        },
      ],
      default: "fit",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
  ],
  features: [
    {
      en: "Move any PDF onto A3, A4, A5, US Letter, US Legal, Tabloid — or an exact custom size in millimetres.",
      hi: "किसी भी PDF को A3, A4, A5, US Letter, US Legal, Tabloid — या मिलीमीटर में सटीक कस्टम साइज़ पर लाएँ।",
    },
    {
      en: "Fit shows the whole page, Fill covers the paper (edges may crop), or keep the original content size.",
      hi: "फ़िट में पूरा पेज दिखता है, फ़िल में काग़ज़ पूरा ढकता है (किनारे कट सकते हैं), या मूल साइज़ रखें।",
    },
    {
      en: "Mixed-size documents get unified — every page lands on the same paper, ready to print.",
      hi: "अलग-अलग साइज़ वाले दस्तावेज़ एक हो जाते हैं — हर पेज एक ही काग़ज़ पर, प्रिंट के लिए तैयार।",
    },
    {
      en: "Auto orientation keeps landscape slides landscape and portrait pages portrait.",
      hi: "ऑटो दिशा में लैंडस्केप स्लाइड लैंडस्केप रहती है और पोर्ट्रेट पेज पोर्ट्रेट।",
    },
    {
      en: "Live preview shows page 1 on the new paper, plus every distinct page size in your file.",
      hi: "लाइव प्रीव्यू में पेज 1 नए काग़ज़ पर दिखता है, साथ में फ़ाइल की सारी अलग साइज़ें।",
    },
    {
      en: "Pages already at the target size are kept untouched — links and form fields survive.",
      hi: "जो पेज पहले से सही साइज़ पर हैं वैसे ही रहते हैं — लिंक और फ़ॉर्म फ़ील्ड बचे रहते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between fit, fill and keep size?",
        hi: "फ़िट, फ़िल और मूल साइज़ में क्या फ़र्क़ है?",
      },
      a: {
        en: "Fit scales the page so everything stays visible, centered with empty margins if the shapes differ. Fill scales so the whole paper is covered — some edges may be cut off. Keep size leaves the content at its original dimensions, so a larger page shows extra margin and a smaller one clips the edges.",
        hi: "फ़िट में पूरा पेज दिखे इतना स्केल होता है — शेप अलग हो तो किनारे ख़ाली छूटते हैं। फ़िल में पूरा काग़ज़ ढक जाता है — कुछ किनारे कट सकते हैं। मूल साइज़ में कंटेंट जैसा है वैसा रहता है — बड़े पेज पर मार्जिन बढ़ता है, छोटे पर किनारे कटते हैं।",
      },
    },
    {
      q: {
        en: "Will my links, comments and form fields survive?",
        hi: "क्या मेरे लिंक, कमेंट और फ़ॉर्म फ़ील्ड बचे रहेंगे?",
      },
      a: {
        en: "Pages that already have the target size are copied untouched, so everything on them survives. Pages that get resized are rebuilt as scaled content — their links and interactive fields are dropped, the same trade-off every page-resizing tool makes. Text stays sharp and selectable everywhere.",
        hi: "जो पेज पहले से सही साइज़ पर हैं वे जस के तस कॉपी होते हैं — उनका सब कुछ बचता है। जिन पेजों का साइज़ बदलता है वे स्केल करके फिर से बनते हैं — उनके लिंक और इंटरैक्टिव फ़ील्ड हट जाते हैं, यही अदला-बदली हर साइज़-बदलने वाले टूल में होती है। टेक्स्ट हर जगह साफ़ और सिलेक्टेबल रहता है।",
      },
    },
    {
      q: {
        en: "How do I fix a document with mixed page sizes?",
        hi: "अलग-अलग पेज साइज़ वाली फ़ाइल कैसे ठीक करूँ?",
      },
      a: {
        en: "Just run this tool. The panel lists every distinct page size it found with page counts; pick the target (A4 is the safe default for India) and every page lands on that paper. Orientation \"Auto\" keeps each page's own portrait or landscape shape while unifying the size.",
        hi: "बस यह टूल चलाएँ। पैनल में मिली हर अलग साइज़ पेज-गिनती के साथ दिखती है; टारगेट चुनें (भारत के लिए A4 सबसे सुरक्षित) और हर पेज उसी काग़ज़ पर आ जाता है। दिशा \"ऑटो\" रखें तो साइज़ एक होते हुए भी हर पेज अपनी पोर्ट्रेट/लैंडस्केप दिशा रखता है।",
      },
    },
  ],
};
