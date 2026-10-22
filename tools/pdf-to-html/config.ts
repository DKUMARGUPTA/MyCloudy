import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to HTML (RB4-b). PDF → ONE self-contained .html, 100%
 * on-device: a Web Worker runs pdf.js (the pdf-to-word extraction
 * recipe) and the model's HTML builder emits a standalone file —
 * embedded minimal CSS, semantic tags, UTF-8 text. EN + हिंदी.
 *
 * The surface (tools/pdf-to-html/surface.tsx) owns the flow
 * (pdf-to-powerpoint precedent): its own DropZone (%PDF sniffed by
 * the shared component), a live page-count preview, the mode
 * explainer (flow = clean readable reflow vs layout = looks like
 * the pages), the page-number switch and page range bound to the
 * shared option values, and the Convert button that spawns this
 * worker. The shell CTA runs the same worker through the standard
 * pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - flow mode is a reflow: text, paragraphs, two heading tiers,
 *    bold/italic and lists survive; positions, columns, images,
 *    colours and tables do not (tables come out as text flow);
 *  - layout mode keeps the page look (exact px geometry, pt × 96/72)
 *    but the text never rewraps — it is a picture made of words, and
 *    the baseline uses a standard 0.8 em ascent approximation;
 *  - scanned PDFs (no selectable text anywhere) stop with an honest
 *    error instead of an empty file;
 *  - Hindi needs NO font embedding — plain UTF-8 is HTML's advantage
 *    over PDF (browsers already carry Devanagari system fonts).
 */
