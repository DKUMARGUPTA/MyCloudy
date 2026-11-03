import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Generate barcode (QR & Barcodes category) — a no-file, surface-first
 * tool like Generate QR code: `noFile` renders the surface directly on
 * the landing page in place of the DropZone. The surface owns the six
 * retail symbologies (Code 128, EAN-13, EAN-8, UPC-A, Code 39, ITF),
 * live preview, print controls and the PNG/SVG/PDF downloads — all via
 * the own barcode engine (src/lib/own/barcode), nothing uploaded.
 */
export const config: ToolConfig = {
  toolId: "generate-barcode",
  noFile: true,
  howKeys: ["barcode.how1", "barcode.how2", "barcode.how3"],
  minFiles: 0,
  maxFiles: 0,
  options: [],
  features: [
    {
      en: "Six retail-grade symbologies in one place — Code 128 for parcels and licences, EAN-13/EAN-8/UPC-A for shop shelves, Code 39 for IDs, ITF for cartons.",
      hi: "एक ही जगह छह तरह के बारकोड — कूरियर और लाइसेंस के लिए Code 128, दुकान के शेल्फ़ के लिए EAN-13/EAN-8/UPC-A, पहचान के लिए Code 39, गोदाम के डिब्बों के लिए ITF।",
    },
    {
      en: "Check digits are computed for you — type 12 digits of an EAN-13 and the 13th appears; type all 13 and a wrong digit is caught honestly before you print.",
      hi: "चेक डिजिट अपने आप बनता है — EAN-13 के 12 अंक लिखिए तेरहवाँ अपने आप जुड़ता है; पूरे 13 लिखें और ग़लत अंक छपने से पहले ही पकड़ में आता है।",
    },
    {
      en: "Live preview with honest validation, adjustable bar height and module width, your colors, and the human-readable line you can switch off.",
      hi: "लाइव प्रीव्यू, ईमानदार वैलिडेशन, बार की ऊँचाई और मॉड्यूल चौड़ाई की सेटिंग, आपके रंग, और नीचे लिखा टेक्स्ट जिसे आप बंद भी कर सकते हैं।",
    },
    {
      en: "Download as pixel-sharp PNG, vector SVG or a print-ready PDF with real text — rendered on this device by our own engine, nothing uploaded anywhere.",
      hi: "साफ़ PNG, वेक्टर SVG या असली टेक्स्ट वाली प्रिंट-रेडी PDF — सब इसी डिवाइस पर हमारे अपने इंजन से बनता है, कुछ भी अपलोड नहीं होता।",
    },
    {
      en: "Quiet zones follow each symbology's spec (11 modules for EAN-13, 9 for UPC-A…) so the code scans on the first try, not the third.",
      hi: "हर बारकोड का क्वाइट ज़ोन उसकी स्पेक के हिसाब से (EAN-13 के लिए 11 मॉड्यूल, UPC-A के लिए 9…) ताकि कोड पहली ही बार में स्कैन हो।",
    },
    {
      en: "ITF pairs digits the GS1 way (2.5:1 bars) and Code 128 auto-switches between the B and C submodes to keep your codes as narrow as possible.",
      hi: "ITF अंकों के जोड़े GS1 तरीके से बनाता है (2.5:1 बार) और Code 128 अपने आप B और C सबमोड चुनकर कोड को जितना हो सके पतला रखता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which format should I pick?",
        hi: "कौन-सा फ़ॉर्मैट चुनूँ?",
      },
      a: {
        en: "Selling in shops that scan at the till? EAN-13 (India/EU) or UPC-A (US) — the store's system expects exactly these. Couriers, licences and asset tags usually want Code 128. Older ID badges use Code 39, and shipping cartons often use ITF. When in doubt, ask whoever will scan it.",
        hi: "दुकान के काउंटर पर स्कैन होना है? EAN-13 (भारत/यूरोप) या UPC-A (अमेरिका) — दुकान का सिस्टम बस यही दो पहचानता है। कूरियर, लाइसेंस और एसेट टैग में आम तौर पर Code 128 चलता है। पुराने ID बैज Code 39 में होते हैं और भेजने के डिब्बों पर ITF। शक हो तो जो स्कैन करेगा उसी से पूछ लें।",
      },
    },
    {
      q: {
        en: "Why is my EAN-13 showing an error on the last digit?",
        hi: "मेरे EAN-13 के आख़िरी अंक पर ग़लती क्यों दिख रही है?",
      },
      a: {
        en: "That digit is a checksum the standard fixes mathematically. If the 13 digits you pasted came from a real product the digit is simply mistyped — fix the 12 data digits and the right check digit is recomputed live. If you only have 12 digits, leave it at that: we add the correct 13th for you.",
        hi: "वह अंक चेकसम है जिसे मानक गणित के हिसाब से तय करता है। अगर आपके 13 अंक किसी असली प्रोडक्ट के हैं तो बस टाइपिंग की ग़लती है — 12 अंक ठीक करते ही सही चेक डिजिट अपने आप बन जाता है। अगर आपके पास सिर्फ़ 12 अंक हैं तो वैसे ही छोड़ दें: तेरहवाँ हम सही जोड़ देते हैं।",
      },
    },
    {
      q: {
        en: "Are these barcodes really scannable?",
        hi: "क्या ये बारकोड सच में स्कैन हो जाते हैं?",
      },
      a: {
        en: "Yes — the bar patterns are encoded to the ISO tables and cross-verified bit-for-bit against a reference implementation before every release. Keep the default black-on-white, leave the quiet zone on, and print at a size where the narrowest bar is at least 0.19 mm (normal 300 dpi print easily clears this).",
        hi: "हाँ — बार के पैटर्न ISO टेबल से बनते हैं और हर रिलीज़़ से पहले एक रेफ़रेंस इंप्लीमेंटेशन से बिट-दर-बिट मिलाकर जाँचे जाते हैं। काले-पर-सफ़ेद रंग और क्वाइट ज़ोन वैसे ही रखें, और इतने आकार में छापें कि सबसे पतला बार कम-से-कम 0.19 मिमी हो (300 dpi प्रिंट में यह आसानी से पूरा होता है)।",
      },
    },
    {
      q: {
        en: "What is the difference between the PNG, SVG and PDF downloads?",
        hi: "PNG, SVG और PDF डाउनलोड में क्या फ़र्क़ है?",
      },
      a: {
        en: "PNG is a raster image for slides and chat apps — pixel-sharp at the size shown. SVG is a vector that stays crisp at any size, ideal for designers. The PDF draws the bars as vector rectangles with real selectable text underneath — the format label printers and print shops prefer.",
        hi: "PNG स्लाइड और चैट के लिए रास्टर इमेज है — दिखाए आकार में बिल्कुल साफ़। SVG वेक्टर है जो किसी भी आकार में नहीं बिगड़ता, डिज़ाइनरों के लिए। PDF में बार वेक्टर आयतों से बनते हैं और नीचे असली चुनने योग्य टेक्स्ट होता है — लेबल प्रिंटर और प्रिंट शॉप इसी को पसंद करते हैं।",
      },
    },
  ],
};
