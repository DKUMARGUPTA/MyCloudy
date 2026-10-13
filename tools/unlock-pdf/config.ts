import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Unlock PDF (PRD §8.4, security): remove protection from files you can
 * already open — the known open password goes away, and files that open
 * freely but carry owner restrictions get those restrictions stripped.
 * The output is rebuilt cleanly (no /Encrypt remnant). No cracking:
 * an unknown open password cannot be removed by anyone, including us.
 */
export const config: ToolConfig = {
  toolId: "unlock-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["view-pdf", "merge-pdf", "compress-pdf", "sign-pdf"],
  features: [
    {
      en: "Two modes in one: remove a known open password, or strip owner restrictions from files that open freely.",
      hi: "एक में दो मोड: पता चालित ओपन पासवर्ड हटाएँ, या खुलकर आने वाली फ़ाइल की ओनर पाबंदियाँ हटाएँ।",
    },
    {
      en: "The output is rebuilt from scratch — not a single byte of encryption metadata survives, verified before you download.",
      hi: "आउटपुट शुरू से बनता है — एन्क्रिप्शन का एक भी बाइट नहीं बचता, डाउनलोड से पहले जाँचा जाता है।",
    },
    {
      en: "Forms, filled values and document info are preserved — unlocking changes protection, nothing else.",
      hi: "फ़ॉर्म, भरी हुई वैल्यू और दस्तावेज़ जानकारी वैसी ही रहती हैं — अनलॉक सिर्फ़ सुरक्षा बदलता है, और कुछ नहीं।",
    },
    {
      en: "Honest policy: an unknown open password cannot be removed — this tool never pretends otherwise.",
      hi: "ईमानदार नीति: अनजान ओपन पासवर्ड हटाया नहीं जा सकता — यह टूल कभी ऐसा दिखावा नहीं करता।",
    },
    {
      en: "Everything happens on your device — the file and the password never leave your browser.",
      hi: "सब कुछ आपके डिवाइस पर — फ़ाइल और पासवर्ड कभी ब्राउज़र से बाहर नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "Can this tool find or crack a password I don't know?",
        hi: "क्या यह टूल अनजान पासवर्ड ढूँढ़ या क्रैक सकता है?",
      },
      a: {
        en: "No — and no honest tool can. AES-256 has no back door. This tool removes protection only from files you can already open. Only unlock your own files, or ones you have permission to modify.",
        hi: "नहीं — और कोई ईमानदार टूल नहीं कर सकता। AES-256 का कोई बैक डोर नहीं। यह टूल सिर्फ़ उन फ़ाइलों की सुरक्षा हटाता है जो आप खोल सकते हैं। सिर्फ़ अपनी फ़ाइलें, या जिनकी अनुमति हो, उन्हें अनलॉक करें।",
      },
    },
    {
      q: {
        en: "The file opens without a password — why is there a lock on it?",
        hi: "फ़ाइल बिना पासवर्ड खुलती है — फिर उस पर लॉक क्यों है?",
      },
      a: {
        en: "Those files carry an empty open password but a set of owner restrictions — printing, copying or editing disabled. Leave the password field empty here and run: the restrictions are stripped while everything else stays identical.",
        hi: "ऐसी फ़ाइलों में ओपन पासवर्ड ख़ाली होता है पर ओनर पाबंदियाँ होती हैं — प्रिंट, कॉपी या एडिट बंद। यहाँ पासवर्ड ख़ाली छोड़कर चलाएँ: पाबंदियाँ हट जाती हैं, बाकी सब वैसा ही रहता है।",
      },
    },
    {
      q: {
        en: "Will unlocking degrade the file?",
        hi: "क्या अनलॉक करने से फ़ाइल ख़राब होती है?",
      },
      a: {
        en: "No. Pages are copied as-is and forms with their filled values survive. Only the encryption wrapper is rebuilt away.",
        hi: "नहीं। पेज वैसे ही कॉपी होते हैं और भरे फ़ॉर्म भी बचते हैं। सिर्फ़ एन्क्रिप्शन का आवरण हटता है।",
      },
    },
  ],
};
