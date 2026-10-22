import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create invoice visually (RB5-a) — the WYSIWYG invoice designer,
 * 100% on-device (mode D), EN + हिंदी.
 *
 * The free-layout COMPLEMENT to create-invoice (the GST-ready form
 * tool): here you drag the blocks themselves on a fixed A4 portrait
 * canvas — company header, bill-to, the items table, totals, footer
 * notes, extra text blocks and a logo slot — and the exported vector
 * PDF reproduces that exact layout (canvas px → pt ×72/96).
 *
 * Honest scope (mirrored in the FAQ):
 *  - fixed A4 portrait, always exactly ONE page;
 *  - four element kinds only — no arbitrary shapes, no lines you draw
 *    by hand, no background images;
 *  - ONE tax percentage for the whole invoice (this is not the GST
 *    engine — for CGST/SGST/IGST, HSN and state logic use
 *    create-invoice);
 *  - everything re-verified on a real print/PDF before you send it.
 */
export const config: ToolConfig = {
  toolId: "create-invoice-visually",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 0,
  fullWidthSurface: true,
  landingSurface: true,
  options: [],
  howKeys: ["civ.how1", "civ.how2", "civ.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "True drag-and-drop design: every block — company header, bill-to, items table, totals, footer notes, your own text blocks and the logo slot — moves on a fixed A4 canvas, snapping to a clean 8 pt grid.",
      hi: "असली ड्रैग-एंड-ड्रॉप डिज़ाइन: हर ब्लॉक — कंपनी हेडर, बिल स्वीकारकर्ता, आइटम टेबल, कुल योग, फ़ुटर नोट्स, आपके अपने टेक्स्ट ब्लॉक और लोगो स्लॉट — तय A4 कैनवास पर खिसकता है, साफ़ 8 pt ग्रिड पर स्नैप होकर।",
    },
    {
      en: "Edit text right on the page: click a block and type in English or हिंदी, with font size, bold, italic, colour and alignment in a small toolbar; amounts are always computed for you (qty × rate, subtotal, tax %, grand total).",
      hi: "टेक्स्ट सीधे पेज पर एडिट करें: किसी ब्लॉक पर क्लिक करके अंग्रेज़ी या हिंदी में टाइप करें — छोटे टूलबार में फ़ॉन्ट साइज़, बोल्ड, इटैलिक, रंग और अलाइनमेंट; रकमें हमेशा आपके लिए गणना होती हैं (गुणता × दर, उप-योग, कर %, कुल योग)।",
    },
    {
      en: "The exported PDF is a true vector file drawn at your exact canvas positions — selectable text, a real embedded logo (PNG/JPEG), and the self-hosted Noto font only when हिंदी (or ₹) needs it.",
      hi: "एक्सपोर्ट हुई PDF सच्ची वेक्टर फ़ाइल है, आपकी सटीक कैनवास स्थितियों पर बनी — चुनने योग्य टेक्स्ट, असली एम्बेडेड लोगो (PNG/JPEG), और सेल्फ़-होस्टेड Noto फ़ॉन्ट सिर्फ़ तब जब हिंदी (या ₹) को ज़रूरत हो।",
    },
    {
      en: "Your design stays on this device — the draft auto-saves in this browser and the PDF is assembled by a worker thread right here. Nothing is uploaded, ever.",
      hi: "आपका डिज़ाइन इसी डिवाइस पर रहता है — ड्राफ़्ट अपने आप इसी ब्राउज़र में सेव होता है और PDF यहीं वर्कर थ्रेड से बनती है। कुछ भी अपलोड नहीं होता।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is NOT supported — the honest list?",
        hi: "क्या सपोर्ट नहीं है — ईमानदार सूची?",
      },
      a: {
        en: "This designer deliberately stays small and reliable: the page is always fixed A4 portrait and always exactly one page (long item lists will overflow — split your invoice instead); there are no arbitrary shapes, no hand-drawn lines, no background images, no columns; the tax is a single percentage for the whole invoice (no CGST/SGST/IGST split — use the Create invoice tool for the full GST engine); and the logo must be PNG or JPEG (an SVG stays crisp on websites but this PDF renderer embeds raster images only — convert it first).",
        hi: "यह डिज़ाइनर जान-बूझकर छोटा और भरोसेमंद रहता है: पेज हमेशा तय A4 पोर्ट्रेट है और हमेशा ठीक एक पेज (लंबी आइटम सूची बाहर निकल जाएगी — इनवॉइस बाँट दें); कोई आर्बिट्रेरी शेप नहीं, हाथ से खिंची लाइनें नहीं, बैकग्राउंड इमेज नहीं, कॉलम नहीं; कर पूरे इनवॉइस का एक ही प्रतिशत है (CGST/SGST/IGST विभाजन नहीं — पूरे GST इंजन के लिए Create invoice टूल इस्तेमाल करें); और लोगो PNG या JPEG होना चाहिए (SVG वेबसाइट पर क्रिस्प रहता है पर यह PDF रेंडरर सिर्फ़ रास्टर इमेज एम्बेड करता है — पहले बदल लें)।",
      },
    },
    {
      q: {
        en: "Does the PDF really match what I arranged on the canvas?",
        hi: "क्या PDF सच में उसी लेआउट की होती है जो मैंने कैनवास पर बनाया?",
      },
      a: {
        en: "Yes — every element's position and size on the fixed A4 canvas maps 1:1 into the PDF (canvas pixels × 72/96 = exact PDF points), the drag snapping uses a clean 8 pt grid, and money is recomputed from the items, never trusted from the screen. Two honest notes: long single words are never squeezed into a narrow text block (they draw wide), and the preview's browser fonts can differ by a hair from the PDF fonts — so before sending an important invoice, open the downloaded PDF (or print it) and give it one final look.",
        hi: "हाँ — तय A4 कैनवास पर हर एलिमेंट की स्थिति और साइज़ PDF में 1:1 मैप होती है (कैनवास पिक्सेल × 72/96 = सटीक PDF पॉइंट), ड्रैग स्नैपिंग साफ़ 8 pt ग्रिड पर है, और रकमें आइटम से दोबारा गणना होती हैं, स्क्रीन से कभी नहीं। दो ईमानदार बातें: लंबे एकल शब्द कभी नहीं निचोड़े जाते तंग टेक्स्ट ब्लॉक में (वे चौड़े छपते हैं), और प्रीव्यू के ब्राउज़र फ़ॉन्ट PDF फ़ॉन्ट से एक बाल के बराबर अलग हो सकते हैं — इसलिए ज़रूरी इनवॉइस भेजने से पहले डाउनलोड की हुई PDF खोलकर (या प्रिंट करके) एक बार देख लें।",
      },
    },
    {
      q: {
        en: "How do हिंदी and the fonts work?",
        hi: "हिंदी और फ़ॉन्ट कैसे काम करते हैं?",
      },
      a: {
        en: "Switch the site language (top of the page) and every label, button and message follows; type हिंदी into any text block and it prints. Latin-only content with a $/€/£/no symbol exports with the built-in Helvetica (no font embedded — small files); the moment any Devanagari character or the ₹ symbol appears, the self-hosted Noto Sans Devanagari subset is embedded instead. Noto ships Regular only, so Hindi bold text keeps its emphasis through size and colour.",
        hi: "साइट की भाषा बदलें (ऊपर) और हर लेबल, बटन और मैसेज उसी भाषा में; किसी भी टेक्स्ट ब्लॉक में हिंदी टाइप करें और वही छपेगी। सिर्फ़ लैटिन सामग्री $/€/£/बिना-चिह्न के बिल्ट-इन Helvetica से निकलती है (कोई फ़ॉन्ट एम्बेड नहीं — छोटी फ़ाइलें); जैसे ही कोई देवनागरी अक्षर या ₹ चिह्न आता है, सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट एम्बेड हो जाता है। Noto में केवल Regular है, इसलिए हिंदी बोल्ड टेक्स्ट का ज़ोर आकार और रंग से बना रहता है।",
      },
    },
    {
      q: {
        en: "Where is my data stored, and what are the limits?",
        hi: "मेरा डेटा कहाँ सेव होता है, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Nowhere but this browser: the design auto-saves as a local draft and the PDF is assembled on your device by a worker thread — no server, no sign-up, no watermark. Limits: up to 40 elements, 30 line items, text blocks up to 2,000 characters, font sizes 6–36 pt, one tax percentage 0–50%, and a logo up to about 1.5 MB as a data URL. The file is named from your invoice number, or invoice-YYYY-MM-DD when you leave it blank.",
        hi: "सिर्फ़ इसी ब्राउज़र में: डिज़ाइन अपने आप लोकल ड्राफ़्ट के रूप में सेव होता है और PDF आपके ही डिवाइस पर वर्कर थ्रेड से बनती है — न सर्वर, न साइन-अप, न वॉटरमार्क। सीमाएँ: 40 एलिमेंट तक, 30 आइटम, टेक्स्ट ब्लॉक 2,000 अक्षरों तक, फ़ॉन्ट साइज़ 6–36 pt, एक कर प्रतिशत 0–50%, और लोगो लगभग 1.5 MB तक का डेटा URL। फ़ाइल का नाम आपके इनवॉइस नंबर से बनता है, या खाली छोड़ने पर invoice-YYYY-MM-DD।",
      },
    },
  ],
};
