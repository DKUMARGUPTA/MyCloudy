import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Workflow Builder (PHASE-6) — the visual pipeline editor: chain any
 * runnable PDF tool (compress → watermark → page numbers → …), run the
 * whole chain end-to-end on one file, watch per-step progress, and
 * save / load / export / import pipelines as JSON. The node library
 * auto-builds from the live registry (buildWorkflowLibrary in lib.ts),
 * execution reuses the shared toolRunner worker pool — no new engine
 * code, every step runs the exact worker its standalone tool uses.
 *
 * noFile: the surface IS the product (generate-password pattern) — it
 * owns its own DropZone (pipeline input), step editor, run phases and
 * results; the shell renders it straight on the landing page.
 */
export const config: ToolConfig = {
  toolId: "workflow-builder",
  noFile: true,
  minFiles: 0,
  maxFiles: 0,
  options: [],
  howKeys: ["wf.how1", "wf.how2", "wf.how3"],
  features: [
    {
      en: "Chain any tools into one pipeline — compress, watermark, page numbers, rotate, stamp — and run the whole chain in a single click.",
      hi: "किसी भी टूल्स को एक पाइपलाइन में जोड़ें — कंप्रेस, वॉटरमार्क, पेज नंबर, घुमाव, स्टैंप — और पूरी चेन एक क्लिक में चलाएँ।",
    },
    {
      en: "Every step shows its own live progress, and the output of one step flows straight into the next — no downloads in between.",
      hi: "हर स्टेप अपना लाइव प्रोग्रेस दिखाता है, और एक स्टेप का आउटपुट सीधे अगले में जाता है — बीच में कोई डाउनलोड नहीं।",
    },
    {
      en: "Save pipelines on this device, or export them as a small JSON file and import them anywhere — your recipe, your control.",
      hi: "पाइपलाइन इसी डिवाइस पर सेव करें, या छोटी JSON फ़ाइल की तरह एक्सपोर्ट करके कहीं भी इंपोर्ट करें — आपका नुस्ख़ा, आपका कंट्रोल।",
    },
    {
      en: "Ready-made presets for the everyday chains: email-ready compress, scan cleanup, archive prep — one tap to load.",
      hi: "रोज़मर्रा की चेन के लिए तैयार प्रीसेट: ईमेल के लिए कंप्रेस, स्कैन साफ़, आर्काइव — एक टैप में लोड।",
    },
    {
      en: "Runs entirely on your device — the file and every intermediate result stay in your browser's memory.",
      hi: "पूरा काम डिवाइस पर — फ़ाइल और हर बीच का नतीजा ब्राउज़र की मेमोरी में ही रहते हैं।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which tools can I put in a pipeline?",
        hi: "पाइपलाइन में कौन से टूल्स डाल सकते हैं?",
      },
      a: {
        en: "Every tool that takes a PDF in and gives a PDF out — compress, watermark, page numbers, rotate, stamps, headers, metadata, and dozens more. The picker only lists tools that chain safely, so you can never build a broken pipeline.",
        hi: "हर वह टूल जो PDF लेता है और PDF देता है — कंप्रेस, वॉटरमार्क, पेज नंबर, घुमाव, स्टैंप, हेडर, मेटाडेटा और दर्जनों और। पिकर में सिर्फ़ सुरक्षित जुड़ने वाले टूल्स आते हैं, टूटी पाइपलाइन बन ही नहीं सकती।",
      },
    },
    {
      q: {
        en: "What happens if a step fails halfway?",
        hi: "अगर बीच का स्टेप फेल हो जाए तो?",
      },
      a: {
        en: "The run stops at that step with an honest error message — steps before it have already succeeded, and you can fix the options and run again from the top. Nothing is hidden, nothing silently skipped.",
        hi: "रन उसी स्टेप पर ईमानदार एरर के साथ रुकता है — उससे पहले के स्टेप पहले ही हो चुके हैं; आप विकल्प ठीक करके दोबारा शुरू से चला सकते हैं। कुछ छिपा नहीं, कुछ चुपचाप छोड़ा नहीं।",
      },
    },
    {
      q: {
        en: "Where are my saved pipelines stored?",
        hi: "मेरी सेव की पाइपलाइन कहाँ रहती हैं?",
      },
      a: {
        en: "On your device only, in the browser's local storage — nothing is uploaded anywhere. Export to JSON gives you a backup you can import on another device or share with a colleague.",
        hi: "सिर्फ़ आपके डिवाइस पर, ब्राउज़र के लोकल स्टोरेज में — कहीं अपलोड नहीं होती। JSON एक्सपोर्ट से बैकअप मिलता है जिसे दूसरे डिवाइस पर इंपोर्ट करें या साथी को भेजें।",
      },
    },
  ],
};
