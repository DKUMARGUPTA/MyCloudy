import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Text color (PHASE-7): recolor the text already inside a PDF. Content-
 * stream surgery on our own engine — every text object on the selected
 * pages (and inside the Form XObjects they draw) is repainted in the
 * colour you pick. Vectors only: text stays sharp, nothing re-rendered.
 */
export const config: ToolConfig = {
  toolId: "text-color",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "text",
      id: "color",
      label: { en: "Text color (hex)", hi: "टेक्स्ट का रंग (hex)" },
      placeholder: { en: "#DC2626", hi: "#DC2626" },
      default: "#DC2626",
      hint: {
        en: "#RRGGBB — e.g. #DC2626 red, #16A34A green, #000000 black",
        hi: "#RRGGBB — जैसे #DC2626 लाल, #16A34A हरा, #000000 काला",
      },
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["adjust-colors", "pdf-to-greyscale", "view-pdf"],
  features: [
    {
      en: "Changes the color of the text already in the file — a repaint, not an overlay that hides your original words.",
      hi: "फ़ाइल में पहले से मौजूद टेक्स्ट का रंग बदलता है — ओवरले नहीं जो आपके असली शब्द ढक दे।",
    },
    {
      en: "Vector surgery on the page streams: text, spacing and layout stay exactly as the author drew them.",
      hi: "पेज स्ट्रीम पर वेक्टर सर्जरी: टेक्स्ट, जगह-चौड़ाई और लेआउट बिल्कुल वैसे ही रहते हैं जैसे लेखक ने बनाए।",
    },
    {
      en: "Text inside Form XObjects is repainted too — the layer Word and InDesign exports hide their text in.",
      hi: "Form XObjects के अंदर का टेक्स्ट भी रंगा जाता है — जिस परत में Word और InDesign अपना टेक्स्ट छिपाते हैं।",
    },
    {
      en: "Pick the pages — recolor the red draft stamp on page 2 without touching the rest.",
      hi: "पेज चुनें — बाक़ी को छेड़े बिना सिर्फ़ पेज 2 का लाल ड्राफ़्ट निशान रंगें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Why is ALL the text on the page recolored, not just one word?",
        hi: "पेज का पूरा टेक्स्ट क्यों रंगा जाता है, सिर्फ़ एक शब्द नहीं?",
      },
      a: {
        en: "This tool repaints whole text objects — the honest, layout-safe operation. For surgical, word-level edits use the Edit PDF tool: it can cover a word and redraw it in any color at the same spot.",
        hi: "यह टूल पूरे टेक्स्ट-ऑब्जेक्ट रंगता है — ईमानदार और लेआउट-सुरक्षित काम। शब्द-दर-शब्द बारीक सुधार के लिए Edit PDF टूल लें: वह शब्द को ढक कर उसी जगह किसी भी रंग में दोबारा लिख सकता है।",
      },
    },
    {
      q: {
        en: "My page has text inside an annotation (a sticky note) — will it change?",
        hi: "मेरे पेज पर एनोटेशन (स्टिकी नोट) के अंदर टेक्स्ट है — क्या वह बदलेगा?",
      },
      a: {
        en: "No — annotation appearance streams are a separate object the page does not draw directly. Recolor the page text here; for annotation text, flatten the PDF first (Flatten PDF tool) and then recolor.",
        hi: "नहीं — एनोटेशन का रंग-रूप अलग ऑब्जेक्ट है जिसे पेज सीधे नहीं बनाता। यहाँ पेज का टेक्स्ट रंगें; एनोटेशन वाला टेक्स्ट चाहिए तो पहले PDF फ़्लैट करें (Flatten PDF टूल), फिर रंगें।",
      },
    },
    {
      q: {
        en: "What happens to text with a gradient or pattern fill?",
        hi: "ग्रेडिएंट या पैटर्न वाले टेक्स्ट का क्या होगा?",
      },
      a: {
        en: "It becomes a solid color of your choice — the honest simplification. The words, positions and fonts stay identical; only the fancy fill is traded for the color you picked.",
        hi: "वह आपकी चुनी एक ठोस रंग बन जाता है — यही ईमानदार सरलीकरण है। शब्द, जगह और फ़ॉन्ट वैसे ही रहते हैं; सिर्फ़ भड़कीला भराव आपके रंग से बदल जाता है।",
      },
    },
  ],
};
