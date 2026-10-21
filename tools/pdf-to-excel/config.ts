import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to Excel (RB1-d — the 70th tool). Rule-based table extraction:
 * pdf.js text items cluster into rows and columns inside the worker and
 * leave as a real .xlsx workbook — 100% on-device, EN + हिंदी.
 *
 * The surface (tools/pdf-to-excel/surface.tsx) owns the flow
 * (create-card precedent): its own DropZone (%PDF sniff via the shared
 * component), a live page-1 grid probe, the sheet-mode and numeric-cell
 * options, and the Convert button that spawns this worker and
 * downloads + toasts. The shell CTA stays functional as a second entry
 * point (worker defaults when the option payload is empty).
 *
 * Honest limits (mirrored in the FAQ): detection is rule-based
 * geometry, not AI; borders, colours and formulas are not recovered;
 * scanned PDFs need the OCR tool first.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-excel",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  // The output is a spreadsheet, which the shared outputKind union does
  // not model ("pdf" | "image" | "text" | "zip") — omitted rather than
  // lying with "zip". The surface-driven run never needs it.
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  fullWidthSurface: true,
  options: [],
  howKeys: ["pdfxcel.how1", "pdfxcel.how2", "pdfxcel.how3"],
  // An .xlsx chains nowhere in this app — the honest empty list beats
  // handing a spreadsheet to a PDF-only tool.
  chainToolIds: [],
  features: [
    {
      en: "Rule-based grid detection, fully on your device — text items cluster into rows and columns by position, and every page's table becomes real spreadsheet cells.",
      hi: "नियम-आधारित ग्रिड पहचान, पूरी आपके डिवाइस पर — टेक्स्ट आइटम जगह के हिसाब से पंक्तियों और कॉलमों में बँधते हैं, और हर पेज की टेबल असली स्प्रेडशीट सेल बनती है।",
    },
    {
      en: "A true .xlsx workbook (Office Open XML) built with fflate — inline strings, pure numbers like 42 or 80.5 as numeric cells, and a bold header row.",
      hi: "fflate से बनी असली .xlsx वर्कबुक (Office Open XML) — इनलाइन स्ट्रिंग, 42 या 80.5 जैसे शुद्ध नंबर न्यूमेरिक सेल, और बोल्ड हेडर पंक्ति।",
    },
    {
      en: "One sheet per page or the whole document stacked into a single sheet — you choose before converting, with a live preview of the grid detected on page 1.",
      hi: "हर पेज की अलग शीट या पूरा दस्तावेज़ एक ही शीट में — बदलने से पहले चुनें, साथ में पेज 1 पर पहचाने ग्रिड का लाइव प्रीव्यू।",
    },
    {
      en: "English and हिंदी both work — Devanagari text lands in cells intact — and limits are honest: up to 20 sheets, 500 rows and 60 columns per sheet.",
      hi: "अंग्रेज़ी और हिंदी दोनों चलती हैं — देवनागरी टेक्स्ट सेल में बिना टूटे पहुँचता है — और सीमाएँ ईमानदार हैं: 20 शीट तक, हर शीट में 500 पंक्तियाँ और 60 कॉलम।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which PDFs convert cleanly?",
        hi: "कौन सी PDF साफ़ बदलती है?",
      },
      a: {
        en: "The detection is rule-based geometry, not AI: it works best on clearly tabular PDFs — invoices, statements, price lists, reports with aligned columns. Pages that are plain prose become a single-column sheet (one row per line), and tangled or overlapping layouts may need a quick tidy-up after export.",
        hi: "यह पहचान नियम-आधारित ज्यामिति है, AI नहीं: साफ़ टेबल वाली PDF पर सबसे अच्छा चलती है — बिल, स्टेटमेंट, प्राइस लिस्ट, कॉलम में सजी रिपोर्ट। सिर्फ़ गद्य वाले पेज एक-कॉलम शीट बनते हैं (हर लाइन एक पंक्ति), और उलझे लेआउट पर एक्सपोर्ट के बाद थोड़ी सफ़ाई करनी पड़ सकती है।",
      },
    },
    {
      q: {
        en: "What happens to text that wraps inside a cell?",
        hi: "सेल के भीतर लपेटता (wrapped) टेक्स्ट का क्या होता है?",
      },
      a: {
        en: "Multi-line wrapped text joins into one cell: a tightly-spaced continuation line whose columns sit under the row above merges into those cells (\"Quarterly totals are audited\" + \"by an external accountant\" becomes one cell). Fully wrapped rows where every column breaks at once are rarer and may land as their own row — a quick check after export catches them.",
        hi: "कई लाइनों में लपेटा टेक्स्ट एक ही सेल में जुड़ जाता है: ऊपर वाली पंक्ति के नीचे कसकर बैठी कंटिन्यूएशन लाइन उन्हीं सेल में मिल जाती है (\"Quarterly totals are audited\" + \"by an external accountant\" एक सेल बनता है)। हर कॉलम एक साथ टूटना और भी कम देखा जाता है — वह अलग पंक्ति बन सकता है; एक्सपोर्ट के बाद एक नज़र उसे पकड़ लेती है।",
      },
    },
    {
      q: {
        en: "Does it work on scanned PDFs?",
        hi: "स्कैन की हुई PDF पर चलता है?",
      },
      a: {
        en: "No — a scan has no selectable text, so the detector has nothing to position. Run the file through the PDF OCR tool first (English + Hindi, on-device), then convert that text-based PDF here. The page-1 probe warns you before you waste a run.",
        hi: "नहीं — स्कैन में चुनने योग्य टेक्स्ट नहीं होता, तो पहचान के लिए कुछ बचता ही नहीं। पहले PDF OCR टूल से फ़ाइल पढ़ें (अंग्रेज़ी + हिंदी, डिवाइस पर), फिर उसी टेक्स्ट वाली PDF को यहाँ बदलें। पेज-1 जाँच पहले ही चेता देती है।",
      },
    },
    {
      q: {
        en: "Are colours, borders and formulas recovered?",
        hi: "रंग, बॉर्डर और फ़ॉर्मूला भी आते हैं?",
      },
      a: {
        en: "No — this is text and numbers only, honestly. Cell fills, borders, merged-cell styling, colours, images and any formulas behind the PDF's values are not recovered; what you get is the detected text grid with pure numbers as numeric cells. Re-apply formatting in Excel or Sheets after export.",
        hi: "नहीं — यह सिर्फ़ टेक्स्ट और नंबर देता है, ईमानदारी से। सेल का रंग-भराव, बॉर्डर, मर्ज-सेल स्टाइल, तस्वीरें और PDF के पीछे छुपे फ़ॉर्मूले नहीं आते; जो मिलता है वह पहचाना गया टेक्स्ट ग्रिड है, शुद्ध नंबर न्यूमेरिक सेल बनकर। एक्सपोर्ट के बाद Excel या Sheets में सजावट फिर लगा लें।",
      },
    },
  ],
};
