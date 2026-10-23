import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to OpenDocument Text (RB4-d). A surface-first tool (the
 * pdf-to-powerpoint pattern): the workspace renders on the landing page
 * in place of the DropZone and owns every control — the PDF drop zone
 * (magic-%PDF verified), the page range, the one-file-per-page switch,
 * the Convert CTA that spawns the real Web Worker, and the on-device
 * download with a pages/paragraphs/headings summary.
 *
 * The worker extracts selectable text with pdf.js (same recipe as
 * pdf-to-word), rebuilds paragraphs, ranks heading tiers from
 * font-size clusters into outline levels 1-6, keeps bold/italic runs
 * through the PDF's own font table, and packages a minimal valid
 * OpenDocument .odt with fflate — 100% on-device, EN + हिंदी.
 *
 * HONEST limits (mirrored in the FAQ): text + structure only. The
 * .odt reflows in LibreOffice, Word and Google Docs — it is NOT a
 * pixel-identical copy of the PDF. Images, columns and tables come
 * out as a plain text flow; scanned PDFs need the OCR tool first.
 * Devanagari travels as plain UTF-8 — no font embedding needed.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-odt",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  options: [
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Ranges like 1-3, 5, 8- (open end = through the last page) — only selected pages are converted.",
        hi: "1-3, 5, 8- जैसी रेंज (खुला सिरा = आख़िरी पेज तक) — चुने पेज ही बदलते हैं।",
      },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
    {
      kind: "switch",
      id: "perPage",
      label: { en: "One file per page", hi: "हर पेज की अलग फ़ाइल" },
      hint: {
        en: "Off: a single .odt for the whole document. On: one .odt per page (downloaded together as a ZIP).",
        hi: "बंद: पूरे दस्तावेज़ की एक .odt। चालू: हर पेज की अलग .odt (सब एक साथ ZIP में)।",
      },
      default: false,
    },
  ],
  howKeys: ["podt.how1", "podt.how2", "podt.how3"],
  chainToolIds: ["odt-to-pdf", "convert-to-pdf"],
  features: [
    {
      en: "Real editable OpenDocument text — the PDF's selectable text becomes .odt paragraphs you can retype, restyle and reuse in LibreOffice, Microsoft Word and Google Docs, entirely on your device.",
      hi: "असली एडिटेबल OpenDocument टेक्स्ट — PDF का चुनने योग्य टेक्स्ट .odt पैराग्राफ़ बन जाता है जिसे LibreOffice, Microsoft Word और Google Docs में बदल सकते हैं — पूरा काम आपके डिवाइस पर।",
    },
    {
      en: "Structure survives — lines merge back into paragraphs, font-size ranks become Heading outline levels 1–6, bold and italic runs stay bold and italic, and page ranges or one-file-per-page splits are one click away.",
      hi: "बनावट बनी रहती है — लाइनें वापस पैराग्राफ़ बनती हैं, फ़ॉन्ट-साइज़ दर्जा हेडिंग आउटलाइन स्तर 1–6 बनता है, बोल्ड और इटैलिक वैसे ही रहते हैं, और पेज रेंज या हर-पेज-अलग-फ़ाइल एक क्लिक दूर है।",
    },
    {
      en: "Hindi needs no font files — the OpenDocument package is plain UTF-8 XML, so देवनागरी text converts without embedding anything and opens correctly wherever you take it.",
      hi: "हिंदी को फ़ॉन्ट फ़ाइल की ज़रूरत नहीं — OpenDocument पैकेज सादा UTF-8 XML है, इसलिए देवनागरी टेक्स्ट बिना कुछ एम्बेड किए बदलता है और जहाँ ले जाएँ वहीं सही खुलता है।",
    },
    {
      en: "Honest conversion — you see the page count and a scan warning before you run, and paragraphs/headings counts after. The layout reflows (it is not a pixel-identical copy): images, columns and tables become a plain text flow.",
      hi: "ईमानदार रूपांतरण — चलाने से पहले पेज गिनती और स्कैन चेतावनी, बाद में पैराग्राफ़/हेडिंग गिनती दिखती है। लेआउट फिर से बहता है (यह पिक्सेल-परफ़ेक्ट प्रति नहीं है): इमेज, कॉलम और टेबल सादे टेक्स्ट-प्रवाह बनते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will the ODT look exactly like my PDF?",
        hi: "क्या ODT बिल्कुल मेरी PDF जैसी दिखेगी?",
      },
      a: {
        en: "No, and we say so up front: this is a text-and-structure conversion. Paragraphs, heading levels 1–6, bold and italic runs are rebuilt as real editable OpenDocument content; images, multi-column layouts and tables are simplified into a linear text flow, and the text reflows to whatever page size your word processor uses. The summary card tells you exactly what was detected.",
        hi: "नहीं, और हम शुरू में ही बता देते हैं: यह टेक्स्ट और बनावट का रूपांतरण है। पैराग्राफ़, हेडिंग स्तर 1–6, बोल्ड और इटैलिक असली एडिट करने योग्य OpenDocument कंटेंट बनते हैं; इमेज, मल्टी-कॉलम लेआउट और टेबल सीधे टेक्स्ट-प्रवाह में सरल होते हैं, और टेक्स्ट आपके वर्ड प्रोसेसर के पेज आकार पर फिर से बहता है। समरी कार्ड बताती है क्या पाया गया।",
      },
    },
    {
      q: {
        en: "Which apps can open the .odt?",
        hi: "कौन-कौन सी ऐप्स .odt खोल सकती हैं?",
      },
      a: {
        en: "The output is a standard OpenDocument Text package — LibreOffice Writer (its native format), Microsoft Word (2007 and later with Service Pack 2), Google Docs and OnlyOffice all open and edit it. The package is the open ISO 26300 standard, so it is a good long-term choice for documents you want to keep editable.",
        hi: "आउटपुट एक स्टैंडर्ड OpenDocument टेक्स्ट पैकेज है — LibreOffice Writer (इसका अपना फ़ॉर्मैट), Microsoft Word (2007 SP2 और बाद के), Google Docs और OnlyOffice सब इसे खोलकर एडिट करते हैं। पैकेज खुला ISO 26300 स्टैंडर्ड है, इसलिए दीर्घकाल एडिट करने योग्य रखने के लिए अच्छा विकल्प है।",
      },
    },
    {
      q: {
        en: "My PDF is a scan — what happens?",
        hi: "मेरी PDF स्कैन है — क्या होगा?",
      },
      a: {
        en: "Scanned pages are images with no selectable text, so the tool stops with an honest \"no selectable text\" message instead of saving an empty file. Run the PDF OCR tool on the same file first (English and Hindi are supported), then convert the result here.",
        hi: "स्कैन किए पेज तस्वीरें हैं, उनमें चुनने योग्य टेक्स्ट नहीं होता, इसलिए टूल ख़ाली फ़ाइल बनाने की जगह साफ़ \"चुनने योग्य टेक्स्ट नहीं मिला\" संदेश देता है। पहले उसी फ़ाइल पर PDF OCR टूल चलाएँ (अंग्रेज़ी और हिंदी समर्थित), फिर नतीजा यहाँ बदलें।",
      },
    },
    {
      q: {
        en: "Where is my document processed, and what do headings depend on?",
        hi: "मेरा दस्तावेज़ कहाँ प्रोसेस होता है, और हेडिंग किस पर निर्भर करती है?",
      },
      a: {
        en: "Entirely in this browser — a Web Worker thread reads the PDF with the self-hosted pdf.js and writes the OpenDocument package with fflate; nothing is uploaded, no sign-up, no watermark, one file at a time (50 MB mobile / 200 MB desktop). Headings come from font-size ranks: the document's dominant size is body text, and clearly larger tiers map to Heading 1-6 in descending order — bold text alone stays a normal paragraph.",
        hi: "पूरा काम इसी ब्राउज़र में — एक वर्कर थ्रेड सेल्फ़-होस्टेड pdf.js से PDF पढ़ता और fflate से OpenDocument पैकेज लिखता है; कुछ भी अपलोड नहीं होता, न साइन-अप, न वॉटरमार्क, एक बार में एक फ़ाइल (मोबाइल 50 MB / डेस्कटॉप 200 MB)। हेडिंग फ़ॉन्ट-साइज़ दर्जे से आती है: दस्तावेज़ का प्रमुख आकार बॉडी टेक्स्ट है, और साफ़ बड़े दर्जे घटते क्रम में Heading 1-6 बनते हैं — अकेला बोल्ड टेक्स्ट सामान्य पैराग्राफ़ ही रहता है।",
      },
    },
  ],
};
