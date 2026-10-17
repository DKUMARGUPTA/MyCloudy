import type { ToolConfig } from "@/lib/tools/config-types";

import { collectRunAssets } from "./asset-store";

/**
 * Edit PDF (PRD §8.2.1, the flagship editor — sub-phases 8.1 shell +
 * 8.2 objects + 8.5 export). The surface (tools/edit-pdf/surface.tsx)
 * is the whole editor: toolbar, thumbnails, canvas, properties, layers.
 *
 * No schema options — the editor's state (objects blob + asset order)
 * rides the dynamic "e:<fileId>" option key (the redact epoch-key
 * pattern) and images ride the run message via collectAssets.
 */
export const config: ToolConfig = {
  toolId: "edit-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  fullWidthSurface: true,
  options: [],
  howKeys: ["editPdf.how1", "editPdf.how2", "editPdf.how3"],
  chainToolIds: ["view-pdf", "compress-pdf", "lock-pdf"],
  collectAssets: () => collectRunAssets(),
  features: [
    {
      en: "Add text anywhere — with fonts for Hindi (Devanagari), size, color, bold and alignment",
      hi: "कहीं भी टेक्स्ट जोड़ें — हिंदी (देवनागरी) फ़ॉन्ट, साइज़, रंग, बोल्ड और अलाइनमेंट के साथ",
    },
    {
      en: "Place images, shapes, arrows and freehand drawings — move, resize and layer them",
      hi: "तस्वीरें, आकृतियाँ, तीर और फ़्रीहैंड ड्रॉइंग रखें — खिसकाएँ, साइज़ बदलें, लेयर करें",
    },
    {
      en: "Whiteout hides anything — cover old content, then type over it",
      hi: "व्हाइटआउट कुछ भी छिपा देता है — पुरानी चीज़ ढककर ऊपर लिखें",
    },
    {
      en: "Sign with your finger — draw a signature and drop it on the page",
      hi: "उँगली से साइन करें — हस्ताक्षर बनाकर पेज पर रखें",
    },
    {
      en: "Full undo/redo, keyboard shortcuts and an objects list — 100% on-device",
      hi: "पूरा अनडू/रीडू, कीबोर्ड शॉर्टकट और ऑब्जेक्ट सूची — 100% ऑन-डिवाइस",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I change text that is already in the PDF?",
        hi: "क्या PDF में पहले से लिखा टेक्स्ट बदल सकता हूँ?",
      },
      a: {
        en: "Use Whiteout to cover the old text, then click the Text tool and type the new words in the same spot — pick a matching font and size. Direct rewriting of embedded text arrives in a coming update.",
        hi: "पुराने टेक्स्ट को व्हाइटआउट से ढकें, फिर टेक्स्ट टूल से उसी जगह नए शब्द लिखें — मिलता फ़ॉन्ट और साइज़ चुनें। मौजूदा टेक्स्ट की सीधी एडिटिंग अगले अपडेट में आ रही है।",
      },
    },
    {
      q: {
        en: "Does my editing stay private?",
        hi: "क्या मेरी एडिटिंग प्राइवेट रहती है?",
      },
      a: {
        en: "Yes — the editor runs entirely in your browser. Pages render locally, objects live in memory, and the final PDF is built by an on-device worker. Nothing is ever uploaded.",
        hi: "हाँ — एडिटर पूरी तरह आपके ब्राउज़र में चलता है। पेज लोकल रेंडर होते हैं, ऑब्जेक्ट मेमोरी में रहते हैं और आख़िरी PDF ऑन-डिवाइस वर्कर से बनता है। कुछ भी अपलोड नहीं होता।",
      },
    },
    {
      q: {
        en: "What happens to my objects when I download?",
        hi: "डाउनलोड करने पर मेरे ऑब्जेक्ट का क्या होता है?",
      },
      a: {
        en: "They are flattened into the page itself — text becomes real PDF text, shapes become vector drawings and images are embedded. The download opens in any PDF reader.",
        hi: "वे पेज में ही मिल जाते हैं — टेक्स्ट असली PDF टेक्स्ट बनता है, आकृतियाँ वेक्टर ड्रॉइंग और तस्वीरें एम्बेड होती हैं। डाउनलोड कोई भी PDF रीडर खोल सकता है।",
      },
    },
  ],
};
