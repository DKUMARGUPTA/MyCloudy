import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Create fillable PDF form (P3-FORM — the 65th tool). A visual A4 form
 * builder that exports a REAL AcroForm PDF entirely on-device (Mode D):
 *
 *  - 11 element kinds: heading/text/divider/box printed matter +
 *    text/multiline/number/date/checkbox/radio/dropdown fields, placed
 *    with an 8px grid snap and moved/resized with pointer or keyboard;
 *  - every printed string goes through the ONE embedded font
 *    (self-hosted Noto Sans Devanagari) so English and हिंदी labels —
 *    ₹ included — both print;
 *  - REAL interactive fields in any PDF reader, with required flags,
 *    max-length caps and Adobe-documented AF* format/keystroke actions
 *    for numbers (2 decimals) and dates (dd/mm/yyyy);
 *  - calculations in simple field notation ("grand = total + tax -
 *    discount") compiled to ISO 32000-1 /AA /C scripts plus the AcroForm
 *    /CO calculation order, with the same engine driving the in-browser
 *    Test fill mode.
 *
 * landingSurface + fullWidthSurface (create-invoice pattern): no files,
 * the surface owns the landing template picker AND the builder
 * workspace; the surface's own "Save as PDF" spawns the worker.
 */
export const config: ToolConfig = {
  toolId: "create-fillable-pdf-form",
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
  howKeys: ["form.how1", "form.how2", "form.how3"],
  chainToolIds: ["view-pdf", "fill-out-pdf", "make-pdf-fillable"],
  features: [
    {
      en: "Visual A4 builder — headings, paragraphs, dividers and boxes plus text, multiline, number, date, checkbox, radio and dropdown fields; drag to place, resize, nudge with arrow keys, snap to an 8px grid, as many pages as you need.",
      hi: "विज़ुअल A4 बिल्डर — हेडिंग, पैराग्राफ़, डिवाइडर और बॉक्स के साथ टेक्स्ट, मल्टीलाइन, नंबर, तारीख़, चेकबॉक्स, रेडियो और ड्रॉपडाउन फ़ील्ड; खींचकर रखें, नाप बदलें, ऐरो कीज़ से खिसकाएँ, 8px ग्रिड पर स्नैप, जितने पेज चाहिए।",
    },
    {
      en: "A real fillable PDF — the fields work in any PDF reader. Mark fields required, cap their length, and numbers auto-format to 2 decimals while dates follow dd/mm/yyyy (the Adobe-documented standard actions).",
      hi: "असली फिलएबल PDF — फ़ील्ड किसी भी PDF रीडर में चलते हैं। फ़ील्ड अनिवार्य चिह्नित करें, लंबाई सीमित रखें, नंबर अपने आप 2 दशमलव पर और तारीख़ें dd/mm/yyyy पर बनती हैं (Adobe की प्रलेखित स्टैंडर्ड क्रियाएँ)।",
    },
    {
      en: "Calculations in plain notation — “grand = total + tax - discount”. The compiler validates field names, catches cycles and unknown fields before export, and the same engine drives the in-browser Test fill mode.",
      hi: "सादे फ़ॉर्मूले — “grand = total + tax - discount”। कंपाइलर एक्सपोर्ट से पहले फ़ील्ड नाम जाँचता है, साइकल और अनजान फ़ील्ड पकड़ता है, और वही इंजन ब्राउज़र में टेस्ट-फ़िल मोड चलाता है।",
    },
    {
      en: "Everything stays on your device — the PDF is assembled by a worker thread in your browser, drafts and up to 30 named forms live in local storage, and हिंदी/English labels print through the embedded Noto font. No sign-up, no server, no watermark.",
      hi: "सब कुछ आपके ही डिवाइस पर — PDF आपके ब्राउज़र के वर्कर थ्रेड में बनता है, ड्राफ़्ट और 30 तक नाम वाले फ़ॉर्म लोकल स्टोरेज में रहते हैं, और हिंदी/अंग्रेज़ी लेबल एम्बेडेड Noto फ़ॉन्ट से छपते हैं। कोई साइन-अप नहीं, सर्वर नहीं, वॉटरमार्क नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Do the calculations work in every PDF viewer?",
        hi: "क्या गणना हर PDF व्यूअर में चलती है?",
      },
      a: {
        en: "Calculations and the number/date auto-format run in Adobe Acrobat and Reader — they follow the ISO 32000-1 JavaScript actions that Adobe documented (most desktop viewers built on the same engine run them too). Other viewers still show every field and let people type; they just skip the scripts. Use the Test fill switch to try the whole form, calculations included, right in your browser before exporting.",
        hi: "गणना और नंबर/तारीख़ का ऑटो-फ़ॉर्मैट Adobe Acrobat और Reader में चलते हैं — ये ISO 32000-1 की JavaScript क्रियाएँ हैं जिन्हें Adobe ने प्रलेखित किया (इसी इंजन पर बने ज़्यादातर डेस्कटॉप व्यूअर भी इन्हें चलाते हैं)। बाकी व्यूअर हर फ़ील्ड दिखाते और भरने देते हैं; सिर्फ़ स्क्रिप्ट छोड़ देते हैं। एक्सपोर्ट से पहले टेस्ट-फ़िल स्विच से पूरा फ़ॉर्म — गणना समेत — ब्राउज़र में ही आज़माएँ।",
      },
    },
    {
      q: {
        en: "Can the form be in Hindi?",
        hi: "क्या फ़ॉर्म हिंदी में बन सकता है?",
      },
      a: {
        en: "Yes — headings, paragraphs, field labels and radio option labels all print in हिंदी (or any mix with English and ₹) through the embedded Noto Sans Devanagari font. What typed field values accept is set by the PDF standard's built-in field font, which is Latin-only: keep dropdown options and default values in English or transliterated text, and prefer radio buttons when you want fully translated choices.",
        hi: "हाँ — हेडिंग, पैराग्राफ़, फ़ील्ड लेबल और रेडियो विकल्प लेबल सब हिंदी में छपते हैं (या अंग्रेज़ी और ₹ के साथ कोई भी मिश्रण) — एम्बेडेड Noto Sans Devanagari फ़ॉन्ट से। भरे जाने वाले मानों की सीमा PDF मानक का बिल्ट-इन फ़ील्ड फ़ॉन्ट तय करता है, जो सिर्फ़ लैटिन है: ड्रॉपडाउन विकल्प और डिफ़ॉल्ट मान अंग्रेज़ी या लिप्यंतरित रखें, और पूरी तरह अनुवादित विकल्पों के लिए रेडियो बटन चुनें।",
      },
    },
    {
      q: {
        en: "Where do my drafts and saved forms go?",
        hi: "मेरे ड्राफ़्ट और सेव किए फ़ॉर्म कहाँ जाते हैं?",
      },
      a: {
        en: "Nowhere outside this browser. The current form autosaves as a draft, up to 30 named forms live in local storage, and the PDF itself is assembled by a worker thread on your device — the tool never makes a network request with your content.",
        hi: "इस ब्राउज़र से बाहर कहीं नहीं। मौजूदा फ़ॉर्म ड्राफ़्ट के रूप में अपने आप सेव होता है, 30 तक नाम वाले फ़ॉर्म लोकल स्टोरेज में रहते हैं, और PDF आपके डिवाइस पर वर्कर थ्रेड से बनता है — टूल आपकी सामग्री के साथ कोई नेटवर्क रिक्वेस्ट कभी नहीं करता।",
      },
    },
    {
      q: {
        en: "What do Required and Max characters do?",
        hi: "अनिवार्य और अधिकतम अक्षर क्या करते हैं?",
      },
      a: {
        en: "Required sets the PDF field's required flag — Acrobat marks the field and refuses to submit or save with it empty. Max characters caps typing in text fields. Both are part of the PDF standard, so they keep working in any reader that honours them; in browsers that ignore flags the form still fills normally.",
        hi: "अनिवार्य PDF फ़ील्ड का required फ़्लैग लगाता है — Acrobat फ़ील्ड को चिह्नित करता है और उसे ख़ाली छोड़कर सबमिट या सेव नहीं होने देता। अधिकतम अक्षर टेक्स्ट फ़ील्ड में टाइपिंग की सीमा है। दोनों PDF मानक का हिस्सा हैं, इसलिए जो रीडर इन्हें मानता है वहाँ ये लागू रहते हैं; जो नहीं मानता वहाँ भी फ़ॉर्म सामान्य रूप से भरा जा सकता है।",
      },
    },
  ],
};
