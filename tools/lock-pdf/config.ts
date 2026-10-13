import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Lock PDF (PRD §8.4, security): AES-256 encryption (AES-128 for older
 * readers) with an open password, an owner password and a full permission
 * set. The surface owns every value (split-tool pattern); the worker
 * verifies the output before reporting success.
 */
export const config: ToolConfig = {
  toolId: "lock-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["view-pdf", "unlock-pdf", "sign-pdf", "compress-pdf"],
  features: [
    {
      en: "AES-256 encryption — the modern standard trusted by banks and governments (AES-128 available for very old readers).",
      hi: "AES-256 एन्क्रिप्शन — बैंकों और सरकारों जैसा आधुनिक मानक (बहुत पुराने रीडरों के लिए AES-128 भी)।",
    },
    {
      en: "Open password plus a separate owner password — so you can share the file but keep full control of permissions.",
      hi: "ओपन पासवर्ड और अलग ओनर पासवर्ड — फ़ाइल शेयर करें, पर अनुमतियों का नियंत्रण आपके पास रहे।",
    },
    {
      en: "Fine-grained permissions: printing, copying, editing, annotating, form filling and accessibility — each toggled separately.",
      hi: "बारीक अनुमतियाँ: प्रिंट, कॉपी, एडिट, एनोटेट, फ़ॉर्म भरना और एक्सेसिबिलिटी — हर एक अलग से चुनें।",
    },
    {
      en: "A live strength meter and one-tap generate button help you pick a password worth locking with.",
      hi: "लाइव स्ट्रेंथ मीटर और एक-टैप जनरेट बटन — लॉक के लायक पासवर्ड चुनने में मदद।",
    },
    {
      en: "Every step runs on your device — the PDF and both passwords never leave your browser.",
      hi: "हर कदम आपके डिवाइस पर — PDF और दोनों पासवर्ड कभी ब्राउज़र से बाहर नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between the open password and the owner password?",
        hi: "ओपन पासवर्ड और ओनर पासवर्ड में क्या फ़र्क़ है?",
      },
      a: {
        en: "The open password is needed to view the file at all. The owner password is for you: opening with it gives full rights and lets you change permissions later. Most people only need the open password — leave the owner field empty and it matches the open one.",
        hi: "ओपन पासवर्ड फ़ाइल खोलने के लिए चाहिए। ओनर पासवर्ड आपके लिए है: इससे खोलने पर पूरे अधिकार मिलते हैं और बाद में अनुमतियाँ बदली जा सकती हैं। ज़्यादातर लोगों को सिर्फ़ ओपन पासवर्ड चाहिए — ओनर ख़ाली छोड़ें तो वही ओपन वाला लग जाता है।",
      },
    },
    {
      q: {
        en: "What happens if I forget the password?",
        hi: "अगर मैं पासवर्ड भूल जाऊँ तो?",
      },
      a: {
        en: "AES-256 has no back door. Keep the original unlocked file somewhere safe, or write the password in a password manager before locking. There is no recovery — and that is exactly what makes the lock real.",
        hi: "AES-256 का कोई बैक डोर नहीं है। ओरिजिनल अनलॉक फ़ाइल कहीं सुरक्षित रखें, या लॉक करने से पहले पासवर्ड मैनेजर में लिख लें। रिकवरी नहीं होती — यही असली लॉक होने की निशानी है।",
      },
    },
    {
      q: {
        en: "Do permissions really stop copying?",
        hi: "क्या अनुमतियाँ सच में कॉपी रोकती हैं?",
      },
      a: {
        en: "Honest answer: permissions are enforced by well-behaved readers (Acrobat, Chrome, Preview). The open password is the real protection — restrictions alone only discourage, they cannot stop a determined tool. Use both together for the best result.",
        hi: "ईमानदार जवाब: अनुमतियाँ अच्छे रीडर (Acrobat, Chrome, Preview) मानते हैं। असली सुरक्षा ओपन पासवर्ड है — पाबंदियाँ अकेले सिर्फ़ रोकती नहीं, ज़िद्दी टूल रोक नहीं सकते। दोनों साथ इस्तेमाल करें।",
      },
    },
  ],
};
