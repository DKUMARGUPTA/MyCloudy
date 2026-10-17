import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Annotate PDF (PRD §8.2 "Highlight / Underline / Strike" + "Sticky
 * note / Comment" — the priority queue's "editor core reuse" round).
 *
 * The surface (tools/annotate-pdf/surface.tsx) is the whole annotator:
 * toolbar, page render, drag-to-highlight machinery, sticky-note
 * bubbles and the comments rail. No schema options — the annotation
 * state rides the dynamic "a:<fileId>" option key (the redact epoch-key
 * pattern) as { annos }.
 */
export const config: ToolConfig = {
  toolId: "annotate-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  fullWidthSurface: true,
  options: [],
  howKeys: ["ann.how1", "ann.how2", "ann.how3"],
  chainToolIds: ["view-pdf", "edit-pdf", "compress-pdf", "lock-pdf"],
  features: [
    {
      en: "Drag over any text to highlight it — snaps to the words underneath, in 5 colours plus your own",
      hi: "किसी भी टेक्स्ट पर ड्रैग करके हाइलाइट करें — पूरे शब्द पर चिपकती है, 5 रंग और अपना रंग भी",
    },
    {
      en: "Underline and strikeout that follow the text lines, not a box you drew",
      hi: "अंडरलाइन और स्ट्राइकआउट टेक्स्ट लाइनों पर चलते हैं, आपके बनाए बॉक्स पर नहीं",
    },
    {
      en: "Sticky notes with a popup bubble — pin your comment anywhere, edit it any time",
      hi: "स्टिकी नोट पॉपअप बबल के साथ — टिप्पणी कहीं भी लगाएँ, कभी भी बदलें",
    },
    {
      en: "Exports REAL PDF annotations — editable and listed in Chrome, Acrobat and every reader",
      hi: "असली PDF टिप्पणियाँ बनती हैं — Chrome, Acrobat हर रीडर में एडिट और सूची में दिखती हैं",
    },
    {
      en: "Full undo/redo, keyboard shortcuts and a comments list — 100% on-device",
      hi: "पूरा अनडू/रीडू, कीबोर्ड शॉर्टकट और टिप्पणियों की सूची — 100% ऑन-डिवाइस",
    },
  ],
  faq: [
    {
      q: {
        en: "Are these real PDF annotations?",
        hi: "क्या ये असली PDF टिप्पणियाँ हैं?",
      },
      a: {
        en: "Yes. Highlights, underlines, strikeouts and sticky notes are written as standard PDF annotation objects — you can open the file in Chrome, Acrobat or any reader and edit, reply to or delete them there.",
        hi: "हाँ। हाइलाइट, अंडरलाइन, स्ट्राइकआउट और स्टिकी नोट स्टैंडर्ड PDF टिप्पणी ऑब्जेक्ट बनकर लिखे जाते हैं — फ़ाइल को Chrome, Acrobat या किसी रीडर में खोलकर वहीं बदल या हटा सकते हैं।",
      },
    },
    {
      q: {
        en: "What happens on a scanned page with no selectable text?",
        hi: "जिस स्कैन पेज पर टेक्स्ट चुना नहीं जा सकता तो?",
      },
      a: {
        en: "Your drag still works — it becomes a translucent coloured box covering exactly the area you drew, so reviews on scans keep the same colours and comments list.",
        hi: "आपका ड्रैग फिर भी काम करता है — वह जगह पर ठीक उतना ही पारदर्शी रंगीन बॉक्स बन जाता है, यानी स्कैन पर भी रंग और टिप्पणी सूची वैसी ही रहती है।",
      },
    },
    {
      q: {
        en: "Can I write notes in Hindi?",
        hi: "क्या नोट हिंदी में लिख सकते हैं?",
      },
      a: {
        en: "Absolutely — sticky note text is stored as Unicode, so Devanagari (and every other script) reads back perfectly in any reader.",
        hi: "बिलकुल — स्टिकी नोट यूनिकोड में सहेजा जाता है, इसलिए देवनागरी (और हर भाषा) हर रीडर में बिल्कुल सही पढ़ी जाती है।",
      },
    },
  ],
};
