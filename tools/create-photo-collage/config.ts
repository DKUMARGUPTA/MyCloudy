import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create photo collage (PRD "Photo collage") — the WYSIWYG image
 * composer. The surface (tools/create-photo-collage/surface.tsx) owns
 * the whole workspace: photo cards (reorder / rotate / remove /
 * polaroid captions), the layout picker and the live preview painted
 * by the same render.ts the worker uses, so it runs full-width with no
 * schema options — the serialized "collage" option carries the recipe.
 *
 * Scope (honest v1): grid/mosaic/filmstrip layouts, polaroid frames
 * with captions, page titles, backgrounds, rounded corners, gap and
 * margin controls, cover/contain fit, multi-page spillover, PDF + JPG +
 * PNG export. Passport sheets live in the separate passport-photo tool;
 * stickers are a later round.
 */
export const config: ToolConfig = {
  toolId: "create-photo-collage",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 50,
  fullWidthSurface: true,
  options: [],
  howKeys: ["collage.how1", "collage.how2", "collage.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Ten layouts — pairs, trios, 2×2, six and nine grids, hero mosaic and filmstrip — switched live on the preview.",
      hi: "दस लेआउट — जोड़े, तिकड़ी, 2×2, छह और नौ ग्रिड, मुख्य मोज़ेक और फ़िल्मस्ट्रिप — प्रीव्यू पर तुरंत बदलते हुए।",
    },
    {
      en: "Polaroid mode turns every photo into a white frame with its own caption line — defaults picked from the file name.",
      hi: "पोलरॉइड मोड हर तस्वीर को सफ़ेद फ़्रेम में बदल देता है, नीचे उसका कैप्शन — नाम फ़ाइल से अपने आप आता है।",
    },
    {
      en: "A4, Letter, square or 4×6 photo pages, portrait or landscape, with backgrounds, rounded corners, gap and margin controls.",
      hi: "A4, लेटर, स्क्वेयर या 4×6 फ़ोटो पेज, पोर्ट्रेट या लैंडस्केप — बैकग्राउंड, गोल कोने, गैप और मार्जिन के साथ।",
    },
    {
      en: "Cover or contain fit, rotate any photo 90°, drag to reorder, and extra pages spill over automatically.",
      hi: "फ़िल या फ़िट मोड, कोई भी तस्वीर 90° घुमाएँ, खींचकर क्रम बदलें, और ज़्यादा तस्वीरें अपने आप अगले पेज पर चली जाती हैं।",
    },
    {
      en: "Export a print-ready PDF or grab page 1 as JPG/PNG — everything composites on your device, nothing uploads.",
      hi: "प्रिंट-रेडी PDF बनाएँ या पेज 1 को JPG/PNG में उतारें — पूरी कंपोज़िशन आपके डिवाइस पर होती है, कुछ अपलोड नहीं होता।",
    },
  ],
  faq: [
    {
      q: {
        en: "Do my photos lose quality in the collage?",
        hi: "कोलाज में तस्वीरों की क्वालिटी गिरती है क्या?",
      },
      a: {
        en: "A collage is a single composed image, so each photo is re-encoded once at JPEG quality 0.92 (about 144 DPI on the page) — the same single re-compression used for rotated photos in Images to PDF. Nothing is re-compressed a second time.",
        hi: "कोलाज एक ही जुड़ी हुई तस्वीर है, इसलिए हर फ़ोटो एक बार JPEG क्वालिटी 0.92 पर दोबारा एनकोड होती है (पेज पर करीब 144 DPI) — वही एक बार का री-कंप्रेशन जो Images to PDF में घुमाई तस्वीरों पर लगता है। दूसरी बार कुछ नहीं होता।",
      },
    },
    {
      q: {
        en: "What happens when I have more photos than the layout holds?",
        hi: "लेआउट से ज़्यादा तस्वीरें हों तो क्या होता है?",
      },
      a: {
        en: "They spill onto extra pages using the same template — a 2×2 grid with 10 photos makes 3 pages. JPG and PNG exports use page 1 (the note under the format switch says so); the PDF keeps every page.",
        hi: "वे उसी टेम्पलेट में अगले पेजों पर चली जाती हैं — 2×2 ग्रिड में 10 तस्वीरें 3 पेज बनाती हैं। JPG और PNG एक्सपोर्ट पेज 1 देते हैं (फ़ॉर्मैट स्विच के नीचे यही लिखा है); PDF में सारे पेज रहते हैं।",
      },
    },
    {
      q: {
        en: "Which photo formats work? What about SVG?",
        hi: "कौन-कौन से फ़ोटो फ़ॉर्मैट चलते हैं? SVG का क्या?",
      },
      a: {
        en: "JPG, PNG, WEBP, GIF, HEIC (decoded on-device via libheif where the browser cannot) and TIFF (first page) all work. SVG vector files are not supported in this tool yet — convert them to PNG first.",
        hi: "JPG, PNG, WEBP, GIF, HEIC (जहाँ ब्राउज़र नहीं पढ़ पाता, वहाँ libheif से डिवाइस पर डिकोड) और TIFF (पहला पेज) सब चलते हैं। SVG वेक्टर फ़ाइलें अभी इस टूल में नहीं चलतीं — पहले PNG में बदल लें।",
      },
    },
  ],
};
