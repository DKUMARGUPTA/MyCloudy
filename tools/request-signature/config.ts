import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Request signature (RB6-b — the 92nd tool, security family). The honest
 * ON-DEVICE "prepare & send for signature" pack maker (mode D):
 *
 *  - a multi-step form: request details (recipient, subject, message, due
 *    date) → spot placement by clicking the rendered page thumbnails;
 *  - the run draws numbered dashed "Sign here" placeholder boxes (vector
 *    ink) and lays REAL empty AcroForm signature fields (/FT /Sig) over
 *    each spot — the PDF genuinely signs in Acrobat, browsers, Preview;
 *  - a request-note PDF + plain-text note (subject, message, due date,
 *    the spot list, "open in any PDF signer" instructions);
 *  - a downloadable signing pack (.zip, fflate — assembled in the worker
 *    on the user's device) and a mailto: draft button that opens the
 *    user's OWN mail client. Browsers cannot attach files to a mail
 *    program, so the note says plainly: attach the PDF yourself.
 *
 * There is NO server, NO expiring link, NO upload — the old registry
 * description promised a Pro/server link this tool must never claim.
 */
export const config: ToolConfig = {
  toolId: "request-signature",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "switch",
      id: "sigFields",
      label: {
        en: "Add real signature fields",
        hi: "असली हस्ताक्षर फ़ील्ड जोड़ें",
      },
      hint: {
        en: "Each numbered box also carries an empty PDF signature field — any signer app can fill it. Recommended.",
        hi: "हर नंबर वाले बॉक्स पर एक ख़ाली PDF हस्ताक्षर फ़ील्ड भी बैठता है — कोई भी साइनिंग ऐप उसे भर सकता है। सुझाया गया।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "flattenFirst",
      label: {
        en: "Flatten existing form fields first",
        hi: "पहले मौजूदा फ़ॉर्म फ़ील्ड फ़्लैटन करें",
      },
      hint: {
        en: "Burns whatever the document's own form fields currently hold into the page, then adds the signature spots.",
        hi: "दस्तावेज़ के फ़ॉर्म फ़ील्ड के मौजूदा मान पेज पर छाप देता है, फिर हस्ताक्षर स्थान जोड़ता है।",
      },
      default: false,
    },
  ],
  howKeys: ["reqsig.how1", "reqsig.how2", "reqsig.how3"],
  chainToolIds: ["sign-pdf", "flatten-pdf", "lock-pdf"],
  features: [
    {
      en: "Numbered sign-here boxes exactly where you click on the page — a dashed amber placeholder with the spot number, the recipient's name and the due date, on as many pages as you need (up to 12 spots).",
      hi: "पेज पर जहाँ क्लिक करें वहीं नंबर वाले हस्ताक्षर बॉक्स — डैश वाला एम्बर प्लेसहोल्डर, स्पॉट नंबर, प्राप्तकर्ता का नाम और अंतिम तारीख़ के साथ, जितने पेज चाहिए (12 स्पॉट तक)।",
    },
    {
      en: "Real PDF signature fields — every box overlays an empty /Sig AcroForm field, so the document signs properly in Adobe Acrobat Reader, browsers and Preview, not just visually.",
      hi: "असली PDF हस्ताक्षर फ़ील्ड — हर बॉक्स के नीचे एक ख़ाली /Sig AcroForm फ़ील्ड बैठता है, इसलिए दस्तावेज़ Adobe Acrobat Reader, ब्राउज़र और Preview में सच में साइन होता है, सिर्फ़ दिखने में नहीं।",
    },
    {
      en: "A request note and a mail draft, generated on your device — subject, message, due date and the list of spots, plus a one-click mailto: button that opens your own mail app. Browsers cannot attach files, so the note reminds the signer's sender to attach the PDF by hand.",
      hi: "अनुरोध पत्र और मेल ड्राफ़्ट, आपके डिवाइस पर बने — विषय, संदेश, अंतिम तारीख़ और स्थानों की सूची, साथ ही एक क्लिक वाला mailto: बटन जो आपका अपना मेल ऐप खोलता है। ब्राउज़र फ़ाइल संलग्न नहीं कर सकते, इसलिए पत्र में लिखा रहता है कि PDF हाथ से जोड़ें।",
    },
    {
      en: "Optional flatten-first: existing form field values are burned into the page before the spots go in (the flatten-pdf engine), so the only thing left to fill is the signature itself.",
      hi: "वैकल्पिक फ़्लैटन-पहले: स्थान जुड़ने से पहले मौजूदा फ़ॉर्म फ़ील्ड के मान पेज पर छप जाते हैं (flatten-pdf इंजन), ताकि भरने के लिए सिर्फ़ हस्ताक्षर ही बचे।",
    },
    {
      en: "Everything stays on your device — the pack is assembled by a worker thread in your browser, हिंदी requests render through the embedded Noto font, and nothing is ever uploaded. No sign-up, no server, no expiring link.",
      hi: "सब कुछ आपके डिवाइस पर — पैक आपके ब्राउज़र के वर्कर थ्रेड में बनता है, हिंदी अनुरोध एम्बेडेड Noto फ़ॉन्ट से छपते हैं, और कुछ भी अपलोड नहीं होता। कोई साइन-अप नहीं, सर्वर नहीं, एक्सपायर होने वाला लिंक नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does this email the document for me?",
        hi: "क्या यह दस्तावेज़ मेरी ओर से मेल कर देता है?",
      },
      a: {
        en: "No — and that is the honest design. Preparing happens fully on your device; sending stays in your hands. The mail draft button opens your own mail program with the subject and body pre-filled, and the request note explains that the PDF must be attached manually (a web page cannot attach files to your mail app). Nothing is ever uploaded to any server.",
        hi: "नहीं — और यही ईमानदार डिज़ाइन है। तैयारी पूरी तरह आपके डिवाइस पर होती है; भेजना आपके हाथ में रहता है। मेल ड्राफ़्ट बटन आपका अपना मेल प्रोग्राम विषय और मुख्य भाग पहले से भरकर खोलता है, और अनुरोध पत्र में लिखा होता है कि PDF हाथ से संलग्न करनी है (वेब पेज मेल ऐप में फ़ाइल नहीं जोड़ सकता)। कुछ भी किसी सर्वर पर अपलोड नहीं होता।",
      },
    },
    {
      q: {
        en: "What exactly does the signer receive?",
        hi: "हस्ताक्षरकर्ता को ठीक क्या मिलता है?",
      },
      a: {
        en: "A PDF that is genuinely signable: each numbered box is visible ink (dashed border, number, recipient, due date) with an empty PDF signature field layered over it, so Acrobat, most browsers and macOS Preview offer to sign when the box is clicked. The signing pack (.zip) also contains a request-note PDF, and the plain-text note lists every spot with its page.",
        hi: "एक PDF जो सच में साइन करने योग्य है: हर नंबर वाला बॉक्स दिखने वाली स्याही है (डैश बॉर्डर, नंबर, प्राप्तकर्ता, अंतिम तारीख़) जिसके ऊपर एक ख़ाली PDF हस्ताक्षर फ़ील्ड बैठता है, इसलिए Acrobat, ज़्यादातर ब्राउज़र और macOS Preview बॉक्स पर क्लिक करते ही हस्ताक्षर का प्रस्ताव देते हैं। साइनिंग पैक (.zip) में अनुरोध-पत्र PDF भी है, और सादा टेक्स्ट पत्र हर स्थान उसके पेज के साथ सूचीबद्ध करता है।",
      },
    },
    {
      q: {
        en: "Why would I flatten the form first?",
        hi: "फ़ॉर्म पहले फ़्लैटन क्यों करूँ?",
      },
      a: {
        en: "If the document already has fillable fields holding values, flattening bakes those values permanently into the page (the same engine as the Flatten PDF tool) before the signature spots are added. The result can no longer be edited field-by-field — only signed. Leave it off when the existing form should stay fillable.",
        hi: "अगर दस्तावेज़ में पहले से भरे फ़ील्ड हैं, तो फ़्लैटन करने से वे मान हमेशा के लिए पेज पर छप जाते हैं (वही इंजन जो Flatten PDF टूल चलाता है) — हस्ताक्षर स्थान जुड़ने से पहले। नतीजा अब फ़ील्ड-दर-फ़ील्ड संपादित नहीं हो सकता — सिर्फ़ साइन हो सकता है। अगर मौजूदा फ़ॉर्म भरने योग्य रहना चाहिए तो इसे बंद रखें।",
      },
    },
    {
      q: {
        en: "Can the request be in Hindi?",
        hi: "क्या अनुरोध हिंदी में हो सकता है?",
      },
      a: {
        en: "Yes — with the Hindi interface, the box labels, the request-note PDF and the mail draft are all Hindi, rendered through the embedded Noto Sans Devanagari font (₹ included). Names and messages in Devanagari print the same way; Latin-only requests embed nothing extra.",
        hi: "हाँ — हिंदी इंटरफ़ेस पर बॉक्स लेबल, अनुरोध-पत्र PDF और मेल ड्राफ़्ट सब हिंदी में होते हैं, एम्बेडेड Noto Sans Devanagari फ़ॉन्ट से (₹ सहित)। देवनागरी में नाम और संदें भी वैसे ही छपते हैं; सिर्फ़ लैटिन अनुरोधों में कुछ अतिरिक्त एम्बेड नहीं होता।",
      },
    },
  ],
};
