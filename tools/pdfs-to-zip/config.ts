import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDFs to ZIP — bundle many PDFs into one archive (P1-c output pack).
 *
 * Own ZIP engine (src/lib/own/zip — the same fflate-surface writer the
 * pptx/repair family uses), STORE by default: PDFs are already deflated
 * inside, so storing is instant and byte-exact; a deflate level is there
 * for files that profit from it. 100% on-device.
 */
export const config: ToolConfig = {
  toolId: "pdfs-to-zip",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "zip",
  minFiles: 2,
  maxFiles: 20,
  options: [
    {
      kind: "select",
      id: "compression",
      label: { en: "Compression", hi: "कंप्रेशन" },
      hint: {
        en: "Store is instant — PDFs are already compressed inside. Deflate squeezes a little more.",
        hi: "Store तुरंत है — PDF अंदर से ही कंप्रेस्ड होती है। Deflate थोड़ा और निचोड़ता है।",
      },
      choices: [
        {
          value: "store",
          label: { en: "Store — instant, exact bytes", hi: "Store — तुरंत, असली बाइट्स" },
        },
        {
          value: "deflate",
          label: { en: "Deflate — smallest ZIP", hi: "Deflate — सबसे छोटा ZIP" },
        },
      ],
      default: "store",
    },
  ],
  features: [
    {
      en: "Pack 2–20 PDFs into a single ZIP — one download instead of a dozen.",
      hi: "2–20 PDF को एक ZIP में — दर्जन डाउनलोड की जगह एक।",
    },
    {
      en: "Store mode keeps every byte exactly as uploaded — instant, zero risk.",
      hi: "Store मोड हर बाइट वैसी ही रखता है — तुरंत, ज़ीरो रिस्क।",
    },
    {
      en: "Same-name files never clash — the second one becomes name-2.pdf automatically.",
      hi: "एक जैसे नाम कभी नहीं टकराते — दूसरी फ़ाइल अपने आप name-2.pdf बन जाती है।",
    },
    {
      en: "Encrypted or signed PDFs ride through untouched — nothing is opened or re-saved.",
      hi: "लॉक या साइन की PDF जस की तस — कुछ खोला या दोबारा सेव नहीं होता।",
    },
    {
      en: "Runs entirely on your device — the files are never uploaded.",
      hi: "पूरा काम डिवाइस पर — फ़ाइलें कहीं अपलोड नहीं होतीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does zipping compress my PDFs?",
        hi: "क्या ZIP करने से PDF छोटी हो जाती है?",
      },
      a: {
        en: "Usually not much — a PDF is already compressed internally, which is why Store (the default) is the honest choice: it is instant and keeps every byte identical. Pick Deflate when you know your PDFs carry uncompressed scans inside.",
        hi: "आमतौर पर ज़्यादा नहीं — PDF अंदर से ही कंप्रेस्ड होती है, इसलिए Store (डिफ़ॉल्ट) सही रहता है: तुरंत और हर बाइट वैसी ही। Deflate तब चुनें जब पता हो कि PDF में बिना-कंप्रेस वाले स्कैन हैं।",
      },
    },
    {
      q: {
        en: "Can I ZIP password-protected PDFs?",
        hi: "क्या पासवर्ड वाली PDF ZIP कर सकते हैं?",
      },
      a: {
        en: "Yes. Nothing is opened or decrypted — the archive just carries the locked files as they are, ready to share with people who have the password.",
        hi: "हाँ। कुछ खोला या डिक्रिप्ट नहीं होता — ZIP में लॉक फ़ाइलें वैसी ही चलती हैं, जिनके पास पासवर्ड है उनके लिए।",
      },
    },
    {
      q: {
        en: "What happens with two files named report.pdf?",
        hi: "दोनों का नाम report.pdf हो तो?",
      },
      a: {
        en: "The second one is renamed to report-2.pdf inside the archive automatically (the third becomes report-3.pdf) — no overwrite, no surprise.",
        hi: "दूसरी फ़ाइल अपने आप report-2.pdf हो जाती है (तीसरी report-3.pdf) — न घिरना, न चौंकाना।",
      },
    },
  ],
};
