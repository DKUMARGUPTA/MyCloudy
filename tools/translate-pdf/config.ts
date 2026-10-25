import type { ToolConfig } from "@/lib/tools/config-types";

import { TARGET_LANGUAGES } from "./model";

/**
 * Translate PDF (R9-c) — the whole document into 9 languages, free. The
 * second (and last) DocoPDF tool with a server round-trip, same honest
 * shape as Chat with PDF: text is extracted on-device, ONLY bounded batch
 * strings ever POST to /api/translate — never file bytes.
 *
 * Layout honesty: the output is a clean re-flowed A4 document (each
 * original page starts with a small "Page N" header), NOT a pixel copy of
 * the input — fonts, columns and images do not carry over. Bilingual mode
 * keeps the original text above each translation in gray.
 */
export const config: ToolConfig = {
  toolId: "translate-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["chat-with-pdf", "edit-pdf", "ocr-pdf", "view-pdf"],
  options: [
    {
      kind: "select",
      id: "targetLang",
      label: { en: "Translate into", hi: "इसमें अनुवाद करें" },
      hint: {
        en: "9 languages our embedded fonts can render — more coming",
        hi: "9 भाषाएँ जो हमारे एम्बेडेड फ़ॉन्ट दिखा सकते हैं — और आएँगे",
      },
      choices: TARGET_LANGUAGES.map((l) => ({
        value: l.code,
        label: { en: l.native, hi: l.native },
      })),
      default: "hi",
    },
    {
      kind: "select",
      id: "mode",
      label: { en: "Output", hi: "आउटपुट" },
      hint: {
        en: "Translated only, or the original in gray above each translation",
        hi: "सिर्फ़ अनुवाद, या हर अनुवाद के ऊपर मूल पाठ स्लेटी में",
      },
      choices: [
        {
          value: "translated",
          label: { en: "Translated PDF", hi: "अनुवादित PDF" },
        },
        {
          value: "bilingual",
          label: {
            en: "Bilingual — original + translation",
            hi: "द्विभाषी — मूल + अनुवाद",
          },
        },
      ],
      default: "translated",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8- (long docs: translate a range)",
        hi: "सब, या रेंज जैसे 1-3, 5, 8- (लंबे दस्तावेज़: रेंज अनुवाद करें)",
      },
      default: "all",
    },
  ],
  features: [
    {
      en: "Translate the whole PDF into Hindi, Marathi, Spanish, French, German, Italian, Portuguese, Dutch or English — free, no page limits per day.",
      hi: "पूरी PDF का अनुवाद हिन्दी, मराठी, स्पेनिश, फ़्रेंच, जर्मन, इतालवी, पुर्तगाली, डच या अंग्रेज़ी में करें — मुफ़्त, कोई रोज़ की सीमा नहीं।",
    },
    {
      en: "Bilingual mode keeps the original text in gray above every translation — perfect for checking what changed.",
      hi: "द्विभाषी मोड हर अनुवाद के ऊपर मूल पाठ स्लेटी में रखता है — जो बदला उसे जाँचने के लिए बिल्कुल सही।",
    },
    {
      en: "Hindi and Marathi render in a real embedded Devanagari font — not boxes or broken glyphs.",
      hi: "हिन्दी और मराठी असली एम्बेडेड देवनागरी फ़ॉन्ट में दिखते हैं — डिब्बे या टूटे अक्षर नहीं।",
    },
    {
      en: "Your file never leaves the device: text is extracted on your device and only bounded text batches go for translation — never the PDF bytes.",
      hi: "आपकी फ़ाइल डिवाइस से बाहर नहीं जाती: टेक्स्ट आपके डिवाइस पर निकलता है और सिर्फ़ सीमित टेक्स्ट बैच अनुवाद के लिए जाते हैं — PDF बाइट्स कभी नहीं।",
    },
    {
      en: "Scans are detected honestly and pointed to PDF OCR first; page ranges let you translate long documents part by part.",
      hi: "स्कैन ईमानदारी से पहचाने जाते हैं और पहले PDF OCR की ओर भेजे जाते हैं; पेज रेंज से लंबे दस्तावेज़ थोड़ा-थोड़ा अनुवाद कर सकते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does the translated PDF look like the original?",
        hi: "क्या अनुवादित PDF मूल जैसी दिखती है?",
      },
      a: {
        en: "No — and we say so plainly. The output is a clean, re-flowed A4 document: every original page starts with a small \"Page N\" header, text wraps naturally in the target language, and fonts, columns and images do not carry over. Bilingual mode shows the original text in gray above each translation.",
        hi: "नहीं — और हम यह साफ़ कहते हैं। आउटपुट एक साफ़, नए-ढाँचे का A4 दस्तावेज़ है: हर मूल पेज छोटे \"Page N\" शीर्षक से शुरू होता है, टेक्स्ट लक्ष्य भाषा में सहज रूप से लपेटता है, और फ़ॉन्ट, कॉलम व तस्वीरें साथ नहीं आतीं। द्विभाषी मोड हर अनुवाद के ऊपर मूल पाठ स्लेटी में दिखाता है।",
      },
    },
    {
      q: {
        en: "Is my PDF uploaded anywhere?",
        hi: "क्या मेरी PDF कहीं अपलोड होती है?",
      },
      a: {
        en: "No. The file is opened in your browser and its text is extracted on your device. Only those bounded text batches — never the PDF itself — are sent for translation, and nothing is stored on the server.",
        hi: "नहीं। फ़ाइल आपके ब्राउज़र में खुलती है और उसका टेक्स्ट आपके डिवाइस पर निकलता है। सिर्फ़ वही सीमित टेक्स्ट बैच — PDF कभी नहीं — अनुवाद के लिए जाते हैं, और सर्वर पर कुछ सेव नहीं होता।",
      },
    },
    {
      q: {
        en: "Which languages work? Why not Chinese or Arabic yet?",
        hi: "कौन सी भाषाएँ चलती हैं? चीनी या अरबी अभी क्यों नहीं?",
      },
      a: {
        en: "Hindi, Marathi, English, Spanish, French, German, Italian, Portuguese and Dutch. Those are exactly the scripts our embedded fonts (Helvetica + self-hosted Noto Devanagari) can render in the output PDF. Chinese, Japanese, Korean and Arabic need their own font files — we would rather ship honest support later than broken boxes today.",
        hi: "हिन्दी, मराठी, अंग्रेज़ी, स्पेनिश, फ़्रेंच, जर्मन, इतालवी, पुर्तगाली और डच। यही वे लिपियाँ हैं जो हमारे एम्बेडेड फ़ॉन्ट (Helvetica + सेल्फ़-होस्टेड नोटो देवनागरी) आउटपुट PDF में दिखा सकते हैं। चीनी, जापानी, कोरियाई और अरबी के लिए अलग फ़ॉन्ट फ़ाइलें चाहिए — टूटे डिब्बों की जगह ईमानदार समर्थन बाद में लाना बेहतर है।",
      },
    },
    {
      q: {
        en: "How long can the document be?",
        hi: "दस्तावेज़ कितना लंबा हो सकता है?",
      },
      a: {
        en: "Up to 200 pages and about 100,000 characters of text in one run. Longer documents are refused honestly — use the Pages option (e.g. 1-20, then 21-40) to translate part by part.",
        hi: "एक बार में 200 पेज और लगभग 1,00,000 अक्षर तक। इससे लंबे दस्तावेज़ ईमानदारी से मना किए जाते हैं — पेज विकल्प से (जैसे 1-20, फिर 21-40) थोड़ा-थोड़ा अनुवाद करें।",
      },
    },
  ],
};
