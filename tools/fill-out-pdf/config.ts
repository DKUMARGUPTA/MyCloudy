import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Fill out PDF forms (PRD §8.2 "Fill out"): fill text fields, checkboxes,
 * radio groups and dropdowns straight on the device, with field highlights
 * on a live page preview, Tab-key navigation, a local auto-fill profile
 * and an optional "flatten after fill". The surface owns every interactive
 * value (split-tool pattern — the schema holds only the flatten switch).
 */
export const config: ToolConfig = {
  toolId: "fill-out-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "switch",
      id: "flatten",
      label: {
        en: "Flatten after filling",
        hi: "भरने के बाद फ़्लैटन करें",
      },
      hint: {
        en: "Makes your answers permanent page content — the form can no longer be edited or cleared. Leave it off to keep the fields editable.",
        hi: "आपके जवाब पेज का स्थायी हिस्सा बन जाते हैं — फ़ॉर्म बाद में बदला नहीं जा सकता। फ़ील्ड एडिटेबल रखने के लिए बंद छोड़ें।",
      },
      default: false,
    },
  ],
  chainToolIds: ["merge-pdf", "pdf-to-png", "pdf-to-jpg"],
  features: [
    {
      en: "Every fillable field is listed and highlighted on a live page preview — text boxes, checkboxes, radios, dropdowns.",
      hi: "हर भरने योग्य फ़ील्ड सूची में और लाइव प्रीव्यू पर हाइलाइट दिखता है — टेक्स्ट, चेकबॉक्स, रेडियो, ड्रॉपडाउन।",
    },
    {
      en: "Tab through the fields in reading order, exactly like in a PDF reader.",
      hi: "फ़ील्ड में क्रम से Tab दबाकर चलें — बिल्कुल PDF रीडर जैसा।",
    },
    {
      en: "Auto-fill saves your name, email and address on this device and matches them to fields in one click.",
      hi: "ऑटो-फ़िल आपका नाम, ईमेल और पता इसी डिवाइस पर रखता है और एक क्लिक में फ़ील्ड से मैच कर देता है।",
    },
    {
      en: "Required and read-only fields are marked honestly — you always know what is left.",
      hi: "ज़रूरी और रीड-ओनली फ़ील्ड साफ़ चिन्हित हैं — क्या बाकी है, हमेशा पता रहता है।",
    },
    {
      en: "Optional flatten turns your answers into permanent content nobody can clear.",
      hi: "विकल्प: फ़्लैटन आपके जवाब स्थायी कर देता है, कोई मिटा नहीं सकता।",
    },
    {
      en: "Runs entirely on your device — your answers never leave the browser.",
      hi: "पूरा काम डिवाइस पर — आपके जवाब ब्राउज़र से बाहर नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "Where are my answers stored?",
        hi: "मेरे जवाब कहाँ सेव होते हैं?",
      },
      a: {
        en: "Only inside the PDF you download. The auto-fill profile (name, email, address) stays in this browser's local storage — nothing is ever uploaded.",
        hi: "सिर्फ़ उसी PDF में जो आप डाउनलोड करते हैं। ऑटो-फ़िल प्रोफ़ाइल (नाम, ईमेल, पता) इसी ब्राउज़र में रहती है — कुछ भी अपलोड नहीं होता।",
      },
    },
    {
      q: {
        en: "What does \"Flatten after filling\" do?",
        hi: "\"भरने के बाद फ़्लैटन करें\" क्या करता है?",
      },
      a: {
        en: "Flattening bakes your answers into the page content, so nobody can edit or clear them — ideal before submitting. Leave it off if you want to keep editing the form later.",
        hi: "फ़्लैटन करने से जवाब पेज का हिस्सा बन जाते हैं, कोई बदल या मिटा नहीं सकता — जमा करने से पहले बढ़िया। बाद में फ़ॉर्म एडिट करना हो तो बंद छोड़ें।",
      },
    },
    {
      q: {
        en: "My PDF is a form, but no fields appear. Why?",
        hi: "मेरी PDF फ़ॉर्म है, पर कोई फ़ील्ड नहीं दिखता। क्यों?",
      },
      a: {
        en: "The file either has flat content (just text and lines, no real fields) or it uses an XFA-only form, which is rare. For flat PDFs, the visual editor (add text anywhere) arrives in a later phase — you can already watermark, stamp or sign these files with the other tools.",
        hi: "फ़ाइल में या तो सपाट कंटेंट है (सिर्फ़ टेक्स्ट-लाइनें, असली फ़ील्ड नहीं) या वह XFA फ़ॉर्म है, जो दुर्लभ है। सपाट PDF के लिए विज़ुअल एडिटर बाद के फ़ेज़ में आएगा — अभी भी आप ऐसी फ़ाइलों पर वॉटरमार्क, स्टैम्प या साइन कर सकते हैं।",
      },
    },
  ],
};
