import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Publisher to PDF (RB4-e). Microsoft Publisher .pub → PDF, 100%
 * on-device (a Web Worker reads the OLE2 compound container, salvages
 * the UTF-16 story text and re-flows it with pdf-lib), EN + हिंदी.
 *
 * HONEST SCOPE — this is a TEXT salvage, not a layout converter (the
 * .pub format is undocumented; no complete open-source parser exists):
 *  - what survives: the text of every story, paragraph breaks, and a
 *    best-effort heading guess (ALL-CAPS / Title-Case short lines);
 *  - what does not: the visual layout — columns, images, shapes,
 *    colors, fonts and exact page composition are NOT carried over;
 *  - the better path for full fidelity: export a PDF from Publisher
 *    itself (File → Save as PDF), then use the other DocoPDF tools.
 *
 * The surface (tools/publisher-to-pdf/surface.tsx) owns the input
 * flow: a drop zone that sniffs the OLE2 magic, a live
 * streams/paragraphs/characters report from the same parser the worker
 * uses, page-size + margin + font-size toggles, and the Convert button
 * that spawns the worker. The shell CTA runs the same worker through
 * the standard pipeline.
 */
export const config: ToolConfig = {
  toolId: "publisher-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "A4 is the Publisher default outside North America",
        hi: "A4 उत्तरी अमेरिका के बाहर पब्लिशर का डिफ़ॉल्ट है",
      },
      choices: [
        { value: "a4", label: { en: "A4 (210 × 297 mm)", hi: "A4 (210 × 297 मिमी)" } },
        { value: "letter", label: { en: "US Letter (8.5 × 11 in)", hi: "US लेटर (8.5 × 11 इंच)" } },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margins", hi: "मार्जिन" },
      hint: {
        en: "Normal 56 pt, narrow 28 pt on every side",
        hi: "सामान्य 56 pt, सँकरा 28 pt हर तरफ़",
      },
      choices: [
        { value: "normal", label: { en: "Normal (56 pt)", hi: "सामान्य (56 pt)" } },
        { value: "narrow", label: { en: "Narrow (28 pt)", hi: "सँकरा (28 pt)" } },
      ],
      default: "normal",
    },
    {
      kind: "number",
      id: "fontSize",
      label: { en: "Text size", hi: "टेक्स्ट साइज़" },
      hint: {
        en: "Body size — headings scale from it (the .pub sizes are not reliably readable)",
        hi: "बॉडी साइज़ — शीर्षक इसी से बड़े होते हैं (.pub के असली आकार पढ़े नहीं जा सकते)",
      },
      min: 8,
      max: 18,
      step: 0.5,
      suffix: { en: "pt", hi: "pt" },
      default: 10.5,
    },
  ],
  howKeys: ["pub.how1", "pub.how2", "pub.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn .pub files into readable PDFs entirely on your device — the OLE2 container is opened and the story text is salvaged right inside your browser. The publication never touches a server.",
      hi: ".pub फ़ाइलों को पढ़ने योग्य PDF बनाएँ — पूरा काम आपके ही डिवाइस पर। OLE2 कंटेनर आपके ब्राउज़र में ही खुलता है और स्टोरी टेक्स्ट वहीं संभलता है। प्रकाशन कभी सर्वर तक जाता ही नहीं।",
    },
    {
      en: "The text of every story is carried over as real, selectable, searchable vector text — paragraphs, line breaks and a best-effort heading guess (ALL-CAPS and Title-Case short lines).",
      hi: "हर स्टोरी का टेक्स्ट असली, चुनने और खोजने योग्य वेक्टर टेक्स्ट बनता है — पैराग्राफ़, लाइन-ब्रेक और शीर्षकों का ईमानदार अंदाज़ा (पूरे बड़े अक्षर या Title-Case छोटी लाइनें)।",
    },
    {
      en: "Hindi and other Devanagari stories work — the text is read as UTF-16 from the container and rendered with an embedded Noto Sans Devanagari subset. English newsletters stay on the built-in Helvetica (tiny files).",
      hi: "हिंदी और देवनागरी स्टोरीज़ भी चलती हैं — कंटेनर से टेक्स्ट UTF-16 में पढ़ा जाता है और एम्बेडेड Noto Sans Devanagari सबसेट से छपता है। अंग्रेज़ी न्यूज़लेटर बिल्ट-इन Helvetica पर रहते हैं (छोटी फ़ाइलें)।",
    },
    {
      en: "A4 or US Letter, normal or narrow margins, your choice of text size, and a live salvage report before you convert — the exact stream and character counts from the same parser the PDF uses.",
      hi: "A4 या US लेटर, सामान्य या सँकरे मार्जिन, अपनी पसंद की टेक्स्ट साइज़, और बदलने से पहले लाइव सैल्वेज रिपोर्ट — उसी पार्सर की सटीक स्ट्रीम और अक्षर गिनती जिससे PDF बनता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly survives the conversion — and what doesn't?",
        hi: "रूपांतरण में क्या बचता है — और क्या नहीं?",
      },
      a: {
        en: "Kept: the text of every story in the file, paragraph breaks, and a best-effort heading guess. Simplified or dropped: the visual layout — Publisher's columns, images, shapes, WordArt, colors, fonts and exact page composition are not carried over, because .pub is an undocumented binary format with no complete public specification. What we produce is a clean, re-flowed text PDF, not a pixel-exact copy of the publication.",
        hi: "बचता है: फ़ाइल की हर स्टोरी का टेक्स्ट, पैराग्राफ़ ब्रेक, और शीर्षकों का ईमानदार अंदाज़ा। सरल या छूटा: विज़ुअल लेआउट — पब्लिशर के कॉलम, तस्वीरें, आकृतियाँ, WordArt, रंग, फ़ॉन्ट और सटीक पेज-संरचना नहीं आती, क्योंकि .pub एक अप्रलेखित बाइनरी फ़ॉर्मैट है जिसकी कोई पूरी सार्वजनिक स्पेसिफिकेशन नहीं है। हम एक साफ़, दोबारा बहने वाली टेक्स्ट PDF बनाते हैं — प्रकाशन की पिक्सेल-सटीक प्रतिलिपि नहीं।",
      },
    },
    {
      q: {
        en: "I need the layout exactly as designed — what should I do?",
        hi: "मुझे लेआउट बिल्कुल वैसा ही चाहिए जैसा डिज़ाइन किया गया है — क्या करूँ?",
      },
      a: {
        en: "Export a PDF directly from Publisher (File → Save As → PDF) — that keeps every column, image and shape pixel-perfect, because Publisher itself draws it. Then use DocoPDF's other PDF tools (compress, merge, page numbers…) on that file. This tool is for the cases where you only have the .pub and Publisher is not available — it rescues the words, not the design.",
        hi: "पब्लिशर से सीधे PDF निकाल लें (File → Save As → PDF) — उसमें हर कॉलम, तस्वीर और आकृति पिक्सेल-सटीक रहती है, क्योंकि उसे पब्लिशर खुद बनाता है। फिर DocoPDF के बाक़ी PDF टूल (कंप्रेस, मर्ज, पेज नंबर…) उसी फ़ाइल पर चलाएँ। यह टूल उन हालात के लिए है जब आपके पास सिर्फ़ .pub है और पब्लिशर नहीं — यह शब्दों को बचाता है, डिज़ाइन को नहीं।",
      },
    },
    {
      q: {
        en: "Does it work with Hindi publications?",
        hi: "हिंदी प्रकाशनों के साथ चलता है?",
      },
      a: {
        en: "Yes. Publisher stores story text as UTF-16, and the salvager reads Devanagari runs natively — any Hindi character switches the PDF to the embedded Noto Sans Devanagari subset, so हिंदी stories render and stay selectable. Latin-only files use the built-in Helvetica instead (nothing embedded, tiny files).",
        hi: "हाँ। पब्लिशर स्टोरी टेक्स्ट UTF-16 में रखता है और सैल्वेजर देवनागरी रन मूल रूप से पढ़ता है — कोई भी हिंदी अक्षर आते ही PDF एम्बेडेड Noto Sans Devanagari सबसेट पर चला जाता है, इसलिए हिंदी स्टोरीज़ छपती और चुनने योग्य रहती हैं। सिर्फ़ लैटिन वाली फ़ाइलें बिल्ट-इन Helvetica से निकलती हैं (कुछ एम्बेड नहीं, छोटी फ़ाइलें)।",
      },
    },
    {
      q: {
        en: "Where is my file processed, and what are the limits?",
        hi: "मेरी फ़ाइल कहाँ प्रोसेस होती है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread opens the OLE2 container, salvages the text and paints the PDF; nothing is uploaded, no sign-up, no watermark. Size limit 50 MB on mobile / 200 MB on desktop, one file at a time. Very text-heavy files are capped honestly: 800 paragraphs / 300,000 characters are converted, and the summary tells you when that happened.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड OLE2 कंटेनर खोलता, टेक्स्ट संभलता और PDF बनाता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। आकार सीमा मोबाइल पर 50 MB / डेस्कटॉप पर 200 MB, एक बार में एक फ़ाइल। बहुत लंबी फ़ाइलें ईमानदारी से सीमित होती हैं: 800 पैराग्राफ़ / 300,000 अक्षर तक बदलते हैं, और सारांश बता देता है कि ऐसा हुआ।",
      },
    },
  ],
};
