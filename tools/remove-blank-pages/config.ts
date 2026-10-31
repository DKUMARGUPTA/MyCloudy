import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove blank pages (PHASE-1 Batch B): detect and delete pages that
 * draw nothing — separator sheets, trailing empties, scanner padding.
 * Conservative by design: a page that shows ANY text, path or image is
 * always kept.
 */
export const config: ToolConfig = {
  toolId: "remove-blank-pages",
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
      id: "strict",
      label: { en: "Also remove pages that draw nothing", hi: "कुछ भी न बनाने वाले पेज भी हटाएँ" },
      hint: {
        en: "Pages whose content sets styles but never shows text or graphics",
        hi: "जो पेज सिर्फ़ स्टाइल सेट करते हैं पर कुछ दिखाते नहीं",
      },
      default: true,
    },
  ],
  chainToolIds: ["merge-pdf", "compress-pdf", "view-pdf"],
  features: [
    {
      en: "Automatically finds and deletes every page that draws nothing.",
      hi: "जो पेज कुछ भी नहीं बनाते, उन्हें अपने आप ढूँढकर हटाता है।",
    },
    {
      en: "Conservative detection — any page with text, graphics or images stays.",
      hi: "सतर्क पहचान — टेक्स्ट, ग्राफ़िक्स या तस्वीर वाला पेज कभी नहीं हटता।",
    },
    {
      en: "Great for scanned stacks with separator sheets and trailing blanks.",
      hi: "स्कैन किए ढेर से खाली सेपरेटर और आख़िरी खाली पेज हटाने के लिए।",
    },
    {
      en: "Smaller files, cleaner documents — content pages untouched.",
      hi: "छोटी फ़ाइल, साफ़ दस्तावेज़ — असली पेज जस के तस।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How does the tool decide a page is blank?",
        hi: "टूल कैसे तय करता है कि पेज खाली है?",
      },
      a: {
        en: "A page is blank when it has no content at all, or when its content never actually draws — no text shown, no path filled or stroked, no image placed. Pages with even one visible mark are always kept.",
        hi: "पेज खाली है जब उसमें कोई कंटेंट ही नहीं, या जब उसका कंटेंट कुछ भी नहीं बनाता — न टेक्स्ट, न भरा/खींचा गया पथ, न तस्वीर। एक भी दिखने वाला निशान हो तो पेज हमेशा बचता है।",
      },
    },
    {
      q: {
        en: "What about pages with only a white rectangle?",
        hi: "सिर्फ़ सफ़ेद आयात वाले पेज का क्या?",
      },
      a: {
        en: "A white rectangle IS drawn content, so those pages are kept. Only truly empty pages (or pages whose operators never draw) are removed.",
        hi: "सफ़ेद आयात बनाया हुआ कंटेंट है, इसलिए वे पेज बचते हैं। सिर्फ़ सच में खाली पेज (या जिनके ऑपरेटर कभी बनाते ही नहीं) हटते हैं।",
      },
    },
    {
      q: {
        en: "Can I undo if too many pages were removed?",
        hi: "क्या ज़्यादा पेज हट जाने पर वापस ले सकते हैं?",
      },
      a: {
        en: "The tool never touches your original file — it saves a new copy. Keep the original until you are happy with the result, or turn off strict mode to remove only fully-empty pages.",
        hi: "टूल आपकी असली फ़ाइल को नहीं छूता — नई कॉपी बनाता है। नतीजे से खुश होने तक असली फ़ाइल रखें, या सख़्त मोड बंद करके सिर्फ़ पूरी तरह खाली पेज हटाएँ।",
      },
    },
  ],
};
