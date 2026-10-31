import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Combine to single page — stitch every page of a PDF into ONE long page:
 * a continuous vertical scroll (or a horizontal strip). The classic fix
 * for "I want the whole document as one image-like page". 100% on-device
 * own-engine composition.
 */
export const config: ToolConfig = {
  toolId: "combine-single-page",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [
    {
      kind: "select",
      id: "direction",
      label: { en: "Direction", hi: "दिशा" },
      hint: {
        en: "Vertical stitches top-to-bottom; horizontal runs left-to-right.",
        hi: "खड़ा ऊपर से नीचे; आड़ा बाएँ से दाएँ।",
      },
      choices: [
        { value: "vertical", label: { en: "Vertical scroll", hi: "खड़ा स्क्रॉल" } },
        { value: "horizontal", label: { en: "Horizontal strip", hi: "आड़ी पट्टी" } },
      ],
      default: "vertical",
    },
    {
      kind: "select",
      id: "width",
      label: { en: "Width", hi: "चौड़ाई" },
      hint: {
        en: "Every page is scaled to this width before stitching.",
        hi: "जोड़ने से पहले हर पेज इस चौड़ाई पर स्केल होता है।",
      },
      choices: [
        { value: "first", label: { en: "Match page 1", hi: "पेज 1 जितनी" } },
        { value: "widest", label: { en: "Widest page", hi: "सबसे चौड़े पेज जितनी" } },
        { value: "narrowest", label: { en: "Narrowest page", hi: "सबसे पतले पेज जितनी" } },
      ],
      default: "first",
      showWhen: { id: "direction", equals: "vertical" },
    },
    {
      kind: "switch",
      id: "gap",
      label: { en: "Small gap between pages", hi: "पेजों के बीच थोड़ा गैप" },
      hint: {
        en: "Off = seamless scroll; on = a hairline gap so pages don't touch.",
        hi: "बंद = बिना जोड़; चालू = पतली रेखा ताकि पेज न चिपकें।",
      },
      default: false,
    },
  ],
  chainToolIds: ["pdf-to-jpg", "compress-pdf", "pdf-to-png"],
  features: [
    {
      en: "Stitch the whole document into one continuous page.",
      hi: "पूरा दस्तावेज़ एक ही लंबे पेज में जोड़ें।",
    },
    {
      en: "Vertical scroll or horizontal strip — your choice.",
      hi: "खड़ा स्क्रॉल या आड़ी पट्टी — आपकी पसंद।",
    },
    {
      en: "Rotated pages are placed exactly as the reader sees them.",
      hi: "घुमाए पेज वैसे ही लगते हैं जैसे पाठक देखता है।",
    },
    {
      en: "Very long documents continue on the next page automatically.",
      hi: "बहुत लंबे दस्तावेज़ अगले पेज पर अपने आप जारी रहते हैं।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is there a length limit?",
        hi: "क्या लंबाई की कोई सीमा है?",
      },
      a: {
        en: "PDF pages max out at about 5 metres (14,400 points), so longer documents automatically continue on the next output page — nothing is ever cut off.",
        hi: "PDF पेज की सीमा करीब 5 मीटर (14,400 पॉइंट) है, इसलिए लंबे दस्तावेज़ अगले आउटपुट पेज पर अपने आप जारी होते हैं — कुछ भी कटता नहीं।",
      },
    },
    {
      q: {
        en: "Will text stay selectable?",
        hi: "क्या टेक्स्ट चुनने योग्य रहेगा?",
      },
      a: {
        en: "Yes — pages are embedded as live PDF content, not screenshots. Text stays sharp, selectable and searchable.",
        hi: "हाँ — पेज स्क्रीनशॉट नहीं, जीवंत PDF कंटेंट की तरह जुड़ते हैं। टेक्स्ट तेज़, चुनने और खोजने योग्य रहता है।",
      },
    },
    {
      q: {
        en: "How is this different from Pages per sheet (N-up)?",
        hi: "यह 'एक शीट में कई पेज' से कैसे अलग है?",
      },
      a: {
        en: "N-up fits many pages into a fixed sheet for printing. Combine ignores the sheet: the output page grows as long as needed, like one endless scroll.",
        hi: "N-up प्रिंटिंग के लिए नपी-तुली शीट में पेज भरता है। जोड़ें शीट की परवाह नहीं करता — आउटपुट पेज जितना चाहिए उतना लंबा होता है, एक अनंत स्क्रॉल-सा।",
      },
    },
  ],
};
