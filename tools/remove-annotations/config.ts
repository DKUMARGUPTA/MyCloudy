import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Remove annotations (P1-d / R53) — the GRANULAR markup strip. Comments,
 * highlights, drawings and stamps go by default; links and form fields
 * survive unless you explicitly turn their switches on. Page-range
 * targeting for surgical cleanups. Distinct from the one-tap Sanitize
 * (privacy bundle that rebuilds the file): this tool preserves the
 * document structure — form fields stay fillable, links stay clickable,
 * only the chosen annotation groups are filtered out. Own engine,
 * on-device, byte-exact content.
 */
export const config: ToolConfig = {
  toolId: "remove-annotations",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 5,
  options: [
    {
      kind: "switch",
      id: "markup",
      label: { en: "Comments, highlights and drawings", hi: "टिप्पणियाँ, हाइलाइट और ड्रॉइंग" },
      hint: {
        en: "Sticky notes, highlights, underlines, ink sketches, stamps — all review markup.",
        hi: "स्टिकी नोट, हाइलाइट, रेखांकन, स्केच, स्टैम्प — सारा रिव्यू मार्कअप।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "links",
      label: { en: "Links", hi: "लिंक" },
      hint: {
        en: "Clickable web and internal links — usually worth keeping.",
        hi: "क्लिक करने लायक़ वेब और अंदरूनी लिंक — आमतौर पर रखने लायक़।",
      },
      default: false,
    },
    {
      kind: "switch",
      id: "widgets",
      label: { en: "Form fields", hi: "फ़ॉर्म फ़ील्ड" },
      hint: {
        en: "Interactive checkboxes, text boxes and dropdowns — only when clearing ALL pages.",
        hi: "इंटरैक्टिव चेकबॉक्स, टेक्स्ट बॉक्स, ड्रॉपडाउन — सिर्फ़ पूरी फ़ाइल पर चलने पर हटते हैं।",
      },
      default: false,
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "Apply to selected pages only — or all.",
        hi: "चुने पेजों पर ही लागू करें — या सब पर।",
      },
      placeholder: { en: "all", hi: "all" },
      default: "all",
    },
  ],
  chainToolIds: ["sanitize-pdf", "flatten-pdf", "view-metadata"],
  features: [
    {
      en: "Strip review markup — comments, highlights, underlines, drawings, stamps — in one pass.",
      hi: "रिव्यू मार्कअप हटाएँ — टिप्पणियाँ, हाइलाइट, रेखांकन, स्टैम्प — एक ही बार में।",
    },
    {
      en: "Links and form fields SURVIVE by default — you choose exactly what goes.",
      hi: "लिंक और फ़ॉर्म फ़ील्ड डिफ़ॉल्ट रूप से बचे रहते हैं — क्या हटाना है, आप तय करते हैं।",
    },
    {
      en: "Page-range targeting: clean pages 1–3 only, leave the rest untouched.",
      hi: "पेज-रेंज चयन: सिर्फ़ 1–3 साफ़ करें, बाक़ी वैसे ही रहने दें।",
    },
    {
      en: "Preserves document structure — kept form fields stay fillable, kept links stay clickable.",
      hi: "दस्तावेज़ की बनावट बरकरार — बचे फ़ॉर्म भरे जा सकते हैं, बचे लिंक क्लिक होते हैं।",
    },
    {
      en: "Runs entirely on your device — up to 5 files per run, one clean copy each.",
      hi: "पूरा काम डिवाइस पर — एक बार में 5 फ़ाइलें, हर एक की साफ़ कॉपी।",
    },
  ],
  faq: [
    {
      q: {
        en: "How is this different from Sanitize PDF?",
        hi: "यह Sanitize PDF से कैसे अलग है?",
      },
      a: {
        en: "Sanitize is the one-tap privacy bundle — it strips annotations, form fields, scripts and hidden data together and rebuilds the file. This tool is surgical: pick the annotation groups, pick the pages, keep everything else alive. Sanitize before sharing; clean markup before sending a final draft.",
        hi: "Sanitize एक-टैप प्राइवेसी बंडल है — एनोटेशन, फ़ॉर्म, स्क्रिप्ट, छुपा डेटा सब एक साथ हटाकर फ़ाइल दोबारा बनाता है। यह टूल सर्जिकल है: समूह चुनो, पेज चुनो, बाक़ी सब ज़िंदा रखो। शेयर से पहले Sanitize; फ़ाइनल ड्राफ़्ट भेजने से पहले यह।",
      },
    },
    {
      q: {
        en: "Why won't it remove form fields from just pages 1–2?",
        hi: "सिर्फ़ पेज 1–2 से फ़ॉर्म फ़ील्ड हटाने पर मना क्यों करता है?",
      },
      a: {
        en: "Form fields are registered document-wide — a field on page 3 can share its data with widgets on page 1. Removing the registry for a partial strip would silently break the remaining pages, so the form option needs the whole document. The page-range option works freely for comments and highlights.",
        hi: "फ़ॉर्म फ़ील्ड पूरे दस्तावेज़ में रजिस्टर्ड होते हैं — पेज 3 का फ़ील्ड पेज 1 के विजेट से डेटा साझा कर सकता है। आधी फ़ाइल में रजिस्ट्री हटाने से बाक़ी पेज चुपचाप टूट जाएँगे, इसलिए फ़ॉर्म विकल्प पूरी फ़ाइल माँगता है। टिप्पणियों और हाइलाइट के लिए पेज-रेंज आज़ाद है।",
      },
    },
    {
      q: {
        en: "Does removing highlights also remove the highlighted text?",
        hi: "क्या हाइलाइट हटाने से उसके नीचे का टेक्स्ट भी हट जाता है?",
      },
      a: {
        en: "No — a highlight is a transparent layer drawn OVER the page. Removing the layer reveals the original text untouched. The same is true for comments, drawings and stamps: page content is never modified.",
        hi: "नहीं — हाइलाइट पेज के ऊपर बनी पारदर्शी परत है। परत हटने पर नीचे का मूल टेक्स्ट वैसा ही दिखता है। टिप्पणियों, ड्रॉइंग और स्टैम्प के साथ भी यही है: पेज कंटेंट कभी नहीं बदलता।",
      },
    },
  ],
};
