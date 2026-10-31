import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Bates numbering (PHASE-1 Batch B): the legal-document page stamp —
 * prefix + zero-padded sequential number + suffix on every page.
 * Numbering CONTINUES across a batch of files (exhibit sets), so
 * deposition packets stay in one series.
 *
 * Schema-driven; the worker stamps via StampContext on OUR OWN engine
 * (same pipeline as page numbers — no re-render, original content kept).
 */
export const config: ToolConfig = {
  toolId: "bates-numbering",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 20,
  options: [
    {
      kind: "text",
      id: "prefix",
      label: { en: "Prefix", hi: "उपसर्ग" },
      hint: {
        en: "Text before the number — e.g. BATES- or CASE123_",
        hi: "नंबर से पहले का टेक्स्ट — जैसे BATES- या CASE123_",
      },
      placeholder: { en: "BATES-", hi: "BATES-" },
      default: "",
    },
    {
      kind: "text",
      id: "suffix",
      label: { en: "Suffix", hi: "प्रत्यय" },
      hint: {
        en: "Text after the number — e.g. -FINAL",
        hi: "नंबर के बाद का टेक्स्ट — जैसे -FINAL",
      },
      placeholder: { en: "", hi: "" },
      default: "",
    },
    {
      kind: "number",
      id: "start",
      label: { en: "Start number", hi: "शुरुआती नंबर" },
      min: 1,
      max: 999999,
      default: 1,
    },
    {
      kind: "number",
      id: "digits",
      label: { en: "Digits", hi: "अंकों की संख्या" },
      hint: {
        en: "Zero-padding width — 6 gives 000001",
        hi: "ज़ीरो-पैडिंग चौड़ाई — 6 से 000001",
      },
      min: 4,
      max: 12,
      default: 6,
    },
    {
      kind: "select",
      id: "position",
      label: { en: "Position", hi: "जगह" },
      choices: [
        { value: "bottom-right", label: { en: "Bottom right", hi: "नीचे दाएँ" } },
        { value: "bottom-left", label: { en: "Bottom left", hi: "नीचे बाएँ" } },
        { value: "bottom-center", label: { en: "Bottom centre", hi: "नीचे बीच" } },
        { value: "top-right", label: { en: "Top right", hi: "ऊपर दाएँ" } },
        { value: "top-left", label: { en: "Top left", hi: "ऊपर बाएँ" } },
        { value: "top-center", label: { en: "Top centre", hi: "ऊपर बीच" } },
      ],
      default: "bottom-right",
    },
    {
      kind: "number",
      id: "margin",
      label: { en: "Edge distance", hi: "किनारे से दूरी" },
      suffix: { en: "pt", hi: "pt" },
      min: 6,
      max: 100,
      default: 24,
    },
    {
      kind: "number",
      id: "size",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      min: 6,
      max: 36,
      default: 10,
    },
    {
      kind: "select",
      id: "font",
      label: { en: "Font", hi: "फ़ॉन्ट" },
      choices: [
        { value: "helvetica", label: { en: "Helvetica", hi: "Helvetica" } },
        { value: "courier", label: { en: "Courier", hi: "Courier" } },
        { value: "times", label: { en: "Times", hi: "Times" } },
      ],
      default: "helvetica",
    },
  ],
  chainToolIds: ["merge-pdf", "lock-pdf", "view-pdf"],
  features: [
    {
      en: "Prefix + padded number + suffix — the classic legal Bates stamp.",
      hi: "उपसर्ग + पैडेड नंबर + प्रत्यय — क्लासिक लीगल बेट्स स्टाम्प।",
    },
    {
      en: "Numbering continues across every file in the batch — one series for the whole exhibit set.",
      hi: "नंबरिंग बैच की हर फ़ाइल पर जारी रहती है — पूरे एक्ज़िबिट सेट के लिए एक ही श्रृंखला।",
    },
    {
      en: "Six stamp positions, adjustable size, edge distance and font.",
      hi: "छह जगह, अपने अनुसार साइज़, किनारे से दूरी और फ़ॉन्ट।",
    },
    {
      en: "Start from any number — continue an existing series.",
      hi: "किसी भी नंबर से शुरू करें — चालू श्रृंखला आगे बढ़ाएँ।",
    },
    {
      en: "Runs entirely on your device — privileged documents never leave it.",
      hi: "पूरा काम डिवाइस पर — संवेदनशील दस्तावेज़ बाहर नहीं जाते।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is Bates numbering?",
        hi: "बेट्स नंबरिंग क्या है?",
      },
      a: {
        en: "Bates numbering stamps a unique sequential number on every page of a document set — the standard way law firms, courts and discovery productions keep thousands of pages in order and citable (“plaintiff exhibit BATES-000214”).",
        hi: "बेट्स नंबरिंग दस्तावेज़ सेट के हर पेज पर एक अनूठा क्रमिक नंबर लगाती है — वह मानक तरीका जिससे कानूनी फ़र्म, अदालतें और डिस्कवरी हज़ारों पेज क्रम में और हवाले योग्य रखती हैं (“प्लेंटिफ़ एक्ज़िबिट BATES-000214”)।",
      },
    },
    {
      q: {
        en: "How does numbering work across multiple files?",
        hi: "कई फ़ाइलों पर नंबरिंग कैसे चलती है?",
      },
      a: {
        en: "Files are numbered in the order you arrange them, and the series never resets — file 2 continues right after file 1's last page. Each file is saved separately with its own stamped copy.",
        hi: "फ़ाइलें आपके रखे क्रम में नंबर होती हैं और श्रृंखला कभी रीसेट नहीं होती — फ़ाइल 2, फ़ाइल 1 के आख़िरी पेज के ठीक बाद से जारी रहती है। हर फ़ाइल अलग से, अपनी स्टाम्प कॉपी के साथ सेव होती है।",
      },
    },
    {
      q: {
        en: "Can I continue a series I already started?",
        hi: "क्या शुरू की हुई श्रृंखला आगे बढ़ा सकते हैं?",
      },
      a: {
        en: "Yes — set the start number to the next free number (e.g. 002137) and the series continues from there with the same padding width.",
        hi: "हाँ — स्टार्ट नंबर अगला खाली नंबर रखें (जैसे 002137) और श्रृंखला उसी पैडिंग चौड़ाई के साथ वहाँ से चलती है।",
      },
    },
  ],
};
