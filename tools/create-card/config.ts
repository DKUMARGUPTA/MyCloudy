import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create card (PRD "Card") — the WYSIWYG greeting/invitation card
 * maker. The surface (tools/create-card/surface.tsx) owns the whole
 * workspace: template picker (Hindi festival designs), format +
 * orientation, per-panel text editors, the optional photo, the CSV
 * mail-merge box and the live preview painted by the same render.ts
 * the worker uses. It runs full-width with no schema options — the
 * serialized "card" option carries the recipe (collage pattern).
 *
 * landingSurface (scan-pdf precedent): photos are OPTIONAL (minFiles
 * 0), so the surface renders directly on the landing page in place of
 * the DropZone and embeds its own photo drop zone. The full run/result
 * pipeline stays: with a photo present the sticky Run CTA is the
 * export path; without one the surface's own export button spawns the
 * same worker (write-pdf pattern).
 *
 * Scope (honest v1): 8 templates (7 designed + blank with custom
 * colour), A6/A5/4×6 flat + A4 folded print layout, CSV mail merge
 * ({{column}}, ≤200 rows, ≤2 MB), one optional front-cover photo,
 * PDF + JPG/PNG export. Envelope addressing and QR codes are not
 * included.
 */
export const config: ToolConfig = {
  toolId: "create-card",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 8,
  fullWidthSurface: true,
  landingSurface: true,
  options: [],
  howKeys: ["card.how1", "card.how2", "card.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "Eight templates — Diwali, Holi, Raksha Bandhan, New Year, birthday, wedding, thank-you, plus a blank card in any colour.",
      hi: "आठ टेम्पलेट — दीपावली, होली, रक्षा बंधन, नया साल, जन्मदिन, शादी, धन्यवाद और किसी भी रंग में ख़ाली कार्ड।",
    },
    {
      en: "Flat A6, A5 and 4×6 postcard sizes, or an A4 sheet folded once into an A5 card — portrait or landscape.",
      hi: "फ़्लैट A6, A5 और 4×6 पोस्टकार्ड, या एक बार फ़ोल्ड होकर A5 कार्ड बनने वाली A4 शीट — पोर्ट्रेट या लैंडस्केप।",
    },
    {
      en: "Write in English or Hindi everywhere — headlines shrink to fit and long messages wrap with an honest cut-short warning.",
      hi: "हर जगह अंग्रेज़ी या हिंदी में लिखें — शीर्षक अपने आप फ़िट होता है और लंबा संदेश लपेटता है, कटने पर सच्ची चेतावनी मिलती है।",
    },
    {
      en: "CSV mail merge: write {{name}} in any field and one card per row comes out — up to 200 recipients.",
      hi: "CSV मेल मर्ज: किसी भी फ़ील्ड में {{name}} लिखें और हर पंक्ति के लिए एक कार्ड बने — 200 प्राप्तकर्ताओं तक।",
    },
    {
      en: "Add an optional photo to the front cover, then export a print-ready PDF or page 1 as JPG/PNG — all on your device.",
      hi: "सामने के कवर में वैकल्पिक तस्वीर जोड़ें, फिर प्रिंट-रेडी PDF या पेज 1 को JPG/PNG में निकालें — सब आपके डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "How do I print the folded A4 card?",
        hi: "फ़ोल्ड वाला A4 कार्ड कैसे प्रिंट करें?",
      },
      a: {
        en: "The PDF has two pages per card: page 1 is the outside (back cover on the left half, front cover on the right) and page 2 is the inside. Print page 1, re-insert the sheet so page 2 prints on the blank side in the same orientation, then fold at the middle line. Printers differ in which duplex flip they need, so do a TEST PRINT on plain paper first.",
        hi: "PDF में हर कार्ड के दो पेज होते हैं: पेज 1 बाहरी भाग (बाएँ आधे में पिछला कवर, दाएँ में सामने का कवर) और पेज 2 अंदर का भाग। पेज 1 प्रिंट करें, शीट वैसी ही रखकर दोबारा डालें ताकि पेज 2 ख़ाली सतह पर उसी दिशा में छपे, फिर बीच की रेखा पर मोड़ें। हर प्रिंटर का डुप्लेक्स फ़्लिप अलग होता है, इसलिए पहले सादे काग़ज़ पर टेस्ट प्रिंट ज़रूर लें।",
      },
    },
    {
      q: {
        en: "How does the CSV mail merge work?",
        hi: "CSV मेल मर्ज कैसे काम करता है?",
      },
      a: {
        en: "Attach a CSV (drop it or paste the text) whose first row is column names, then write {{column}} in any text field — for example \"Dear {{name}}\". Each data row becomes one card. Limits: up to 200 rows, files up to 2 MB, and column names match exactly (case-sensitive). An unknown column name stops the export with a list of the offenders.",
        hi: "ऐसी CSV जोड़ें (छोड़ें या टेक्स्ट पेस्ट करें) जिसकी पहली पंक्ति कॉलम के नाम हों, फिर किसी भी टेक्स्ट फ़ील्ड में {{column}} लिखें — जैसे \"प्रिय {{name}}\"। हर पंक्ति का एक कार्ड बनता है। सीमाएँ: 200 पंक्तियाँ तक, फ़ाइल 2 MB तक, और कॉलम नाम बिल्कुल सटीक (केस-सेंसिटिव) मिलते हैं। अनजाना कॉलम मिलने पर एक्सपोर्ट रुक जाता है और नाम दिखते हैं।",
      },
    },
    {
      q: {
        en: "What happens to my photo's quality?",
        hi: "मेरी तस्वीर की क्वालिटी का क्या होता है?",
      },
      a: {
        en: "A card is a raster composition, so the photo is re-encoded exactly once — JPEG quality 0.92 at about 144 DPI on the page — the same single re-compression used by the photo collage and rotated photos in Images to PDF. Nothing is re-compressed a second time.",
        hi: "कार्ड एक रेस्टर कंपोज़िशन है, इसलिए तस्वीर ठीक एक बार दोबारा एनकोड होती है — JPEG क्वालिटी 0.92, पेज पर करीब 144 DPI — वही एक बार का री-कंप्रेशन जो फ़ोटो कोलाज और Images to PDF की घुमाई तस्वीरों पर लगता है। दूसरी बार कुछ नहीं होता।",
      },
    },
  ],
};
