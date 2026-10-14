import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Make PDF fillable (PRD §8.2 "Make fillable": "Auto-detect likely fields
 * (underlines, boxes) + manual add; field properties; export as
 * AcroForm"). The visual field editor lives in surface.tsx — the schema
 * options below only carry the export-time text-field border style.
 */
export const config: ToolConfig = {
  toolId: "make-pdf-fillable",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["fill-out-pdf", "view-pdf", "lock-pdf"],
  options: [
    {
      kind: "select",
      id: "border",
      label: { en: "Text field borders", hi: "टेक्स्ट फ़ील्ड किनारे" },
      hint: {
        en: "Detected underlines usually already show where to type — borders are optional.",
        hi: "पहचानी लाइनें आम तौर पर टाइप करने की जगह दिखा देती हैं — किनारे वैकल्पिक हैं।",
      },
      choices: [
        {
          value: "invisible",
          label: { en: "Invisible (suggested)", hi: "अदृश्य (सुझाया)" },
        },
        {
          value: "outlined",
          label: { en: "Light outline", hi: "हल्की रेखा" },
        },
      ],
      default: "invisible",
    },
  ],
  features: [
    {
      en: "Scans your PDF and suggests fields on underlines, boxes and checkboxes — click any suggestion to keep or drop it.",
      hi: "आपकी PDF स्कैन कर लाइनों, बॉक्स और चेकबॉक्स पर फ़ील्ड सुझाता है — किसी भी सुझाव को रखें या हटाएँ।",
    },
    {
      en: "Draw your own text boxes and checkboxes anywhere — drag on the page.",
      hi: "अपने टेक्स्ट बॉक्स और चेकबॉक्स ख़ुद बनाएँ — पेज पर खींचें।",
    },
    {
      en: "Name every field and switch it between single-line, multi-line and checkbox.",
      hi: "हर फ़ील्ड का नाम रखें और सिंगल-लाइन, मल्टी-लाइन या चेकबॉक्स चुनें।",
    },
    {
      en: "Exports a real AcroForm — opens fillable in Acrobat, Preview and every PDF viewer.",
      hi: "असली AcroForm बनाता है — Acrobat, Preview और हर PDF व्यूअर में भरने योग्य।",
    },
    {
      en: "100% on-device — your form never leaves the browser.",
      hi: "100% ऑन-डिवाइस — फ़ॉर्म ब्राउज़र से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "How does auto-detect find the fields?",
        hi: "ऑटो-डिटेक्ट फ़ील्ड कैसे ढूँढता है?",
      },
      a: {
        en: "It reads the page's drawing commands: long horizontal lines become text fields, small squares become checkboxes and larger boxes become text areas. It then names each field after the printed label on its left. Nothing is ever perfect — review the suggestions before exporting.",
        hi: "यह पेज की ड्रॉइंग कमांड पढ़ता है: लंबी क्षैतिज लाइनें टेक्स्ट फ़ील्ड बनती हैं, छोटे वर्ग चेकबॉक्स और बड़े बॉक्स टेक्स्ट एरिया। हर फ़ील्ड का नाम बाईं ओर लिखे लेबल से रखता है। एक्सपोर्ट से पहले सुझाव ज़रूर जाँचें।",
      },
    },
    {
      q: {
        en: "My PDF already has form fields — what happens?",
        hi: "मेरी PDF में पहले से फ़ील्ड हैं — क्या होगा?",
      },
      a: {
        en: "You'll see a notice. New fields are simply added next to the existing ones, and every name is made unique automatically. To type into existing fields use Fill out PDF instead.",
        hi: "आपको सूचना दिखेगी। नए फ़ील्ड पुरानों के साथ जुड़ जाते हैं और हर नाम अपने आप अनूठा हो जाता है। पुराने फ़ील्ड भरने के लिए PDF भरें टूल इस्तेमाल करें।",
      },
    },
    {
      q: {
        en: "Why is the typed text invisible in some viewers?",
        hi: "कुछ व्यूअर में टाइप किया टेक्स्ट दिखता क्यों नहीं?",
      },
      a: {
        en: "It shouldn't be — fields export with appearances. If a viewer ignores them, its \"show form fields\" setting is off. Every major viewer (Acrobat, Chrome, Edge, Preview) shows them by default.",
        hi: "नहीं दिखना चाहिए — फ़ील्ड एपियरेंस के साथ एक्सपोर्ट होते हैं। अगर कोई व्यूअर नज़रअंदाज़ करे तो उसकी \"फ़ॉर्म फ़ील्ड दिखाएँ\" सेटिंग बंद है। Acrobat, Chrome, Edge, Preview सब डिफ़ॉल्ट में दिखाते हैं।",
      },
    },
  ],
};
