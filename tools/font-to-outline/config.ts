import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Font to outline (PHASE-7): convert text drawn with embedded TrueType
 * fonts into pure bezier CURVES — the "convert fonts to outlines" print
 * shops and design agencies ask for. Words stop being text; the drawing
 * keeps every stroke. Own-engine glyf→bezier surgery on Type0
 * (Identity-H) fonts — the modern mainstream embedding.
 */
export const config: ToolConfig = {
  toolId: "font-to-outline",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["flatten-pdf", "compress-pdf", "view-pdf"],
  features: [
    {
      en: "Text becomes true vector curves — nothing left to select, copy or search in any editor.",
      hi: "टेक्स्ट सच्चे वेक्टर कर्व बन जाता है — किसी भी एडिटर में चुनने, कॉपी करने या खोजने को कुछ नहीं बचता।",
    },
    {
      en: "Print-shop ready: no font embedding worries, no missing-font substitutions on the RIP.",
      hi: "प्रिंट-शॉप के लिए तैयार: फ़ॉन्ट एम्बेड की चिंता नहीं, RIP पर फ़ॉन्ट ग़ायब होने का डर नहीं।",
    },
    {
      en: "Every glyph is redrawn from its own embedded outline — the curves ARE the letterforms, not an approximation.",
      hi: "हर ग्लिफ़ अपने ही एम्बेडेड आउटलाइन से दोबारा बनता है — कर्व वही अक्षर-रूप हैं, कोई अंदाज़ा नहीं।",
    },
    {
      en: "Layout stays byte-stable — positions, sizes, rotations and colors all come from the page's own matrices.",
      hi: "लेआउट जस का तस — जगह, आकार, घुमाव और रंग सब पेज के अपने मैट्रिक्स से आते हैं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which fonts can be converted?",
        hi: "कौन से फ़ॉन्ट बदले जा सकते हैं?",
      },
      a: {
        en: "Embedded TrueType in the modern Type0 / Identity-H form — what Chrome, Word, LibreOffice and most generators write. Type1, CFF and non-embedded fonts are counted and left as text; the tool reports exactly how much was converted.",
        hi: "आधुनिक Type0 / Identity-H रूप में एम्बेडेड TrueType — जो Chrome, Word, LibreOffice और ज़्यादातर जनरेटर लिखते हैं। Type1, CFF और बिना-एम्बेडेड फ़ॉन्ट गिने जाते हैं और टेक्स्ट ही रहते हैं; टूल साफ़ बताता है कितना बदला।",
      },
    },
    {
      q: {
        en: "Why would I want text as curves?",
        hi: "टेक्स्ट को कर्व में क्यों बदलूँ?",
      },
      a: {
        en: "Two classic reasons: the file must render identically everywhere (no font substitution ever), or the wording must stop being machine-read (no select/copy). The trade: the text is no longer searchable or editable — keep the original for edits.",
        hi: "दो पुराने कारण: फ़ाइल हर जगह बिल्कुल वैसी ही दिखे (कोई फ़ॉन्ट-बदली नहीं), या शब्द मशीन से पढ़े न जाएँ (न चुनना, न कॉपी)। समझौता: टेक्स्ट अब खोजा या एडिट नहीं जा सकता — बदलाव के लिए असली फ़ाइल रखें।",
      },
    },
    {
      q: {
        en: "Will the file size grow?",
        hi: "क्या फ़ाइल का आकार बढ़ेगा?",
      },
      a: {
        en: "Usually a little — each glyph's curves cost more bytes than the font program shares across the whole page. Run Compress PDF afterwards if size matters; the curves compress well.",
        hi: "आमतौर पर थोड़ा — हर ग्लिफ़ के कर्व ज़्यादा बाइट खाते हैं जो फ़ॉन्ट प्रोग्राम पूरे पेज पर साझा करता है। आकार मायने रखता हो तो बाद में Compress PDF चलाएँ; कर्व अच्छी दबती हैं।",
      },
    },
  ],
};
