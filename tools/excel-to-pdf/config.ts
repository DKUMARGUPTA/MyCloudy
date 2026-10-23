import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Excel to PDF (RB1-c — the 69th tool). XLSX/XLSM sheets → clean
 * table PDFs, 100% on-device (mode D), EN + हिंदी.
 *
 * The surface (tools/excel-to-pdf/surface.tsx) owns the whole flow
 * (create-card / scan-pdf precedent): a DropZone that sniffs the real
 * OOXML magic (PK + [Content_Types] — extension labels are never
 * trusted), a live workbook summary (sheets × rows × cols detected on
 * the main thread by the same pure model the worker uses), the sheet
 * picker (all or individual), orientation, page size, fit-to-width and
 * zebra options — everything rides the option values so it survives
 * ToolShell phase remounts. The Convert button spawns the worker
 * (create-resume protocol) which re-parses the file in the worker and
 * draws the PDF with pdf-lib.
 *
 * Honest limits (mirrored in the FAQ): formulas export their last
 * cached value or the raw formula text — nothing is recalculated;
 * charts, images and shapes are not rendered; very wide sheets are
 * truncated at 100 columns (and 500 rows / 10 sheets); legacy binary
 * .xls is rejected with a "convert first" message (the modern .xlsx
 * format has been Excel's default since 2007).
 */
export const config: ToolConfig = {
  toolId: "excel-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  fullWidthSurface: true,
  landingSurface: true,
  options: [],
  howKeys: ["xls.how1", "xls.how2", "xls.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Every sheet becomes a clean table PDF — real selectable text in a proper grid with a bold header row, hairlines and automatic page breaks that repeat the header on every page.",
      hi: "हर शीट एक साफ़ टेबल PDF बनती है — बोल्ड हेडर पंक्ति, बारीक लाइनों और हर पेज पर दोहराए जाने वाले हेडर के साथ असली चुनने योग्य टेक्स्ट।",
    },
    {
      en: "Pick which sheets to export (all of them or just a few), portrait or landscape, A4 or US Letter, and whether the table stretches to the full page width — the live summary shows every sheet's rows and columns before you commit.",
      hi: "चुनें कौन-सी शीट एक्सपोर्ट करनी है (सब या कुछ), पोर्ट्रेट या लैंडस्केप, A4 या US लेटर, और टेबल पूरी पेज-चौड़ाई तक फैले या नहीं — लाइव सारांश में हर शीट की पंक्तियाँ और कॉलम पहले ही दिख जाते हैं।",
    },
    {
      en: "Dates come out as real dates (Excel serial numbers are converted), TRUE/FALSE cells, inline text and formula results are all read — and everything happens inside your browser, the file never leaves your device.",
      hi: "तिथियाँ असली तिथियाँ बनकर आती हैं (Excel सीरियल नंबर बदले जाते हैं), TRUE/FALSE सेल, इनलाइन टेक्स्ट और फ़ॉर्मूला के नतीजे सब पढ़े जाते हैं — और सब कुछ आपके ब्राउज़र के अंदर होता है, फ़ाइल कहीं नहीं जाती।",
    },
    {
      en: "Hindi spreadsheets print properly — any Devanagari text or ₹ amount embeds the Noto font so the PDF is crisp and searchable in both languages.",
      hi: "हिंदी स्प्रेडशीट सही छपती हैं — कोई भी देवनागरी टेक्स्ट या ₹ राशि Noto फ़ॉन्ट जोड़ देती है, इसलिए PDF दोनों भाषाओं में साफ़ और सर्च करने योग्य रहता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What happens to my formulas?",
        hi: "मेरे फ़ॉर्मूलों का क्या होता है?",
      },
      a: {
        en: "Nothing is recalculated. Each formula cell exports its last cached value — the number Excel saved the last time the file was open. If a cell has no cached value at all, the formula text itself is printed (like =SUM(A1:A5)). To refresh the numbers, open the file in Excel or Google Sheets, save, then convert.",
        hi: "कुछ भी दोबारा गणना नहीं होती। हर फ़ॉर्मूला सेल अपनी आख़िरी सेव की गई कैश वैल्यू एक्सपोर्ट करता है — वही नंबर जो Excel ने पिछली बार फ़ाइल खुलने पर सेव किया था। अगर किसी सेल की कोई कैश वैल्यू ही नहीं है, तो फ़ॉर्मूले का टेक्स्ट जैसा है वैसा छप जाता है (जैसे =SUM(A1:A5))। नंबर ताज़ा करने के लिए फ़ाइल को Excel या Google Sheets में खोलकर सेव करें, फिर बदलें।",
      },
    },
    {
      q: {
        en: "Do charts, images and cell colours come through?",
        hi: "क्या चार्ट, तस्वीरें और सेल के रंग आ जाते हैं?",
      },
      a: {
        en: "No — this converts the cell data, not the drawing layer. Charts, embedded images, shapes and cell background colours are not rendered; what you get is the actual table: text, numbers, dates and TRUE/FALSE values in a clean grid. Bold text survives; everything else about the decoration does not.",
        hi: "नहीं — यह सेल का डेटा बदलता है, ड्रॉइंग लेयर नहीं। चार्ट, जुड़ी तस्वीरें, शेप और सेल के बैकग्राउंड रंग रेंडर नहीं होते; जो मिलता है वह असली टेबल है: टेक्स्ट, नंबर, तिथि और TRUE/FALSE वैल्यू, एक साफ़ ग्रिड में। बोल्ड टेक्स्ट बचा रहता है; सजावट का बाक़ी सब नहीं।",
      },
    },
    {
      q: {
        en: "What are the size limits?",
        hi: "आकार की सीमाएँ क्या हैं?",
      },
      a: {
        en: "Per sheet the PDF shows the first 100 columns and 500 rows, and the first 10 sheets of a workbook — the tool tells you honestly when something was cut. Very wide tables are fit to the page width with wrapped text, so enormous spreadsheets still produce readable pages rather than confetti.",
        hi: "हर शीट में PDF पहले 100 कॉलम और 500 पंक्तियाँ दिखाता है, और वर्कबुक की पहली 10 शीट — कुछ काटा गया हो तो टूल साफ़ बता देता है। बहुत चौड़ी टेबल पेज-चौड़ाई में फ़िट होकर टेक्स्ट लपेटती है, ताकि विशाल स्प्रेडशीट भी पढ़ने योग्य पेज ही बनाए।",
      },
    },
    {
      q: {
        en: "Why is my .xls file rejected?",
        hi: "मेरी .xls फ़ाइल क्यों अस्वीकृत हुई?",
      },
      a: {
        en: "The old binary .xls format (and .xlsb) is not supported — this tool reads the modern .xlsx / .xlsm format that Excel, Google Sheets and LibreOffice have used by default since 2007. Open your .xls once in any of those, save it as .xlsx, then drop it here. The tool detects this case and tells you exactly that instead of producing garbage.",
        hi: "पुराना बाइनरी .xls फ़ॉर्मैट (और .xlsb) समर्थित नहीं है — यह टूल आधुनिक .xlsx / .xlsm फ़ॉर्मैट पढ़ता है जिसे Excel, Google Sheets और LibreOffice 2007 से डिफ़ॉल्ट रूप से इस्तेमाल करते हैं। अपनी .xls को इनमें से किसी में एक बार खोलकर .xlsx के रूप में सेव करें, फिर यहाँ डालें। टूल यह मामला पहचानकर साफ़ यही बता देता है, बेकार फ़ाइल बनाने की जगह।",
      },
    },
  ],
};
