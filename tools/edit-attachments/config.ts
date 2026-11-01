import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Edit attachments (PHASE-3 batch 2): rename and delete the files embedded
 * inside a PDF. The surface probe lists them (pdf.js), the worker is the
 * authority (own-engine /Names tree surgery — re-walked, ops applied by
 * position). Sibling name trees are preserved; deletions drop the entries
 * from the rebuilt flat tree.
 */
export const config: ToolConfig = {
  toolId: "edit-attachments",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  chainToolIds: ["extract-attachments", "add-attachments", "view-pdf"],
  howKeys: ["edat.how1", "edat.how2", "edat.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Rename embedded files in place — fix names that arrived mangled or meaningless.",
      hi: "अंदर जुड़ी फ़ाइलों के नाम वहीं बदलें — बिगड़े या बेमतलब नाम ठीक करें।",
    },
    {
      en: "Delete attachments you no longer need — they disappear from every viewer's panel.",
      hi: "न चाहिए अटैचमेंट मिटाएँ — हर व्यूअर के पैनल से ग़ायब हो जाते हैं।",
    },
    {
      en: "The list loads automatically from the file itself — nothing to type from memory.",
      hi: "सूची फ़ाइल से अपने आप भरती है — याददाश्त से कुछ टाइप नहीं करना।",
    },
    {
      en: "Everything stays on your device — the PDF never leaves the browser.",
      hi: "सब कुछ डिवाइस पर — PDF ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What happens to the attached file's contents when I rename it?",
        hi: "नाम बदलने पर जुड़ी फ़ाइल की सामग्री का क्या होता है?",
      },
      a: {
        en: "Nothing — only the label changes. The embedded bytes are untouched, so the file opens exactly as before under its new name.",
        hi: "कुछ नहीं — सिर्फ़ नाम बदलता है। अंदर की फ़ाइल वैसी की वैसी रहती है, नए नाम से भी पहले जैसी ही खुलती है।",
      },
    },
    {
      q: {
        en: "Does deleting an attachment make the PDF smaller?",
        hi: "अटैचमेंट मिटाने से PDF छोटी हो जाती है?",
      },
      a: {
        en: "Usually yes once the entry is gone from the name tree. Run Compress PDF afterwards for a final cleanup pass if size matters.",
        hi: "आम तौर पर हाँ, जब एंट्री नेम-ट्री से हट जाती है। साइज़ ज़रूरी हो तो बाद में PDF कंप्रेस कर लें।",
      },
    },
    {
      q: {
        en: "Can I add brand-new attachments here too?",
        hi: "क्या यहीं नई फ़ाइलें भी जोड़ सकते हैं?",
      },
      a: {
        en: "Use Add attachments for that — it accepts any files and rides them inside. This tool edits what is already embedded.",
        hi: "उसके लिए अटैचमेंट जोड़ें टूल चुनें — कोई भी फ़ाइल अंदर जुड़ जाती है। यह टूल पहले से जुड़ी चीज़ें संपादित करता है।",
      },
    },
  ],
};
