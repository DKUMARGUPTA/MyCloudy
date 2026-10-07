import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Compress PDF (PRD §7.5, device mode): embedded photos are re-encoded as
 * JPEG at a chosen quality + max pixel size, while text, fonts and vector
 * art stay untouched — selectable text stays selectable. Presets cover the
 * common cases; "Custom" reveals quality + max size (showWhen).
 */
export const config: ToolConfig = {
  toolId: "compress-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: [
    "view-pdf",
    "protect-pdf",
    "pdf-to-jpg",
    "change-pdf-doc-info",
  ],
  options: [
    {
      kind: "select",
      id: "preset",
      label: { en: "Compression level", hi: "कंप्रेशन लेवल" },
      hint: {
        en: "Photos are re-encoded — text stays sharp and selectable",
        hi: "तस्वीरें दोबारा एन्कोड होती हैं — टेक्स्ट साफ़ और सिलेक्टेबल रहता है",
      },
      choices: [
        {
          value: "light",
          label: { en: "Light — nearly identical", hi: "हल्का — लगभग वैसा ही" },
        },
        {
          value: "recommended",
          label: { en: "Recommended — best balance", hi: "सुझाया गया — संतुलित" },
        },
        {
          value: "strong",
          label: { en: "Strong — smallest size", hi: "ज़्यादा — सबसे छोटा साइज़" },
        },
        {
          value: "custom",
          label: { en: "Custom", hi: "कस्टम" },
        },
      ],
      default: "recommended",
    },
    {
      kind: "number",
      id: "quality",
      label: { en: "Photo quality (JPG)", hi: "तस्वीर क्वालिटी (JPG)" },
      hint: {
        en: "Lower = smaller photos, slightly softer look",
        hi: "कम = छोटी तस्वीरें, थोड़ा मुलायम लुक",
      },
      min: 30,
      max: 95,
      step: 5,
      suffix: { en: "%", hi: "%" },
      default: 65,
      showWhen: { id: "preset", equals: "custom" },
    },
    {
      kind: "number",
      id: "maxDim",
      label: { en: "Max photo size", hi: "तस्वीर का अधिकतम साइज़" },
      hint: {
        en: "Longer side of every photo, in pixels — bigger photos are scaled down",
        hi: "हर तस्वीर की लंबी भुजा, पिक्सेल में — बड़ी तस्वीरें छोटी कर दी जाती हैं",
      },
      min: 600,
      max: 4000,
      step: 100,
      suffix: { en: "px", hi: "px" },
      default: 1600,
      showWhen: { id: "preset", equals: "custom" },
    },
    {
      kind: "switch",
      id: "grayscale",
      label: { en: "Grayscale photos", hi: "तस्वीरें सादे (ग्रेस्केल)" },
      hint: {
        en: "Colour photos become grayscale — much smaller scans and documents",
        hi: "रंगीन तस्वीरें ग्रेस्केल हो जाती हैं — स्कैन और दस्तावेज़ बहुत छोटे",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "stripMetadata",
      label: { en: "Also remove metadata", hi: "मेटाडेटा भी हटाएँ" },
      hint: {
        en: "Drops the document info + XMP block — usually saves little on its own",
        hi: "दस्तावेज़ की जानकारी + XMP हटती है — अकेले इससे फ़ाइल कम ही छोटी होती है",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Three presets — from nearly identical to smallest size — plus a Custom mode with your own JPG quality and photo dimensions.",
      hi: "तीन प्रीसेट — लगभग वैसा ही से लेकर सबसे छोटे साइज़ तक — साथ में कस्टम मोड में अपनी JPG क्वालिटी और साइज़।",
    },
    {
      en: "Text stays text: fonts and vector art are never touched, so selectable text remains selectable.",
      hi: "टेक्स्ट टेक्स्ट ही रहता है: फ़ॉन्ट और वेक्टर आर्ट को नहीं छेड़ा जाता — सिलेक्ट करने लायक़ टेक्स्ट वैसा ही रहता है।",
    },
    {
      en: "An honest before/after size with the exact percentage saved — no fake numbers.",
      hi: "पहले/बाद का सच्चा साइज़ और कितना बचा, ठीक प्रतिशत में — कोई झूठे आँकड़े नहीं।",
    },
    {
      en: "Photos that would not shrink are left untouched — the result never gets bigger image-by-image.",
      hi: "जो तस्वीरें छोटी नहीं होतीं, वे वैसी ही रहती हैं — नतीजा कभी बड़ा नहीं होता।",
    },
    {
      en: "Grayscale option squeezes scans and text-heavy documents down even further.",
      hi: "ग्रेस्केल विकल्प स्कैन और टेक्स्ट-भरे दस्तावेज़ और भी छोटे कर देता है।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Will my text stay selectable?",
        hi: "क्या टेक्स्ट सिलेक्ट करने लायक़ रहेगा?",
      },
      a: {
        en: "Yes. Only the embedded photos are re-encoded; the text layer, fonts and vector graphics are copied through untouched — so search, copy and screen readers keep working exactly as before.",
        hi: "हाँ। सिर्फ़ अंदर की तस्वीरें दोबारा एन्कोड होती हैं; टेक्स्ट लेयर, फ़ॉन्ट और वेक्टर ग्राफ़िक्स वैसे ही रहते हैं — खोज, कॉपी और स्क्रीन रीडर पहले जैसे ही चलते हैं।",
      },
    },
    {
      q: {
        en: "Why did my file barely shrink?",
        hi: "मेरी फ़ाइल छोटी ही क्यों नहीं हुई?",
      },
      a: {
        en: "A text-only PDF is already compact — the size lives in the photos. Files whose images were already well-compressed JPEGs also have little left to win. Try the Strong preset or Grayscale for scans.",
        hi: "सिर्फ़ टेक्स्ट वाली PDF पहले से कॉम्पैक्ट होती है — साइज़ तस्वीरों में होता है। जिनकी तस्वीरें पहले से अच्छी तरह कंप्रेस्ड JPEG हैं, उनमें भी कम बचत होती है। स्कैन के लिए ज़्यादा (Strong) प्रीसेट या ग्रेस्केल आज़माएँ।",
      },
    },
    {
      q: {
        en: "What quality will I actually get?",
        hi: "असल में कितनी क्वालिटी मिलेगी?",
      },
      a: {
        en: "Light is visually near-identical to the original photos. Recommended fits email and form portals. Strong produces the smallest files that still read clearly on screen — and Custom hands you the exact JPG quality and pixel size.",
        hi: "हल्का आँखों को लगभग उतना ही लगता है जितना असली तस्वीरें। सुझाया गया ईमेल और फ़ॉर्म पोर्टल के लिए ठीक है। ज़्यादा सबसे छोटी फ़ाइलें बनाता है जो स्क्रीन पर साफ़ पढ़ी जाती हैं — और कस्टम में आपको ठीक JPG क्वालिटी और पिक्सेल साइज़ खुद चुनने मिलता है।",
      },
    },
  ],
};
