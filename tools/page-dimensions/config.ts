import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Page dimensions (P1-d / R53) — the dedicated size analyzer. What paper
 * is this PDF? Every page's visible box measured in points, millimetres
 * and inches, orientation classified, standard paper names detected
 * (A4, Letter, Legal, A3, A5, B4, B5, Tabloid, Statement, Executive —
 * ±2pt), mixed-size documents grouped with the dominant size called out.
 * TXT sheet for humans, JSON for scripts. Read-only, on-device — the
 * companion to view-metadata (which reads document info, not geometry).
 */
export const config: ToolConfig = {
  toolId: "page-dimensions",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "format",
      label: { en: "Report format", hi: "रिपोर्ट फ़ॉर्मैट" },
      hint: {
        en: "TXT reads like a spec sheet; JSON is for scripts and pipelines.",
        hi: "TXT स्पेक-शीट जैसा; JSON स्क्रिप्ट और पाइपलाइन के लिए।",
      },
      choices: [
        { value: "txt", label: { en: "TXT — readable", hi: "TXT — पढ़ने लायक़" } },
        { value: "json", label: { en: "JSON — for scripts", hi: "JSON — स्क्रिप्ट के लिए" } },
      ],
      default: "txt",
    },
    {
      kind: "select",
      id: "unit",
      label: { en: "Display unit", hi: "माप की इकाई" },
      hint: {
        en: "JSON always carries pt + mm + inch together; this sets the TXT display.",
        hi: "JSON में pt + mm + inch सब आते हैं; यह सिर्फ़ TXT की इकाई तय करता है।",
      },
      choices: [
        { value: "mm", label: { en: "Millimetres (mm)", hi: "मिलीमीटर (mm)" } },
        { value: "pt", label: { en: "Points (pt)", hi: "पॉइंट (pt)" } },
        { value: "in", label: { en: "Inches (in)", hi: "इंच (in)" } },
      ],
      default: "mm",
    },
    {
      kind: "switch",
      id: "includePages",
      label: { en: "List every page", hi: "हर पेज की पंक्ति" },
      hint: {
        en: "Adds a per-page section. Off shows just the size summary.",
        hi: "हर पेज का साइज़ जोड़ता है। बंद होने पर सिर्फ़ सारांश।",
      },
      default: true,
    },
  ],
  chainToolIds: ["change-pdf-page-size", "crop-pdf", "extract-pdf-pages"],
  features: [
    {
      en: "One question answered instantly: what paper is this PDF? A4, Letter, Legal, Tabloid and more — by name.",
      hi: "एक सवाल का तुरंत जवाब: यह PDF किस पेपर की है? A4, Letter, Legal, Tabloid और भी — नाम के साथ।",
    },
    {
      en: "Every page measured in points, millimetres AND inches — with portrait/landscape/square orientation.",
      hi: "हर पेज की नाप पॉइंट, मिलीमीटर और इंच तीनों में — पोर्ट्रेट/लैंडस्केप/स्क्वेयर दिशा के साथ।",
    },
    {
      en: "Mixed-size detector: groups identical pages, names the dominant size and flags the strays with their page numbers.",
      hi: "मिक्स-साइज़ डिटेक्टर: एक-जैसे पेज समूहबद्ध, सबसे आम साइज़ नाम से, बाक़ी पेज अपने नंबर के साथ।",
    },
    {
      en: "Print-shop ready — the exact numbers a printer asks for, before you send the file.",
      hi: "प्रिंट-शॉप तैयार — फ़ाइल भेजने से पहले वही नंबर जो प्रिंटर माँगता है।",
    },
    {
      en: "Strictly read-only — nothing is modified, nothing leaves your device.",
      hi: "पूरी तरह सिर्फ़ पढ़ने लायक़ — कुछ नहीं बदलता, डिवाइस से बाहर नहीं जाता।",
    },
  ],
  faq: [
    {
      q: {
        en: "Which box does it measure — CropBox or MediaBox?",
        hi: "यह कौन-सा बॉक्स नापता है — CropBox या MediaBox?",
      },
      a: {
        en: "The visible one. PDFs carry a full sheet (MediaBox) and a visible window (CropBox) — this tool reports the window, which is what you actually see and print. When a page has no CropBox it falls back to the MediaBox, exactly like viewers do.",
        hi: "जो दिखता है वही। PDF में पूरी शीट (MediaBox) और दिखने वाली खिड़की (CropBox) होती है — यह टूल खिड़की नापता है, जो आप देखते और प्रिंट करते हैं। CropBox न हो तो MediaBox, बिल्कुल व्यूअर की तरह।",
      },
    },
    {
      q: {
        en: "My PDF says A4 but the numbers don't match exactly — why?",
        hi: "मेरी PDF A4 बताती है पर नंबर बिल्कुल मेल नहीं खाते — क्यों?",
      },
      a: {
        en: "Paper names match within a 2-point tolerance (about 0.7mm) — small rounding from the creating tool is normal. Bigger gaps mean the page really is a custom size; the raw numbers are always the truth.",
        hi: "पेपर के नाम 2 पॉइंट (क़रीब 0.7mm) की सहनशीलता से मिलाए जाते हैं — बनाने वाले टूल की छोटी-मोटी राउंडिंग सामान्य है। बड़ा फ़र्क़ का मतलब है पेज सच में कस्टम साइज़ का है; कच्चे नंबर हमेशा सच बोलते हैं।",
      },
    },
    {
      q: {
        en: "Can it change page sizes too?",
        hi: "क्या यह पेज साइज़ बदल भी सकता है?",
      },
      a: {
        en: "No — this tool only measures. The chain link at the end hands the file straight to Change page size, where you can standardize mixed pages, and to Crop for trimming.",
        hi: "नहीं — यह टूल सिर्फ़ नापता है। आख़िर में चेन-लिंक फ़ाइल सीधे Change page size को दे देता है, जहाँ मिक्स पेज एक जैसे किए जा सकते हैं, और Crop से ट्रिम भी।",
      },
    },
  ],
};
