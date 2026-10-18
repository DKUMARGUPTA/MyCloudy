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
  chainToolIds: ["view-pdf", "fill-out-pdf", "compress-pdf", "lock-pdf"],
  collectAssets: () => collectRunAssets(),
  features: [
    {
      en: "Edit text already on the page — click any line to retype it with a matched font (Hindi too), or find & replace across the document",
      hi: "पेज पर पहले से लिखा टेक्स्ट सुधारें — किसी भी लाइन पर क्लिक करके मिलते फ़ॉन्ट से नए सिरे से लिखें (हिंदी भी), या पूरे दस्तावेज़ में खोजें और बदलें",
    },
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
      en: "Add fillable form fields — text boxes, checkboxes, dropdowns and radio groups with names, defaults and required flags",
      hi: "भरने योग्य फ़ॉर्म फ़ील्ड जोड़ें — टेक्स्ट बॉक्स, चेकबॉक्स, ड्रॉपडाउन और रेडियो ग्रुप, नाम, डिफ़ॉल्ट और अनिवार्य फ़्लैग के साथ",
    },
    {
      en: "Sign with your finger — draw a signature and drop it on the page; full undo/redo, 100% on-device",
      hi: "उँगली से साइन करें — हस्ताक्षर बनाकर पेज पर रखें; पूरा अनडू/रीडू, 100% ऑन-डिवाइस",
    },
  ],
  faq: [
    {
      q: {
        en: "Can I change text that is already in the PDF?",
        hi: "क्या PDF में पहले से लिखा टेक्स्ट बदल सकता हूँ?",
      },
      a: {
        en: "Yes — pick the Edit existing text tool and click any line on the page. The original words are covered with a box matching the page background and retyped in the same spot with the closest matching font. Editing works line by line (paragraphs don't reflow), and scanned pages need OCR first.",
        hi: "हाँ — 'मौजूदा टेक्स्ट सुधारें' टूल चुनकर पेज की किसी भी लाइन पर क्लिक करें। पुराने शब्द पेज के बैकग्राउंड से मिलते रंग के डिब्बे से ढक जाते हैं और उसी जगह सबसे मिलते-जुलते फ़ॉन्ट से नए सिरे से लिखे जाते हैं। एडिटिंग लाइन-दर-लाइन होती है (पैराग्राफ़ रीफ़्लो नहीं), और स्कैन पेजों के लिए पहले OCR चलाएँ।",
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
        en: "Text, shapes, drawings and images are flattened into the page itself — text becomes real PDF text, shapes become vector drawings and images are embedded. Form fields you placed stay live: they export as real fillable AcroForm fields anyone can type into in any PDF reader.",
        hi: "टेक्स्ट, आकृतियाँ, ड्रॉइंग और तस्वीरें पेज में ही मिल जाती हैं — टेक्स्ट असली PDF टेक्स्ट बनता है, आकृतियाँ वेक्टर ड्रॉइंग और तस्वीरें एम्बेड होती हैं। आपके रखे फ़ॉर्म फ़ील्ड ज़िंदा रहते हैं: वे असली भरने योग्य AcroForm फ़ील्ड बनते हैं जिन्हें कोई भी PDF रीडर में भर सकता है।",
      },
    },
  ],
};
