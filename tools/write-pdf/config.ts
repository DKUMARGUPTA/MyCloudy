import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Write PDF (PRD §8 "Write PDF" — word-processor style). A no-file,
 * surface-first tool like Generate QR code: the surface renders directly
 * on the landing page in place of the DropZone and owns every control —
 * the template picker, the block editor, the live paginated preview, the
 * page setup. The heavy export runs in the tool's real Web Worker, driven
 * by the surface itself (progress → on-device download), so the run
 * pipeline stays honest without any shell changes.
 */
export const config: ToolConfig = {
  toolId: "write-pdf",
  noFile: true,
  howKeys: ["write.how1", "write.how2", "write.how3"],
  minFiles: 0,
  maxFiles: 0,
  outputKind: "pdf",
  options: [],
  features: [
    {
      en: "Write like a word processor — headings, bold, italic, underline, colour, lists, quotes and tables that flow across pages",
      hi: "वर्ड प्रोसेसर की तरह लिखें — हेडिंग, बोल्ड, इटैलिक, अंडरलाइन, रंग, लिस्ट, कोट और टेबल, पेजों पर बहते हुए",
    },
    {
      en: "Hindi typing built in — Devanagari text shapes correctly inside the PDF with the embedded Noto font",
      hi: "हिंदी टाइपिंग शामिल — देवनागरी टेक्स्ट एम्बेडेड नोटो फ़ॉन्ट से PDF में बिल्कुल सही बनता है",
    },
    {
      en: "Start from a template — blank page, letter, Hindi application, job offer or report — then make it yours",
      hi: "टेम्पलेट से शुरू करें — ख़ाली पेज, पत्र, हिंदी आवेदन, जॉब ऑफ़र या रिपोर्ट — फिर अपना बनाएँ",
    },
    {
      en: "See the real pages as you write — the live preview paginates exactly like the exported PDF",
      hi: "लिखते-लिखते असली पेज देखें — लाइव प्रीव्यू बिल्कुल वैसा ही पेज बाँटता है जैसी एक्सपोर्ट होने वाली PDF",
    },
    {
      en: "Page breaks, dividers, images, headers, footers and page numbers — and everything stays on your device",
      hi: "पेज ब्रेक, डिवाइडर, तस्वीरें, हेडर, फ़ुटर और पेज नंबर — और सब कुछ आपके डिवाइस पर ही रहता है",
    },
  ],
  faq: [
    {
      q: {
        en: "Is this a full word processor?",
        hi: "क्या यह पूरा वर्ड प्रोसेसर है?",
      },
      a: {
        en: "It covers everyday documents: styled text, lists, tables, images, page breaks and page furniture. It intentionally does not reflow around floating images or track changes — for that, a desktop editor is still the right tool.",
        hi: "रोज़मर्रा के दस्तावेज़ों के लिए पूरा है: स्टाइल वाला टेक्स्ट, लिस्ट, टेबल, तस्वीरें, पेज ब्रेक और पेज का साज़-सामान। फ़्लोटिंग इमेज के चारों ओर रीफ़्लो या ट्रैक-चेंजेस जान-बूझकर नहीं हैं — उसके लिए डेस्कटॉप एडिटर ही सही है।",
      },
    },
    {
      q: {
        en: "How close is the preview to the downloaded PDF?",
        hi: "प्रीव्यू डाउनलोड होने वाली PDF से कितना मिलता है?",
      },
      a: {
        en: "Both are laid out by the same engine. Line breaks, page breaks, tables and page numbers come out the same; tiny letter-width differences can appear if your device substitutes an unusual system font, never a different page count in practice.",
        hi: "दोनों को एक ही इंजन बाँटता है। लाइन ब्रेक, पेज ब्रेक, टेबल और पेज नंबर एक जैसे आते हैं; अगर आपका डिवाइस कोई अलग सिस्टम फ़ॉन्ट लगा दे तो अक्षर-चौड़ाई में बहुत छोटा फ़र्क दिख सकता है — पेज संख्या व्यवहार में कभी नहीं बदलती।",
      },
    },
    {
      q: {
        en: "Can I write in Hindi and English together?",
        hi: "क्या हिंदी और अंग्रेज़ी साथ-साथ लिख सकते हैं?",
      },
      a: {
        en: "Yes. Any paragraph containing Devanagari switches entirely to the embedded Hindi font so the line looks consistent, and the rupee sign ₹ is supported. English-only paragraphs stay on the compact built-in fonts.",
        hi: "हाँ। देवनागरी वाला पैराग्राफ़ पूरा एम्बेडेड हिंदी फ़ॉन्ट में चला जाता है ताकि लाइन एक जैसी दिखे, और ₹ चिन्ह भी साथ है। सिर्फ़ अंग्रेज़ी पैराग्राफ़ बिल्ट-इन फ़ॉन्ट पर रहते हैं।",
      },
    },
  ],
};
