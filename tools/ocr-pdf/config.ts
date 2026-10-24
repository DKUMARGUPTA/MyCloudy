import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF OCR (PRD §8.4) — on-device Tesseract (LSTM) with self-hosted
 * English + Hindi models. Scanned pages become searchable; pages that
 * already have text pass through untouched. Output: searchable PDF or
 * plain text.
 */
export const config: ToolConfig = {
  toolId: "ocr-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["pdf-to-txt", "compress-pdf", "lock-pdf"],
  options: [
    {
      kind: "select",
      id: "languages",
      label: { en: "Language", hi: "भाषा" },
      hint: {
        en: "First run downloads the model once (English 3 MB, Hindi 1.4 MB) — then it works offline",
        hi: "पहली बार मॉडल एक बार डाउनलोड होता है (अंग्रेज़ी 3 MB, हिंदी 1.4 MB) — फिर ऑफ़लाइन चलता है",
      },
      choices: [
        { value: "eng", label: { en: "English", hi: "अंग्रेज़ी" } },
        { value: "hin", label: { en: "हिंदी — Hindi", hi: "हिंदी" } },
        {
          value: "eng+hin",
          label: { en: "English + हिंदी", hi: "अंग्रेज़ी + हिंदी" },
        },
      ],
      default: "eng",
    },
    {
      kind: "select",
      id: "output",
      label: { en: "Output", hi: "आउटपुट" },
      hint: {
        en: "Searchable PDF keeps the scan and adds an invisible text layer; Text gives plain .txt",
        hi: "Searchable PDF स्कैन रखता है और अदृश्य टेक्स्ट जोड़ता है; Text सादा .txt देता है",
      },
      choices: [
        {
          value: "searchable",
          label: { en: "Searchable PDF", hi: "खोजने योग्य PDF" },
        },
        { value: "text", label: { en: "Text (.txt)", hi: "टेक्स्ट (.txt)" } },
      ],
      default: "searchable",
    },
    {
      kind: "select",
      id: "dpi",
      label: { en: "Scan quality", hi: "स्कैन क्वालिटी" },
      hint: {
        en: "300 DPI reads small and Hindi text better, but takes longer",
        hi: "300 DPI छोटे और हिंदी टेक्स्ट को बेहतर पढ़ता है, पर धीमा है",
      },
      choices: [
        {
          value: "150",
          label: { en: "150 DPI — fast", hi: "150 DPI — तेज़" },
        },
        {
          value: "300",
          label: { en: "300 DPI — best accuracy", hi: "300 DPI — सबसे सटीक" },
        },
      ],
      default: "150",
    },
    {
      kind: "switch",
      id: "deskew",
      label: {
        en: "Deskew pages",
        hi: "पेज सीधे करें (डीस्क्यू)",
      },
      hint: {
        en: "Straightens slightly-tilted scans before OCR (up to ±10°). Applies to pages that get OCR'd — the output page is the straightened scan with its search text aligned to it; pages that already have text are untouched.",
        hi: "OCR से पहले हल्के टेढ़े स्कैन सीधे करता है (±10° तक)। यह उन्हीं पेजों पर लागू होता है जिन पर OCR होता है — आउटपुट पेज सीधा किया स्कैन होता है, उसकी खोज-परत उसी के साथ बैठती है; जिन पेजों में पहले से टेक्स्ट है वे जस के तस रहते हैं।",
      },
      default: false,
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
    {
      kind: "switch",
      id: "skipText",
      label: { en: "Skip pages that already have text", hi: "जिन पेजों में टेक्स्ट है, छोड़ें" },
      hint: {
        en: "Mixed files: digital pages pass through unchanged, only scans get OCR",
        hi: "मिली-जुली फ़ाइलों में: डिजिटल पेज जस के तस, सिर्फ़ स्कैन पर OCR",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "pageMarks",
      label: { en: "Mark page breaks", hi: "पेज-ब्रेक चिह्नित करें" },
      hint: {
        en: "Text output: adds ───── Page N ───── between pages",
        hi: "टेक्स्ट आउटपुट में ───── Page N ───── जोड़ता है",
      },
      default: true,
    },
  ],
  features: [
    {
      en: "Recognize scanned English and Hindi text — देवनागरी included, no upload.",
      hi: "स्कैन किया अंग्रेज़ी और हिंदी टेक्स्ट पहचानें — देवनागरी शामिल, कोई अपलोड नहीं।",
    },
    {
      en: "Searchable PDF keeps your original scan and hides the text layer under it — copy and search work instantly.",
      hi: "खोजने योग्य PDF में असली स्कैन जस का तस रहता है, नीचे छिपी टेक्स्ट परत से खोजना-कॉपी करना तुरंत चलता है।",
    },
    {
      en: "Mixed documents are smart: pages with real text are never re-OCRed.",
      hi: "मिली-जुली फ़ाइलें समझदारी से: जिन पेजों में टेक्स्ट है उन्हें दोबारा OCR नहीं होता।",
    },
    {
      en: "Language models download once on first use and are cached — after that OCR works offline.",
      hi: "भाषा मॉडल पहली बार एक बार आते हैं और कैश हो जाते हैं — उसके बाद OCR ऑफ़लाइन चलता है।",
    },
    {
      en: "Optional deskew straightens tilted scans before recognition — accuracy and the search layer both improve.",
      hi: "वैकल्पिक डीस्क्यू पहचान से पहले टेढ़े स्कैन सीधे कर देता है — सटीकता और खोज-परत दोनों बेहतर होते हैं।",
    },
    {
      en: "Runs entirely on your device — the scan never leaves your browser.",
      hi: "पूरा काम डिवाइस पर — स्कैन ब्राउज़र से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: { en: "What is a searchable PDF?", hi: "खोजने योग्य PDF क्या है?" },
      a: {
        en: "Your scan stays pixel-identical, but an invisible text layer is added underneath. Ctrl+F, select, copy — everything works like on a normal document.",
        hi: "आपका स्कैन जस का तस रहता है, बस नीचे एक अदृश्य टेक्स्ट परत जुड़ जाती है। Ctrl+F, चुनना, कॉपी — सब सामान्य दस्तावेज़ जैसा चलता है।",
      },
    },
    {
      q: { en: "How accurate is Hindi OCR?", hi: "हिंदी OCR कितना सटीक है?" },
      a: {
        en: "Modern LSTM models read clean printed Hindi very well. For best results scan at 300 DPI and keep the page straight. Handwriting is not supported.",
        hi: "LSTM मॉडल साफ़ छपी हिंदी बहुत अच्छी पढ़ते हैं। बेहतर नतीजे के लिए 300 DPI पर स्कैन करें और पेज सीधा रखें। हस्तलेखन समर्थित नहीं है।",
      },
    },
    {
      q: { en: "What does \"Deskew pages\" do?", hi: "\"पेज सीधे करें (डीस्क्यू)\" क्या करता है?" },
      a: {
        en: "Scanners and phone cameras often tilt the page a few degrees. With the switch on, each page that needs OCR is measured (text-line baselines) and rotated back — up to ±10° — before recognition, which reads crooked text noticeably better. The output page is the straightened scan, and its invisible search layer is drawn from that same straightened image, so search highlights land exactly on the words you see. Pages that already have selectable text are never touched.",
        hi: "स्कैनर और फ़ोन कैमरे पेज को कुछ डिग्री घुमा देते हैं। स्विच ऑन होने पर जिस पेज पर OCR होना है उसे मापा जाता है (टेक्स्ट-लाइन बेसलाइन से) और पहचान से पहले वापस सीधा घुमाया जाता है — ±10° तक — जिससे टेढ़ा टेक्स्ट काफ़ी बेहतर पढ़ा जाता है। आउटपुट पेज सीधा किया स्कैन होता है, और उसकी अदृश्य खोज-परत उसी सीधी तस्वीर से बनती है, इसलिए खोज की हाइलाइट ठीक वहीं गिरती है जहाँ शब्द दिखते हैं। जिन पेजों में पहले से टेक्स्ट है, वे कभी नहीं बदलते।",
      },
    },
    {
      q: { en: "Why is the first run slower?", hi: "पहली बार धीमा क्यों?" },
      a: {
        en: "The OCR engine (~4 MB) and your language model download once from this site — never a third party — and are cached for offline use after that.",
        hi: "OCR इंजन (~4 MB) और भाषा मॉडल एक बार इसी साइट से आते हैं — किसी तीसरी पार्टी से नहीं — और उसके बाद ऑफ़लाइन उपयोग के लिए कैश हो जाते हैं।",
      },
    },
  ],
};
