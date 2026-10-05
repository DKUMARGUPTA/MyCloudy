import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to PNG (PRD §8.6) — lossless pages with optional transparency.
 * Shared worker with pdf-to-jpg; DPI + page range + transparent background.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-png",
  createWorker: () =>
    new Worker(new URL("../pdf-to-images/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["images-to-pdf", "png-to-pdf", "webp-to-pdf", "heic-to-pdf"],
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      hint: {
        en: "Higher DPI = sharper but heavier files",
        hi: "ज़्यादा DPI = ज़्यादा साफ़ लेकिन भारी फ़ाइलें",
      },
      choices: [
        { value: "72", label: { en: "72 — screen", hi: "72 — स्क्रीन" } },
        { value: "150", label: { en: "150 — balanced", hi: "150 — संतुलित" } },
        { value: "300", label: { en: "300 — print", hi: "300 — प्रिंट" } },
        { value: "600", label: { en: "600 — archive", hi: "600 — आर्काइव" } },
      ],
      default: "150",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
    {
      kind: "switch",
      id: "transparent",
      label: { en: "Transparent background", hi: "पारदर्शी बैकग्राउंड" },
      hint: {
        en: "Keep PDF pages without a white base — ideal for logos and overlays",
        hi: "सफ़ेद आधार के बिना पेज — लोगो और ओवरले के लिए एकदम सही",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Lossless PNG pages — crisp text, sharp edges, no JPG artefacts.",
      hi: "लॉसलेस PNG पेज — साफ़ टेक्स्ट, तेज़ किनारे, कोई JPG दाग़ नहीं।",
    },
    {
      en: "Optional transparent background for logos, stamps and overlays.",
      hi: "लोगो, मुहर और ओवरले के लिए विकल्प के रूप में पारदर्शी बैकग्राउंड।",
    },
    {
      en: "72 to 600 DPI, full documents or exact page ranges — ZIP included.",
      hi: "72 से 600 DPI, पूरा दस्तावेज़ या सटीक पेज रेंज — ZIP सहित।",
    },
    {
      en: "Live pixel-size preview before you commit to a big render.",
      hi: "बड़ा रेंडर करने से पहले लाइव पिक्सेल-साइज़ प्रीव्यू।",
    },
    {
      en: "On-device rendering — your PDF never leaves the browser.",
      hi: "डिवाइस पर रेंडरिंग — आपकी PDF ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: { en: "PNG or JPG — which one?", hi: "PNG या JPG — कौन-सा?" },
      a: {
        en: "PNG is lossless and best for text, line art and screenshots; JPG is smaller and better for photos and scans.",
        hi: "PNG लॉसलेस है — टेक्स्ट, लाइन-आर्ट और स्क्रीनशॉट के लिए बेहतर; JPG छोटी होती है — फ़ोटो और स्कैन के लिए।",
      },
    },
    {
      q: { en: "When is the transparent option useful?", hi: "पारदर्शी विकल्प कब काम आता है?" },
      a: {
        en: "When the PDF is a logo, stamp or diagram you want to place over something else — you get just the artwork with no white box around it.",
        hi: "जब PDF कोई लोगो, मुहर या डायग्राम है जिसे किसी और चीज़ पर रखना है — सफ़ेद बॉक्स के बिना सिर्फ़ आर्टवर्क मिलता है।",
      },
    },
    {
      q: { en: "Why are PNG files bigger than my PDF?", hi: "PNG, PDF से बड़ी क्यों?" },
      a: {
        en: "A PDF page is vectors + fonts; a PNG is every pixel stored losslessly. Pick 150 DPI instead of 300 if the size feels heavy.",
        hi: "PDF पेज वेक्टर + फ़ॉन्ट होता है; PNG हर पिक्सेल बिना नुक़सान संभालती है। साइज़ ज़्यादा लगे तो 300 की जगह 150 DPI चुनें।",
      },
    },
  ],
};
