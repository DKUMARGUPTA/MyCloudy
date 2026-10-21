import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create resume (CR-66 — the 66th tool). ATS-friendly resume builder,
 * 100% on-device (mode D), EN + हिंदी.
 *
 * The surface (tools/create-resume/surface.tsx) owns the whole
 * workspace: template picker (classic / modern / compact), header +
 * optional circle-cropped photo, all eight section kinds with ▲▼
 * reorder, and the live A4/Letter preview at exact pt geometry. The
 * export spawns the worker (create-invoice pattern) which draws the
 * same content as a true vector PDF via pdf-lib.
 *
 * Honest ATS notes (mirrored in the FAQ):
 *  - every glyph is REAL selectable text — bullets are "• " text
 *    lines, never images;
 *  - contact details are icon-free plain lines;
 *  - the photo is optional (leave it off for the strictest ATS);
 *  - classic template ignores the accent colour (near-black only);
 *  - 2 languages: English + हिंदी (Devanagari → embedded Noto subset).
 */
export const config: ToolConfig = {
  toolId: "create-resume",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 0,
  fullWidthSurface: true,
  landingSurface: true,
  options: [],
  howKeys: ["resume.how1", "resume.how2", "resume.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Three ATS-safe templates — Classic (single column, near-black, pure parser-friendly), Modern (accent sidebar with contact and skills), and Compact (dense, 2-page friendly) — on A4 or US Letter.",
      hi: "तीन ATS-सुरक्षित टेम्पलेट — क्लासिक (एक कॉलम, गह़रा काला, पार्सर-फ्रेंडली), मॉडर्न (संपर्क और कौशल वाली एक्सेंट साइडबार) और कॉम्पैक्ट (सघन, 2-पेज फ़्रेंडली) — A4 या US लेटर पर।",
    },
    {
      en: "Every word in the PDF is real selectable text — bullets are \"• \" text lines, never images — so ATS parsers and recruiters can copy and search everything.",
      hi: "PDF का हर शब्द असली चुनने योग्य टेक्स्ट है — बुलेट \"• \" टेक्स्ट लाइनें हैं, तस्वीर नहीं — इसलिए ATS पार्सर और HR हर चीज़ कॉपी और सर्च कर सकते हैं।",
    },
    {
      en: "Eight section kinds — summary, experience, education, skills, projects, certifications, languages and custom — reorder them with ▲▼, add or remove anything, in English or real हिंदी.",
      hi: "आठ तरह के सेक्शन — सारांश, अनुभव, शिक्षा, कौशल, परियोजनाएँ, प्रमाणपत्र, भाषाएँ और अन्य — ▲▼ से क्रम बदलें, कुछ भी जोड़ें या हटाएँ, अंग्रेज़ी या असली हिंदी में।",
    },
    {
      en: "Optional circular photo (iPhone HEIC works), auto page-break estimate before you export, a test-render mode that shows the true PDF, and your resumes stay on this device — drafts plus up to 30 named saves in this browser.",
      hi: "वैकल्पिक गोल फ़ोटो (iPhone की HEIC भी चलती है), एक्सपोर्ट से पहले पेज-संख्या का अनुमान, असली PDF दिखाना वाला टेस्ट-रेंडर मोड, और आपके रिज़्यूमे इसी डिवाइस पर रहते हैं — ड्राफ़्ट और 30 नाम से सेव इसी ब्राउज़र में।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will this resume pass ATS (applicant tracking systems)?",
        hi: "क्या यह रिज़्यूमे ATS (आवेदन ट्रैकिंग सिस्टम) पास करेगा?",
      },
      a: {
        en: "The PDF text is fully selectable and searchable — never screenshots of words. The Classic template is the safest: one column, standard fonts, no colours except near-black, plain text contact lines with no icons, and no letter-spaced headings. The photo is optional; leave it off for the strictest systems. Modern's sidebar is still real text, but if a recruiter asks for the most conservative file, export Classic.",
        hi: "PDF का टेक्स्ट पूरी तरह चुनने और सर्च करने योग्य है — कभी शब्दों के स्क्रीनशॉट नहीं। क्लासिक टेम्पलेट सबसे सुरक्षित है: एक कॉलम, स्टैंडर्ड फ़ॉन्ट, गह़रे काले के अलावा कोई रंग नहीं, बिना आइकन की सादी संपर्क पंक्तियाँ, और बिना लेटर-स्पेसिंग वाले शीर्षक। फ़ोटो वैकल्पिक है; सबसे सख़्त सिस्टम के लिए उसे हटा दें। मॉडर्न की साइडबार भी असली टेक्स्ट ही है, पर अगर HR सबसे रूढ़िवादी फ़ाइल माँगे तो क्लासिक एक्सपोर्ट करें।",
      },
    },
    {
      q: {
        en: "How do the two languages work?",
        hi: "दोनों भाषाएँ कैसे काम करती हैं?",
      },
      a: {
        en: "Switch the app language (top of the site) and every button, label and date follows — Hindi resumes print months like जन 2021 – मार्च 2023 and \"वर्तमान\" for current roles. Latin-only content is exported with the built-in Helvetica (no font embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset. The Noto face ships Regular only, so Hindi headings get their hierarchy from size and rules instead of bold.",
        hi: "साइट की भाषा बदलें (ऊपर) और हर बटन, लेबल और तिथि उसी भाषा में हो जाती है — हिंदी रिज़्यूमे में महीने जन 2021 – मार्च 2023 जैसे छपते हैं और चालू नौकरी के लिए \"वर्तमान\"। सिर्फ़ लैटिन सामग्री बिल्ट-इन Helvetica से निकलती है (कोई फ़ॉन्ट एम्बेड नहीं, छोटी फ़ाइल); कोई भी देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है। Noto फ़ेस में केवल Regular है, इसलिए हिंदी शीर्षकों का आकर्षण आकार और रेखाओं से आता है, बोल्ड से नहीं।",
      },
    },
    {
      q: {
        en: "Is the photo safe to include?",
        hi: "फ़ोटो लगाना ठीक है?",
      },
      a: {
        en: "It is entirely optional and never replaces text. The photo is embedded once as a PNG image with a transparent circular crop — nothing else about the page changes, and removing it is one click. Many ATS setups ignore images anyway; if a job posting says \"no photo\", simply remove it and export again.",
        hi: "यह पूरी तरह वैकल्पिक है और कभी टेक्स्ट की जगह नहीं लेती। फ़ोटो पारदर्शी गोल क्रॉप के साथ एक बार PNG इमेज के रूप में जुड़ती है — पेज की बाकी कुछ नहीं बदलता, और हटाना एक क्लिक है। कई ATS वैसे भी इमेज नज़रअंदाज़ करते हैं; अगर नौकरी के विज्ञापन में \"बिना फ़ोटो\" लिखा हो तो बस हटाकर दोबारा एक्सपोर्ट करें।",
      },
    },
    {
      q: {
        en: "Where is my data stored, and what are the limits?",
        hi: "मेरा डेटा कहाँ सेव होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Nowhere but this browser: the draft auto-saves to local storage (dp_resume), up to 30 named copies live beside it, and the PDF is assembled on your device by a worker thread — no server, no sign-up, no watermark. Limits: 16 sections, 40 items per section, 12 bullets per role, 12 skill groups, and a photo up to 300 px; the page-count badge is an honest estimate from the same layout math the PDF uses.",
        hi: "सिर्फ़ इसी ब्राउज़र में: ड्राफ़्ट अपने आप लोकल स्टोरेज (dp_resume) में सेव होता है, साथ में 30 नाम की प्रतियाँ रहती हैं, और PDF एक वर्कर थ्रेड आपके ही डिवाइस पर बनाता है — न सर्वर, न साइन-अप, न वॉटरमार्क। सीमाएँ: 16 सेक्शन, हर सेक्शन में 40 आइटम, हर अनुभव में 12 बुलेट, 12 कौशल समूह और 300 px तक की फ़ोटो; पेज-संख्या का बैज उसी लेआउट गणित से निकला ईमानदार अनुमान है जिससे PDF बनता है।",
      },
    },
  ],
};
