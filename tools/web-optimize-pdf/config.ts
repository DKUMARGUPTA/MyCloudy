import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Web optimize PDF (RB3-b): structural tune-up for online viewing —
 * object stream packing, max-level recompression of compressed streams,
 * unreferenced-object removal and an optional metadata strip (Title/Author
 * survive). Distinct from compress-pdf, which re-encodes PHOTOS (quality/
 * DPI): this tool never touches image pixels — it rebuilds the container.
 */
export const config: ToolConfig = {
  toolId: "web-optimize-pdf",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  chainToolIds: [
    "view-pdf",
    "compress-pdf",
    "protect-pdf",
    "pdf-to-jpg",
  ],
  howKeys: ["wopt.how1", "wopt.how2", "wopt.how3"],
  options: [
    {
      kind: "switch",
      id: "objectStreams",
      label: { en: "Object streams", hi: "ऑब्जेक्ट स्ट्रीम" },
      hint: {
        en: "Packs loose objects into compressed /ObjStm containers — the big structural win on object-heavy files.",
        hi: "बिखरे ऑब्जेक्ट्स कंप्रेस्ड /ObjStm कंटेनरों में पैक होते हैं — ऑब्जेक्ट-भरी फ़ाइलों पर बड़ी बचत।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "recompress",
      label: { en: "Recompress streams", hi: "स्ट्रीम दोबारा कंप्रेस" },
      hint: {
        en: "Every compressed stream is re-deflated at maximum level — replaced only when it is genuinely smaller.",
        hi: "हर कंप्रेस्ड स्ट्रीम अधिकतम लेवल पर दोबारा डिफ्लेट होती है — सिर्फ़ तभी बदलती है जब सच में छोटी हो।",
      },
      default: true,
    },
    {
      kind: "switch",
      id: "stripMetadata",
      label: { en: "Strip metadata", hi: "मेटाडेटा हटाएँ" },
      hint: {
        en: "Drops the XMP block and app-generated Producer/Creator. Title, Author and keywords are kept — your data stays.",
        hi: "XMP ब्लॉक और ऐप-निर्मित Producer/Creator हटते हैं। Title, Author और keywords रहते हैं — आपका डेटा बना रहता है।",
      },
      default: false,
    },
  ],
  features: [
    {
      en: "Object stream packing: loose PDF objects are grouped into compressed /ObjStm containers, shrinking the cross-reference overhead that bloats object-heavy files.",
      hi: "ऑब्जेक्ट स्ट्रीम पैकिंग: बिखरे PDF ऑब्जेक्ट्स कंप्रेस्ड /ObjStm कंटेनरों में समूहबद्ध होते हैं — ऑब्जेक्ट-भरी फ़ाइलों का क्रॉस-रेफ़रेंस ओवरहेड घटता है।",
    },
    {
      en: "Every compressed stream is re-deflated at the maximum level — and replaced only when the new bytes are genuinely smaller. Nothing ever grows.",
      hi: "हर कंप्रेस्ड स्ट्रीम अधिकतम लेवल पर दोबारा डिफ्लेट होती है — और सिर्फ़ तभी बदलती है जब नई बाइट्स सच में छोटी हों। कुछ भी बड़ा नहीं होता।",
    },
    {
      en: "Unreferenced objects left inside the file are found by a reachability walk and dropped — with the honest count shown in the report.",
      hi: "फ़ाइल में छूटे बिना-इस्तेमाल ऑब्जेक्ट्स रीचेबिलिटी वॉक से मिलकर हटा दिए जाते हैं — रिपोर्ट में ईमानदार गिनती के साथ।",
    },
    {
      en: "Optional metadata strip removes the XMP block and app-generated Producer/Creator junk — your Title, Author and keywords stay.",
      hi: "विकल्प में मेटाडेटा हटाना XMP ब्लॉक और ऐप-निर्मित Producer/Creator कचरा हटाता है — आपका Title, Author और keywords रहता है।",
    },
    {
      en: "Honest about fast web view: we optimize structure — we never stamp a fake /Linearized flag.",
      hi: "फ़ास्ट वेब व्यू पर ईमानदारी: हम स्ट्रक्चर ऑप्टिमाइज़ करते हैं — कभी नकली /Linearized फ़्लैग नहीं लगाते।",
    },
    {
      en: "Runs entirely on your device — the PDF is never uploaded.",
      hi: "पूरा काम डिवाइस पर — PDF कहीं अपलोड नहीं होती।",
    },
  ],
  faq: [
    {
      q: {
        en: "Does this make my PDF a \"fast web view\" (linearized) file?",
        hi: "क्या यह मेरी PDF को \"फ़ास्ट वेब व्यू\" (लीनियराइज़्ड) बना देता है?",
      },
      a: {
        en: "No — and we say so honestly. True linearization is a special file layout (first-page objects first, plus hint tables and a /Linearized dictionary) that lets a browser paint page 1 before the whole file has downloaded. Our engine cannot write that structure correctly, and stamping a /Linearized flag without the real hint tables would simply lie to browsers. What we do instead: pack objects into compressed streams, re-deflate content at maximum level and drop junk — a smaller file that downloads faster on any connection.",
        hi: "नहीं — और हम यह साफ़ कहते हैं। असली लीनियराइज़ेशन एक ख़ास फ़ाइल-लेआउट है (पहले पेज के ऑब्जेक्ट्स पहले, साथ में हिंट टेबल और /Linearized डिक्शनरी) जिससे ब्राउज़र पूरी फ़ाइल डाउनलोड होने से पहले ही पहला पेज दिखा देता है। हमारा इंजन यह स्ट्रक्चर सही से नहीं लिख सकता, और बिना असली हिंट टेबल के /Linearized फ़्लैग लगाना ब्राउज़र से झूठ होगा। इसके बजाय हम यह करते हैं: ऑब्जेक्ट्स को कंप्रेस्ड स्ट्रीम में पैक करना, कंटेंट को अधिकतम लेवल पर दोबारा डिफ्लेट करना और कचरा हटाना — छोटी फ़ाइल, हर कनेक्शन पर तेज़ डाउनलोड।",
      },
    },
    {
      q: {
        en: "Why did my file barely shrink?",
        hi: "मेरी फ़ाइल छोटी ही क्यों नहीं हुई?",
      },
      a: {
        en: "Most modern exports are already structurally tight — their objects are packed and their streams compressed near the maximum. Nothing honest can be won there, and we say so instead of showing fake savings. If your file is big because of PHOTOS, use Compress PDF: that tool re-encodes images (quality, pixel size), which is where large scans and photo documents actually shrink.",
        hi: "ज़्यादातर नई एक्सपोर्ट-फ़ाइलें पहले से स्ट्रक्चरली कसी हुई होती हैं — ऑब्जेक्ट्स पैक हैं और स्ट्रीम लगभग अधिकतम कंप्रेस्ड। वहाँ ईमानदारी से कुछ नहीं बचता, और हम यही कहते हैं, नकली बचत नहीं दिखाते। अगर फ़ाइल तस्वीरों की वजह से बड़ी है तो Compress PDF इस्तेमाल करें — वह टूल इमेज दोबारा एन्कोड करता है (क्वालिटी, पिक्सेल साइज़), वहीं बड़े स्कैन और फ़ोटो-दस्तावेज़ असल में छोटे होते हैं।",
      },
    },
    {
      q: {
        en: "Is my content changed at all?",
        hi: "क्या मेरा कंटेंट किसी तरह बदलता है?",
      },
      a: {
        en: "No. Text, fonts, vector art and images keep their exact decoded bytes — only the container structure is rewritten. Pages render identically, selectable text stays selectable, and the optional metadata strip removes only the XMP block plus app-generated Producer/Creator (Title, Author and keywords survive — that is your data).",
        hi: "नहीं। टेक्स्ट, फ़ॉन्ट, वेक्टर आर्ट और तस्वीरों की डिकोडेड बाइट्स बिल्कुल वैसी ही रहती हैं — सिर्फ़ कंटेनर का स्ट्रक्चर नया लिखा जाता है। पेज वैसे ही दिखते हैं, सिलेक्टेबल टेक्स्ट सिलेक्टेबल रहता है, और वैकल्पिक मेटाडेटा स्ट्रिप सिर्फ़ XMP ब्लॉक और ऐप-निर्मित Producer/Creator हटाती है (Title, Author और keywords बचे रहते हैं — वह आपका डेटा है)।",
      },
    },
  ],
};
