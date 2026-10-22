import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to PowerPoint (RB3-d). PDF pages → editable PPTX slides, 100%
 * on-device: a Web Worker runs pdf.js (text extraction) and the
 * model's fflate OOXML writer produces a real .pptx — EN + हिंदी.
 *
 * The surface (tools/pdf-to-powerpoint/surface.tsx) owns the flow
 * (create-card precedent): its own DropZone (%PDF sniff via the shared
 * component), a live per-page preview count (pages → slides), the
 * mode explainer (editable text vs page images), the slide-size and
 * page-range controls bound to the shared option values, and the
 * Convert button that spawns this worker. The shell CTA runs the same
 * worker through the standard pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - text mode = text only: vector art, fills, tables and images do
 *    not carry over; positions are approximated (contain-fit + block
 *    geometry), not pixel-exact;
 *  - page-images mode = pixel-exact look, but nothing is editable and
 *    text is not selectable;
 *  - scanned pages in text mode produce empty slides (counted in the
 *    run summary) — switch to page images for scans;
 *  - Hindi works WITHOUT any font file: PPTX references typefaces by
 *    name (Devanagari runs point at "Noto Sans Devanagari").
 */
export const config: ToolConfig = {
  toolId: "pdf-to-powerpoint",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  // The output is a presentation, which the shared outputKind union
  // does not model ("pdf" | "image" | "text" | "zip") — omitted rather
  // than lying with "zip" (the pdf-to-excel precedent).
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  howKeys: ["p2ppt.how1", "p2ppt.how2", "p2ppt.how3"],
  options: [
    {
      kind: "select",
      id: "mode",
      label: { en: "Slides", hi: "स्लाइड" },
      hint: {
        en: "Editable text boxes (positions approximate) or pixel-exact page images",
        hi: "एडिटेबल टेक्स्ट-बॉक्स (स्थिति अनुमानित) या पिक्सेल-परफ़ेक्ट पेज इमेज",
      },
      choices: [
        { value: "text", label: { en: "Editable text", hi: "एडिटेबल टेक्स्ट" } },
        { value: "images", label: { en: "Page images", hi: "पेज इमेज" } },
      ],
      default: "text",
    },
    {
      kind: "select",
      id: "slideSize",
      label: { en: "Slide size", hi: "स्लाइड साइज़" },
      hint: {
        en: "16:9 widescreen, 4:3 classic, or match the PDF page (orientation-aware)",
        hi: "16:9 वाइडस्क्रीन, 4:3 क्लासिक, या PDF पेज जितना (ओरिएंटेशन सहित)",
      },
      choices: [
        { value: "16-9", label: { en: "16:9", hi: "16:9" } },
        { value: "4-3", label: { en: "4:3", hi: "4:3" } },
        {
          value: "match",
          label: { en: "Match page", hi: "पेज जितना" },
        },
      ],
      default: "16-9",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "e.g. 1-3, 5, 8- — each selected page becomes one slide",
        hi: "जैसे 1-3, 5, 8- — चुना हर पेज एक स्लाइड बनता है",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  // A .pptx chains honestly into powerpoint-to-pdf (accepts office);
  // nothing else in this app eats a presentation.
  chainToolIds: ["powerpoint-to-pdf"],
  features: [
    {
      en: "PDF pages become editable PowerPoint slides entirely on your device — pdf.js extracts the text inside a Web Worker and the .pptx is packaged right there in your browser, no upload.",
      hi: "PDF पेज एडिट करने योग्य पावरपॉइंट स्लाइड बनते हैं, पूरी तरह आपके डिवाइस पर — pdf.js वेब वर्कर में टेक्स्ट निकालता है और .pptx वहीं आपके ब्राउज़र में पैक होता है, कोई अपलोड नहीं।",
    },
    {
      en: "Real text boxes, not screenshots — lines merge into paragraphs, the largest top-of-page font is detected as the slide title, font sizes scale to the slide (8–96 pt), and you can retype everything in PowerPoint.",
      hi: "स्क्रीनशॉट नहीं, असली टेक्स्ट-बॉक्स — लाइनें पैराग्राफ़ में जुड़ती हैं, पेज के ऊपर का सबसे बड़ा फ़ॉन्ट स्लाइड-शीर्षक पहचाना जाता है, फ़ॉन्ट साइज़ स्लाइड के हिसाब से बदलती है (8–96 pt), और PowerPoint में सब दोबारा टाइप सकते हैं।",
    },
    {
      en: "Two honest modes — Editable text (positions approximate, everything retypable) or Page images (each page a pixel-exact full-bleed picture). Slide sizes: 16:9, 4:3 or exactly match the PDF page.",
      hi: "दो ईमानदार मोड — एडिटेबल टेक्स्ट (स्थिति अनुमानित, सब दोबारा लिखने योग्य) या पेज इमेज (हर पेज पिक्सेल-परफ़ेक्ट फ़ुल-ब्लीड तस्वीर)। स्लाइड साइज़: 16:9, 4:3 या PDF पेज जितना हूबहू।",
    },
    {
      en: "हिंदी works without any font file — PowerPoint files name their fonts instead of embedding them, so Devanagari text simply references Noto Sans Devanagari and opens correctly in PowerPoint, Google Slides and LibreOffice.",
      hi: "हिंदी बिना किसी फ़ॉन्ट फ़ाइल के चलती है — पावरपॉइंट फ़ाइलें फ़ॉन्ट को नाम से याद रखती हैं, एम्बेड नहीं करतीं, इसलिए देवनागरी टेक्स्ट Noto Sans Devanagari नाम संदर्भित करता है और PowerPoint, Google Slides तथा LibreOffice में सही खुलता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly survives the conversion — and what doesn't?",
        hi: "रूपांतरण में क्या बचता है — और क्या नहीं?",
      },
      a: {
        en: "In editable-text mode: the text itself, its rough positions, font sizes (scaled to the slide, clamped 8–96 pt), and a detected slide title (the largest font in the top third of the page) which comes out bold. Approximated: box positions and widths — they are rebuilt from line and block geometry, so treat them as a starting point. Not carried: vector art, colors and fills, images, and tables (a table becomes plain text boxes). Page-images mode instead puts one pixel-exact picture of each page on a slide — the look is preserved, but nothing is editable and the text is not selectable.",
        hi: "एडिटेबल-टेक्स्ट मोड में: टेक्स्ट ख़ुद, उसकी मोटी-मोटी स्थिति, फ़ॉन्ट साइज़ (स्लाइड के हिसाब से, 8–96 pt पर सीमित), और पहचाना गया स्लाइड-शीर्षक (पेज के ऊपरी तिहाई का सबसे बड़ा फ़ॉन्ट) जो बोल्ड आता है। अनुमानित: बॉक्स की स्थिति और चौड़ाई — वे लाइन/ब्लॉक ज्यामिति से दोबारा बनते हैं, इसलिए शुरुआती बिंदु मानें। नहीं आता: वेक्टर आर्ट, रंग-भराव, तस्वीरें और टेबलें (टेबल सादे टेक्स्ट-बॉक्स बनती है)। पेज-इमेज मोड इसके बजाय हर पेज की पिक्सेल-परफ़ेक्ट तस्वीर स्लाइड पर रखता है — दिखावट बचती है, पर कुछ एडिट करने योग्य नहीं और टेक्स्ट चुनने योग्य नहीं।",
      },
    },
    {
      q: {
        en: "How does Hindi work without a font file?",
        hi: "फ़ॉन्ट फ़ाइल के बिना हिंदी कैसे चलती है?",
      },
      a: {
        en: "PDF has to embed font bytes to render हिंदी; PowerPoint does not — a .pptx stores plain UTF-8 text and references each run's typeface by name. Devanagari runs are tagged \"Noto Sans Devanagari\" (Latin runs get Calibri), so any system with that font installed — Windows, Google Slides, LibreOffice — renders the text correctly, and PowerPoint even substitutes a matching face when it is missing.",
        hi: "PDF को हिंदी छापने के लिए फ़ॉन्ट के बाइट जोड़ने पड़ते हैं; पावरपॉइंट को नहीं — .pptx सादा UTF-8 टेक्स्ट रखता है और हर रन का फ़ॉन्ट नाम से संदर्भित करता है। देवनागरी रन \"Noto Sans Devanagari\" नाम पाते हैं (लैटिन रन को Calibri), इसलिए जिस सिस्टम में वह फ़ॉन्ट है — Windows, Google Slides, LibreOffice — वहीं टेक्स्ट सही छपता है, और न हो तो PowerPoint ख़ुद मिलता-जुलता फ़ेस लगा देता है।",
      },
    },
    {
      q: {
        en: "What happens with scanned or encrypted PDFs?",
        hi: "स्कैन की या पासवर्ड वाली PDF का क्या होता है?",
      },
      a: {
        en: "A scanned page has no selectable text, so in editable-text mode it becomes an empty slide — the run summary tells you exactly how many slides came out empty, and the page-1 preview warns you before you run. Switch to Page images mode to convert scans (the whole page is rendered as a picture). Encrypted files stop honestly with a \"this PDF needs a password\" message — unlock the file first, then convert.",
        hi: "स्कैन किए पेज में चुनने योग्य टेक्स्ट नहीं होता, इसलिए एडिटेबल-टेक्स्ट मोड में वे ख़ाली स्लाइड बनते हैं — रन सारांश बताता है कि कितनी स्लाइड ख़ाली निकलीं, और पेज-1 जाँच पहले ही चेता देती है। स्कैन बदलने के लिए पेज-इमेज मोड चुनें (पूरा पेज तस्वीर बनकर आता है)। पासवर्ड वाली फ़ाइल ईमानदारी से रुकती है — \"इस PDF को पासवर्ड चाहिए\" संदेश के साथ; पहले अनलॉक करें, फिर बदलें।",
      },
    },
    {
      q: {
        en: "Which slide size should I pick, and what happens to page ranges?",
        hi: "कौन-सी स्लाइड साइज़ लूँ, और पेज रेंज का क्या होता है?",
      },
      a: {
        en: "16:9 is the modern default (PowerPoint's widescreen); 4:3 suits older decks; \"Match page\" makes the slide exactly the PDF page's size and orientation — a portrait A4 report becomes a portrait slide. Every page is contain-fit into the slide (centered when the aspects differ), so nothing lands off-canvas. The Pages box accepts ranges like 1-3, 5, 8- (open end = through the last page) — only the selected pages become slides.",
        hi: "16:9 आधुनिक डिफ़ॉल्ट है (पावरपॉइंट का वाइडस्क्रीन); 4:3 पुराने डेक के लिए; \"पेज जितना\" स्लाइड को PDF पेज के बराबर आकार और दिशा देता है — पोर्ट्रेट A4 रिपोर्ट पोर्ट्रेट स्लाइड बनती है। हर पेज स्लाइड में कंटेन-फ़िट होता है (आस्पेक्ट अलग हों तो बीच में), इसलिए कुछ भी कैनवास से बाहर नहीं जाता। पेज बॉक्स में 1-3, 5, 8- जैसी रेंज चलती है (खुला सिरा = आख़िरी पेज तक) — चुने पेज ही स्लाइड बनते हैं।",
      },
    },
  ],
};
