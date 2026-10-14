import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Bookmark PDF (PRD §7.1 / §8.1, Organize) — an outline tree editor:
 * the surface loads any existing bookmarks (pdf.js read-only probe),
 * lets the user add / rename / nest / reorder / delete items, and the
 * worker writes the tree via pdf-lib low-level outline dictionaries,
 * REPLACING the old outline and opening the bookmarks panel
 * (/PageMode /UseOutlines) in every viewer.
 */
export const config: ToolConfig = {
  toolId: "bookmark-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  chainToolIds: ["view-pdf"],
  howKeys: ["bm.how1", "bm.how2", "bm.how3"],
  minFiles: 1,
  maxFiles: 1,
  options: [],
  features: [
    {
      en: "Full outline editor — add bookmarks, nest them up to 6 levels, rename, reorder and delete; what you build is exactly what ships.",
      hi: "पूरा आउटलाइन एडिटर — बुकमार्क जोड़ें, 6 लेवल तक नेस्ट करें, नाम बदलें, क्रम बदलें, मिटाएँ; जो बनाएँगे वही फ़ाइल में जाएगा।",
    },
    {
      en: "Existing bookmarks load automatically — edit what's there or start fresh; the output cleanly replaces the old tree.",
      hi: "पुराने बुकमार्क अपने आप लोड होते हैं — उन्हें संपादित करें या नए से शुरू करें; आउटपुट पुराना ट्री साफ़-सुथरा बदल देता है।",
    },
    {
      en: "One-per-page starter — a bookmark for every page (up to 100) in one click, then rename the ones that matter.",
      hi: "एक क्लिक में हर पेज का बुकमार्क (100 तक) — फिर ज़रूरी वालों के नाम बदल लीजिए।",
    },
    {
      en: "Every bookmark jumps to the top of its page with the zoom retained — the behavior every viewer agrees on.",
      hi: "हर बुकमार्क अपने पेज के ऊपर ले जाता है, ज़ूम जस का तस — वही व्यवहार जिस पर हर व्यूअर सहमत है।",
    },
    {
      en: "Titles are fully Unicode — English, Hindi, anything — and nothing leaves this device.",
      hi: "टाइटल पूरी तरह यूनिकोड — अंग्रेज़ी, हिंदी, कुछ भी — और कुछ भी इस डिवाइस से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is a PDF bookmark / outline?",
        hi: "PDF बुकमार्क या आउटलाइन क्या है?",
      },
      a: {
        en: "It is the navigation tree viewers show in a side panel — the clickable table of contents that jumps to pages. It lives inside the PDF itself, so it works in every reader (Acrobat, browser, phone) and in print it costs nothing.",
        hi: "यह वह नेविगेशन ट्री है जो व्यूअर साइड पैनल में दिखाते हैं — क्लिक करने पर पेज पर ले जाने वाली विषय-सूची। यह PDF के अंदर ही रहती है, इसलिए हर रीडर (Acrobat, ब्राउज़र, फ़ोन) में चलती है और प्रिंट में कुछ नहीं बिगाड़ती।",
      },
    },
    {
      q: {
        en: "Will my existing bookmarks survive?",
        hi: "मेरे पुराने बुकमार्क बचेंगे?",
      },
      a: {
        en: "They load into the editor automatically, so you keep exactly what you keep — rename them, drag them around, nest them deeper, delete the ones you don't want. The output replaces the old tree with the edited one, so nothing old lingers and nothing you kept is lost.",
        hi: "वे एडिटर में अपने आप आ जाते हैं, जो रखेंगे वही रहेगा — नाम बदलें, क्रम घुमाएँ, गहरा नेस्ट करें, न चाहिए वह मिटाएँ। आउटपुट पुराने ट्री की जगह संपादित वाला लगाता है — न पुराना रेंगता है, न रखा हुआ खोता है।",
      },
    },
    {
      q: {
        en: "How deep can bookmarks nest?",
        hi: "बुकमार्क कितने गहरे तक नेस्ट हो सकते हैं?",
      },
      a: {
        en: "The editor goes 6 levels deep — chapter → section → sub-section is the practical limit of usefulness anyway. The PDF format itself would accept more, but the indent button stops honestly at 6 instead of letting you build a tree nobody can navigate.",
        hi: "एडिटर 6 लेवल तक जाता है — अध्याय → अनुभाग → उप-अनुभाग वैसे भी उपयोगिता की वास्तविक सीमा है। PDF फ़ॉर्मैट और गहरा मान लेता, पर इंडेंट बटन 6 पर ईमानदारी से रुकता है — ऐसा पेड़ न बनने दे जिसमें कोई रास्ता न पाए।",
      },
    },
  ],
};
