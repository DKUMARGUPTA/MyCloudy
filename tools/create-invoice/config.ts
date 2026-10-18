import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create invoice (P3-INVOICE — the 64th tool). Built from the user's own
 * standalone invoice-generator (upload/invoice-generator.zip): the same
 * 39-template catalog, the same paise-integer tax engine (pro-rata
 * discount with last-item remainder, CGST/SGST split, round-off, amount
 * in words, GSTIN checksum) and the same A4 sheet design — rebuilt as a
 * DocoPDF tool.
 *
 * Changes for proper integration (vs. the standalone app):
 *  - PDF export: html2pdf.js from a CDN → our pdf-lib worker. The
 *    invoice PDF is now REAL vector text (selectable, crisp, ~10×
 *    smaller) drawn with the self-hosted Noto Sans Devanagari — the one
 *    font that covers ₹ + Latin + हिंदी — and it works offline, keeping
 *    the 100% on-device promise (Mode D, zero external requests).
 *  - The UPI QR is drawn as vector rectangles from the qrcode matrix
 *    (the same npm engine as Generate QR code), not a raster screenshot.
 *  - Language follows the app locale; the standalone app's per-tool
 *    EN/हिंदी toggle is gone. Every label — including the 39 type
 *    names, extra header fields and column labels that stayed English
 *    in the standalone हिंदी UI — is now translated.
 *  - Block reordering keeps the HTML5 drag of the original AND adds
 *    ▲/▼ buttons so touch users can reorder too (≥44 px targets).
 *
 * landingSurface (create-card / write-pdf precedent): no files needed,
 * the whole workspace renders on the landing page in place of the
 * DropZone; the surface's own "Save as PDF" button spawns the worker.
 */
