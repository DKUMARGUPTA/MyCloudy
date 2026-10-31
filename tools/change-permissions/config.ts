import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Change PDF permissions (PHASE-1 Batch C): restrict what readers can do
 * — printing, copying, editing, annotating — without adding an
 * open-password. The document stays free to open; the restrictions ride
 * an owner password you choose (or a random one we generate, so nobody
 * can quietly lift them).
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
      kind: "select",
      id: "printing",
      label: { en: "Printing", hi: "प्रिंटिंग" },
      choices: [
        { value: "high", label: { en: "Allowed — full quality", hi: "मंज़ूर — पूरी क्वालिटी" } },
        { value: "low", label: { en: "Low resolution only", hi: "सिर्फ़ कम रेज़ोल्यूशन" } },
        { value: "none", label: { en: "Blocked", hi: "रोकी गई" } },
      ],
      default: "high",
    },
    {
      kind: "switch",
      id: "copying",
      label: { en: "Allow copying text & images", hi: "टेक्स्ट और तस्वीरें कॉपी करने दें" },
      default: true,
    },
    {
      kind: "switch",
      id: "modifying",
      label: { en: "Allow editing content", hi: "सामग्री संपादित करने दें" },
      default: false,
    },
    {
      kind: "switch",
      id: "annotating",
      label: { en: "Allow comments & annotations", hi: "टिप्पणियाँ और एनोटेशन देने दें" },
      default: true,
    },
    {
      kind: "switch",
      id: "fillingForms",
      label: { en: "Allow filling form fields", hi: "फ़ॉर्म फ़ील्ड भरने दें" },
      default: true,
    },
    {
      kind: "text",
      id: "ownerPassword",
      label: { en: "Owner password (optional)", hi: "ओनर पासवर्ड (वैकल्पिक)" },
      hint: {
        en: "Needed to LIFT the restrictions later. Leave empty and we generate a random one — the file still opens freely.",
        hi: "बाद में पाबंदियाँ हटाने के लिए चाहिए। खाली छोड़ें तो हम यादृच्छिक बनाते हैं — फ़ाइल फिर भी खुली रहती है।",
      },
      placeholder: { en: "e.g. my-secret-2024", hi: "जैसे my-secret-2024" },
      default: "",
    },
  ],
  chainToolIds: ["lock-pdf", "unlock-pdf", "sanitize-pdf"],
  features: [
    {
      en: "Block printing, copying or editing — while the PDF still opens for everyone.",
      hi: "प्रिंट, कॉपी या संपादन रोकें — जबकि PDF सबके लिए खुलती रहे।",
    },
    {
      en: "Fine-grained switches: printing quality, copying, editing, comments, forms.",
      hi: "बारीक कंट्रोल: प्रिंट क्वालिटी, कॉपी, संपादन, टिप्पणियाँ, फ़ॉर्म।",
    },
    {
      en: "AES-256 encryption under the hood — the same standard our Lock tool uses.",
      hi: "अंदर AES-256 एन्क्रिप्शन — वही मानक जो हमारा Lock टूल इस्तेमाल करता है।",
    },
    {
      en: "Owner password optional — empty means we generate a random one for you.",
      hi: "ओनर पासवर्ड वैकल्पिक — खाली का मतलब हम आपके लिए यादृच्छिक बनाते हैं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What's the difference from Lock PDF?",
        hi: "Lock PDF से यह कैसे अलग है?",
      },
      a: {
        en: "Lock PDF adds an OPEN password — nobody sees the file without it. Change permissions keeps the file open for everyone but restricts what they can DO: print, copy, edit, comment. Many workflows need exactly this half.",
        hi: "Lock PDF ओपन पासवर्ड लगाता है — उसके बिना कोई फ़ाइल देख ही नहीं सकता। Change permissions फ़ाइल सबके लिए खुली रखता है पर सीमाता है कि लोग क्या कर सकते हैं: प्रिंट, कॉपी, संपादन, टिप्पणी। कई कामों को ठीक यही आधा हिस्सा चाहिए।",
      },
    },
    {
      q: {
        en: "Can readers remove these restrictions?",
        hi: "क्या पढ़ने वाले ये पाबंदियाँ हटा सकते हैं?",
      },
      a: {
        en: "Lifting them needs the owner password. If you leave it empty we generate a strong random one (shown nowhere — write nothing down, the file simply cannot be un-restricted casually). Keep your own copy if you may need to lift them later.",
        hi: "हटाने के लिए ओनर पासवर्ड चाहिए। खाली छोड़ने पर हम मज़बूत यादृच्छिक पासवर्ड बनाते हैं (कहीं नहीं दिखता — आराम से पाबंदी हटाई नहीं जा सकती)। बाद में हटाना हो तो अपनी कॉपी रखें।",
      },
    },
    {
      q: {
        en: "Do permissions work in every viewer?",
        hi: "क्या पाबंदियाँ हर व्यूअर में चलती हैं?",
      },
      a: {
        en: "They are part of the PDF security standard, so mainstream viewers (Acrobat, Preview, browsers) honour them. They are cooperation-enforced, not unbreakable — a determined expert can bypass them, so treat them as policy, not absolute secrecy.",
        hi: "ये PDF सुरक्षा मानक का हिस्सा हैं, इसलिए बड़े व्यूअर (Acrobat, Preview, ब्राउज़र) मानते हैं। ये सहयोग-आधारित हैं, अभेद्य नहीं — ज़िद्दी माहिर उन्हें तोड़ सकता है, इसलिए इन्हें नीति समझें, पूर्ण गोपनीयता नहीं।",
      },
    },
  ],
};
