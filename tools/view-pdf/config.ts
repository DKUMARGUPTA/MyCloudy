import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * View PDF (PRD §6.5 / §7.7) — the fast on-device viewer. Thumbnails,
 * outline, full-text search with highlights, zoom/fit/rotate, single-page
 * and two-page spread, dark reading mode, presentation mode (fullscreen,
 * one fitted page at a time, click or arrow-key advance), print,
 * download, keyboard navigation — and lazy page rendering (only visible
 * ±2 pages in memory).
 *
 * This is the first "viewer-only" tool: it never processes anything, so
 * there is no worker and no run step — the workspace surface IS the tool.
 * Printing and downloading act on the original file bytes; the password
 * prompt for encrypted files stays entirely on the device.
 */
export const config: ToolConfig = {
  toolId: "view-pdf",
  viewerOnly: true,
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Continuous scroll, single page or two-page spread — with zoom from 25% to 400%, fit-width, fit-page and 90° view rotation.",
      hi: "लगातार स्क्रॉल, सिंगल पेज या दो-पेज स्प्रेड — 25% से 400% ज़ूम, फ़िट-चौड़ाई, फ़िट-पेज और 90° घुमाव के साथ।",
    },
    {
      en: "Search the whole document (Ctrl+F) and jump through every match — matches are highlighted right on the page.",
      hi: "पूरे दस्तावेज़ में खोजें (Ctrl+F) और हर मैच पर जाएँ — मैच पेज पर ही हाइलाइट होते हैं।",
    },
    {
      en: "Thumbnails and outline in the sidebar; go to any page with G; arrow keys, PageUp/PageDown and +/- all work.",
      hi: "साइडबार में थंबनेल और आउटलाइन; G से किसी भी पेज पर जाएँ; ऐरो की, PageUp/PageDown और +/- सब चलते हैं।",
    },
    {
      en: "Dark reading mode flips pages to easy-on-eyes paper without touching the file.",
      hi: "डार्क रीडिंग मोड फ़ाइल में कुछ बदले बिना पेजों को आँखों को आराम देने वाला बना देता है।",
    },
    {
      en: "Present full-screen: one fitted page at a time, advance by click or arrow key — controls fade away while you talk.",
      hi: "फ़ुल-स्क्रीन प्रेज़ेंट करें: एक बार में एक पूरा पेज, क्लिक या ऐरो की से आगे बढ़ें — बोलते समय कंट्रोल ओछे हो जाते हैं।",
    },
    {
      en: "Select and copy text, print or download the original — the file never leaves your device.",
      hi: "टेक्स्ट चुनकर कॉपी करें, ओरिजिनल प्रिंट या डाउनलोड करें — फ़ाइल कभी डिवाइस से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does the viewer change my PDF in any way?",
        hi: "क्या व्यूअर मेरी PDF में कुछ बदलता है?",
      },
      a: {
        en: "No. Zoom, rotation and dark reading mode only change what you see on screen — your file is never re-saved. Printing and downloading always use the original bytes.",
        hi: "नहीं। ज़ूम, घुमाव और डार्क मोड सिर्फ़ स्क्रीन पर दिखता है — आपकी फ़ाइल दोबारा सेव नहीं होती। प्रिंट और डाउनलोड हमेशा ओरिजिनल बाइट्स ही इस्तेमाल करते हैं।",
      },
    },
    {
      q: {
        en: "How does it handle big documents?",
        hi: "बड़े दस्तावेज़ों का क्या होता है?",
      },
      a: {
        en: "Pages render lazily: only the ones near your viewport (about ±2 pages) are kept in memory, so even 500-page files scroll smoothly.",
        hi: "पेज लेज़ी रेंडर होते हैं: सिर्फ़ व्यूपोर्ट के पास वाले (लगभग ±2 पेज) मेमोरी में रहते हैं, इसलिए 500 पेज की फ़ाइल भी आराम से स्क्रॉल होती है।",
      },
    },
    {
      q: {
        en: "My PDF asks for a password — is it safe to unlock here?",
        hi: "मेरी PDF पासवर्ड माँगती है — यहाँ खोलना सुरक्षित है?",
      },
      a: {
        en: "Yes. The password is used only in your browser to open the file for viewing — it is never sent anywhere or stored.",
        hi: "हाँ। पासवर्ड सिर्फ़ आपके ब्राउज़र में फ़ाइल खोलने के लिए इस्तेमाल होता है — यह कहीं भेजा या सेव नहीं जाता।",
      },
    },
  ],
};
