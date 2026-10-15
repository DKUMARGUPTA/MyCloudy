import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Set viewer preferences (PRD §8.5 "Viewer preferences" row): initial page
 * layout, zoom (with start page), page mode / fullscreen, window title
 * display, hidden toolbar / menubar / window UI, window sizing — every
 * option is tri-state ("keep" leaves that entry exactly as the file has
 * it), so the tool only ever writes what the user actually chose.
 */
export const config: ToolConfig = {
  toolId: "set-pdf-viewer-preferences",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: ["view-pdf", "change-pdf-doc-info", "compress-pdf", "lock-pdf"],
  options: [
    {
      kind: "select",
      id: "layout",
      label: { en: "Page layout", hi: "पेज लेआउट" },
      hint: {
        en: "How pages are arranged when the file opens",
        hi: "फ़ाइल खुलने पर पेज कैसे लगें",
      },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "SinglePage",
          label: { en: "Single page at a time", hi: "एक बार में एक पेज" },
        },
        {
          value: "OneColumn",
          label: { en: "Continuous scroll", hi: "लगातार स्क्रॉल" },
        },
        {
          value: "TwoColumnLeft",
          label: { en: "Two columns, cover on left", hi: "दो कॉलम, कवर बाएँ" },
        },
        {
          value: "TwoColumnRight",
          label: { en: "Two columns, cover on right", hi: "दो कॉलम, कवर दाएँ" },
        },
        {
          value: "TwoPageLeft",
          label: { en: "Facing pages, cover on left", hi: "सामने-आमने पेज, कवर बाएँ" },
        },
        {
          value: "TwoPageRight",
          label: { en: "Facing pages, cover on right", hi: "सामने-आमने पेज, कवर दाएँ" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "pageMode",
      label: { en: "Side panel", hi: "साइड पैनल" },
      hint: {
        en: "What the reader shows beside the page",
        hi: "रीडर पेज के बगल में क्या दिखाए",
      },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "UseNone",
          label: { en: "Nothing — just the page", hi: "कुछ नहीं — सिर्फ़ पेज" },
        },
        {
          value: "UseThumbs",
          label: { en: "Page thumbnails", hi: "पेज थंबनेल" },
        },
        {
          value: "UseOutlines",
          label: { en: "Bookmarks", hi: "बुकमार्क" },
        },
        {
          value: "UseAttachments",
          label: { en: "Attachments", hi: "अटैचमेंट" },
        },
        {
          value: "FullScreen",
          label: { en: "Fullscreen mode", hi: "फ़ुलस्क्रीन मोड" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "exitFsMode",
      label: { en: "After leaving fullscreen", hi: "फ़ुलस्क्रीन छोड़ने पर" },
      hint: {
        en: "Shown when the reader exits fullscreen",
        hi: "रीडर फ़ुलस्क्रीन से बाहर आए तो यह दिखे",
      },
      choices: [
        {
          value: "UseNone",
          label: { en: "Nothing", hi: "कुछ नहीं" },
        },
        {
          value: "UseThumbs",
          label: { en: "Page thumbnails", hi: "पेज थंबनेल" },
        },
        {
          value: "UseOutlines",
          label: { en: "Bookmarks", hi: "बुकमार्क" },
        },
      ],
      default: "UseNone",
      showWhen: { id: "pageMode", equals: "FullScreen" },
    },
    {
      kind: "select",
      id: "zoom",
      label: { en: "Zoom", hi: "ज़ूम" },
      hint: {
        en: "The magnification the file opens at",
        hi: "फ़ाइल खुलने पर कितना बड़ा दिखे",
      },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "50",
          label: { en: "50%", hi: "50%" },
        },
        {
          value: "75",
          label: { en: "75%", hi: "75%" },
        },
        {
          value: "100",
          label: { en: "100%", hi: "100%" },
        },
        {
          value: "125",
          label: { en: "125%", hi: "125%" },
        },
        {
          value: "150",
          label: { en: "150%", hi: "150%" },
        },
        {
          value: "200",
          label: { en: "200%", hi: "200%" },
        },
        {
          value: "fitPage",
          label: { en: "Fit whole page", hi: "पूरा पेज फ़िट" },
        },
        {
          value: "fitWidth",
          label: { en: "Fit page width", hi: "पेज की चौड़ाई फ़िट" },
        },
      ],
      default: "keep",
    },
    {
      kind: "number",
      id: "startPage",
      label: { en: "Open at page", hi: "इस पेज पर खोलें" },
      hint: {
        en: "Needs a zoom choice, or a page after the first",
        hi: "ज़ूम चुनने या पहले के बाद का पेज चाहिए",
      },
      min: 1,
      max: 10000,
      step: 1,
      default: 1,
    },
    {
      kind: "select",
      id: "showTitle",
      label: { en: "Window title", hi: "विंडो टाइटल" },
      hint: {
        en: "Show the file's title in the window bar",
        hi: "विंडो बार में फ़ाइल का टाइटल दिखे",
      },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "on",
          label: { en: "Show file title", hi: "टाइटल दिखाएँ" },
        },
        {
          value: "off",
          label: { en: "Show file name only", hi: "सिर्फ़ फ़ाइल नाम" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "hideToolbar",
      label: { en: "Toolbar", hi: "टूलबार" },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "on",
          label: { en: "Hide the toolbar", hi: "टूलबार छिपाएँ" },
        },
        {
          value: "off",
          label: { en: "Keep it visible", hi: "दिखता रहे" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "hideMenubar",
      label: { en: "Menu bar", hi: "मेन्यू बार" },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "on",
          label: { en: "Hide the menu bar", hi: "मेन्यू बार छिपाएँ" },
        },
        {
          value: "off",
          label: { en: "Keep it visible", hi: "दिखता रहे" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "hideWindowUI",
      label: { en: "Window controls", hi: "विंडो कंट्रोल" },
      hint: {
        en: "Scrollbars and other window furniture",
        hi: "स्क्रॉलबार वग़ैरह विंडो के हिस्से",
      },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "on",
          label: { en: "Hide them", hi: "छिपाएँ" },
        },
        {
          value: "off",
          label: { en: "Keep them visible", hi: "दिखते रहें" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "fitWindow",
      label: { en: "Window size", hi: "विंडो साइज़" },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "on",
          label: { en: "Resize window to fit the page", hi: "विंडो पेज के अनुसार" },
        },
        {
          value: "off",
          label: { en: "Don't resize", hi: "साइज़ न बदले" },
        },
      ],
      default: "keep",
    },
    {
      kind: "select",
      id: "centerWindow",
      label: { en: "Window position", hi: "विंडो की जगह" },
      choices: [
        {
          value: "keep",
          label: { en: "Keep as-is", hi: "जैसा है वैसा रहे" },
        },
        {
          value: "on",
          label: { en: "Center on screen", hi: "स्क्रीन के बीच में" },
        },
        {
          value: "off",
          label: { en: "Wherever it opens", hi: "जहाँ खुले" },
        },
      ],
      default: "keep",
    },
  ],
  features: [
    {
      en: "Decide how the file opens — layout, zoom, side panel, fullscreen",
      hi: "तय करें फ़ाइल कैसे खुले — लेआउट, ज़ूम, साइड पैनल, फ़ुलस्क्रीन",
    },
    {
      en: "Every setting is optional — anything you leave on \"Keep as-is\" stays untouched",
      hi: "हर सेटिंग वैकल्पिक — \"जैसा है वैसा\" छोड़ा तो कुछ नहीं बदले",
    },
    {
      en: "Jump straight to any page, at the zoom you pick",
      hi: "अपनी पसंद के ज़ूम पर सीधे किसी भी पेज पर पहुँचें",
    },
    {
      en: "Hide the toolbar, menu bar or window controls — or show the file's title instead",
      hi: "टूलबार, मेन्यू बार या विंडो कंट्रोल छिपाएँ — या टाइटल दिखाएँ",
    },
    {
      en: "Works with every reader — the rules travel inside the PDF itself",
      hi: "हर रीडर के साथ — नियम PDF के अंदर ही चलते हैं",
    },
    {
      en: "100% on-device — your file never leaves the browser",
      hi: "100% ऑन-डिवाइस — फ़ाइल ब्राउज़र से बाहर नहीं जाती",
    },
  ],
  faq: [
    {
      q: {
        en: "Do all readers follow these settings?",
        hi: "क्या सभी रीडर इन सेटिंग को मानते हैं?",
      },
      a: {
        en: "The rules are part of the PDF standard, so desktop readers like Adobe, Foxit and Preview follow them. Most browser tabs ignore window options (toolbars, centering) but still honour layout, zoom and the opening page.",
        hi: "ये नियम PDF स्टैंडर्ड का हिस्सा हैं, इसलिए Adobe, Foxit जैसे डेस्कटॉप रीडर मानते हैं। ब्राउज़र टैब ज़्यादातर विंडो वाले नियम छोड़ देते हैं, पर लेआउट, ज़ूम और शुरुआती पेज मानते हैं।",
      },
    },
    {
      q: {
        en: "What does \"Keep as-is\" mean?",
        hi: "\"जैसा है वैसा\" का मतलब क्या है?",
      },
      a: {
        en: "That entry is left exactly as the file has it today. Only the settings you actively choose are written — so you can change just the zoom without disturbing anything else.",
        hi: "वह एंट्री बिल्कुल वैसी ही रहती है जैसी आज है। सिर्फ़ जो आप चुनते हैं वही लिखा जाता है — बाकी कुछ अछूता।",
      },
    },
    {
      q: {
        en: "Why would I hide the toolbar or menu bar?",
        hi: "टूलबार या मेन्यू बार छिपाना कब काम आता है?",
      },
      a: {
        en: "It makes a clean reading or kiosk-style view — great for sharing a presentation, a form to fill, or a document meant to be read, not edited.",
        hi: "साफ़ पढ़ने वाला या कियोस्क जैसा नज़ारा — प्रेज़ेंटेशन, भरने वाला फ़ॉर्म या सिर्फ़ पढ़ने के लिए बना दस्तावेज़।",
      },
    },
  ],
};
