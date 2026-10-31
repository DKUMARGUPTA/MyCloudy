import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Prepare PDF for AI (P2 / R54) — PDF → LlamaIndex-style JSON export for
 * RAG pipelines. Chunks with page metadata, token-estimated sizes,
 * paragraph-boundary integrity, optional overlap. The AI-first on-ramp:
 * feed the JSON to ChatGPT, Claude, LlamaIndex or LangChain without any
 * parsing boilerplate. 100% on-device, zero network.
 */
export const config: ToolConfig = {
  toolId: "prepare-pdf-for-ai",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "select",
      id: "format",
      label: { en: "Export format", hi: "एक्सपोर्ट फ़ॉर्मैट" },
      hint: {
        en: "JSON carries the full document + chunk nodes; JSONL is one node per line — the ingestion format most RAG loaders read.",
        hi: "JSON में पूरा दस्तावेज़ + चंक नोड्स; JSONL में हर लाइन एक नोड — ज़्यादातर RAG लोडर यही पढ़ते हैं।",
      },
      choices: [
        { value: "json", label: { en: "JSON — full document", hi: "JSON — पूरा दस्तावेज़" } },
        { value: "jsonl", label: { en: "JSONL — one node per line", hi: "JSONL — हर लाइन एक नोड" } },
      ],
      default: "json",
    },
    {
      kind: "number",
      id: "chunkTokens",
      label: { en: "Chunk size (tokens)", hi: "चंक साइज़ (टोकन)" },
      hint: {
        en: "Target size per chunk, estimated at ~4 characters per token. 800 fits most embedding models.",
        hi: "हर चंक का लक्ष्य आकार, ~4 अक्षर = 1 टोकन के हिसाब से। 800 ज़्यादातर एम्बेडिंग मॉडलों में फ़िट बैठता है।",
      },
      min: 128,
      max: 4000,
      step: 64,
      default: 800,
    },
    {
      kind: "number",
      id: "overlapTokens",
      label: { en: "Overlap (tokens)", hi: "ओवरलैप (टोकन)" },
      hint: {
        en: "Tail of one chunk carried into the next, so answers spanning a boundary stay retrievable.",
        hi: "एक चंक का आख़िरी हिस्सा अगले में जुड़ता है, ताकि सीमा पर बँटे जवाब भी मिलें।",
      },
      min: 0,
      max: 512,
      step: 16,
      default: 96,
    },
  ],
  chainToolIds: ["chat-with-pdf", "summarize-pdf", "pdf-to-txt"],
  features: [
    {
      en: "One JSON, ready for RAG: your PDF as a LlamaIndex-style document with chunk nodes, page metadata and token estimates — no parsing boilerplate.",
      hi: "RAG के लिए तैयार एक JSON: आपकी PDF LlamaIndex-शैली दस्तावेज़ बन जाती है — चंक नोड्स, पेज मेटाडेटा और टोकन अनुमान के साथ, बिना कोई पार्सिंग कोड।",
    },
    {
      en: "Chunks respect paragraph boundaries — retrieval gets semantically whole units, never mid-sentence fragments. Oversized paragraphs split at sentence ends.",
      hi: "चंक पैराग्राफ़ की सीमा तोड़ते नहीं — रिट्रीवल को पूरे-पूरे अर्थ वाले हिस्से मिलते हैं, वाक्य के बीच से कटा हुआ टुकड़ा नहीं। बहुत बड़े पैराग्राफ़ वाक्यांत पर बँटते हैं।",
    },
    {
      en: "Every node knows its page — start_page, end_page and page_label — so your AI answers can cite exactly where they came from.",
      hi: "हर नोड अपना पेज जानता है — start_page, end_page और page_label — ताकि AI के जवाब बता सकें कि वे कहाँ से आए।",
    },
    {
      en: "JSON or JSONL: the full document for inspection, or one-node-per-line for direct ingestion into LlamaIndex, LangChain, Haystack and friends.",
      hi: "JSON या JSONL: देखने-जाँचने के लिए पूरा दस्तावेज़, या हर लाइन एक नोड — LlamaIndex, LangChain, Haystack में सीधा इनजेस्ट।",
    },
    {
      en: "Up to 5 PDFs in one run, each exported separately. Works with English and Hindi (Devanagari) text; the language hint is recorded in metadata.",
      hi: "एक बार में 5 PDF तक, हर एक अलग एक्सपोर्ट। अंग्रेज़ी और हिन्दी (देवनागरी) दोनों चलते हैं; भाषा का संकेत मेटाडेटा में दर्ज होता है।",
    },
    {
      en: "Your document never leaves the device — extraction, chunking and export all happen in your browser. Zero uploads, zero API keys.",
      hi: "आपका दस्तावेज़ डिवाइस से बाहर नहीं जाता — एक्स्ट्रैक्शन, चंकिंग और एक्सपोर्ट सब आपके ब्राउज़र में। कोई अपलोड नहीं, कोई API की नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly is in the JSON?",
        hi: "JSON में ठीक क्या होता है?",
      },
      a: {
        en: "A LlamaIndex-style document: an id_, the full extracted text, metadata (file name, page count, char/word counts, token estimate, language hint) and a nodes array — one entry per chunk, each with its own id_, text, source pages and size counts. JSONL outputs just the nodes, one JSON object per line.",
        hi: "LlamaIndex-शैली का दस्तावेज़: एक id_, पूरा निकाला गया टेक्स्ट, मेटाडेटा (फ़ाइल का नाम, पेज संख्या, अक्षर/शब्द गिनती, टोकन अनुमान, भाषा संकेत) और nodes की सूची — हर चंक का अपना id_, टेक्स्ट, स्रोत पेज और आकार। JSONL में सिर्फ़ नोड्स होते हैं, हर लाइन में एक।",
      },
    },
    {
      q: {
        en: "How do I feed it to my AI stack?",
        hi: "इसे अपने AI सिस्टम में कैसे डालूँ?",
      },
      a: {
        en: "With LlamaIndex: SimpleDirectoryReader is unnecessary — load the JSON and map nodes to TextNode objects directly. With LangChain: JSONL lines map 1:1 to Document objects. With ChatGPT or Claude: paste the full text field or attach the JSON file. The token estimates tell you beforehand whether a chunk fits your model's context window.",
        hi: "LlamaIndex में: SimpleDirectoryReader की ज़रूरत नहीं — JSON लोड करके नोड्स सीधे TextNode बनाइए। LangChain में: JSONL की हर लाइन एक Document बनती है। ChatGPT या Claude में: पूरा text फ़ील्ड पेस्ट करें या JSON फ़ाइल जोड़ें। टोकन अनुमान पहले बता देता है कि चंक आपके मॉडल की कॉन्टेक्स्ट विंडो में फ़िट होगा या नहीं।",
      },
    },
    {
      q: {
        en: "Why does my scanned PDF fail?",
        hi: "मेरी स्कैन की हुई PDF क्यों असफल होती है?",
      },
      a: {
        en: "Scanned pages are images — there is no text to chunk. Run the file through PDF OCR first, then prepare the OCR result here. The tool refuses honestly instead of exporting an empty JSON.",
        hi: "स्कैन किए पेज तस्वीरें हैं — चंक करने को टेक्स्ट ही नहीं होता। पहले फ़ाइल को PDF OCR से निकालिए, फिर वही नतीजा यहाँ तैयार करें। यह टूल ख़ाली JSON निर्यात करने के बजाय ईमानदारी से मना करता है।",
      },
    },
  ],
};
