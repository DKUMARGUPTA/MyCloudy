import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * CBZ to PDF (P3-c / R57) — comic book archives → PDF, 100% on-device
 * (mode D), EN + हिन्दी.
 *
 * The generic ToolShell flow: DropZone (accepts any file — the worker
 * validates the ZIP container itself), options (page size / margin),
 * the worker opens the archive with our OWN zip engine (no fflate on
 * this path), naturally sorts the image entries ("page-2" before
 * "page-10"), embeds JPG/PNG pages byte-for-byte and decodes BMP/PSD/
 * GIF/WEBP/AVIF on-device, one PDF page per comic page.
 */
export const config: ToolConfig = {
  toolId: "cbz-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "Fit makes every page exactly the comic panel's shape — the natural reading mode.",
        hi: "फ़िट हर पेज को बिल्कुल कॉमिक पैनल की आकृति का रखता है — स्वाभाविक पढ़ने का तरीक़ा।",
      },
      choices: [
        { value: "fit", label: { en: "Fit to page image", hi: "पेज-इमेज के अनुसार" } },
        { value: "a4", label: { en: "A4", hi: "A4" } },
        { value: "letter", label: { en: "US Letter", hi: "US लेटर" } },
      ],
      default: "fit",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margin", hi: "मार्जिन" },
      choices: [
        { value: "none", label: { en: "None", hi: "कोई नहीं" } },
        { value: "small", label: { en: "Small", hi: "छोटा" } },
        { value: "big", label: { en: "Big", hi: "बड़ा" } },
      ],
      default: "none",
    },
  ],
  chainToolIds: ["compress-pdf", "merge-pdf", "view-pdf"],
  features: [
    {
      en: "Comic archives (.cbz / .zip) become one PDF, pages in natural order — page-2 before page-10, chapters grouped by folder, never filename-byte order.",
      hi: "कॉमिक आर्काइव (.cbz / .zip) एक PDF बनते हैं, पेज स्वाभाविक क्रम में — page-10 से पहले page-2, फ़ोल्डर के हिसाब से अध्याय, कभी फ़ाइलनाम-बाइट क्रम नहीं।",
    },
    {
      en: "JPG and PNG pages embed byte-for-byte — zero quality loss on the formats comics actually use.",
      hi: "JPG और PNG पेज जस की तस जुड़ते हैं — कॉमिक्स के असली फ़ॉर्मैट पर शून्य क्वालिटी नुकसान।",
    },
    {
      en: "BMP and Photoshop pages decode with our own decoder; GIF/WEBP/AVIF through the browser — junk entries like __MACOSX are skipped.",
      hi: "BMP और फ़ोटोशॉप पेज हमारा अपना डिकोडर खोलता है; GIF/WEBP/AVIF ब्राउज़र से — __MACOSX जैसी बेकार एंट्री छोड़ दी जाती हैं।",
    },
    {
      en: "The archive is opened with our own ZIP engine, entirely in your browser — your comics are never uploaded.",
      hi: "आर्काइव हमारा अपना ZIP इंजन खोलता है, पूरा ब्राउज़र में — आपके कॉमिक्स कहीं अपलोड नहीं होते।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference from PDF to CBZ?",
        hi: "PDF से CBZ से क्या फ़र्क़ है?",
      },
      a: {
        en: "Opposite directions. PDF to CBZ rasterizes PDF pages into a comic archive for comic readers; CBZ to PDF turns the archive into a document you can print, share or annotate. Your comics flow stays on-device in both.",
        hi: "उलटी दिशाएँ। PDF से CBZ, PDF पेजों को कॉमिक रीडर के लिए आर्काइव में बदलता है; CBZ से PDF आर्काइव को ऐसा दस्तावेज़ बनाता है जिसे प्रिंट, शेयर या एनोटेट कर सकें। दोनों में कॉमिक डिवाइस पर ही रहती है।",
      },
    },
    {
      q: {
        en: "Does it open CBR (RAR) files?",
        hi: "CBR (RAR) फ़ाइलें खुलती हैं?",
      },
      a: {
        en: "No — CBR is RAR-compressed and RAR is a closed format our engine cannot open honestly. Convert the archive to CBZ first (any archiver can re-zip the same images); the pages themselves need no change.",
        hi: "नहीं — CBR, RAR-कंप्रेस्ड है और RAR बंद फ़ॉर्मैट है जिसे हमारा इंजन ईमानदारी से नहीं खोल सकता। पहले आर्काइव को CBZ में बदलें (कोई भी आर्काइवर वही तस्वीरें दोबारा ज़िप कर देगा); पेजों को खुद कुछ नहीं करना पड़ता।",
      },
    },
    {
      q: {
        en: "How many pages can one archive have?",
        hi: "एक आर्काइव में कितने पेज हो सकते हैं?",
      },
      a: {
        en: "Up to 3,000 image entries per archive, and up to 600 MB of uncompressed image data — beyond that the tool refuses honestly instead of freezing the tab. Larger libraries split cleanly into volumes first.",
        hi: "प्रति आर्काइव 3,000 इमेज एंट्री तक, और 600 MB तक अनकंप्रेस्ड इमेज डेटा — उसके आगे टूल टैब जमाने के बजाय ईमानदारी से मना करता है। बड़ी लाइब्रेरी पहले वॉल्यूम में बाँट लें।",
      },
    },
  ],
};
