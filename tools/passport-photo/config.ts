import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Passport photo maker (PRD "Passport photo maker") — the India-focused
 * photo studio. The surface (tools/passport-photo/surface.tsx) owns the
 * whole workspace: the drag/zoom framing editor with the aspect guide,
 * the smart-white background + brightness/contrast adjustments and the
 * live sheet preview — no schema options, the serialized "passport"
 * option carries the recipe.
 *
 * One run delivers BOTH outputs: the single photo JPEG (exactly
 * size×300 DPI pixels, JFIF density tagged) and the print-ready sheet
 * PDF (4×6 or A4, cut guides, info line) — the result view shows each
 * with its own download button.
 *
 * Scope (honest v1): India passport 35×45mm, India visa/PAN-size 25×35mm,
 * US visa 51×51mm, China visa 33×48mm + custom mm (15–100). The white
 * background is an edge-seeded flood fill — it works on plain
 * backgrounds; busy scenes keep the original. It is NOT an official
 * spec validator: acceptance is always the authority's call.
 *
 * R4-c: a target-country selector (7 countries) adds published-spec
 * GUIDANCE — standard print size, face-height band, background hint —
 * plus an honest mismatch warning when the chosen size differs. The
 * tool never analyses the photo (no face detection); see the FAQ.
 */
