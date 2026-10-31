import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add stamps (PHASE-1 Batch C): put DRAFT / CONFIDENTIAL / PAID (or any
 * text) on pages — 9 positions or big diagonal across the middle, your
 * colour, opacity, size and rotation.
 */
export const config: ToolConfig = {
  toolId: "add-stamps",
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
      id: "text",
      label: { en: "Stamp text", hi: "स्टाम्प टेक्स्ट" },
      placeholder: { en: "DRAFT", hi: "मसौदा" },
      default: "DRAFT",
    },
    {
      kind: "select",
      id: "placement",
      label: { en: "Placement", hi: "जगह" },
      choices: [
        { value: "diagonal", label: { en: "Big diagonal across the page", hi: "पेज पर बड़ा तिरछा" } },
        { value: "top-left", label: { en: "Top left", hi: "ऊपर बाएँ" } },
        { value: "top-center", label: { en: "Top centre", hi: "ऊपर बीच" } },
        { value: "top-right", label: { en: "Top right", hi: "ऊपर दाएँ" } },
        { value: "middle-left", label: { en: "Middle left", hi: "बीच बाएँ" } },
        { value: "middle-center", label: { en: "Centre", hi: "बीच" } },
        { value: "middle-right", label: { en: "Middle right", hi: "बीच दाएँ" } },
        { value: "bottom-left", label: { en: "Bottom left", hi: "नीचे बाएँ" } },
        { value: "bottom-center", label: { en: "Bottom centre", hi: "नीचे बीच" } },
        { value: "bottom-right", label: { en: "Bottom right", hi: "नीचे दाएँ" } },
      ],
      default: "diagonal",
    },
    {
      kind: "select",
      id: "color",
      label: { en: "Colour", hi: "रंग" },
      choices: [
        { value: "red", label: { en: "Red", hi: "लाल" } },
        { value: "gray", label: { en: "Grey", hi: "स्लेटी" } },
        { value: "blue", label: { en: "Slate", hi: "स्लेट" } },
        { value: "green", label: { en: "Green", hi: "हरा" } },
        { value: "purple", label: { en: "Purple", hi: "बैंगनी" } },
        { value: "black", label: { en: "Black", hi: "काला" } },
      ],
      default: "red",
    },
    {
      kind: "number",
      id: "opacity",
      label: { en: "Opacity", hi: "अपारदर्शिता" },
      suffix: { en: "%", hi: "%" },
      min: 10,
      max: 100,
      step: 5,
      default: 25,
    },
    {
      kind: "number",
      id: "size",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      hint: {
        en: "~48 for the big diagonal, ~14 for corner positions",
        hi: "बड़े तिरछे के लिए ~48, कोनों के लिए ~14",
      },
      min: 8,
      max: 96,
      default: 48,
    },
    {
      kind: "number",
      id: "angle",
      label: { en: "Rotation", hi: "घुमाव" },
      suffix: { en: "°", hi: "°" },
      hint: {
        en: "Counter-clockwise — 45 is the classic upward diagonal",
        hi: "घड़ी के उल्टी दिशा — 45 क्लासिक ऊपर की ओर तिरछा",
      },
      min: -90,
      max: 90,
      default: 45,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      placeholder: { en: "all", hi: "सभी" },
      default: "all",
    },
  ],
  chainToolIds: ["add-watermark", "lock-pdf", "view-pdf"],
  features: [
    {
      en: "DRAFT, CONFIDENTIAL, PAID — any text, nine positions or big diagonal.",
      hi: "DRAFT, CONFIDENTIAL, PAID — कोई भी टेक्स्ट, नौ जगह या बड़ा तिरछा।",
    },
    {
      en: "Your colour and opacity — a loud red stamp or a faint grey hint.",
      hi: "आपका रंग और अपारदर्शिता — गर्जने वाला लाल स्टाम्प या हल्की स्लेटी झलक।",
    },
    {
      en: "Rotate the diagonal any way you like.",
      hi: "तिरछे स्टाम्प को जैसे चाहें घुमाएँ।",
    },
    {
      en: "Stamp every page or just a range.",
      hi: "हर पेज पर या सिर्फ़ एक रेंज पर स्टाम्प करें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Stamp vs watermark — which one?",
        hi: "स्टाम्प बनाम वॉटरमार्क — कौन सा?",
      },
      a: {
        en: "They share the engine but serve different jobs: the watermark tool repeats a faint mark over the WHOLE page (behind content, logo support), while stamps put one clear label — DRAFT, PAID — at a position you pick, on top of the content.",
        hi: "दोनों का इंजन एक है पर काम अलग: वॉटरमार्क टूल पूरे पेज पर एक हल्का निशान दोहराता है (सामग्री के पीछे, लोगो सपोर्ट के साथ), जबकि स्टाम्प एक साफ़ लेबल — DRAFT, PAID — आपकी चुनी जगह पर, सामग्री के ऊपर लगाता है।",
      },
    },
    {
      q: {
        en: "Can the stamp be removed later?",
        hi: "क्या स्टाम्प बाद में हटाया जा सकता है?",
      },
      a: {
        en: "Not automatically — the stamp becomes part of the page content. Keep your original file; this tool always writes a new copy.",
        hi: "अपने आप नहीं — स्टाम्प पेज की सामग्री का हिस्सा बन जाता है। असली फ़ाइल रखें; यह टूल हमेशा नई कॉपी लिखता है।",
      },
    },
    {
      q: {
        en: "Will Hindi text work in the stamp?",
        hi: "क्या स्टाम्प में हिंदी टेक्स्ट चलेगा?",
      },
      a: {
        en: "The stamp uses the standard fonts, which cover Latin scripts. For Devanagari stamps, use the watermark tool — it embeds a Hindi-capable font.",
        hi: "स्टाम्प मानक फ़ॉन्ट इस्तेमाल करता है जो लैटिन लिपि के लिए हैं। देवनागरी स्टाम्प के लिए वॉटरमार्क टूल लें — वह हिंदी-सक्षम फ़ॉन्ट जोड़ता है।",
      },
    },
  ],
};
