import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Generate QR code (PRD §7.7 / §8.7) — a no-file, surface-first tool like
 * Generate password: `noFile` renders the surface directly on the landing
 * page in place of the DropZone (no run CTA, no options aside, no
 * processing/result phases), and the surface owns every control: the eight
 * payload kinds, live preview, colors, logo and the PNG/SVG/PDF downloads.
 */
export const config: ToolConfig = {
  toolId: "generate-qr-code",
  noFile: true,
  howKeys: ["qr.how1", "qr.how2", "qr.how3"],
  minFiles: 0,
  maxFiles: 0,
  options: [],
  features: [
    {
      en: "Eight kinds in one place — link, plain text, WiFi login, UPI payment, vCard contact, email, phone and WhatsApp chat.",
      hi: "एक ही जगह आठ तरह के QR — लिंक, सादा टेक्स्ट, WiFi लॉगिन, UPI पेमेंट, vCard संपर्क, ईमेल, फ़ोन और WhatsApp चैट।",
    },
    {
      en: "Batch mode: drop a CSV (up to 200 rows) and get one QR per row in a single ZIP of PNGs, named from the second column or the row number.",
      hi: "बैच मोड: CSV छोड़ें (200 पंक्तियाँ तक) और हर पंक्ति का एक QR, सब एक ZIP में PNG के रूप में — नाम दूसरे कॉलम से या पंक्ति-नंबर से।",
    },
    {
      en: "Live preview as you type, with honest validation — the download buttons stay off until the payload actually scans.",
      hi: "टाइप करते ही लाइव प्रीव्यू, ईमानदार वैलिडेशन के साथ — पेलोड असल में स्कैन होने लायक़ हो तभी डाउनलोड बटन चालू होते हैं।",
    },
    {
      en: "Your colors, your quiet zone, four error-correction levels — and a center logo that automatically forces the highest (H) correction.",
      hi: "आपके रंग, आपका क्वाइट ज़ोन, चार एरर-करेक्शन लेवल — और बीच में लोगो लगाने पर सबसे ऊँचा (H) करेक्शन अपने आप लग जाता है।",
    },
    {
      en: "Download as PNG, crisp vector SVG or print-ready PDF — rendered on this device, nothing uploaded anywhere.",
      hi: "PNG, साफ़ वेक्टर SVG या प्रिंट-रेडी PDF में डाउनलोड — सब इसी डिवाइस पर बनता है, कुछ भी अपलोड नहीं होता।",
    },
    {
      en: "A contrast meter watches your color choices and warns before a scanner could struggle.",
      hi: "कंट्रास्ट मीटर आपके रंगों पर नज़र रखता है और स्कैनर को दिक़्क़त होने से पहले ही चेता देता है।",
    },
  ],
  faq: [
    {
      q: {
        en: "What does the CSV batch mode expect?",
        hi: "CSV बैच मोड में क्या चाहिए?",
      },
      a: {
        en: "A plain CSV with no header row: column 1 is the QR content or link, column 2 (optional) is the PNG file name. Blank or over-long rows are skipped and counted honestly; up to 200 rows and 2 MB. Every QR uses the colors, size, quiet zone and logo you set above, and same-named rows get -2, -3 suffixes in the ZIP.",
        hi: "बिना हेडर वाली सादी CSV: कॉलम 1 में QR कंटेंट या लिंक, कॉलम 2 (वैकल्पिक) में PNG फ़ाइल का नाम। खाली या बहुत लंबी पंक्तियाँ छोड़ दी जाती हैं और ईमानदारी से गिनी जाती हैं; 200 पंक्तियाँ और 2 MB तक। हर QR ऊपर सेट किए रंगों, आकार, क्वाइट ज़ोन और लोगो से बनता है, और एक जैसे नामों को ZIP में -2, -3 जुड़ जाता है।",
      },
    },
    {
      q: {
        en: "What can I put in a QR code?",
        hi: "QR कोड में क्या-क्या डाल सकते हैं?",
      },
      a: {
        en: "Anything text, but the eight kinds here give scanners a head start: a URL opens the browser, WIFI joins a network, upi://pay opens any UPI app with the payee pre-filled, a vCard saves straight to contacts, and mailto:/tel:/wa.me links open the right app.",
        hi: "कोई भी टेक्स्ट चलता है, पर यहाँ के आठ तरह स्कैनर का काम आसान करते हैं: URL ब्राउज़र खोलता है, WIFI नेटवर्क से जोड़ता है, upi://pay किसी भी UPI ऐप में पाने वाले की जानकारी भर देता है, vCard सीधे संपर्कों में सेव होता है, और mailto:/tel:/wa.me लिंक सही ऐप खोलते हैं।",
      },
    },
    {
      q: {
        en: "Why is error correction forced to H when I add a logo?",
        hi: "लोगो लगाने पर एरर करेक्शन H क्यों हो जाता है?",
      },
      a: {
        en: "Honesty about the math: a logo covers some modules in the middle of the code. Level H can rebuild the data from the remaining ~70%, so the code keeps scanning; at level L the same logo could make it unreadable. The SVG export stays logo-free for exactly this reason — a vector code should be complete.",
        hi: "हिसाब में ईमानदारी: लोगो कोड के बीच के कुछ मॉड्यूल ढक देता है। लेवल H बचे हुए ~70% से डेटा दोबारा बना सकता है, इसलिए कोड स्कैन होता रहता है; लेवल L पर वही लोगो उसे बेकार कर सकता है। SVG एक्सपोर्ट इसी वजह से लोगो-फ़्री रहता है — वेक्टर कोड पूरा होना चाहिए।",
      },
    },
    {
      q: {
        en: "My colors warn about contrast — does that matter?",
        hi: "मेरे रंगों पर कंट्रास्ट की चेतावनी आती है — क्या यह ज़रूरी है?",
      },
      a: {
        en: "Yes. Phone cameras need the dark and light areas to clearly differ — a ratio of about 3:1 or better. Dark foreground on a light background is the safest choice; the meter uses the same WCAG math browsers use for text.",
        hi: "हाँ। फ़ोन कैमरे को गहरे और हल्के हिस्सों में साफ़ फ़र्क़ चाहिए — करीब 3:1 या उससे बेहतर। हल्के बैकग्राउंड पर गहरा फ़ोरग्राउंड सबसे सुरक्षित है; मीटर वही WCAG हिसाब इस्तेमाल करता है जो ब्राउज़र टेक्स्ट के लिए करते हैं।",
      },
    },
  ],
};
