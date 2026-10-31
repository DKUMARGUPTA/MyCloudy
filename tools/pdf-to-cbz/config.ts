import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to CBZ (P3-a / R55) — every page becomes an image and the set is
 * packed into a .cbz comic archive that every comic reader opens. JPG or
 * PNG pages, your DPI, page ranges, zero-padded names so the reading
 * order is never a question. 100% on-device, zero network.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-cbz",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "zip",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["pdf-to-jpg", "pdf-to-png", "pdfs-to-zip"],
  options: [
    {
      kind: "select",
      id: "format",
      label: { en: "Page format", hi: "पेज फ़ॉर्मैट" },
      hint: {
        en: "JPG keeps the archive small — the comic convention; PNG is lossless for sharp line art.",
        hi: "JPG आर्काइव छोटा रखता है — कॉमिक का रिवाज़; PNG लॉसलेस है, तीखी लाइन-आर्ट के लिए।",
      },
      choices: [
        { value: "jpg", label: { en: "JPG — small (comic convention)", hi: "JPG — छोटा (कॉमिक रिवाज़)" } },
        { value: "png", label: { en: "PNG — lossless", hi: "PNG — लॉसलेस" } },
      ],
      default: "jpg",
    },
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      hint: {
        en: "150 is plenty for screen reading; 300 only when you plan to zoom deep.",
        hi: "स्क्रीन पर पढ़ने के लिए 150 काफ़ी है; 300 सिर्फ़ तब जब गहरा ज़ूम चाहिए।",
      },
      choices: [
        { value: "96", label: { en: "96 — screen", hi: "96 — स्क्रीन" } },
        { value: "150", label: { en: "150 — balanced", hi: "150 — संतुलित" } },
        { value: "300", label: { en: "300 — print", hi: "300 — प्रिंट" } },
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
      kind: "number",
      id: "quality",
      label: { en: "JPG quality", hi: "JPG क्वालिटी" },
      hint: {
        en: "85 keeps art crisp at a sane size (JPG only)",
        hi: "85 आर्ट साफ़ और साइज़ संतुलित रखता है (सिर्फ़ JPG)",
      },
      min: 40,
      max: 100,
      step: 5,
      suffix: { en: "%", hi: "%" },
      default: 85,
    },
  ],
  features: [
    {
      en: "One .cbz, every page an image — the format CDisplayEx, YACReader, Tachiyomi and every comic shelf app opens natively.",
      hi: "एक .cbz, हर पेज एक तस्वीर — वह फ़ॉर्मैट जो CDisplayEx, YACReader, Tachiyomi और हर कॉमिक ऐप सीधा खोलता है।",
    },
    {
      en: "Pages are named page-001, page-002… zero-padded, so the reading order survives every reader's sort — no renaming marathons.",
      hi: "पेज page-001, page-002… जैसे ज़ीरो-पैडेड नामों से जाते हैं, इसलिए पढ़ने का क्रम हर रीडर की सॉर्टिंग में बचा रहता है — नाम बदलने का मैराथन नहीं।",
    },
    {
      en: "JPG keeps archives small (the comic convention); PNG stays lossless for crisp line art. Pick 96 / 150 / 300 DPI and a page range.",
      hi: "JPG आर्काइव छोटा रखता है (कॉमिक रिवाज़); PNG लॉसलेस रहता है, तीखी लाइन-आर्ट के लिए। 96 / 150 / 300 DPI और पेज रेंज चुनें।",
    },
    {
      en: "Sequential rendering with a memory budget — long comics render flat, page after page, without choking the device.",
      hi: "क्रमबद्ध रेंडरिंग, मेमोरी बजट के साथ — लंबी कॉमिक्स पेज-दर-पेज बिना डिवाइस अटकाए बनती हैं।",
    },
    {
      en: "Up to 5 PDFs in one run, each its own .cbz. Everything happens on your device — zero uploads.",
      hi: "एक बार में 5 PDF तक, हर एक की अपनी .cbz। सब कुछ आपके डिवाइस पर — कोई अपलोड नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "What exactly is a CBZ file?",
        hi: "CBZ फ़ाइल आख़िर होती क्या है?",
      },
      a: {
        en: "A ZIP archive of numbered page images with the .cbz extension — the open comic-book convention. Comic readers treat it as one book with proper pages; you can also rename it to .zip and open it with any archiver.",
        hi: "नंबर वाली पेज-तस्वीरों की ZIP आर्काइव, .cbz एक्सटेंशन के साथ — खुला कॉमिक-बुक रिवाज़। कॉमिक रीडर इसे पूरी किताब मानते हैं; चाहें तो नाम बदल कर .zip कर लें और किसी भी आर्काइवर से खोल लें।",
      },
    },
    {
      q: {
        en: "Why are my pages inside a folder in the archive?",
        hi: "आर्काइव में मेरे पेज फ़ोल्डर के अंदर क्यों हैं?",
      },
      a: {
        en: "Pages sit under the book's own folder (book-name/page-001.jpg) — the layout mainstream comic readers prefer, and it keeps multi-file archives unambiguous when you merge them later.",
        hi: "पेज किताब के अपने फ़ोल्डर में रहते हैं (book-name/page-001.jpg) — ज़्यादातर कॉमिक रीडर यही लेआउट पसंद करते हैं, और आगे आर्काइव मिलाने पर भी सब साफ़ रहता है।",
      },
    },
    {
      q: {
        en: "How do I convert only a few chapters' pages?",
        hi: "सिर्फ़ कुछ पेज (चैप्टर) कैसे बदलूँ?",
      },
      a: {
        en: "Write ranges in the Pages field: 1-3, 5, 8- means pages one to three, page five, and eight to the end. The exported pages renumber from 001.",
        hi: "पेज फ़ील्ड में रेंज लिखें: 1-3, 5, 8- का मतलब पेज 1 से 3, पेज 5, और 8 से आख़िर तक। निकले पेज 001 से नए सिरे से नंबर पाते हैं।",
      },
    },
  ],
};
