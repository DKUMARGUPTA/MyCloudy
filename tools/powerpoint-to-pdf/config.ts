import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PowerPoint to PDF (RB2-a — the 71st tool). PPTX → clean vector PDF,
 * 100% on-device (a Web Worker unzips the OOXML and paints it with
 * pdf-lib), EN + हिंदी.
 *
 * The surface (tools/powerpoint-to-pdf/surface.tsx) owns the input
 * flow: a drop zone that sniffs the PK ZIP magic of the .pptx (and
 * honestly recognizes the legacy OLE2 .ppt), a live slide/shape/word
 * summary from the same parser the worker uses, page-size + margin +
 * speaker-notes + fit-to-width toggles, and the Convert button that
 * spawns the worker (create-invoice pattern). The shell CTA runs the
 * same worker through the standard pipeline.
 *
 * Honest limits (mirrored in the FAQ):
 *  - .pptx only — the pre-2007 binary .ppt format is NOT a ZIP and is
 *    rejected up front;
 *  - pictures, charts, SmartArt and graphicFrame tables are not
 *    carried over; multi-column slide layouts flatten to their text;
 *  - text that overflows its slide box is still drawn (never silently
 *    dropped) and counted in the run summary;
 *  - Hindi bold renders as regular (the Noto OFL face ships Regular
 *    only — hierarchy comes from size).
 */
