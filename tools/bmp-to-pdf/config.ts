import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * BMP → PDF (PHASE-3 batch 3): our own decoder reads 24/32-bit and
 * palettised BMPs (top-down or bottom-up) and lays each on its own page —
 * lossless PNG embedding, no canvas round-trip, no upload.
 */
export const config: ToolConfig = {
  toolId: "bmp-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 20,
  options: [],
  chainToolIds: ["merge-pdf", "compress-pdf", "view-pdf"],
  features: [
    {
      en: "Reads 24-bit, 32-bit and palettised BMPs — top-down and bottom-up alike.",
      hi: "24-बिट, 32-बिट और पैलेट वाली BMP पढ़ता है — ऊपर-से-नीचे और नीचे-से-ऊपर दोनों।",
    },
    {
      en: "Lossless embedding — every pixel lands in the PDF exactly as stored.",
      hi: "बिना नुक़सान जोड़ — हर पिक्सल PDF में वैसा ही जाता है जैसा संभाला था।",
    },
    {
      en: "One page per image, sized to the bitmap — no borders, no surprises.",
      hi: "हर इमेज की अपनी पेज, बिटमैप के नाप पर — न बॉर्डर, न चौंकाने वाली बात।",
    },
    {
      en: "Up to 20 BMPs in one run, one PDF each — or merge them after.",
      hi: "एक रन में 20 BMP, हर एक की अपनी PDF — या बाद में जोड़ लें।",
    },
    {
      en: "Runs entirely on your device.",
      hi: "पूरा काम डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which BMP variants are supported?",
        hi: "कौन-सी BMP किस्में चलती हैं?",
      },
      a: {
        en: "Uncompressed (BI_RGB) BMPs at 8-bit palettised, 24-bit and 32-bit — which covers essentially every BMP in the wild. RLE-compressed and 1/4/16-bit files get an honest unsupported error.",
        hi: "बिना कंप्रेशन (BI_RGB) वाली 8-बिट पैलेट, 24-बिट और 32-बिट BMP — दुनिया की लगभग हर BMP इसी में आती है। RLE-कंप्रेस्ड और 1/4/16-बिट फ़ाइलें ईमानदार 'असमर्थित' एरर देती हैं।",
      },
    },
    {
      q: {
        en: "Does the file get re-compressed?",
        hi: "फ़ाइल दोबारा कंप्रेस होती है?",
      },
      a: {
        en: "Pixels are embedded losslessly (PNG) — quality never drops. The PDF is usually far smaller than the BMP because PNG compresses while BMP doesn't.",
        hi: "पिक्सल बिना नुक़सान (PNG) जुड़ते हैं — क्वालिटी कभी नहीं गिरती। PDF अक्सर BMP से कहीं छोटी बनती है क्योंकि PNG कंप्रेस करता है, BMP नहीं।",
      },
    },
    {
      q: {
        en: "Can I combine many BMPs into ONE PDF?",
        hi: "कई BMP को एक ही PDF में जोड़ सकते हैं?",
      },
      a: {
        en: "Run this tool for one PDF per bitmap, then chain into Merge PDF — or use Images to PDF which accepts BMP output directly.",
        hi: "यह टूल हर बिटमैप की अलग PDF बनाता है, फिर Merge PDF से जोड़ें — या Images to PDF चुनें जो सीधे कई इमेज लेता है।",
      },
    },
  ],
};
