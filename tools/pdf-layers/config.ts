import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF layers (PHASE-3 batch 4): the Optional Content Group editor —
 * see every layer with its visibility and lock state, toggle it, add
 * top-level or nested layers, delete stale ones. /OCProperties surgery
 * on OUR OWN engine (no pdf.js in the probe, no network, ever).
 */
export const config: ToolConfig = {
  toolId: "pdf-layers",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  chainToolIds: ["view-pdf", "bookmark-pdf", "compress-pdf"],
  howKeys: ["pl.how1", "pl.how2", "pl.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Every layer listed with its visibility and lock state — CAD exports and design files read at a glance.",
      hi: "हर लेयर अपनी दिखने की हालत और लॉक के साथ — CAD एक्सपोर्ट और डिज़ाइन फ़ाइलें एक नज़र में।",
    },
    {
      en: "Toggle visibility with checkboxes — locked layers (set by the author) stay protected.",
      hi: "चेकबॉक्स से दिखाएँ-छिपाएँ — लेखक ने जिन्हें लॉक किया है वे सुरक्षित रहते हैं।",
    },
    {
      en: "Add new layers — top-level or nested under an existing parent.",
      hi: "नई लेयर जोड़ें — सबसे ऊपर या किसी मौजूदा पैरेंट के नीचे।",
    },
    {
      en: "Delete layers you no longer need before sharing the template.",
      hi: "टेम्पलेट साझा करने से पहले बेकार लेयर मिटा दें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "My PDF has no layers — can I add some here?",
        hi: "मेरी PDF में लेयर नहीं हैं — क्या यहाँ जोड़ सकते हैं?",
      },
      a: {
        en: "You can create the layer list, yes — but content only belongs to a layer when it is drawn with that layer's marker, which authoring tools do at export time. Useful layer toggling needs the layers to already exist in the file.",
        hi: "लेयर की सूची बना सकते हैं, हाँ — पर कोई सामग्री तभी लेयर की होती है जब वह उस लेयर के चिह्न के साथ बनी हो, जो बनाने वाले टूल एक्सपोर्ट के वक़्त लगाते हैं। मतलबी टॉगल के लिए लेयर फ़ाइल में पहले से होनी चाहिए।",
      },
    },
    {
      q: {
        en: "What does the lock icon mean?",
        hi: "लॉक का निशान क्या मतलब है?",
      },
      a: {
        en: "The document's author locked that layer's visibility state. Every honest viewer respects it — so this editor shows the lock and keeps the checkbox disabled.",
        hi: "दस्तावेज़ के लेखक ने उस लेयर की दिखने की हालत लॉक कर दी है। हर ईमानदार व्यूअर इसे मानता है — इसलिए यह एडिटर लॉक दिखाता है और चेकबॉक्स बंद रखता है।",
      },
    },
    {
      q: {
        en: "Where do layers usually come from?",
        hi: "लेयर आम तौर पर कहाँ से आती हैं?",
      },
      a: {
        en: "CAD drawings, Illustrator/Inkscape exports, maps and engineering documents. Most Word-to-PDF or scan files have none — the editor will say so honestly.",
        hi: "CAD चित्रों, Illustrator/Inkscape एक्सपोर्ट, नक़्शों और इंजीनियरिंग दस्तावेज़ों से। आम Word-to-PDF या स्कैन फ़ाइलों में नहीं होतीं — एडिटर ईमानदारी से बता देगा।",
      },
    },
  ],
};
