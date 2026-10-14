import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Compare PDFs config (PRD §8.5 View & Check).
 *
 * All controls (view tabs, sensitivity, ignore case/whitespace, page
 * mapping) live in the custom surface — the search-pdf precedent: the
 * options schema is intentionally empty, the surface owns the interactive
 * values and serializes them into the shared option values (bookmark
 * effect pattern) so the worker run reports exactly what was on screen.
 *
 * The run writes ONE self-contained PDF report: summary, the page-pair
 * table, the text change list, and the red/green overlay render of every
 * changed page pair.
 */
export const config: ToolConfig = {
  toolId: "compare-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 2,
  maxFiles: 2,
  options: [],
  chainToolIds: ["view-pdf", "lock-pdf", "sign-pdf"],
  howKeys: ["compare.how1", "compare.how2", "compare.how3"],
  features: [
    {
      en: "Drop two PDFs — original and revised — and every page pair lines up in one scroll.",
      hi: "दो PDF डालें — असली और नई — और हर पेज का जोड़ा एक ही स्क्रॉल में सामने आ जाता है।",
    },
    {
      en: "Overlay view paints the exact pixel changes: red = removed, green = added, purple = modified.",
      hi: "ओवरले व्यू पिक्सेल-स्तर के बदलाव दिखाता है: लाल = हटाया, हरा = जोड़ा, बैंगनी = बदला।",
    },
    {
      en: "Word-level change list with a jump button next to every change — see it on the pages instantly.",
      hi: "हर बदलाव के साथ शब्द-स्तर की सूची और जंप बटन — पेज पर तुरंत देखिए।",
    },
    {
      en: "Smart page mapping survives insertions and deletions: a page added in the middle shifts the pairing, not every page after it.",
      hi: "स्मार्ट पेज मैपिंग जोड़े/हटाए पेज सह लेती है: बीच में पेज जुड़ने पर आगे के सारे पेज 'बदले' नहीं दिखते।",
    },
    {
      en: "Sensitivity control, ignore case and ignore whitespace options — tune what counts as a change.",
      hi: "सेंसिटिविटी, केस और स्पेस नज़रअंदाज़ करने के विकल्प — तय कीजिए कि क्या बदलाव माना जाए।",
    },
    {
      en: "The run writes a shareable PDF report — pair table, text changes and the overlay of every changed page. All on your device.",
      hi: "रन करने पर शेयर करने लायक़ PDF रिपोर्ट बनती है — पेयर टेबल, टेक्स्ट बदलाव और हर बदले पेज का ओवरले। सब आपके डिवाइस पर।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between the three views?",
        hi: "तीनों व्यू में क्या फ़र्क़ है?",
      },
      a: {
        en: "Side by side shows both pages of every pair together — scrolling is automatically in sync. Overlay computes a pixel-level red/green diff of each pair. Text changes lists every word-level difference with a jump button.",
        hi: "साइड बाय साइड हर जोड़े के दोनों पेज साथ दिखाता है — स्क्रॉल अपने आप सिंक रहता है। ओवरले हर जोड़े का पिक्सेल-स्तरीय लाल/हरा डिफ़ बनाता है। टेक्स्ट बदलाव हर शब्द-स्तरीय फ़र्क़ जंप बटन के साथ सूचीबद्ध करता है।",
      },
    },
    {
      q: {
        en: "One file has a page more than the other. How does the pairing work?",
        hi: "एक फ़ाइल में दूसरी से एक पेज ज़्यादा है। जोड़ी कैसे बनती है?",
      },
      a: {
        en: "Smart mapping (default) aligns pages by their text similarity, so a page inserted mid-document shifts the pairing instead of marking every later page as changed. Position mapping simply pairs page 1 with page 1, page 2 with page 2 — the surplus shows as added or removed.",
        hi: "स्मार्ट मैपिंग (डिफ़ॉल्ट) टेक्स्ट मिलता-जुलता होने के आधार पर पेज जोड़ती है, इसलिए बीच में जुड़ा पेज आगे के सारे पेजों को 'बदला' नहीं बनाता। पोज़िशन मैपिंग सीधे पेज 1 के साथ पेज 1 जोड़ती है — बचा हुआ पेज जोड़ा/हटाया दिखता है।",
      },
    },
    {
      q: {
        en: "Does it work with scanned PDFs?",
        hi: "क्या स्कैन की PDF पर भी चलता है?",
      },
      a: {
        en: "Yes — the overlay view is exactly for scans: it compares the rendered pixels, so it catches changes even without selectable text. The text change list needs selectable text; run the OCR tool first for scanned files.",
        hi: "हाँ — ओवरले व्यू स्कैन के लिए ही बना है: वह रेंडर किए पिक्सल तुलना करता है, इसलिए बिना टेक्स्ट वाले स्कैन में भी बदलाव पकड़ता है। टेक्स्ट बदलाव सूची के लिए चुनने योग्य टेक्स्ट चाहिए; स्कैन पहले OCR टूल से निकालें।",
      },
    },
    {
      q: {
        en: "What does the sensitivity control change?",
        hi: "सेंसिटिविटी कंट्रोल क्या बदलता है?",
      },
      a: {
        en: "It sets how small a difference counts as a change: High flags subtle pixel differences and near-identical pages, Low only flags clear changes. Use High for scans or anti-aliased exports, Low for noisy scans that differ everywhere.",
        hi: "यह तय करता है कि कितना छोटा फ़र्क़ बदलाव माना जाए: हाई सूक्ष्म पिक्सल फ़र्क़ और लगभग एक जैसे पेज भी पकड़ता है, लो सिर्फ़ साफ़ बदलाव। स्कैन या एंटी-एलियास्ड एक्सपोर्ट के लिए हाई, शोर भरे स्कैन के लिए लो चुनें।",
      },
    },
  ],
};
