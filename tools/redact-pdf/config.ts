import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Redact PDF (PRD §8.4): find and permanently remove sensitive text.
 *
 * The custom surface owns matching + marking; the two schema options below
 * deliberately live in the shared OptionsPanel so the aside stays useful
 * for surface tools too (paying off the P3.13 note about empty option
 * cards).
 */
export const config: ToolConfig = {
  toolId: "redact-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Flatten quality", hi: "फ़्लैटन क्वालिटी" },
      hint: {
        en: "Quality of the flattened (redacted) pages. Unmarked pages stay vector-sharp.",
        hi: "फ़्लैटन (रिडैक्ट) पेजों की क्वालिटी। बाक़ी पेज वेक्टर जितने साफ़ रहते हैं।",
      },
      choices: [
        { value: "96", label: { en: "Screen — 96 DPI", hi: "स्क्रीन — 96 DPI" } },
        { value: "150", label: { en: "Balanced — 150 DPI", hi: "संतुलित — 150 DPI" } },
        { value: "300", label: { en: "Print — 300 DPI", hi: "प्रिंट — 300 DPI" } },
      ],
      default: "150",
    },
    {
      kind: "select",
      id: "color",
      label: { en: "Redaction box colour", hi: "रिडैक्शन बॉक्स का रंग" },
      hint: {
        en: "Both colours are fully opaque — the hidden text is destroyed either way.",
        hi: "दोनों रंग पूरी तरह अपारदर्शी हैं — छिपाया टेक्स्ट दोनों में मिट जाता है।",
      },
      choices: [
        { value: "black", label: { en: "Black", hi: "काला" } },
        { value: "white", label: { en: "White", hi: "सफ़ेद" } },
      ],
      default: "black",
    },
  ],
  chainToolIds: ["view-pdf", "remove-pdf-metadata", "compress-pdf", "pdf-to-jpg"],
  features: [
    {
      en: "One click finds Aadhaar, PAN, phone numbers and emails — drawn as boxes you can review before applying.",
      hi: "एक क्लिक में आधार, पैन, फ़ोन नंबर और ईमेल ढूँढें — लागू करने से पहले बॉक्स देख लें।",
    },
    {
      en: "Add your own words to search, or draw boxes anywhere on the page.",
      hi: "अपने शब्द भी खोजें, या पेज पर कहीं भी बॉक्स बनाएँ।",
    },
    {
      en: "Real redaction: marked pages are flattened so the text is destroyed, not just covered.",
      hi: "असली रिडैक्शन: चुने पेज फ़्लैटन होते हैं — टेक्स्ट ढका नहीं, मिटाया जाता है।",
    },
    {
      en: "The output is re-scanned after redacting — if any hidden text survived, you hear about it.",
      hi: "रिडैक्शन के बाद फ़ाइल दोबारा जाँची जाती है — कुछ बचा होता तो आपको बताया जाता है।",
    },
    {
      en: "Forms and bookmarks are flattened in the output — a redacted file is a clean final copy.",
      hi: "आउटपुट में फ़ॉर्म-बुकमार्क फ़्लैटन रहते हैं — रिडैक्ट फ़ाइल एक साफ़ अंतिम प्रति है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is the text really gone, or just hidden behind a box?",
        hi: "क्या टेक्स्ट सच में मिटता है, या सिर्फ़ बॉक्स से ढका रहता है?",
      },
      a: {
        en: "Really gone. Each page you mark is flattened into an image with the boxes painted in before saving, and the page's original text layer, annotations and form fields are not carried into the new file at all. Copy, search and text extraction all come back empty — the tool verifies this automatically before handing you the file.",
        hi: "सच में मिटाया जाता है। आपका चुना हर पेज एक इमेज में बदल जाता है और उसका पुराना टेक्स्ट लेयर, एनोटेशन और फ़ॉर्म फ़ील्ड नई फ़ाइल में आते ही नहीं। कॉपी, सर्च और टेक्स्ट एक्स्ट्रैक्शन — तीनों खाली निकलते हैं। फ़ाइल देने से पहले टूल यह जाँच खुद करता है।",
      },
    },
    {
      q: {
        en: "My document is a scan — can I still redact?",
        hi: "मेरा दस्तावेज़ स्कैन है — क्या फिर भी रिडैक्ट कर सकते हैं?",
      },
      a: {
        en: "Yes, with boxes. Scans have no selectable text, so search cannot highlight anything — draw boxes over the sensitive parts instead. They flatten the page exactly the same way.",
        hi: "हाँ, बॉक्स बनाकर। स्कैन में चुनने योग्य टेक्स्ट नहीं होता, इसलिए सर्च कुछ नहीं दिखाता — संवेदनशील हिस्सों पर खुद बॉक्स बना लें। वे भी पेज उसी तरह फ़्लैटन करते हैं।",
      },
    },
    {
      q: {
        en: "Why did the pages I redacted stop being selectable?",
        hi: "जिन पेजों को रिडैक्ट किया, वे चुने क्यों नहीं जा रहे?",
      },
      a: {
        en: "That is the security model: a redacted page becomes an image, which is exactly why its text cannot be recovered. Pages without redactions keep their text fully selectable.",
        hi: "यही तो सुरक्षा है: रिडैक्ट पेज इमेज बन जाता है, इसीलिए उसका टेक्स्ट वापस नहीं आ सकता। जिन पेजों में कुछ नहीं मिटाया, वे पूरे चुनने योग्य रहते हैं।",
      },
    },
  ],
};
