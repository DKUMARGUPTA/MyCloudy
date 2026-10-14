import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to WEBP (PRD §7.2 / §8.6) — modern web images: typically 25-35%
 * smaller than JPG at the same visual quality, with optional alpha.
 * Shared worker with pdf-to-jpg/png/tiff; browsers that can't encode WEBP
 * from a canvas (older Safari) get an honest pre-run error instead of
 * silently misnamed PNG bytes.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-webp",
  createWorker: () =>
    new Worker(new URL("../pdf-to-images/worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "image",
  minFiles: 1,
  maxFiles: 5,
  chainToolIds: ["images-to-pdf", "webp-to-pdf"],
  options: [
    {
      kind: "select",
      id: "dpi",
      label: { en: "Resolution (DPI)", hi: "रेज़ोल्यूशन (DPI)" },
      hint: {
        en: "Higher DPI = sharper but heavier files",
        hi: "ज़्यादा DPI = ज़्यादा साफ़ लेकिन भारी फ़ाइलें",
      },
      choices: [
        { value: "72", label: { en: "72 — screen", hi: "72 — स्क्रीन" } },
        { value: "150", label: { en: "150 — balanced", hi: "150 — संतुलित" } },
        { value: "300", label: { en: "300 — print", hi: "300 — प्रिंट" } },
        { value: "600", label: { en: "600 — archive", hi: "600 — आर्काइव" } },
      ],
      default: "150",
    },
    {
      kind: "pages",
      id: "pages",
      label: { en: "Pages", hi: "पेज" },
      hint: {
        en: "All, or ranges like 1-3, 5, 8-",
        hi: "सब, या रेंज जैसे 1-3, 5, 8-",
      },
      default: "all",
    },
    {
      kind: "number",
      id: "quality",
      label: { en: "WEBP quality", hi: "WEBP क्वालिटी" },
      hint: {
        en: "85 keeps pages crisp at a small size",
        hi: "85 पेज साफ़ और साइज़ छोटा रखता है",
      },
      min: 40,
      max: 100,
      step: 5,
      suffix: { en: "%", hi: "%" },
      default: 85,
    },
    {
      kind: "switch",
      id: "transparent",
      label: { en: "Transparent background", hi: "पारदर्शी बैकग्राउंड" },
      hint: {
        en: "Keep PDF pages without a white base — ideal for logos and overlays",
        hi: "सफ़ेद आधार के बिना पेज — लोगो और ओवरले के लिए एकदम सही",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Modern WEBP pages — typically 25-35% smaller than JPG at the same quality.",
      hi: "आधुनिक WEBP पेज — वही क्वालिटी पर JPG से आमतौर पर 25-35% छोटी।",
    },
    {
      en: "Quality slider plus optional transparent background for logos and overlays.",
      hi: "क्वालिटी स्लाइडर और लोगो-ओवरले के लिए विकल्प के रूप में पारदर्शी बैकग्राउंड।",
    },
    {
      en: "72 to 600 DPI, full documents or exact page ranges — ZIP included.",
      hi: "72 से 600 DPI, पूरा दस्तावेज़ या सटीक पेज रेंज — ZIP सहित।",
    },
    {
      en: "Live pixel-size preview before you commit to a big render.",
      hi: "बड़ा रेंडर करने से पहले लाइव पिक्सेल-साइज़ प्रीव्यू।",
    },
    {
      en: "On-device rendering — your PDF never leaves the browser.",
      hi: "डिवाइस पर रेंडरिंग — आपकी PDF ब्राउज़र से बाहर नहीं जाती।",
    },
  ],
  faq: [
    {
      q: { en: "Which browsers can create WEBP here?", hi: "कौन-से ब्राउज़र यहाँ WEBP बना सकते हैं?" },
      a: {
        en: "Chrome, Edge and Firefox encode WEBP natively. If your browser can't (older Safari), DocoPDF tells you before running anything — use PDF to PNG instead.",
        hi: "Chrome, Edge और Firefox यहाँ WEBP बना सकते हैं। अगर आपका ब्राउज़र नहीं बना पाता (पुराना Safari), तो DocoPDF चलाने से पहले ही बता देता है — तब PDF से PNG चुनें।",
      },
    },
    {
      q: { en: "WEBP or JPG — which one?", hi: "WEBP या JPG — कौन-सा?" },
      a: {
        en: "WEBP gives you the same look at a smaller size and also supports transparency. Pick JPG only when a very old app or device must read the file.",
        hi: "WEBP उसी दिखती है और साइज़ में छोटी होती है, साथ में पारदर्शिता भी। JPG सिर्फ़ तब चुनें जब कोई बहुत पुराना ऐप या डिवाइस फ़ाइल पढ़ना हो।",
      },
    },
    {
      q: { en: "How do I export just a few pages?", hi: "कुछ ही पेज निकालें?" },
      a: {
        en: "Write ranges in the Pages field: 1-3, 5, 8- means pages one to three, page five, and eight to the end. Multiple pages download as a ZIP plus singles.",
        hi: "पेज फ़ील्ड में रेंज लिखें: 1-3, 5, 8- का मतलब पेज 1 से 3, पेज 5, और 8 से आख़िर तक। कई पेज ZIP में और अलग-अलग भी मिलते हैं।",
      },
    },
  ],
};
