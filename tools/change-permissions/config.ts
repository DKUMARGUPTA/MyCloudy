import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Change PDF permissions (P1-c) — the restrictions-only lock. The file
 * opens for everyone (NO open password) but carries your permission set:
 * what may be printed, copied, edited, annotated, filled or assembled.
 * The owner password (required — the engine refuses password-less
 * restrictions, and they would be meaningless) keeps others from lifting
 * them. Own-engine standard security handler (AES-256 default, AES-128
 * for old readers) — the same core lock-pdf runs on. On-device only.
 */
export const config: ToolConfig = {
  toolId: "change-permissions",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "text",
      id: "ownerPassword",
      label: { en: "Owner password", hi: "ओनर पासवर्ड" },
      hint: {
        en: "Guards these restrictions — only this password can lift them. At least 6 characters.",
        hi: "इन पाबंदियों की रखवाली — सिर्फ़ यही पासवर्ड हटा सकता है। कम से कम 6 अक्षर।",
      },
      placeholder: { en: "at least 6 characters", hi: "कम से कम 6 अक्षर" },
      default: "",
    },
    {
      kind: "select",
      id: "algorithm",
      label: { en: "Encryption", hi: "एन्क्रिप्शन" },
      hint: {
        en: "AES-256 is the modern default. AES-128 only for very old readers (A–Z passwords).",
        hi: "AES-256 आधुनिक डिफ़ॉल्ट। AES-128 सिर्फ़ बहुत पुराने रीडर के लिए (A–Z पासवर्ड)।",
      },
      choices: [
        { value: "aes256", label: { en: "AES-256 (recommended)", hi: "AES-256 (सलाह)" } },
        { value: "aes128", label: { en: "AES-128 (legacy)", hi: "AES-128 (पुराना)" } },
      ],
      default: "aes256",
    },
    {
      kind: "select",
      id: "permPrinting",
      label: { en: "Printing", hi: "प्रिंटिंग" },
      choices: [
        {
          value: "highResolution",
          label: { en: "Allowed — high quality", hi: "अनुमत — उच्च गुणवत्ता" },
        },
        {
          value: "lowResolution",
          label: { en: "Allowed — low quality only", hi: "अनुमत — केवल निम्न गुणवत्ता" },
        },
        { value: "notAllowed", label: { en: "Not allowed", hi: "अनुमत नहीं" } },
      ],
      default: "highResolution",
    },
    {
      kind: "switch",
      id: "permCopy",
      label: { en: "Copy text and images", hi: "टेक्स्ट/तस्वीर कॉपी" },
      default: true,
    },
    {
      kind: "switch",
      id: "permModify",
      label: { en: "Edit content", hi: "कंटेंट एडिट" },
      default: false,
    },
    {
      kind: "switch",
      id: "permAnnotate",
      label: { en: "Comments and highlights", hi: "टिप्पणी और हाइलाइट" },
      default: true,
    },
    {
      kind: "switch",
      id: "permForms",
      label: { en: "Fill form fields", hi: "फ़ॉर्म भरना" },
      default: true,
    },
    {
      kind: "switch",
      id: "permAccess",
      label: { en: "Screen-reader access", hi: "स्क्रीन-रीडर एक्सेस" },
      hint: {
        en: "Accessibility extraction — please keep this on.",
        hi: "एक्सेसिबिलिटी निकासी — इसे चालू रखें।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "permAssemble",
      label: { en: "Assemble pages (insert, rotate, delete)", hi: "पेज जोड़ना-घुमाना-हटाना" },
      default: false,
    },
  ],
  chainToolIds: ["unlock-pdf", "view-metadata"],
  features: [
    {
      en: "Restrict without locking people out — the file opens normally, the permissions ride along.",
      hi: "बिना बंद किए पाबंदी — फ़ाइल सामान्य खुलती है, अनुमतियाँ साथ चलती हैं।",
    },
    {
      en: "Seven separate rights: print quality, copy, edit, comment, fill forms, accessibility, assemble.",
      hi: "सात अलग अधिकार: प्रिंट क्वालिटी, कॉपी, एडिट, टिप्पणी, फ़ॉर्म, एक्सेसिबिलिटी, असेंबली।",
    },
    {
      en: "An owner password guards the set — only you can lift the restrictions later.",
      hi: "ओनर पासवर्ड की रखवाली — पाबंदियाँ बाद में सिर्फ़ आप ही हटा सकते हैं।",
    },
    {
      en: "AES-256 standard security handler — the same core the Lock PDF tool runs on.",
      hi: "AES-256 स्टैंडर्ड सिक्योरिटी हैंडलर — वही कोर जिस पर Lock PDF चलता है।",
    },
    {
      en: "Runs entirely on your device — the PDF and passwords are never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF और पासवर्ड कहीं अपलोड नहीं होते।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from Lock PDF?",
        hi: "यह Lock PDF से कैसे अलग है?",
      },
      a: {
        en: "Lock PDF adds an open password — nobody sees the file without it. Change permissions only sets restrictions: everyone can read, but printing/copying/editing follow your rules. Use Lock for secrecy, this for control.",
        hi: "Lock PDF ओपन पासवर्ड लगाता है — पासवर्ड के बिना कोई फ़ाइल देख ही नहीं सकता। Change permissions सिर्फ़ पाबंदियाँ लगाता है: सब पढ़ सकते हैं, पर प्रिंट/कॉपी/एडिट आपके नियम से। गोपनीयता के लिए Lock, नियंत्रण के लिए यह।",
      },
    },
    {
      q: {
        en: "Can restrictions actually stop someone from copying?",
        hi: "क्या पाबंदियाँ सच में कॉपी रोकती हैं?",
      },
      a: {
        en: "Honest answer: well-behaved readers (Acrobat, Chrome, Preview) enforce them, and they stop casual copying. A determined person with special tools can bypass permission flags — that is a PDF-format reality, not a weakness of this tool. Keep the owner password safe: it is the only way to lift the restrictions.",
        hi: "ईमानदार जवाब: अच्छे रीडर (Acrobat, Chrome, Preview) इन्हें मानते हैं और आम कॉपी रुक जाती है। ज़िद्दी आदमी ख़ास टूल से पाबंदियाँ बायपास कर सकता है — यह PDF फ़ॉर्मैट की सच्चाई है, टूल की कमज़ोरी नहीं। ओनर पासवर्ड सुरक्षित रखें: पाबंदियाँ हटाने का यही एक रास्ता है।",
      },
    },
    {
      q: {
        en: "Why can't I change permissions of a file that is already protected?",
        hi: "पहले से सुरक्षित फ़ाइल की अनुमतियाँ बदल क्यों नहीं सकते?",
      },
      a: {
        en: "Because that would need the current owner's password — changing someone else's restrictions would break the whole point. Unlock it first (with the password you know), then apply your own set.",
        hi: "क्योंकि उसके लिए मौजूदा ओनर का पासवर्ड चाहिए — किसी और की पाबंदियाँ बदलना पूरे उद्देश्य के ख़िलाफ़ है। पहले अनलॉक करें (अपना पासवर्ड लेकर), फिर अपना सेट लगाएँ।",
      },
    },
  ],
};