export const config: ToolConfig = {
  toolId: "powerpoint-to-pdf",
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
        en: "Slide size keeps the exact deck geometry; A4 and Letter come out landscape",
        hi: "स्लाइड साइज़ डेक की सटीक ज्यामिति रखता है; A4 और लेटर लैंडस्केप में आते हैं",
      },
      choices: [
        {
          value: "slide-native",
          label: { en: "Slide size (exact)", hi: "स्लाइड साइज़ (सटीक)" },
        },
        { value: "a4", label: { en: "A4 landscape", hi: "A4 लैंडस्केप" } },
        {
          value: "letter",
          label: { en: "US Letter landscape", hi: "US लेटर लैंडस्केप" },
        },
      ],
      default: "slide-native",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margins", hi: "मार्जिन" },
      hint: {
        en: "Framing on A4/Letter pages and the notes pages",
        hi: "A4/लेटर पेजों और नोट्स पेजों पर फ़्रेमिंग",
      },
      choices: [
        { value: "normal", label: { en: "Normal (56 pt)", hi: "सामान्य (56 pt)" } },
        { value: "narrow", label: { en: "Narrow (28 pt)", hi: "सँकरा (28 pt)" } },
      ],
      default: "normal",
    },
    {
      kind: "switch",
      id: "notes",
      label: { en: "Speaker notes", hi: "स्पीकर नोट्स" },
      hint: {
        en: "Adds one extra page per slide with its notes",
        hi: "हर स्लाइड के लिए उसके नोट्स वाला एक अतिरिक्त पेज",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "fit",
      label: { en: "Fit to page width", hi: "पेज चौड़ाई तक फैलाएँ" },
      hint: {
        en: "A4/Letter only: fill the paper width instead of letterboxing",
        hi: "केवल A4/लेटर: लैटरबॉक्स की जगह पूरी चौड़ाई भरें",
      },
      default: false,
    },
  ],
  howKeys: ["ppt.how1", "ppt.how2", "ppt.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Turn .pptx decks into PDFs entirely on your device — the OOXML is unzipped and re-painted inside your browser, so the presentation never touches a server.",
      hi: ".pptx डेक को PDF बनाएँ — पूरी तरह आपके डिवाइस पर। OOXML यहीं आपके ब्राउज़र में खुलता और बनता है, प्रेज़ेंटेशन कभी सर्वर तक जाता ही नहीं।",
    },
    {
      en: "One true vector page per slide — real selectable text, never a screenshot: titles, bullet lists, bold, italic, font sizes and text colors become searchable words you can copy.",
      hi: "हर स्लाइड का एक सच्चा वेक्टर पेज — असली चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं: शीर्षक, बुलेट सूचियाँ, बोल्ड, इटैलिक, फ़ॉन्ट आकार और रंग सर्च करने योग्य शब्द बनते हैं।",
    },
    {
      en: "Pick the page size (exact slide size, landscape A4 or Letter), add speaker-notes pages with one click, and watch a live slides/shapes/words summary before you convert — honest counts from the same parser the PDF uses.",
      hi: "पेज साइज़ चुनें (सटीक स्लाइड साइज़, लैंडस्केप A4 या लेटर), एक क्लिक में स्पीकर-नोट्स पेज जोड़ें, और बदलने से पहले स्लाइड/आकृतियाँ/शब्दों का लाइव ब्यौरा देखें — उसी पार्सर से ईमानदार गिनती जिससे PDF बनता है।",
    },
    {
      en: "Hindi decks export properly — any Devanagari character embeds the self-hosted Noto Sans Devanagari subset, while English decks use the built-in Helvetica (nothing embedded, tiny files) — अंग्रेज़ी और हिंदी दोनों।",
      hi: "हिंदी डेक सही छपते हैं — कोई भी देवनागरी अक्षर सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट जोड़ देता है, जबकि अंग्रेज़ी डेक बिल्ट-इन Helvetica से निकलते हैं (कुछ एम्बेड नहीं, छोटी फ़ाइलें) — अंग्रेज़ी और हिंदी दोनों।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly survives the conversion — and what doesn't?",
        hi: "रूपांतरण में क्या बचता है — और क्या नहीं?",
      },
      a: {
        en: "Kept: every slide as one page with its text boxes at the real positions and sizes — titles (drawn bold), bullet lists, bold/italic runs, font sizes and text colors, group shapes with their scaling, and the slide's aspect ratio. Optional: one speaker-notes page per slide. Simplified or dropped: pictures, charts, SmartArt, graphicFrame tables and multi-column slide layouts flatten to their plain text. Text that overflows its box is still drawn (never silently lost) and reported. Everything that IS drawn is real selectable text — we never rasterize your words.",
        hi: "बचता है: हर स्लाइड एक पेज के रूप में, अपने टेक्स्ट-बॉक्स असली स्थिति और आकार में — शीर्षक (बोल्ड छपते हैं), बुलेट सूचियाँ, बोल्ड/इटैलिक रन, फ़ॉन्ट आकार और रंग, स्केलिंग सहित ग्रुप आकृतियाँ, और स्लाइड का आस्पेक्ट रेशियो। वैकल्पिक: हर स्लाइड के लिए स्पीकर-नोट्स पेज। सरल या छूटा: तस्वीरें, चार्ट, SmartArt, graphicFrame टेबलें और कई कॉलम वाले स्लाइड लेआउट सादे टेक्स्ट में समतल हो जाते हैं। बॉक्स से बाहर जाता टेक्स्ट फिर भी छपता है (चुपचाप खोया नहीं) और रिपोर्ट होता है। जो कुछ भी छपता है वह असली चुनने योग्य टेक्स्ट है — आपके शब्दों की तस्वीर कभी नहीं बनती।",
      },
    },
    {
      q: {
        en: "Does it work with Hindi presentations?",
        hi: "हिंदी प्रेज़ेंटेशन के साथ चलता है?",
      },
      a: {
        en: "Yes. Any Devanagari character switches the PDF to the embedded Noto Sans Devanagari subset, so हिंदी titles, bullets and speaker notes render and stay selectable — even the \"Slide N — notes\" heading localizes to स्लाइड N — नोट्स. Latin-only decks use the built-in Helvetica instead — nothing is embedded and the files stay tiny. One honest limit: the Noto face ships Regular only, so bold Hindi text renders at the same weight (titles still stand out through size).",
        hi: "हाँ। कोई भी देवनागरी अक्षर आते ही PDF एम्बेडेड Noto Sans Devanagari सबसेट पर चला जाता है, इसलिए हिंदी शीर्षक, बुलेट और स्पीकर नोट्स छपते और चुनने योग्य रहते हैं — \"Slide N — notes\" वाला शीर्षक भी स्लाइड N — नोट्स बन जाता है। सिर्फ़ लैटिन वाले डेक बिल्ट-इन Helvetica से निकलते हैं — कुछ एम्बेड नहीं होता, फ़ाइलें छोटी रहती हैं। एक ईमानदार सीमा: Noto फ़ेस में केवल Regular है, इसलिए बोल्ड हिंदी टेक्स्ट सामान्य मोटाई में छपता है (शीर्षक आकार से अलग दिखते हैं)।",
      },
    },
    {
      q: {
        en: "Why is my old .ppt file rejected?",
        hi: "मेरी पुरानी .ppt फ़ाइल क्यों नहीं चलती?",
      },
      a: {
        en: "The pre-2007 .ppt format is a binary OLE2 compound file, not the ZIP-based .pptx this tool unpacks — converting it would need a completely different parser. Open the deck in PowerPoint, Google Slides or LibreOffice and re-save as .pptx (takes seconds), then convert here. The tool checks the file signature up front (ZIP for .pptx, OLE2 gets its own clear message), so a renamed file can't sneak through.",
        hi: "2007 से पहले का .ppt फ़ॉर्मैट बाइनेरी OLE2 कंपाउंड फ़ाइल है, इस टूल की ZIP-आधारित .pptx नहीं — उसे बदलने के लिए बिल्कुल अलग पार्सर चाहिए। डेक को PowerPoint, Google Slides या LibreOffice में खोलकर .pptx के रूप में सेव कर लें (सेकंडों का काम), फिर यहाँ बदलें। टूल शुरू में ही फ़ाइल हस्ताक्षर जाँचता है (.pptx के लिए ZIP, OLE2 को उसका अपना साफ़ संदेश मिलता है), इसलिए नाम बदली फ़ाइल चुपचाप नहीं निकल सकती।",
      },
    },
    {
      q: {
        en: "Where is my deck processed, and what are the limits?",
        hi: "मेरा डेक कहाँ प्रोसेस होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread unzips the file and paints the PDF; nothing is uploaded, no sign-up, no watermark. Size limit 50 MB on mobile / 200 MB on desktop, one deck at a time. Very large decks are capped honestly: 100 slides with 300 text shapes each are converted, and the summary tells you when that happened. .pptx only — the binary .ppt is not supported.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड फ़ाइल खोलता और PDF बनाता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क। आकार सीमा मोबाइल पर 50 MB / डेस्कटॉप पर 200 MB, एक बार में एक डेक। बहुत बड़े डेक ईमानदारी से सीमित होते हैं: 100 स्लाइड, हर एक पर 300 टेक्स्ट आकृतियाँ तक बदलते हैं, और सारांश बता देता है कि ऐसा हुआ। केवल .pptx — बाइनेरी .ppt समर्थित नहीं है।",
      },
    },
  ],
};
