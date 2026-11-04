import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to JSON (P3-a / R55) — the structured document export: every page
 * with its geometry (pt), extracted text (flow or per-line), counts and
 * optional per-item positions — one machine-readable JSON. The developer
 * counterpart of prepare-pdf-for-ai (which targets RAG chunks instead).
 * 100% on-device, zero network.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-json",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["prepare-pdf-for-ai", "pdf-to-csv", "pdf-to-txt"],
  options: [
    {
      kind: "select",
      id: "layout",
      label: { en: "Text layout", hi: "टेक्स्ट लेआउट" },
      hint: {
        en: "Flow merges lines into reading paragraphs; lines keeps one entry per visual line — better for exact page reproduction.",
        hi: "फ़्लो लाइनों को पैराग्राफ़ में जोड़ता है; lines हर विज़ुअल लाइन को अलग रखता है — पेज का सटीक पुनर्निर्माण चाहिए तो यह बेहतर है।",
      },
      choices: [
        { value: "flow", label: { en: "Flow — paragraphs", hi: "फ़्लो — पैराग्राफ़" } },
        { value: "lines", label: { en: "Lines — per visual line", hi: "लाइनें — हर लाइन अलग" } },
      ],
      default: "flow",
    },
    {
      kind: "switch",
      id: "textItems",
      label: { en: "Include text positions", hi: "टेक्स्ट की स्थिति भी शामिल करें" },
      hint: {
        en: "Every text piece with x/y coordinates, width and font size — for your own layout analysis. Makes the file much larger.",
        hi: "हर टेक्स्ट टुकड़ा x/y निर्देशांक, चौड़ाई और फ़ॉन्ट साइज़ के साथ — अपने लेआउट विश्लेषण के लिए। फ़ाइल काफ़ी बड़ी हो जाती है।",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "One JSON, the whole document: file stats (pages, characters, words, language hint) plus a pages array with width, height and rotation in PDF points.",
      hi: "एक JSON में पूरा दस्तावेज़: फ़ाइल आँकड़े (पेज, अक्षर, शब्द, भाषा संकेत) और pages सूची — हर पेज की चौड़ाई, ऊँचाई और रोटेशन PDF पॉइंट्स में।",
    },
    {
      en: "Choose the text shape: flow (paragraphs merged for reading) or lines (one entry per visual line, the exact page order).",
      hi: "टेक्स्ट का रूप चुनें: फ़्लो (पढ़ने लायक पैराग्राफ़) या लाइनें (हर विज़ुअल लाइन अलग, पेज का सटीक क्रम)।",
    },
    {
      en: "Turn on text positions to get every piece with x/y coordinates, width and font size — feed your own layout analysis, translation tooling or search indexer.",
      hi: "टेक्स्ट पोज़िशन चालू करें तो हर टुकड़ा x/y निर्देशांक, चौड़ाई और फ़ॉन्ट साइज़ के साथ मिलता है — अपना लेआउट विश्लेषण, ट्रांसलेशन टूलिंग या सर्च इंडेक्सर चलाइए।",
    },
    {
      en: "Works with English and Hindi (Devanagari) text; the language hint tells you what the document holds before you write a line of parsing code.",
      hi: "अंग्रेज़ी और हिन्दी (देवनागरी) दोनों चलते हैं; भाषा संकेत पहले बता देता है कि दस्तावेज़ में क्या है — पार्सिंग कोड लिखने से पहले।",
    },
    {
      en: "Up to 5 PDFs in one run, each exported as its own JSON file.",
      hi: "एक बार में 5 PDF तक, हर एक की अपनी JSON फ़ाइल।",
    },
    {
      en: "Your document never leaves the device — extraction and export happen in your browser. Zero uploads, zero API keys.",
      hi: "आपका दस्तावेज़ डिवाइस से बाहर नहीं जाता — एक्स्ट्रैक्शन और एक्सपोर्ट आपके ब्राउज़र में होते हैं। कोई अपलोड नहीं, कोई API की नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from Prepare PDF for AI?",
        hi: "यह Prepare PDF for AI से कैसे अलग है?",
      },
      a: {
        en: "Prepare PDF for AI reshapes your document for RAG pipelines — chunk nodes with token estimates, the LlamaIndex convention. PDF to JSON keeps the document's own structure: one entry per page with geometry, text and counts. Use the first to feed an AI; use this when your code wants the document as data.",
        hi: "Prepare PDF for AI दस्तावेज़ को RAG पाइपलाइन के लिए ढालता है — टोकन अनुमान वाले चंक नोड्स, LlamaIndex शैली। PDF to JSON दस्तावेज़ की अपनी संरचना रखता है: हर पेज की अपनी एंट्री — ज्यामिति, टेक्स्ट और गिनती के साथ। AI को खिलाने के लिए पहला, और जब आपके कोड को दस्तावेज़ डेटा के रूप में चाहिए तो यह वाला।",
      },
    },
    {
      q: {
        en: "What are the coordinate values when I enable text positions?",
        hi: "टेक्स्ट पोज़िशन चालू करने पर निर्देशांक क्या होते हैं?",
      },
      a: {
        en: "PDF user-space points: the origin is the bottom-left corner of the page, y grows upward, and one point is 1/72 inch. Width is the piece's advance width; fontSize is its rendered size. The page object's width/height tell you the box they live in.",
        hi: "PDF यूज़र-स्पेस पॉइंट: मूल बिंदु पेज का निचला-बायाँ कोना, y ऊपर की ओर बढ़ता है, और एक पॉइंट = 1/72 इंच। width टुकड़े की चौड़ाई है; fontSize उसका रेंडर साइज़। पेज ऑब्जेक्ट की width/height बताती है कि वे किस बॉक्स में हैं।",
      },
    },
    {
      q: {
        en: "Why does my scanned PDF fail?",
        hi: "मेरी स्कैन की हुई PDF क्यों असफल होती है?",
      },
      a: {
        en: "Scanned pages are images — there is no text to export. Run the file through PDF OCR first, then export the OCR result here. The tool refuses honestly instead of shipping an empty JSON.",
        hi: "स्कैन किए पेज तस्वीरें हैं — निर्यात करने को टेक्स्ट ही नहीं होता। पहले फ़ाइल को PDF OCR से निकालिए, फिर वही नतीजा यहाँ एक्सपोर्ट करें। यह टूल ख़ाली JSON देने के बजाय ईमानदारी से मना करता है।",
      },
    },
  ],
};
