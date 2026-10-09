import type { ToolConfig } from "@/lib/tools/config-types";
import { signatureAssetFiles } from "./signature-store";

/**
 * Sign PDF config (PRD §7.6 "Sign PDF (visual signature)").
 *
 * The split-tool pattern: the schema holds no fields — the interactive
 * surface owns every placement ("p:<fileId>" JSON option) and ships the
 * signature PNGs to the worker via collectAssets, so no image data ever
 * rides the options or the network.
 */
export const config: ToolConfig = {
  toolId: "sign-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  chainToolIds: ["compress-pdf", "lock-pdf", "view-pdf"],
  collectAssets: () => signatureAssetFiles(),
  features: [
    {
      en: "Draw your signature with mouse, touch or stylus — or type it in five handwriting styles, including a Hindi font.",
      hi: "माउस, टच या स्टाइलस से हस्ताक्षर बनाएँ — या पाँच हैंडराइटिंग स्टाइल में टाइप करें, हिंदी फ़ॉन्ट समेत।",
    },
    {
      en: "Click the page to place, then drag, resize and rotate your signature exactly where it belongs.",
      hi: "पेज पर क्लिक करके लगाएँ, फिर खींचें, छोटा-बड़ा करें और घुमाएँ — बिल्कुल वहीं जहाँ चाहिए।",
    },
    {
      en: "Quick stamps for date, name, initials and checkmarks — initials on every page in one tap.",
      hi: "तारीख़, नाम, इनिशियल और टिक के तुरंत स्टैम्प — एक टैप में हर पेज पर इनिशियल।",
    },
    {
      en: "Upload a photo or scan of your signature — the white background is removed automatically.",
      hi: "हस्ताक्षर की फ़ोटो या स्कैन अपलोड करें — सफ़ेद बैकग्राउंड अपने-आप हट जाता है।",
    },
    {
      en: "Signatures are flattened into the page — permanent and visible in every PDF reader.",
      hi: "हस्ताक्षर पेज में हमेशा के लिए जुड़ जाता है — हर PDF रीडर में दिखता है।",
    },
    {
      en: "Your signature library stays in this browser's storage — the document never leaves your device.",
      hi: "आपकी हस्ताक्षर लाइब्रेरी इसी ब्राउज़र में रहती है — दस्तावेज़ डिवाइस से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is this a legally valid signature?",
        hi: "क्या यह कानूनी रूप से मान्य हस्ताक्षर है?",
      },
      a: {
        en: "It creates a visual (electronic) signature — the same as printing, signing and scanning. For most everyday documents (forms, applications, letters) this is widely accepted. Digitally certified signatures (PAdES) with tamper-proof certificates arrive in a later phase.",
        hi: "यह विज़ुअल (इलेक्ट्रॉनिक) हस्ताक्षर बनाता है — जैसे प्रिंट करके, साइन करके स्कैन करना। रोज़मर्रा के दस्तावेज़ों (फ़ॉर्म, आवेदन, पत्र) के लिए यह व्यापक रूप से मान्य है। टैम्पर-प्रूफ़ सर्टिफ़िकेट वाले डिजिटल हस्ताक्षर (PAdES) बाद के फ़ेज़ में आएँगे।",
      },
    },
    {
      q: {
        en: "Where are my saved signatures stored?",
        hi: "मेरे सेव किए हस्ताक्षर कहाँ रहते हैं?",
      },
      a: {
        en: "Only in this browser's local storage on your device — they are never uploaded anywhere. You can remove them from the signature tray at any time.",
        hi: "सिर्फ़ इसी ब्राउज़र के लोकल स्टोरेज में, आपके डिवाइस पर — कहीं अपलोड नहीं होते। हस्ताक्षर ट्रे से कभी भी हटा सकते हैं।",
      },
    },
    {
      q: {
        en: "Can I sign one document for several people?",
        hi: "एक दस्तावेज़ पर कई लोगों के हस्ताक्षर कर सकते हैं?",
      },
      a: {
        en: "Yes — add several signatures to your library and place each one independently. Every signature can go on different pages, at its own size and rotation.",
        hi: "हाँ — लाइब्रेरी में कई हस्ताक्षर जोड़ें और हर एक अलग-अलग रखें। हर हस्ताक्षर अलग पेजों पर, अपने आकार और घुमाव के साथ जा सकता है।",
      },
    },
  ],
};
