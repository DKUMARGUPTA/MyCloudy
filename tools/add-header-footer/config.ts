import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Header & footer (PRD §8.2): left/center/right text in the header and the
 * footer with {page} {pages} {date} {filename} {title} variables, shared
 * font/size/color, edge distance, date shape, page targeting. Custom panel
 * + live preview surface own every interactive value (split-tool pattern).
 */
export const config: ToolConfig = {
  toolId: "add-header-footer",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: [
    "add-page-numbers",
    "pdf-to-jpg",
    "pdf-to-png",
    "merge-pdf",
  ],
  features: [
    {
      en: "Left, center and right text in the header and the footer — six independent slots.",
      hi: "हेडर और फुटर में बाएँ, बीच, दाएँ टेक्स्ट — छह अलग-अलग जगहें।",
    },
    {
      en: "Variables: {page}, {pages}, {date}, {filename}, {title} — resolved per page.",
      hi: "वेरिएबल: {page}, {pages}, {date}, {filename}, {title} — हर पेज पर अलग से हल होते हैं।",
    },
    {
      en: "Hindi text works too — the Devanagari font is embedded inside your PDF automatically.",
      hi: "हिंदी टेक्स्ट भी चलता है — देवनागरी फ़ॉन्ट PDF में अपने आप जुड़ जाता है।",
    },
    {
      en: "Pick your date shape: 07/10/2026, 10/07/2026 or 2026-10-07.",
      hi: "तारीख़ का रूप चुनें: 07/10/2026, 10/07/2026 या 2026-10-07।",
    },
    {
      en: "Live preview shows every slot on the selected page — on your device only.",
      hi: "लाइव प्रीव्यू चुने हुए पेज पर हर जगह दिखाता है — सब आपके डिवाइस पर।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do the variables work?",
        hi: "वेरिएबल कैसे काम करते हैं?",
      },
      a: {
        en: "Type {page} anywhere in a field and it becomes the page number, {pages} the total, {date} today’s date, {filename} the file’s name, {title} the PDF’s Title metadata.",
        hi: "किसी भी फ़ील्ड में {page} लिखें तो वह पेज नंबर बन जाता है, {pages} कुल पेज, {date} आज की तारीख़, {filename} फ़ाइल का नाम, {title} PDF का टाइटल मेटाडेटा।",
      },
    },
    {
      q: {
        en: "Can I write the header in Hindi?",
        hi: "क्या हेडर हिंदी में लिख सकते हैं?",
      },
      a: {
        en: "Yes — Devanagari text automatically renders with an embedded Hindi font, so it displays on every device. Latin-only text uses your chosen built-in PDF font.",
        hi: "हाँ — देवनागरी टेक्स्ट अपने आप एम्बेडेड हिंदी फ़ॉन्ट से बनता है, तो हर डिवाइस पर दिखता है। सिर्फ़ लैटिन टेक्स्ट आपके चुने हुए बिल्ट-इन फ़ॉन्ट से।",
      },
    },
    {
      q: {
        en: "Will it overwrite an existing header?",
        hi: "क्या पुराना हेडर हट जाएगा?",
      },
      a: {
        en: "No — your text is added on top; anything already printed in the page stays. Move the edge distance if the two overlap.",
        hi: "नहीं — आपका टेक्स्ट ऊपर जुड़ता है; पेज पर पहले से छपा कुछ वैसा ही रहता है। ओवरलैप हो तो किनारे से दूरी बढ़ा लें।",
      },
    },
  ],
};
