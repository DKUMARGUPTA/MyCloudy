import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Webpage to PDF (RB4-f). URL → PDF with an honest privacy split:
 * a thin same-origin API route FETCHES the page's HTML server-side
 * (browsers can't — CORS) as a pure pass-through that never stores
 * anything, and ALL rendering to PDF happens on the user's device in
 * a Web Worker that reuses the html-to-pdf engine (parse + vector
 * paint + the WinAnsi-vs-Noto font decision).
 *
 * The surface (tools/webpage-to-pdf/surface.tsx) owns the input: a URL
 * text field with validation + the run gate (no file drop — the tool
 * accepts a url, the registry def says so), page size / margins / font
 * size / link-address options, and the "paste the HTML file directly"
 * note pointing at HTML to PDF.
 *
 * Honest limits (mirrored in the FAQ):
 *  - the server is a dumb pipe: it fetches and forgets — the page is
 *    never stored, logged or forwarded; the PDF is built on-device;
 *  - JavaScript never runs, so SPA shells / paywalled pages render
 *    whatever their server returned as HTML (often very little);
 *  - CSS layout and images are not applied (content extraction, not a
 *    browser engine) — alt text prints in brackets;
 *  - internal addresses (127.x, 10.x, 192.168.x …) are refused — the
 *    pipe only reads public pages;
 *  - one page per run, ≤ 5 MB, 15 s budget, ≤ 3 redirects.
 */
export const config: ToolConfig = {
  toolId: "webpage-to-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 0,
  maxFiles: 1,
  landingSurface: true,
  options: [
    {
      kind: "select",
      id: "pageSize",
      label: { en: "Page size", hi: "पेज साइज़" },
      hint: {
        en: "A4 outside North America, US Letter for the US/Canada",
        hi: "उत्तरी अमेरिका के बाहर A4, अमेरिका/कनाडा के लिए US लेटर",
      },
      choices: [
        { value: "a4", label: { en: "A4 (210 × 297 mm)", hi: "A4 (210 × 297 मिमी)" } },
        {
          value: "letter",
          label: { en: "US Letter (8.5 × 11 in)", hi: "US लेटर (8.5 × 11 इंच)" },
        },
      ],
      default: "a4",
    },
    {
      kind: "select",
      id: "margin",
      label: { en: "Margins", hi: "मार्जिन" },
      hint: {
        en: "Normal 56 pt, narrow 28 pt on every side",
        hi: "सामान्य 56 pt, सँकरा 28 pt हर तरफ़",
      },
      choices: [
        { value: "normal", label: { en: "Normal (56 pt)", hi: "सामान्य (56 pt)" } },
        { value: "narrow", label: { en: "Narrow (28 pt)", hi: "सँकरा (28 pt)" } },
      ],
      default: "normal",
    },
    {
      kind: "select",
      id: "baseFontSize",
      label: { en: "Font size", hi: "फ़ॉन्ट साइज़" },
      hint: {
        en: "Body text 10 / 11 / 12.5 pt — headings scale with it",
        hi: "मुख्य टेक्स्ट 10 / 11 / 12.5 pt — शीर्षक इसी अनुपात में बदलते हैं",
      },
      choices: [
        { value: "small", label: { en: "Small (10 pt)", hi: "छोटा (10 pt)" } },
        { value: "normal", label: { en: "Normal (11 pt)", hi: "सामान्य (11 pt)" } },
        { value: "large", label: { en: "Large (12.5 pt)", hi: "बड़ा (12.5 pt)" } },
      ],
      default: "normal",
    },
    {
      kind: "switch",
      id: "showLinks",
      label: { en: "Show link addresses", hi: "लिंक पते दिखाएँ" },
      hint: {
        en: "Print the href after each link text, footnote-style",
        hi: "हर लिंक टेक्स्ट के बाद उसका पता छापें (फ़ुटनोट शैली)",
      },
      default: false,
    },
  ],
  howKeys: ["wpdf.how1", "wpdf.how2", "wpdf.how3"],
  chainToolIds: ["view-pdf", "compress-pdf", "lock-pdf"],
  features: [
    {
      en: "Paste a page address and get a PDF — the server only FETCHES the HTML as a pass-through (it never stores or forwards it), and the whole PDF is rendered right here on your device.",
      hi: "पेज का पता चिपकाइए और PDF पाइए — सर्वर सिर्फ़ HTML लाता है (पास-थ्रू, कहीं सेव या आगे नहीं भेजता), और पूरी PDF आपके ही डिवाइस पर बनती है।",
    },
    {
      en: "Real selectable vector text, never a screenshot: headings h1–h6, paragraphs with bold/italic/underline, nested lists, blockquotes, code blocks and bordered tables — the same engine as HTML to PDF.",
      hi: "असली चुनने योग्य वेक्टर टेक्स्ट, स्क्रीनशॉट नहीं: h1–h6 शीर्षक, बोल्ड-इटैलिक-रेखांकित पैराग्राफ़, नेस्टेड सूचियाँ, कोट, कोड ब्लॉक और किनारों वाली टेबलें — वही इंजन जो HTML to PDF में है।",
    },
    {
      en: "English pages export with the built-in Helvetica and Courier (nothing embedded, tiny files); any Devanagari character switches to the self-hosted Noto Sans Devanagari subset — English and हिंदी pages both work.",
      hi: "अंग्रेज़ी पेज बिल्ट-इन Helvetica और Courier से निकलते हैं (कुछ एम्बेड नहीं, छोटी फ़ाइल); कोई देवनागरी अक्षर आते ही सेल्फ़-होस्टेड Noto Sans Devanagari सबसेट लग जाता है — अंग्रेज़ी और हिंदी दोनों पेज चलते हैं।",
    },
    {
      en: "A4 or US Letter, normal or narrow margins, three font sizes, optional link addresses — and the PDF is named after the page's <title>, falling back to the site's hostname.",
      hi: "A4 या US लेटर, सामान्य या सँकरे मार्जिन, तीन फ़ॉन्ट साइज़, वैकल्पिक लिंक पते — और PDF का नाम पेज के <title> से बनता है, न मिले तो साइट के होस्टनेम से।",
    },
    {
      en: "Honest about what it is: JavaScript never runs, so app-like pages and paywalled articles render only what their server sent as HTML; CSS layout and images are not carried; internal addresses (127.x, 10.x, 192.168.x …) are refused.",
      hi: "अपने बारे में ईमानदार: JavaScript कभी नहीं चलता, इसलिए ऐप-जैसे पेज और पे-वॉल लेख सिर्फ़ वही दिखाते हैं जो सर्वर ने HTML में भेजा; CSS लेआउट और तस्वीरें नहीं आतीं; भीतरी पते (127.x, 10.x, 192.168.x…) मना हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is my page uploaded to a server?",
        hi: "क्या मेरा पेज सर्वर पर अपलोड होता है?",
      },
      a: {
        en: "The page content is never stored anywhere. Browsers cannot fetch other sites directly (that is the same-origin rule), so this tool uses its own tiny fetch endpoint as a dumb pipe: it brings the HTML across and hands it straight to your browser, where the PDF is rendered on your device. Nothing is written to disk, nothing is logged, nothing is forwarded — the bytes exist only for the moment of the request.",
        hi: "पेज की सामग्री कहीं सेव नहीं होती। ब्राउज़र सीधे दूसरी साइटें नहीं खींच सकते (सेम-ऑरिजिन नियम), इसलिए यह टूल अपना छोटा फ़ेच-एंडपॉइंट एक सादे पाइप की तरह इस्तेमाल करता है: HTML को लाकर सीधे आपके ब्राउज़र को दे देता है, और PDF आपके डिवाइस पर बनती है। कुछ डिस्क पर नहीं लिखा जाता, न लॉग होता है, न आगे भेजा जाता — बाइट्स सिर्फ़ रिक्वेस्ट के क्षण के लिए जीते हैं।",
      },
    },
    {
      q: {
        en: "Why does my page come out with almost no content?",
        hi: "मेरा पेज लगभग खाली क्यों निकलता है?",
      },
      a: {
        en: "Honest answer: JavaScript never runs in this pipeline. Pages that build themselves in the browser (single-page apps, infinite feeds, paywalled articles) send an almost-empty shell as HTML and fill it with scripts — that shell is all any non-browser fetcher can see. Static pages, articles, blogs, documentation and wikis convert richly. If you can save the page from your browser as a .html file, the HTML to PDF tool renders exactly that saved copy.",
        hi: "ईमानदार जवाब: इस पाइपलाइन में JavaScript कभी नहीं चलता। जो पेज ब्राउज़र में खुद बनते हैं (सिंगल-पेज ऐप, इन्फ़िनिट फ़ीड, पे-वॉल लेख) वे HTML में लगभग खाली ढाँचा भेजते हैं और बाक़ी स्क्रिप्ट से भरते हैं — बिना ब्राउज़र वाले को वही ढाँचा दिखता है। स्टैटिक पेज, लेख, ब्लॉग, डॉक्यूमेंटेशन और विकि समृद्ध रूप से बदलते हैं। ब्राउज़र से पेज को .html फ़ाइल की तरह सेव कर सकते हैं तो HTML to PDF टूल उसी सेव की हुई कॉपी को बना देता है।",
      },
    },
    {
      q: {
        en: "Will the PDF look like the page does in my browser?",
        hi: "क्या PDF ब्राउज़र जैसी दिखेगी?",
      },
      a: {
        en: "No — this is content extraction, not a browser engine. Headings, paragraphs, lists, quotes, code blocks and tables are re-typeset as clean selectable vector text; CSS layout, web fonts, colours, scripts and images are not applied (a picture with alt text prints as that alt text in brackets). What you get is a readable, printable document of the page's actual text and structure.",
        hi: "नहीं — यह कंटेंट एक्स्ट्रैक्शन है, ब्राउज़र इंजन नहीं। शीर्षक, पैराग्राफ़, सूचियाँ, कोट, कोड ब्लॉक और टेबलें साफ़ चुनने योग्य वेक्टर टेक्स्ट में नए सिरे से छपती हैं; CSS लेआउट, वेब फ़ॉन्ट, रंग, स्क्रिप्ट और तस्वीरें नहीं लगतीं (alt टेक्स्ट वाली तस्वीर उसी टेक्स्ट को कोष्ठक में छापती है)। जो मिलता है वह पेज के असली टेक्स्ट और ढाँचे का पढ़ने-प्रिंट करने लायक दस्तावेज़ है।",
      },
    },
    {
      q: {
        en: "Which pages can it fetch, and what are the limits?",
        hi: "कौन-से पेज लाए जा सकते हैं, और सीमाएँ क्या हैं?",
      },
      a: {
        en: "Public http(s) pages only. The pipe refuses internal and private addresses (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x, ::1 and friends) on every redirect hop, follows at most 3 redirects, waits at most 15 seconds and reads at most 5 MB per page. Non-HTML answers (a PDF or an image URL) are rejected honestly instead of producing garbage. Pages behind a login can only render what their server sends without a session.",
        hi: "सिर्फ़ सार्वजनिक http(s) पेज। पाइप भीतरी/प्राइवेट पते (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x, ::1 आदि) हर रीडायरेक्ट पर मना करता है, ज़्यादा-से-ज़्यादा 3 रीडायरेक्ट चलाता है, 15 सेकंड तक इंतज़ार करता है और प्रति पेज 5 MB पढ़ता है। ग़ैर-HTML जवाब (PDF या तस्वीर का URL) ईमानदारी से नामंज़ूर होते हैं, बेकार फ़ाइल नहीं बनती। लॉगिन के पीछे वाले पेज सिर्फ़ वही दिखाते हैं जो सर्वर बिना सेशन भेजता है।",
      },
    },
  ],
};
