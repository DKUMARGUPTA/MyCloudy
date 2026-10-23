import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to Markdown (RB4-c). PDF → clean Markdown, 100% on-device:
 * pdf.js extracts the selectable text inside a Web Worker (same recipe
 * as pdf-to-word), the pure model rebuilds paragraphs, heading tiers
 * (#..###### by font-size rank), bold/italic runs, bullet + numbered
 * lists, visually-distinct quotes and link annotations, and the .md is
 * written right there in the browser — EN + हिंदी, raw UTF-8.
 *
 * The surface (tools/pdf-to-markdown/surface.tsx, pdf-to-powerpoint
 * precedent) owns the flow: its own DropZone (%PDF sniff via the shared
 * component), a cheap main-thread probe (page count + a scanned-pages
 * warning — the full heading count honestly lands in the run summary
 * because it needs the whole extraction), the honest explainer card
 * (what converts, what doesn't), and the Convert button that spawns
 * this worker. The shell CTA runs the same worker through the standard
 * pipeline — where multi-file (per-page) outputs also get the ZIP.
 *
 * HONEST limits (mirrored in the FAQ): structure maps when the PDF has
 * real structure (real text, distinct font sizes); two-column PDFs
 * approximate to a line-by-line text flow; tables are NOT converted
 * (pdf-to-excel is the table tool); images are skipped; scanned pages
 * need the OCR tool first.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-markdown",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  outputKind: "text",
  howKeys: ["pmd.how1", "pmd.how2", "pmd.how3"],
  options: [
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "e.g. 1-3, 5, 8- — convert only the selected pages",
        hi: "जैसे 1-3, 5, 8- — सिर्फ़ चुने पेज बदलें",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
    {
      kind: "switch",
      id: "perPage",
      label: { en: "One file per page", hi: "हर पेज की अलग फ़ाइल" },
      hint: {
        en: "One .md per selected page instead of a single document (download all as ZIP)",
        hi: "एक दस्तावेज़ की जगह हर चुने पेज का अलग .md (सबको ZIP में डाउनलोड करें)",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "pageRules",
      label: { en: "Rules between pages", hi: "पेजों के बीच रेखा" },
      hint: {
        en: "A --- thematic break where each PDF page starts",
        hi: "हर PDF पेज की शुरुआत पर --- विभाजक रेखा",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "metaComment",
      label: { en: "Provenance comment", hi: "स्रोत टिप्पणी" },
      hint: {
        en: "Adds <!-- converted by MyCloudy --> at the top of the file",
        hi: "फ़ाइल के ऊपर <!-- converted by MyCloudy --> टिप्पणी जोड़ता है",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "frontMatter",
      label: { en: "YAML front matter", hi: "YAML फ़्रंट मैटर" },
      hint: {
        en: "A --- block with title, source and page count (for static-site generators)",
        hi: "title, source और पेज-गिनती वाला --- ब्लॉक (स्टैटिक-साइट जनरेटर के लिए)",
      },
      default: false,
    },
  ],
  // A .md chains honestly into markdown-to-pdf (its mirror tool).
  chainToolIds: ["markdown-to-pdf"],
  features: [
    {
      en: "Clean Markdown, written on your device — pdf.js reads the PDF's selectable text inside a Web Worker and the .md (UTF-8, ready for notes apps, GitHub and static sites) is assembled right there in your browser. Nothing is uploaded.",
      hi: "साफ़ मार्कडाउन, आपके डिवाइस पर लिखा जाता है — pdf.js वेब वर्कर में PDF का चुनने योग्य टेक्स्ट पढ़ता है और .md (UTF-8, नोट्स ऐप्स, GitHub और स्टैटिक साइट्स के लिए तैयार) वहीं आपके ब्राउज़र में बनता है। कुछ भी अपलोड नहीं होता।",
    },
    {
      en: "Structure maps when the PDF has real structure — font-size ranks become # .. ###### headings, bold and italic runs become **bold** / *italic*, bullet and numbered lines become - lists, visually indented italic passages become > quotes, and clickable link annotations survive as [text](url).",
      hi: "जब PDF में असली बनावट हो तो वह मैप होती है — फ़ॉन्ट-साइज़ के दरजे # .. ###### हेडिंग बनते हैं, बोल्ड/इटैलिक **bold** / *italic* बनते हैं, बुलेट और नंबर वाली लाइनें - सूचियाँ बनती हैं, दाहिने खिसी इटैलिक पैराग्राफ़ > कोट बनता है, और क्लिक करने योग्य लिंक [text](url) बनकर बचते हैं।",
    },
    {
      en: "हिंदी comes through clean — Devanagari text is written as raw UTF-8 (never HTML entities), and the matra order PDFs sometimes scramble is repaired before it is written.",
      hi: "हिंदी बिल्कुल साफ़ आती है — देवनागरी टेक्स्ट सीधा UTF-8 में लिखा जाता है (HTML एंटिटी कभी नहीं), और PDF में कभी-कभी उलझन वाला मात्रा-क्रम लिखने से पहले ठीक किया जाता है।",
    },
    {
      en: "Honest conversion — you pick the pages, optional page rules and header blocks, and see the page / paragraph / heading counts in the run summary. What doesn't convert is said out loud: tables and images are skipped (pdf-to-excel is the table tool), and two-column layouts approximate to a text flow.",
      hi: "ईमानदार रूपांतरण — आप पेज चुनते हैं, वैकल्पिक पेज-रेखा और हेडर ब्लॉक लेते हैं, और रन सारांश में पेज / पैराग्राफ़ / हेडिंग गिनती देखते हैं। जो नहीं बदलता वह साफ़ कहा जाता है: टेबल और इमेज छोड़े जाते हैं (pdf-to-excel टेबल का टूल है), और दो-कॉलम लेआउट टेक्स्ट-प्रवाह में अनुमानित होता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly converts to Markdown — and what doesn't?",
        hi: "मार्कडाउन में ठीक क्या बदलता है — और क्या नहीं?",
      },
      a: {
        en: "Text and structure: paragraphs (soft-wrapped lines joined back), headings ranked by font size (# for the biggest tier, up to ######), **bold** and *italic* runs, bullet lists (-) and numbered lists (1.) when the lines are visibly marked, > quotes when a passage is indented AND italic, and link annotations as [text](url). Not converted: tables (use PDF to Excel — it is built for them), images, colors, and fonts. A line that literally starts with *, #, _ or [ is backslash-escaped so it can never turn into fake Markdown.",
        hi: "टेक्स्ट और बनावट: पैराग्राफ़ (टूटी लाइनें वापस जुड़ती हैं), फ़ॉन्ट-साइज़ के दरजे से हेडिंग (सबसे बड़ा दरजा #, ###### तक), **बोल्ड** और *इटैलिक* रन, बुलेट सूचियाँ (-) और नंबर वाली सूचियाँ (1.) जब लाइनें साफ़ चिह्नित हों, > कोट जब पैराग्राफ़ दाएँ खिसा और इटैलिक हो, और लिंक एनोटेशन [text](url) बनकर। नहीं बदलता: टेबल (PDF to Excel इसी के लिए है), इमेज, रंग और फ़ॉन्ट। जो लाइन सचमुच *, #, _ या [ से शुरू होती है उसे बैकस्लैश-एस्केप कर दिया जाता है ताकि नकली मार्कडाउन कभी न बने।",
      },
    },
    {
      q: {
        en: "My PDF has two columns and tables — how do those come out?",
        hi: "मेरी PDF में दो कॉलम और टेबलें हैं — वे कैसे निकलती हैं?",
      },
      a: {
        en: "Honestly approximate, and we say so. Two-column pages come out as a reading flow where a line from the left and a line from the right column that share a baseline may join into one line — fine for notes, not a faithful layout. Tables are NOT converted to Markdown tables: their cells arrive as plain text lines. When you need the table, run PDF to Excel on the same file — it reconstructs grids properly; when you need the prose, this tool is the right one.",
        hi: "ईमानदारी से अनुमानित, और हम यही कहते हैं। दो-कॉलम पेज पढ़ने की प्रवाह बनते हैं जहाँ एक ही बेसलाइन वाली बाएँ-दाएँ कॉलम की लाइनें एक लाइन में जुड़ सकती हैं — नोट्स के लिए ठीक, हूबहू लेआउट नहीं। टेबल मार्कडाउन टेबल में नहीं बदतीं: उनके सेल सादी टेक्स्ट लाइनें बनते हैं। टेबल चाहिए तो उसी फ़ाइल पर PDF to Excel चलाएँ — वह ग्रिड ठीक से बनाता है; मज़मून चाहिए तो यही टूल सही है।",
      },
    },
    {
      q: {
        en: "What do the switches do — one file per page, rules, headers?",
        hi: "स्विच क्या करती हैं — हर पेज अलग फ़ाइल, रेखा, हेडर?",
      },
      a: {
        en: "Pages picks a subset (1-3, 5, 8- with an open end). \"One file per page\" writes a separate .md per selected page instead of one document — handy for notes per chapter; the result screen also offers everything as a ZIP. \"Rules between pages\" adds a --- thematic break where each PDF page starts, keeping page boundaries visible in one file. The provenance comment adds <!-- converted by MyCloudy --> at the top; YAML front matter adds a --- block with title, source and page count for static-site generators (both are off by default — the .md stays clean).",
        hi: "पेज में सबसेट चुनें (1-3, 5, 8- खुले सिरे के साथ)। \"हर पेज की अलग फ़ाइल\" एक दस्तावेज़ की जगह हर चुने पेज का अलग .md लिखती है — हर अध्याय के नोट्स के लिए सही; रिज़ल्ट स्क्रीन सबकुछ ZIP में भी देती है। \"पेजों के बीच रेखा\" हर PDF पेज की शुरुआत पर --- विभाजक रखती है, ताकि एक फ़ाइल में पेज की हद दिखती रहे। स्रोत टिप्पणी ऊपर <!-- converted by MyCloudy --> जोड़ती है; YAML फ़्रंट मैटर स्टैटिक-साइट जनरेटर के लिए title, source और पेज-गिनती वाला --- ब्लॉक देता है (दोनों डिफ़ॉल्ट में बंद — .md साफ़ रहती है)।",
      },
    },
    {
      q: {
        en: "What happens with scanned or encrypted PDFs?",
        hi: "स्कैन की या पासवर्ड वाली PDF का क्या होता है?",
      },
      a: {
        en: "A scanned page is an image with no selectable text, so the tool stops honestly with a \"no selectable text\" message instead of saving an empty .md — run the PDF OCR tool on the file first (English and Hindi are supported), then convert the result here. Encrypted files fail with a clear \"this PDF needs a password\" message; unlock the file first, then convert. And heading ranks come from the document's own font sizes, so a PDF that is all one size comes out as plain paragraphs — honestly, not as invented headings.",
        hi: "स्कैन किया पेज तस्वीर है, उसमें चुनने योग्य टेक्स्ट नहीं, इसलिए टूल ख़ाली .md बनाने की जगह साफ़ \"चुनने योग्य टेक्स्ट नहीं मिला\" संदेश देता है — पहले उसी फ़ाइल पर PDF OCR टूल चलाएँ (अंग्रेज़ी और हिंदी समर्थित), फिर नतीजा यहाँ बदलें। पासवर्ड वाली फ़ाइल साफ़ \"इस PDF को पासवर्ड चाहिए\" संदेश देती है; पहले अनलॉक करें, फिर बदलें। और हेडिंग के दरजे दस्तावेज़ के अपने फ़ॉन्ट-साइज़ से आते हैं, इसलिए जिस PDF में सब एक ही साइज़ है वह सादे पैराग्राफ़ बनती है — ईमानदारी से, मनगढ़ंत हेडिंग नहीं।",
      },
    },
  ],
};