export const config: ToolConfig = {
  toolId: "create-invoice",
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
  howKeys: ["invoice.how1", "invoice.how2", "invoice.how3"],
  chainToolIds: ["view-pdf", "compress-pdf"],
  features: [
    {
      en: "39 templates in one tool — GST tax invoice, bill of supply, export invoice, credit and debit notes, proforma, quotation, estimate, purchase order, receipts, and trade-specific bills from pharmacy to hotel.",
      hi: "एक टूल में 39 टेम्पलेट — GST टैक्स इनवॉइस, बिल ऑफ़ सप्लाई, एक्सपोर्ट इनवॉइस, क्रेडिट और डेबिट नोट, प्रोफ़ॉर्मा, कोटेशन, अनुमान, परचेज़ ऑर्डर, रसीदें, और फ़ार्मेसी से होटल तक के पेशेवर बिल।",
    },
    {
      en: "India-ready GST maths: CGST + SGST or IGST split decided by your state and place of supply, per-item GST rates and HSN/SAC, discount before tax (flat or %) shared fairly across items, and round-off to a whole rupee.",
      hi: "भारत के लिए GST गणित: आपके राज्य और आपूर्ति के स्थान से CGST + SGST या IGST का बँटवारा, हर आइटम पर GST दर और HSN/SAC, कर से पहले छूट (सीधी या %) का आइटमों में न्यायसंगत बँटवारा, और पूर्ण रुपये में राउंड ऑफ़।",
    },
    {
      en: "Every money value is computed in integer paise and shown live — subtotal, taxable value, taxes, total and the amount in words (Crore/Lakh for ₹, Billion/Million for $ € £) can never disagree.",
      hi: "हर राशि पूर्णांक पैसे में गिनी जाती है और तुरंत दिखती है — उप-योग, कर योग्य मूल्य, कर, कुल योग और शब्दों में राशि (₹ में करोड़/लाख, $ € £ में बिलियन/मिलियन) में कभी अंतर नहीं हो सकता।",
    },
    {
      en: "GST helper checks as you type: GSTIN checksum validation, state-code match, HSN/SAC digit check, unusual-rate alerts and the ₹50,000 e-way bill reminder for goods.",
      hi: "टाइपते ही GST जाँच: GSTIN चेकसम की पुष्टि, राज्य-कोड मिलान, HSN/SAC अंक जाँच, असामान्य दर की चेतावनी और ₹50,000 से ऊपर माल के लिए ई-वे बिल रिमाइंडर।",
    },
    {
      en: "UPI QR code on the invoice (scannable in any UPI app), logo and signature images, an accent colour, drag-to-reorder sheet sections, saved invoices and your business profile — all stored only in this browser.",
      hi: "इनवॉइस पर UPI QR कोड (किसी भी UPI ऐप में स्कैन होता है), लोगो और हस्ताक्षर की छवियाँ, एक्सेंट रंग, खींचकर क्रम बदलने वाले सेक्शन, सेव किए इनवॉइस और आपकी व्यवसाय प्रोफ़ाइल — सब सिर्फ़ इसी ब्राउज़र में।",
    },
    {
      en: "Download a true vector PDF (selectable text, not a screenshot) with हिंदी or English labels, or print straight from the browser — no watermark, no sign-up, no server.",
      hi: "असली वेक्टर PDF डाउनलोड करें (चुनने योग्य टेक्स्ट, स्क्रीनशॉट नहीं) — हिंदी या अंग्रेज़ी लेबलों के साथ, या सीधे ब्राउज़र से प्रिंट करें — कोई वॉटरमार्क नहीं, साइन-अप नहीं, सर्वर नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which invoice type should I use?",
        hi: "मुझे कौन सा इनवॉइस प्रकार चुनना चाहिए?",
      },
      a: {
        en: "Use a GST tax invoice for taxable sales by a GST-registered seller, a bill of supply for exempt or composition supplies, a proforma invoice or quotation before the sale, and a credit or debit note to correct an invoice later. For other work, pick the template closest to your trade — the maths is identical; only the labels and extra fields change.",
        hi: "GST-पंजीकृत विक्रेता की कर योग्य बिक्री के लिए GST टैक्स इनवॉइस, छूट या कंपोज़िशन आपूर्ति के लिए बिल ऑफ़ सप्लाई, बिक्री से पहले प्रोफ़ॉर्मा इनवॉइस या कोटेशन, और बाद में सुधार के लिए क्रेडिट या डेबिट नोट। बाकी कामों के लिए अपने पेशे के सबसे क़रीब का टेम्पलेट चुनें — गणित बिल्कुल वही रहता है; सिर्फ़ लेबल और अतिरिक्त फ़ील्ड बदलते हैं।",
      },
    },
    {
      q: {
        en: "How do CGST, SGST and IGST get decided?",
        hi: "CGST, SGST और IGST कैसे तय होते हैं?",
      },
      a: {
        en: "By your state and the place of supply you select: same state splits the GST rate into CGST + SGST (half each), different states charge IGST at the full rate. If either is blank the tool treats the supply as intra-state, exactly like the printed hint says.",
        hi: "आपके चुने राज्य और आपूर्ति के स्थान से: समान राज्य में GST दर CGST + SGST (आधी-आधी) में बँटती है, अलग राज्य में पूरी दर का IGST लगता है। कोई एक भी ख़ाली हो तो टूल उसे राज्य-भीतर की आपूर्ति मानता है — बिल्कुल वैसे ही जैसा छपा संकेत कहता है।",
      },
    },
    {
      q: {
        en: "Where does my data go?",
        hi: "मेरा डेटा कहाँ जाता है?",
      },
      a: {
        en: "Nowhere. The whole tool runs in your browser: the PDF is assembled on your device by a worker thread, your business profile and saved invoices (up to 50) live in this browser's local storage, and no network request is ever made.",
        hi: "कहीं नहीं। पूरा टूल आपके ब्राउज़र में चलता है: PDF एक वर्कर थ्रेड आपके ही डिवाइस पर बनाता है, आपकी व्यवसाय प्रोफ़ाइल और सेव किए इनवॉइस (50 तक) इसी ब्राउज़र के लोकल स्टोरेज में रहते हैं, और कोई नेटवर्क रिक्वेस्ट कभी नहीं होती।",
      },
    },
    {
      q: {
        en: "What happens when I click New invoice?",
        hi: "नया इनवॉइस दबाने पर क्या होता है?",
      },
      a: {
        en: "The client, items and notes are cleared, the date resets to today and the number bumps the trailing digits (INV/25-26/004 → 005), separately for each template. Your business profile, saved invoices and design settings stay.",
        hi: "ग्राहक, आइटम और टिप्पणियाँ साफ़ हो जाती हैं, तिथि आज की हो जाती है और नंबर के आख़िरी अंक बढ़ जाते हैं (INV/25-26/004 → 005) — हर टेम्पलेट के लिए अलग से। आपकी व्यवसाय प्रोफ़ाइल, सेव किए इनवॉइस और डिज़ाइन सेटिंग बनी रहती हैं।",
      },
    },
  ],
};
