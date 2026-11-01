import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * CBZ → PDF (PHASE-3 batch 3): opens the comic archive, sorts pages
 * naturally (page-2 before page-10) and lays each image on its own page —
 * JPEG/PNG byte-direct, BMP through our own decoder. One comic, one PDF.
 */
export const config: ToolConfig = {
  toolId: "cbz-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 10,
  options: [],
  chainToolIds: ["view-pdf", "compress-pdf", "pdf-to-cbz"],
  features: [
    {
      en: "Natural page order — page-2 lands before page-10, every time.",
      hi: "स्वाभाविक पेज क्रम — page-2, page-10 से पहले आता है, हर बार।",
    },
    {
      en: "JPEG and PNG pages embed byte-direct — no re-encode, no quality loss.",
      hi: "JPEG और PNG पेज सीधे जुड़ते हैं — दोबारा एनकोड नहीं, क्वालिटी बिल्कुल नहीं गिरती।",
    },
    {
      en: "BMP pages ride our own decoder; Mac resource junk is skipped quietly.",
      hi: "BMP पेज हमारे अपने डिकोडर से; मैक की जंक फ़ाइलें चुपचाप छोड़ दी जाती हैं।",
    },
    {
      en: "One page per image, sized to the artwork — the reading order you authored.",
      hi: "हर इमेज अपनी पेज, कला के नाप पर — वही क्रम जो आपने बनाया।",
    },
    {
      en: "Up to 10 archives in one run — everything on your device.",
      hi: "एक रन में 10 आर्काइव — सब कुछ आपके डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which image formats can be inside the CBZ?",
        hi: "CBZ के अंदर कौन-से इमेज फ़ॉर्मैट हो सकते हैं?",
      },
      a: {
        en: "JPEG, PNG and BMP — the formats comic archives actually contain. GIF and exotic formats get an honest unsupported error naming the file.",
        hi: "JPEG, PNG और BMP — वही जो कॉमिक आर्काइव में सच में होते हैं। GIF वग़ैरह पर ईमानदार 'असमर्थित' एरर, फ़ाइल का नाम बताते हुए।",
      },
    },
    {
      q: {
        en: "Will the PDF be bigger than the CBZ?",
        hi: "PDF, CBZ से बड़ी हो जाएगी?",
      },
      a: {
        en: "Usually close — JPEGs are embedded as-is and PNGs stay lossless. Run Compress PDF afterwards if you need a lighter file.",
        hi: "आम तौर पर बराबर — JPEG जस के तस जुड़ते हैं और PNG बिना नुक़सान रहते हैं। हल्की फ़ाइल चाहिए तो बाद में PDF कंप्रेस करें।",
      },
    },
    {
      q: {
        en: "Does it read CBR too?",
        hi: "क्या यह CBR भी पढ़ता है?",
      },
      a: {
        en: "No — CBR is RAR-compressed, a different archive family. Convert the CBR to CBZ first (any archiver does it), then bring it here.",
        hi: "नहीं — CBR RAR-कंप्रेस्ड होता है, अलग आर्काइव परिवार। पहले CBR को CBZ में बदलें (कोई भी आर्काइवर कर लेगा), फिर यहाँ लाएँ।",
      },
    },
  ],
};
