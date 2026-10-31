import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Add blank page — insert empty pages anywhere: at the start, the end, or
 * before/after any page number. The blank matches the neighbouring page's
 * size, so mixed-size documents stay tidy. 100% on-device own-engine.
 */
export const config: ToolConfig = {
  toolId: "add-blank-page",
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
      id: "position",
      label: { en: "Where", hi: "कहाँ" },
      hint: {
        en: "Where the blank page(s) go.",
        hi: "ख़ाली पेज कहाँ जुड़ेंगे।",
      },
      choices: [
        { value: "start", label: { en: "At the start", hi: "शुरुआत में" } },
        { value: "end", label: { en: "At the end", hi: "अंत में" } },
        { value: "after", label: { en: "After a page", hi: "किसी पेज के बाद" } },
        { value: "before", label: { en: "Before a page", hi: "किसी पेज के पहले" } },
      ],
      default: "end",
    },
    {
      kind: "number",
      id: "atPage",
      label: { en: "Page number", hi: "पेज नंबर" },
      hint: {
        en: "The blank goes after (or before) this page.",
        hi: "ख़ाली पेज इस पेज के बाद (या पहले) लगेगा।",
      },
      min: 1,
      max: 5000,
      step: 1,
      default: 1,
      showWhen: { id: "position", equals: "after" },
    },
    {
      kind: "number",
      id: "atPageBefore",
      label: { en: "Page number", hi: "पेज नंबर" },
      hint: {
        en: "The blank goes before this page.",
        hi: "ख़ाली पेज इस पेज के पहले लगेगा।",
      },
      min: 1,
      max: 5000,
      step: 1,
      default: 1,
      showWhen: { id: "position", equals: "before" },
    },
    {
      kind: "number",
      id: "count",
      label: { en: "How many", hi: "कितने" },
      hint: {
        en: "1–20 blank pages in one run.",
        hi: "एक बार में 1–20 ख़ाली पेज।",
      },
      min: 1,
      max: 20,
      step: 1,
      default: 1,
    },
  ],
  chainToolIds: ["rearrange-pdf-pages", "add-page-numbers", "merge-pdf"],
  features: [
    {
      en: "Insert a blank at the start, the end, or before/after any page.",
      hi: "ख़ाली पेज शुरुआत, अंत, या किसी पेज के आगे/पीछे जोड़ें।",
    },
    {
      en: "The blank matches the page size around it — no odd-sized holes.",
      hi: "ख़ाली पेज आस-पास के पेज के साइज़ का ही — अजीब साइज़ का सुराख़ नहीं।",
    },
    {
      en: "Add up to 20 blanks in one run.",
      hi: "एक बार में 20 तक ख़ाली पेज जोड़ें।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "What size will the blank page be?",
        hi: "ख़ाली पेज किस साइज़ का होगा?",
      },
      a: {
        en: "Exactly the size of its neighbour — at the start it copies page 1, at the end the last page, and after/before page N that page's size. Mixed-size documents stay consistent.",
        hi: "बिल्कुल अपने पड़ोसी जितना — शुरुआत में पेज 1, अंत में आख़िरी पेज, और पेज N के आगे/पीछे उसी पेज का साइज़। मिक्स-साइज़ दस्तावेज़ भी सुसंगत रहते हैं।",
      },
    },
    {
      q: {
        en: "Can I add blanks at several places at once?",
        hi: "क्या एक साथ कई जगह ख़ाली पेज जोड़ सकते हैं?",
      },
      a: {
        en: "One spot per run. Run it again (or use the result as the next input) for more spots — each run is instant.",
        hi: "एक बार में एक जगह। और जगहों के लिए दोबारा चलाएँ (या नतीजे को अगले इनपुट की तरह लें) — हर बार बड़ी तेज़।",
      },
    },
    {
      q: {
        en: "Why would I need a blank page?",
        hi: "ख़ाली पेज की कब ज़रूरत पड़ती है?",
      },
      a: {
        en: "Chapter breaks in print, room for handwritten notes, form sections, or making a scanned document's page count even for duplex printing.",
        hi: "प्रिंट में चैप्टर ब्रेक, हाथ से नोट्स की जगह, फ़ॉर्म सेक्शन, या डुप्लेक्स प्रिंटिंग के लिए पेज-गिनती सम करना।",
      },
    },
  ],
};