export const config: ToolConfig = {
  toolId: "passport-photo",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 1,
  fullWidthSurface: true,
  options: [],
  howKeys: ["pp.how1", "pp.how2", "pp.how3"],
  chainToolIds: ["images-to-pdf", "convert-to-pdf", "jpg-to-pdf"],
  features: [
    {
      en: "India passport 35×45mm, visa/PAN-size 25×35mm, US visa 51×51mm, China visa 33×48mm — or your own mm (15–100).",
      hi: "भारत पासपोर्ट 35×45मिमी, वीज़ा/पैन-साइज़ 25×35मिमी, अमेरिकी वीज़ा 51×51मिमी, चीन वीज़ा 33×48मिमी — या अपना साइज़ (15–100मिमी)।",
    },
    {
      en: "Drag and zoom to frame the photo with a head-height guide band; smart white washes plain backgrounds with a tolerance slider.",
      hi: "तस्वीर खींचकर और ज़ूम करके फ़्रेम करें, सिर की ऊँचाई की गाइड-बैंड के साथ; स्मार्ट व्हाइट सादे बैकग्राउंड को टॉलरेंस स्लाइडर से सफ़ेद करता है।",
    },
    {
      en: "Target-country guidance for 7 countries (India, US, UK, Schengen/EU, Canada, Australia, China): standard print size, head/face-height band and background hint — with an honest warning when your size differs. Published specs only; the tool never analyses your photo.",
      hi: "7 देशों के लिए लक्ष्य-देश मार्गदर्शन (भारत, अमेरिका, यूके, शेंजेन/यूरोपीय संघ, कनाडा, ऑस्ट्रेलिया, चीन): स्टैंडर्ड प्रिंट साइज़, सिर/चेहरे की ऊँचाई की सीमा और बैकग्राउंड संकेत — साइज़ अलग होने पर ईमानदार चेतावनी के साथ। केवल प्रकाशित विनिर्देश; टूल आपकी तस्वीर का विश्लेषण कभी नहीं करता।",
    },
    {
      en: "Brightness and contrast touch-ups — plain per-pixel math, applied on your device.",
      hi: "ब्राइटनेस और कंट्रास्ट ठीक करें — सीधा पिक्सेल गणित, पूरा आपके डिवाइस पर।",
    },
    {
      en: "Every run gives both files: the photo JPEG at exactly 300 DPI and a print-ready sheet PDF (4×6 or A4) with dashed cut guides.",
      hi: "हर रन दोनों फ़ाइलें देता है: ठीक 300 DPI का फ़ोटो JPEG और प्रिंट-रेडी शीट PDF (4×6 या A4) काटने की डैश-लाइनों के साथ।",
    },
    {
      en: "Everything happens on your device — your photo never leaves the browser.",
      hi: "सब कुछ आपके डिवाइस पर होता है — आपकी तस्वीर ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does the smart white background always work?",
        hi: "स्मार्ट व्हाइट बैकग्राउंड हमेशा काम करता है क्या?",
      },
      a: {
        en: "No — it is an honest flood fill, not AI magic. The four corners decide the background colour, and every connected pixel within your tolerance washes to pure white. Plain, evenly-lit backgrounds work well; busy scenes, hair against dark walls or shadows are kept as the original. Raise the tolerance gradually and watch the preview.",
        hi: "नहीं — यह ईमानदार फ़्लड फ़िल है, कोई जादू नहीं। चार कोने बैकग्राउंड का रंग तय करते हैं, और आपकी टॉलरेंस के भीतर जुड़ा हर पिक्सेल शुद्ध सफ़ेद हो जाता है। सादे, एक-सी रोशनी वाले बैकग्राउंड अच्छे चलते हैं; भीड़भाड़ वाले दृश्य या परछाइयाँ जस की तस रहती हैं। टॉलरेंस धीरे-धीरे बढ़ाएँ और प्रीव्यू देखें।",
      },
    },
    {
      q: {
        en: "Are these sizes officially guaranteed?",
        hi: "क्या ये साइज़ आधिकारिक रूप से गारंटीड हैं?",
      },
      a: {
        en: "The presets follow the commonly published specs, but rules change — always check your passport office, embassy or form's current requirements before printing. The size, the 300 DPI pixel count and the sheet grid are exact; the head guide band is a rough visual hint, not a spec.",
        hi: "प्रीसेट आम तौर पर प्रकाशित विनिर्देशों पर चलते हैं, लेकिन नियम बदलते हैं — प्रिंट करने से पहले अपने पासपोर्ट दफ़्तर, दूतावास या फ़ॉर्म की मौजूदा शर्तें ज़रूर देखें। साइज़, 300 DPI पिक्सेल गिनती और शीट ग्रिड सटीक हैं; सिर की गाइड-बैंड एक मोटा संकेत है, विनिर्देश नहीं।",
      },
    },
    {
      q: {
        en: "What does the target-country selector actually check?",
        hi: "लक्ष्य-देश चयनकर्ता असल में क्या जाँचता है?",
      },
      a: {
        en: "It shows the published spec for the country you pick — standard print size in mm, the head/face-height band as a % of photo height, and a plain-background hint — and warns honestly when your chosen size differs from that standard. It does NOT analyse your photo: there is no face detection here, so the face band is framing guidance only. The authority reviewing your application always has the final call.",
        hi: "यह आपके चुने देश का प्रकाशित विनिर्देश दिखाता है — मिमी में स्टैंडर्ड प्रिंट साइज़, फ़ोटो ऊँचाई के % के रूप में सिर/चेहरे की ऊँचाई की सीमा, और सादे बैकग्राउंड का संकेत — और आपका साइज़ उस स्टैंडर्ड से अलग होने पर ईमानदारी से चेतावनी देता है। यह आपकी तस्वीर का विश्लेषण नहीं करता: यहाँ कोई फ़ेस-डिटेक्शन नहीं है, इसलिए फ़ेस-बैंड केवल फ़्रेमिंग मार्गदर्शन है। आख़री फ़ैसला हमेशा आवेदन देखने वाले अधिकारी का है।",
      },
    },
    {
      q: {
        en: "How do I print the sheet correctly?",
        hi: "शीट सही तरह कैसे प्रिंट करूँ?",
      },
      a: {
        en: "Print the PDF at 100% / actual size — not “fit to page” — on 4×6 photo paper or A4. The dashed gray lines around each photo are cut guides; the small info line (size, DPI, copies) sits in the bottom margin, outside the photos. The photo JPEG itself is exactly the right pixels at 300 DPI for online uploads.",
        hi: "PDF को 100% / असली साइज़ पर प्रिंट करें — “पेज के अनुसार” पर नहीं — 4×6 फ़ोटो पेपर या A4 पर। हर तस्वीर के चारों ओर धूसर डैश लाइनें काटने के लिए हैं; नीचे के मार्जिन में छोटी जानकारी लाइन (साइज़, DPI, गिनती) तस्वीरों के बाहर रहती है। फ़ोटो JPEG ऑनलाइन अपलोड के लिए ठीक 300 DPI पिक्सेल है।",
      },
    },
  ],
};
