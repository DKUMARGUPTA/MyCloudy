import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Edit PDF text (PHASE-7): the focused typo-fixer. Search the text
 * inside the PDF, check the lines to fix, type the replacement — each
 * edit covers exactly the old line's band and redraws the new words at
 * the same baseline, auto-fitted so they never spill. The full editor's
 * cover+redraw engine, distilled. Own engine, device only.
 */
export const config: ToolConfig = {
  toolId: "edit-pdf-text",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  fullWidthSurface: true,
  minFiles: 1,
  maxFiles: 1,
  options: [
    { kind: "text", id: "query", label: { en: "Find", hi: "खोजें" }, default: "" },
    {
      kind: "text",
      id: "replacement",
      label: { en: "Replace with", hi: "इससे बदलें" },
      default: "",
    },
    {
      kind: "text",
      id: "background",
      label: { en: "Cover color (hex)", hi: "कवर का रंग (hex)" },
      default: "#FFFFFF",
    },
    { kind: "text", id: "edits", label: { en: "Edits", hi: "संपादन" }, default: "" },
  ],
  chainToolIds: ["view-pdf", "compress-pdf", "flatten-pdf"],
  features: [
    {
      en: "Find the words, see every matching line on its page, and retype them — no editor learning curve.",
      hi: "शब्द खोजें, हर मिली पंक्ति अपने पेज संख्या के साथ देखें, और दोबारा लिखें — कोई एडिटर सीखने की ज़रूरत नहीं।",
    },
    {
      en: "Each edit covers exactly the old line's band and redraws the new words at the same baseline — placement comes from the page itself.",
      hi: "हर संपादन पुरानी पंक्ति की पट्टी को ठीक ढकता है और नए शब्द उसी आधार-रेखा पर लिखता है — जगह पेज से ही आती है।",
    },
    {
      en: "Auto-fit sizing: longer replacements shrink to stay inside the covered band; short ones keep the original size.",
      hi: "ऑटो-फ़िट आकार: लंबे बदलाव ढकी पट्टी के भीतर रहने के लिए छोटे हो जाते हैं; छोटे असली आकार रखते हैं।",
    },
    {
      en: "Hindi (Devanagari) replacements redraw with the embedded Devanagari font.",
      hi: "हिंदी (देवनागरी) बदलाव एम्बेडेड देवनागरी फ़ॉन्ट से लिखे जाते हैं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from the Edit PDF tool?",
        hi: "यह Edit PDF टूल से कैसे अलग है?",
      },
      a: {
        en: "Edit PDF is the full canvas — annotations, images, shapes, everything. This tool does ONE job with zero learning: find text, retype it. For heavy layout work, use the editor; for a typo, use this.",
        hi: "Edit PDF पूरा कैनवस है — एनोटेशन, तस्वीरें, आकृतियाँ, सब कुछ। यह टूल बिना सीखे एक ही काम करता है: टेक्स्ट खोजो, दोबारा लिखो। भारी लेआउट के लिए एडिटर लें; टाइपो के लिए यह।",
      },
    },
    {
      q: {
        en: "Can the new text flow onto the next line?",
        hi: "क्या नया टेक्स्ट अगली पंक्ति में बह सकता है?",
      },
      a: {
        en: "No — this is an honest in-place retyping, not reflow. The replacement is scaled to fit the covered band, so a much longer text becomes smaller but stays on the line. For reflow-level editing, edit the source document.",
        hi: "नहीं — यह ईमानदार जगह-पर-पुनर्लेखन है, रीफ़्लो नहीं। बदला गया टेक्स्ट ढकी पट्टी में फ़िट होने तक छोटा होता है, पंक्ति पर ही रहता है। रीफ़्लो जैसा संपादन चाहिए तो मूल दस्तावेज़ एडिट करें।",
      },
    },
    {
      q: {
        en: "Why does the cover color matter?",
        hi: "कवर का रंग मायने क्यों रखता है?",
      },
      a: {
        en: "The old words are hidden by a filled rectangle before the new ones are drawn. On a white page the default white cover is invisible; on tinted paper pick the matching hex so the patch disappears.",
        hi: "पुराने शब्द भरे हुए आयत से ढके जाते हैं, फिर नए लिखे जाते हैं। सफ़ेद पेज पर डिफ़ॉल्ट सफ़ेद कवर अदृश्य है; रंगीन काग़ज़ पर मैचिंग hex चुनें ताकि पैच न दिखे।",
      },
    },
  ],
};
