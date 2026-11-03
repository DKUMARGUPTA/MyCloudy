import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Scan QR code (QR & Barcodes category) — a no-file, surface-first tool:
 * the surface embeds its own image drop zone (like Generate QR's CSV
 * batch input) and decodes entirely on-device with jsQR + a canvas.
 * Decoded payloads are explained (WiFi, UPI, vCard, links…) with a copy
 * button — nothing ever leaves the browser.
 */
export const config: ToolConfig = {
  toolId: "scan-qr-code",
  noFile: true,
  howKeys: ["scanqr.how1", "scanqr.how2", "scanqr.how3"],
  minFiles: 0,
  maxFiles: 0,
  options: [],
  features: [
    {
      en: "Drop a photo, screenshot or scan — the QR inside is decoded on this device by the same math phone scanners use, inverted colors included.",
      hi: "फ़ोटो, स्क्रीनशॉट या स्कैन छोड़ें — उसमें छिपा QR इसी डिवाइस पर उसी गणित से पढ़ा जाता है जो फ़ोन के स्कैनर इस्तेमाल करते हैं, उल्टे रंग भी।",
    },
    {
      en: "Not just raw text: WiFi logins, UPI payment details, vCard contacts, WhatsApp chats, emails and locations are broken into labelled fields.",
      hi: "सिर्फ़ कच्चा टेक्स्ट नहीं: WiFi लॉगिन, UPI पेमेंट की जानकारी, vCard संपर्क, WhatsApp चैट, ईमेल और लोकेशन — सब नाम लगे खानों में।",
    },
    {
      en: "One tap copies the payload; links open in a new tab only when you choose to — the scanner never navigates by itself.",
      hi: "एक टैप में पूरा पेलोड कॉपी; लिंक तभी नए टैब में खुलता है जब आप चुनें — स्कैनर अपने आप कहीं नहीं जाता।",
    },
    {
      en: "Sharp-image friendly: big posters and tiny corner codes both decode, with inverted attempts for white-on-black codes.",
      hi: "साफ़ तस्वीरों के लिए बना: बड़े पोस्टर और कोने में छिपे छोटे कोड दोनों पढ़े जाते हैं, सफ़ेद-पर-काले कोड के लिए उल्टी कोशिश भी।",
    },
    {
      en: "Honest when nothing is found — a clear message tells you to try a tighter crop or a sharper shot instead of guessing.",
      hi: "कुछ न मिले तो ईमानदारी से बताया जाता है — करीब से काटी तस्वीर या साफ़ शॉट लेने की सलाह, अंदाज़ा नहीं।",
    },
    {
      en: "Your images stay where they are — decoding happens in the page, with no upload, no account and no history.",
      hi: "आपकी तस्वीरें वहीं रहती हैं — पढ़ाई पेज के अंदर होती है, न अपलोड, न अकाउंट, न इतिहास।",
    },
  ],
  faq: [
    {
      q: {
        en: "What image formats can I scan?",
        hi: "कौन-से इमेज फ़ॉर्मैट स्कैन हो सकते हैं?",
      },
      a: {
        en: "Anything your browser can draw to a canvas: JPG, PNG, WEBP, GIF, BMP, HEIC (Chrome and Safari), even SVG screenshots. If it renders, it scans.",
        hi: "जो कुछ भी ब्राउज़र कैनवास पर बना सके: JPG, PNG, WEBP, GIF, BMP, HEIC (Chrome और Safari), SVG स्क्रीनशॉट तक। जो दिखे, वही स्कैन होगा।",
      },
    },
    {
      q: {
        en: "The scan says no QR found but I can see one — what now?",
        hi: "स्कैन कहता है कुछ नहीं मिला पर कोड दिख रहा है — अब क्या करूँ?",
      },
      a: {
        en: "Usually blur or glare. Try cropping tightly around the code, avoid flash reflections, and make sure the code is not physically damaged. A screenshot of the code decodes perfectly — that is the fastest check that the code itself is valid.",
        hi: "आम तौर पर धुँधलापन या चमक। कोड के इर्द-गिर्द से सिर्फ़ कोड काट लें, फ़्लैश की चमक से बचें, और देखें कि कोड फटा तो नहीं है। कोड का स्क्रीनशॉट परफ़ेक्ट पढ़ा जाता है — कोड ख़ुद सही है या नहीं, यह जानने का सबसे तेज़ तरीका यही है।",
      },
    },
    {
      q: {
        en: "Is it safe to scan payment QR codes here?",
        hi: "क्या यहाँ पेमेंट QR स्कैन करना सुरक्षित है?",
      },
      a: {
        en: "Yes — the image never leaves your device, so the UPI ID, payee name and amount are shown only to you. Read the payee name carefully before paying anywhere; a QR can only pre-fill a payment, it cannot pull money from you.",
        hi: "हाँ — तस्वीर आपके डिवाइस से बाहर नहीं जाती, इसलिए UPI ID, पाने वाले का नाम और रक़म सिर्फ़ आपको दिखती है। कहीं भी पेमेंट से पहले पाने वाले का नाम ध्यान से पढ़ें; QR पेमेंट की जानकारी भर सकता है, आपसे पैसे खींच नहीं सकता।",
      },
    },
    {
      q: {
        en: "Does it read barcodes too?",
        hi: "क्या यह बारकोड भी पढ़ता है?",
      },
      a: {
        en: "This scanner reads QR codes (the square ones). The 1D retail barcodes — EAN, UPC, Code 128 and friends — need a different decoder; use the Generate barcode tool to create those, or a store's till scanner to read them.",
        hi: "यह स्कैनर QR कोड (चौकोर वाले) पढ़ता है। दुकानों वाले 1D बारकोड — EAN, UPC, Code 128 आदि — के लिए अलग डिकोडर चाहिए; उन्हें बनाने के लिए बारकोड बनाएँ टूल देखें, पढ़ने के लिए दुकान का स्कैनर।",
      },
    },
  ],
};
