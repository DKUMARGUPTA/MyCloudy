import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove attachments (P3-d) — strip the document-level paperclip
 * list: every /Names /EmbeddedFiles tree entry and catalog /AF
 * association goes, the orphaned filespec + stream objects are
 * deleted, and pages render exactly as before. File-attachment
 * ANNOTATIONS (page pins) keep their files alive — a different
 * mechanism, honestly untouched.
 */
export const config: ToolConfig = {
  toolId: "remove-attachments",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [],
  chainToolIds: ["sanitize-pdf", "compress-pdf", "view-metadata"],
  features: [
    {
      en: "Clear the entire paperclip list in one pass — every embedded file, its filespec entry and its stream object — leaving a lean, clean PDF.",
      hi: "एक ही बार में पूरी क्लिप-सूची साफ़ — हर जुड़ी फ़ाइल, उसकी filespec एंट्री और स्ट्रीम ऑब्जेक्ट — एक हल्की, साफ़ PDF बचती है।",
    },
    {
      en: "Bytes really leave the file: the orphaned objects are deleted from the object table, not just hidden — the size actually shrinks.",
      hi: "डेटा सच में फ़ाइल से निकलता है: अनाथ ऑब्जेक्ट टेबल से मिटते हैं, सिर्फ़ छुपते नहीं — साइज़ सच में घटती है।",
    },
    {
      en: "Page-level attachment pins survive by design — files still used by an annotation keep their objects; only the document-level list is cleared.",
      hi: "पेज पर लगे अटैचमेंट-पिन जान-बूझकर बचते हैं — किसी एनोटेशन के इस्तेमाल में फ़ाइलें अपने ऑब्जेक्ट रखती हैं; सिर्फ़ दस्तावेज़-स्तर की सूची साफ़ होती है।",
    },
    {
      en: "Pages render untouched — same count, same look, same text. Only the hidden payload goes.",
      hi: "पेज वैसे ही रहते हैं — उतने ही, वैसा ही दिखना, वही टेक्स्ट। सिर्फ़ छुपा सामान जाता है।",
    },
    {
      en: "Honest refusal when a PDF carries no document-level attachments — nothing is invented, nothing is broken.",
      hi: "जिस PDF में कोई दस्तावेज़-स्तर अटैचमेंट नहीं, वहाँ ईमानदार मनाई — कुछ बनाया नहीं जाता, कुछ टूटता नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why is the file smaller after removing attachments?",
        hi: "अटैचमेंट हटाने के बाद फ़ाइल छोटी क्यों हो जाती है?",
      },
      a: {
        en: "Because the embedded copies really are deleted — the filespec dictionaries and the streams that carried the file bytes are removed from the object table, and the whole document is re-serialized. Nothing is left for a repair tool to find later; that is exactly what you want when slimming a file for sharing.",
        hi: "क्योंकि जुड़ी कॉपियाँ सच में मिट जाती हैं — filespec डिक्शनरी और जिन स्ट्रीम में फ़ाइल के बाइट थे, वे ऑब्जेक्ट टेबल से हट जाते हैं और पूरा दस्तावेज़ दोबारा लिखा जाता है। बाद में किसी रिपेयर टूल को पकड़ने को कुछ नहीं बचता; शेयर के लिए फ़ाइल हल्की करते वक़्त यही चाहिए।",
      },
    },
    {
      q: {
        en: "There are pin icons on my pages — will this tool remove those too?",
        hi: "मेरे पेजों पर पिन के निशान हैं — क्या यह टूल उन्हें भी हटाएगा?",
      },
      a: {
        en: "No — and that is deliberate. Page pins are file-attachment ANNOTATIONS, a different PDF mechanism from the document-level paperclip list. Removing their filespec objects would leave broken annotations behind, so this tool keeps whatever an annotation still needs and clears only the document-level list. Use Remove annotations with the markup switch on to take the pins themselves off the pages.",
        hi: "नहीं — और यह जान-बूझकर है। पेज के पिन फ़ाइल-अटैचमेंट एनोटेशन हैं, दस्तावेज़-स्तर की क्लिप-सूची से PDF का अलग तंत्र। उनके filespec ऑब्जेक्ट हटाने पर टूटे एनोटेशन बच जाते, इसलिए यह टूल जो किसी एनोटेशन को चाहिए वह रखता है और सिर्फ़ दस्तावेज़-स्तर की सूची साफ़ करता है। पिन ख़ुद हटाने हों तो Remove annotations चलाएँ।",
      },
    },
    {
      q: {
        en: "Is removing attachments enough to sanitize a PDF before sharing?",
        hi: "शेयर से पहले PDF साफ़ करने के लिए क्या अटैचमेंट हटाना काफ़ी है?",
      },
      a: {
        en: "It clears the embedded files, but a full cleanup usually wants more: comments, form fields, scripts, hidden metadata and revision history. Run Sanitize PDF for that one-tap privacy bundle — this tool is the surgical files-only pass when you want everything else kept.",
        hi: "यह जुड़ी फ़ाइलें हटा देता है, पर पूरी सफ़ाई में अक्सर और भी चाहिए: टिप्पणियाँ, फ़ॉर्म फ़ील्ड, स्क्रिप्ट, छुपा मेटाडेटा और रिवीज़न हिस्ट्री। उसके लिए Sanitize PDF चलाएँ — वह एक-टैप प्राइवेसी बंडल है; यह टूल सिर्फ़ फ़ाइलों वाली सर्जिकल सफ़ाई है जब बाक़ी सब रखना हो।",
      },
    },
  ],
};
