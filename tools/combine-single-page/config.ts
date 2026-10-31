import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Combine to a single page (PHASE-1 Batch A): lay EVERY page of the PDF
 * onto one sheet — a contact-sheet view of the whole document. Choose
 * the paper, orientation, column count (or let it auto-fit a near-square
 * grid), margins and gaps.
 *
 * Schema-driven; the worker embeds each page as a Form XObject on OUR
 * OWN engine and composes one output sheet.
 */
export const config: ToolConfig = {
  toolId: "combine-single-page",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "paper",
      label: { en: "Sheet size", hi: "शीट साइज़" },
      choices: [
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US Letter" } },
        { value: "legal", label: { en: "US Legal", hi: "US Legal" } },
        {
          value: "match",
          label: { en: "Match page 1", hi: "पेज 1 जैसी" },
        },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "orientation",
      label: { en: "Orientation", hi: "दिशा" },
      choices: [
        {
          value: "auto",
          label: { en: "Auto", hi: "अपने आप" },
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
      kind: "number",
      id: "columns",
      label: { en: "Columns", hi: "कॉलम" },
      hint: {
        en: "0 lets the tool auto-fit a near-square grid",
        hi: "0 पर टूल अपने आप लगभग-वर्ग ग्रिड बनाता है",
      },
      min: 0,
      max: 12,
      default: 0,
    },
    {
      kind: "number",
      id: "margin",
      label: { en: "Sheet margin", hi: "शीट मार्जिन" },
      suffix: { en: "mm", hi: "mm" },
      min: 0,
      max: 30,
      default: 6,
    },
    {
      kind: "number",
      id: "gap",
      label: { en: "Gap between pages", hi: "पेजों के बीच गैप" },
      suffix: { en: "mm", hi: "mm" },
      min: 0,
      max: 30,
      default: 4,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Which pages to place on the sheet",
        hi: "शीट पर कौन से पेज रखें",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["pdf-to-png", "print", "view-pdf"],
  features: [
    {
      en: "The whole document becomes ONE page — a contact sheet of every page.",
      hi: "पूरा दस्तावेज़ एक ही पेज बन जाता है — हर पेज की संपर्क-शीट।",
    },
    {
      en: "Auto-fit grid or your own column count, with margins and gaps.",
      hi: "अपने-आप फ़िट ग्रिड या अपना कॉलम चुनाव — मार्जिन और गैप के साथ।",
    },
    {
      en: "A4, Letter, Legal or match your first page's size.",
      hi: "A4, Letter, Legal या पहले पेज के साइज़ जैसी शीट।",
    },
    {
      en: "Pick a page subset — combine just the pages that matter.",
      hi: "पेज चुनें — सिर्फ़ ज़रूरी पेजों को जोड़ें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from Pages per sheet (N-up)?",
        hi: "यह प्रति शीट पेज (N-up) से कैसे अलग है?",
      },
      a: {
        en: "N-up produces MANY sheets with a fixed number of pages each. Combine to a single page produces exactly ONE sheet with ALL pages in a grid — the whole document at a glance, ideal for overviews, storyboards and archives.",
        hi: "N-up कई शीट बनाता है, हर शीट पर तय संख्या में पेज। यह टूल ठीक एक शीट बनाता है जिसमें सारे पेज ग्रिड में होते हैं — पूरा दस्तावेज़ एक नज़र में; ओवरव्यू, स्टोरीबोर्ड और अभिलेख के लिए बढ़िया।",
      },
    },
    {
      q: {
        en: "How do I choose the grid?",
        hi: "ग्रिड कैसे चुनूँ?",
      },
      a: {
        en: "Leave Columns at 0 and the tool fits a near-square grid automatically. Or set an exact column count (1-12) — for example 3 columns for a 9-page document makes a clean 3×3 sheet.",
        hi: "कॉलम 0 छोड़ें तो टूल अपने आप लगभग-वर्ग ग्रिड फ़िट करता है। या सटीक कॉलम संख्या (1-12) दें — जैसे 9 पेज के दस्तावेज़ में 3 कॉलम से साफ़ 3×3 शीट बनती है।",
      },
    },
    {
      q: {
        en: "Will small text still be readable?",
        hi: "क्या छोटा टेक्स्ट पढ़ने लायक रहेगा?",
      },
      a: {
        en: "Each page keeps its original vectors and resolution — zooming in your PDF viewer stays crisp. How much fits at reading size depends on the page count and the sheet size you pick.",
        hi: "हर पेज का असली वेक्टर और रेज़ोल्यूशन वही रहता है — PDF व्यूअर में ज़ूम करने पर भी साफ़। पढ़ने लायक साइज़ कितना बनेगा, वह पेज संख्या और शीट साइज़ पर निर्भर करता है।",
      },
    },
  ],
};