export const config: ToolConfig = {
  toolId: "pdf-to-html",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  // A single downloadable .html document — the same "text" outputKind
  // pdf-to-word uses for its single-file .docx (the union has no
  // "file" member; "text" is the honest closest kind).
  outputKind: "text",
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  howKeys: ["phtml.how1", "phtml.how2", "phtml.how3"],
  options: [
    {
      kind: "select",
      id: "mode",
      label: { en: "Output", hi: "आउटपुट" },
      hint: {
        en: "Flow reflows into clean responsive HTML; layout keeps the page look",
        hi: "फ़्लो साफ़ रिस्पॉन्सिव HTML बनाता है; लेआउट पेज का लुक रखता है",
      },
      choices: [
        { value: "flow", label: { en: "Flow (readable)", hi: "फ़्लो (पढ़ने योग्य)" } },
        { value: "layout", label: { en: "Layout (page look)", hi: "लेआउट (पेज जैसा)" } },
      ],
      default: "flow",
    },
    {
      kind: "switch",
      id: "pageNumbers",
      label: { en: "Page markers", hi: "पेज मार्कर" },
      hint: {
        en: "A small \"Page N\" label at each PDF page boundary in the output",
        hi: "आउटपुट में हर PDF पेज की सीमा पर छोटा \"पेज N\" लेबल",
      },
      default: false,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "e.g. 1-3, 5, 8- — only the selected pages are converted",
        hi: "जैसे 1-3, 5, 8- — चुने पेज ही बदलते हैं",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  // An .html chains honestly into html-to-pdf (accepts text) — the
  // round trip stays in the family.
  chainToolIds: ["html-to-pdf"],
  features: [
    {
      en: "One self-contained .html file — doctype, charset, title from the PDF's own metadata, embedded minimal CSS and the full text, all in a single download that works offline. Built entirely on your device.",
      hi: "एक आत्मनिर्भर .html फ़ाइल — doctype, charset, PDF के मेटाडेटा से शीर्षक, अंदर बुना छोटा CSS और पूरा टेक्स्ट, सब एक ही डाउनलोड में, ऑफ़लाइन भी चलती है। निर्माण पूरी तरह आपके डिवाइस पर।",
    },
    {
      en: "Two honest modes — Flow reflows everything into clean, responsive, readable HTML (semantic h1/h2, paragraphs, bold and italic runs, bullet and numbered lists); Layout rebuilds each page at its exact size with px-precise positioned lines, so it looks like the pages.",
      hi: "दो ईमानदार मोड — फ़्लो पूरे दस्तावेज़ को साफ़, रिस्पॉन्सिव, पढ़ने योग्य HTML में बहाता है (सिमेंटिक h1/h2, पैराग्राफ़, बोल्ड-इटैलिक, बुलेट व नंबर सूचियाँ); लेआउट हर पेज उसी सटीक आकार में px-सटीक पोज़िशन्ड लाइनों से बनाता है, यानी पेज जैसा ही दिखता है।",
    },
    {
      en: "हिंदी needs no font embedding — the first real advantage of HTML over PDF: Devanagari travels as plain UTF-8 and every browser already renders it, so the file stays tiny and the text stays selectable and searchable.",
      hi: "हिंदी को फ़ॉन्ट एम्बेड नहीं चाहिए — HTML का PDF पर पहला सच्चा फ़ायदा: देवनागरी सादे UTF-8 में चलती है, हर ब्राउज़र उसे पहले से छापता है, इसलिए फ़ाइल छोटी रहती है और टेक्स्ट चुनने व खोजने योग्य रहता है।",
    },
    {
      en: "Structure from the text layer itself — font-size clusters become Heading 1 / 2, line gaps become paragraphs, hyphenated line breaks merge back, and bullet or numbered lines become real <ul>/<ol> lists. Bold and italic runs are recovered from the PDF's own font table.",
      hi: "बनावट टेक्स्ट-लेयर से ही — फ़ॉन्ट-साइज़ के समूह हेडिंग 1/2 बनते हैं, लाइन-अंतर पैराग्राफ़ बनाते हैं, हाइफ़न पर टूटे शब्द जुड़ते हैं, और बुलेट/नंबर वाली लाइनें असली <ul>/<ol> सूचियाँ बनती हैं। बोल्ड-इटैलिक PDF के फ़ॉन्ट टेबल से लौटते हैं।",
    },
    {
      en: "Honest about what doesn't come along: images, colours, multi-column layouts and tables are not rebuilt (flow turns them into a text order; layout places their words at their positions but draws no art). Scanned PDFs stop with a clear \"no selectable text\" message — run the OCR tool first.",
      hi: "जो साथ नहीं आता, वह साफ़ कहा गया है: इमेज, रंग, मल्टी-कॉलम लेआउट और टेबलें दोबारा नहीं बनतीं (फ़्लो उन्हें टेक्स्ट-क्रम में रखता है; लेआउट उनके शब्द अपनी जगह पर रखता है, कला नहीं बनाता)। स्कैन PDF साफ़ \"चुनने योग्य टेक्स्ट नहीं\" संदेश से रुकती है — पहले OCR टूल चलाएँ।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the HTML look exactly like my PDF?",
        hi: "क्या HTML बिल्कुल मेरी PDF जैसी दिखेगी?",
      },
      a: {
        en: "Pick your trade-off, we don't pretend there is only one answer. Flow mode produces a clean, responsive, readable web page — text, paragraphs, two heading tiers, bold/italic and lists survive, but positions, columns, images and tables do not. Layout mode rebuilds every page at its exact pixel size with lines placed at their real PDF coordinates (pt × 96/72), so it looks like the pages — but the text never rewraps on small screens, and the baseline placement uses a standard 0.8 em ascent approximation. Neither mode draws images or vector art.",
        hi: "आप अपना सौदा चुनें, हम यह नहीं कहते कि जवाब सिर्फ़ एक है। फ़्लो मोड साफ़, रिस्पॉन्सिव, पढ़ने योग्य वेबपेज बनाता है — टेक्स्ट, पैराग्राफ़, दो हेडिंग दरजे, बोल्ड-इटैलिक और सूचियाँ बचती हैं, पर स्थिति, कॉलम, इमेज और टेबल नहीं। लेआउट मोड हर पेज उसके सटीक पिक्सेल आकार में बनाता है, लाइनें अपनी असली PDF स्थितियों (pt × 96/72) पर — यानी पेज जैसा दिखता है, पर छोटी स्क्रीन पर टेक्स्ट कभी नहीं बदलता और बेसलाइन सामान्य 0.8 em एसेंट अनुमान से बैठती है। दोनों मोड इमेज या वेक्टर आर्ट नहीं बनाते।",
      },
    },
    {
      q: {
        en: "How do headings, bold, italic and lists work?",
        hi: "हेडिंग, बोल्ड, इटैलिक और सूचियाँ कैसे काम करती हैं?",
      },
      a: {
        en: "Straight from the text layer: the document's body size is the most-used font size; the two clearly-larger size clusters become <h1> and <h2> (a third \"tier\" stays body text — we don't invent deeper headings). Bold and italic runs are recovered by matching pdf.js's internal font ids with the PDF's own /Font table, so \"Helvetica-Bold\" text becomes <strong> and \"Helvetica-Oblique\" becomes <em>. Lines starting with •, ·, - or \"1.\" become real <ul>/<ol> list items; heading-sized lines are never mistaken for list items.",
        hi: "सीधे टेक्स्ट-लेयर से: दस्तावेज़ का मुख्य आकार सबसे ज़्यादा इस्तेमाल हुआ फ़ॉन्ट-साइज़ है; साफ़ बड़े दो साइज़-समूह <h1> और <h2> बनते हैं (तीसरा \"दरजा\" मुख्य टेक्स्ट ही रहता है — हम गहरी हेडिंग गढ़ते नहीं)। बोल्ड-इटैलिक रन pdf.js के आंतरिक फ़ॉन्ट id को PDF के अपने /Font टेबल से मिलाकर लौटते हैं — \"Helvetica-Bold\" <strong> बनता है और \"Helvetica-Oblique\" <em>। •, ·, - या \"1.\" से शुरू होती लाइनें असली <ul>/<ol> आइटम बनती हैं; हेडिंग-आकार की लाइनें कभी सूची-आइटम नहीं समझी जातीं।",
      },
    },
    {
      q: {
        en: "What about Hindi and other scripts?",
        hi: "हिंदी और दूसरी लिपियों का क्या?",
      },
      a: {
        en: "This is where HTML beats PDF outright. A PDF must embed font bytes to render Devanagari; an HTML file just carries plain UTF-8 and every browser already ships system fonts for it. So हिंदी text converts with no font file, stays selectable, searchable and copyable, and the output stays tiny. The file's lang attribute is even set from the content (mostly-Devanagari documents get lang=\"hi\").",
        hi: "यहीं HTML, PDF से साफ़ आगे है। PDF को देवनागरी छापने के लिए फ़ॉन्ट के बाइट जोड़ने पड़ते हैं; HTML फ़ाइल सादा UTF-8 ले जाती है और हर ब्राउज़र में उसके फ़ॉन्ट पहले से होते हैं। इसलिए हिंदी बिना किसी फ़ॉन्ट फ़ाइल के बदलती है, चुनने, खोजने और कॉपी करने योग्य रहती है, और आउटपुट छोटा रहता है। फ़ाइल का lang गुण कंटेंट से तय होता है (ज़्यादातर देवनागरी दस्तावेज़ को lang=\"hi\" मिलता है)।",
      },
    },
    {
      q: {
        en: "Where is my file processed, and what are the limits?",
        hi: "मेरी फ़ाइल कहाँ प्रोसेस होती है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker reads the PDF with the self-hosted pdf.js, extracts and rebuilds the text, and writes the single .html locally. Nothing is uploaded, no sign-up, no watermark. One PDF at a time; page ranges like 1-3, 5, 8- convert only the pages you pick. Very large documents are capped honestly: 2,000 blocks in flow mode and 6,000 positioned lines in layout mode. A PDF with no selectable text anywhere (a pure scan) stops with a clear message instead of an empty file — run the OCR tool on it first, then convert the result.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वेब वर्कर सेल्फ़-होस्टेड pdf.js से PDF पढ़ता है, टेक्स्ट निकालकर दोबारा बनाता है और एकमात्र .html वहीं लिखता है। कुछ अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। एक बार में एक PDF; 1-3, 5, 8- जैसी रेंज सिर्फ़ चुने पेज बदलती है। बहुत बड़े दस्तावेज़ ईमानदारी से सीमित हैं: फ़्लो मोड में 2,000 ब्लॉक और लेआउट मोड में 6,000 पोज़िशन्ड लाइनें। जिस PDF में कहीं भी चुनने योग्य टेक्स्ट नहीं (शुद्ध स्कैन), वह ख़ाली फ़ाइल की जगह साफ़ संदेश से रुकती है — पहले उस पर OCR टूल चलाएँ, फिर नतीजा बदलें।",
      },
    },
  ],
};
