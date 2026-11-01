import type { L10n } from "@/lib/tools/registry";

/**
 * Programmatic SEO landing pages (PHASE-4): intent-specific routes that
 * open the compress-pdf-to-size tool with the matching target preset.
 * Unique title / description / FAQ per page (EN + HI), FAQPage +
 * BreadcrumbList JSON-LD, hreflang pair, sitemap-included.
 */

export interface LandingFaqItem {
  q: L10n;
  a: L10n;
}

export interface CompressLanding {
  /** URL slug: /<slug> (and /hi/<slug>). */
  slug: string;
  /** Tool option preset applied at shell mount. */
  preset: Record<string, string | number | boolean>;
  title: L10n;
  description: L10n;
  keywords: L10n;
  /** One-line proof under the H1 (SSR-hidden — the tool is the hero). */
  intro: L10n;
  faq: LandingFaqItem[];
}

export const COMPRESS_LANDINGS: readonly CompressLanding[] = [
  {
    slug: "compress-pdf-to-100kb",
    preset: { target: "100" },
    title: {
      en: "Compress PDF to 100 KB — Free, On-Device",
      hi: "PDF को 100 KB में कंप्रेस करें — मुफ़्त, डिवाइस पर",
    },
    description: {
      en: "Shrink any PDF under 100 KB online for free — government form portals, exam applications and upload limits. Nothing uploads; it all happens on your device.",
      hi: "कोई भी PDF 100 KB से कम करें — सरकारी फ़ॉर्म पोर्टल, परीक्षा आवेदन और अपलोड लिमिट के लिए। कुछ अपलोड नहीं होता; सब आपके डिवाइस पर।",
    },
    keywords: {
      en: "compress pdf to 100kb, pdf under 100kb, reduce pdf size 100kb, 100 kb pdf compressor",
      hi: "pdf 100 kb, pdf छोटी करें 100kb, 100kb pdf",
    },
    intro: {
      en: "The 100 KB target is preselected — drop your PDF and run.",
      hi: "100 KB का लक्ष्य पहले से चुना हुआ है — PDF डालें और रन करें।",
    },
    faq: [
      {
        q: { en: "How do I get a PDF under 100 KB?", hi: "PDF को 100 KB से कम कैसे करूँ?" },
        a: {
          en: "Drop the file on this page — the 100 KB target is already selected — and press run. The tool re-encodes images and optimizes streams until the file fits the limit, trying progressively stronger passes only as needed.",
          hi: "फ़ाइल इस पेज पर डालें — 100 KB का लक्ष्य पहले से चुना है — और रन दबाएँ। टूल इमेज दोबारा एनकोड करता और स्ट्रीम ऑप्टिमाइज़ करता है जब तक फ़ाइल लिमिट में फिट हो जाए, ज़रूरत के हिसाब से लगातार मज़बूत पास आज़माते हुए।",
        },
      },
      {
        q: { en: "Will text stay readable at 100 KB?", hi: "100 KB पर टेक्स्ट पढ़ने लायक रहेगा?" },
        a: {
          en: "Text stays vector-sharp — compression targets images first. A text document with a small logo usually reaches 100 KB with no visible loss; a photo-heavy file has to lose some image quality to fit, which the tool does honestly and only as much as needed.",
          hi: "टेक्स्ट वेक्टर-साफ़ रहता है — कंप्रेशन पहले इमेज पर चलता है। छोटे लोगो वाला टेक्स्ट दस्तावेज़ आम तौर पर बिना दिखने लायक नुक़सान के 100 KB पहुँच जाता है; फ़ोटो-भरी फ़ाइल को कुछ इमेज क्वालिटी देनी पड़ती है, जो टूल ईमानदारी से, जितनी ज़रूरी है उतनी ही लेता है।",
        },
      },
      {
        q: { en: "Why do portals ask for exactly 100 KB?", hi: "पोर्टल ठीक 100 KB क्यों माँगते हैं?" },
        a: {
          en: "Government and exam portals cap uploads to keep their servers light. 100 KB is the most common limit for signatures, photos and certificates in Indian form portals — this page exists for exactly that.",
          hi: "सरकारी और परीक्षा पोर्टल अपलोड पर कैप रखते हैं ताकि सर्वर हल्के रहें। भारतीय फ़ॉर्म पोर्टल में हस्ताक्षर, फ़ोटो और प्रमाणपत्र के लिए 100 KB सबसे आम लिमिट है — यह पेज उसी के लिए है।",
        },
      },
    ],
  },
  {
    slug: "compress-pdf-to-200kb",
    preset: { target: "200" },
    title: {
      en: "Compress PDF to 200 KB — Free, On-Device",
      hi: "PDF को 200 KB में कंप्रेस करें — मुफ़्त, डिवाइस पर",
    },
    description: {
      en: "Bring any PDF under 200 KB online for free — form portals, visa applications and email limits. Private by design: the file never leaves your device.",
      hi: "कोई भी PDF 200 KB से कम करें — फ़ॉर्म पोर्टल, वीज़ा आवेदन और ईमेल लिमिट के लिए। गोपनीयता डिज़ाइन में है: फ़ाइल कभी डिवाइस से बाहर नहीं जाती।",
    },
    keywords: {
      en: "compress pdf to 200kb, pdf under 200kb, reduce pdf to 200 kb",
      hi: "pdf 200 kb, pdf छोटी करें 200kb",
    },
    intro: {
      en: "The 200 KB target is preselected — drop your PDF and run.",
      hi: "200 KB का लक्ष्य पहले से चुना हुआ है — PDF डालें और रन करें।",
    },
    faq: [
      {
        q: { en: "Is 200 KB enough for a scanned document?", hi: "स्कैन किए दस्तावेज़ के लिए 200 KB काफ़ी है?" },
        a: {
          en: "For a one-to-two page scan with reasonable DPI, yes. The tool re-encodes scans as optimized JPEG and can bring a typical 2-page document under 200 KB while keeping it readable.",
          hi: "एक-दो पेज के ठीक DPI वाले स्कैन के लिए, हाँ। टूल स्कैन को ऑप्टिमाइज़्ड JPEG में बदलता है और आम 2-पेज दस्तावेज़ को पढ़ने लायक हालत में 200 KB से नीचे ला देता है।",
        },
      },
      {
        q: { en: "What if my PDF still won't fit 200 KB?", hi: "अगर मेरी PDF 200 KB में फिट न हो?" },
        a: {
          en: "The tool tries image re-encoding, then grayscale, then rasterization passes. If even the strongest pass can't fit, it says so honestly instead of shipping a broken file — you can then split the document and compress parts separately.",
          hi: "टूल पहले इमेज री-एनकोडिंग, फिर ग्रेस्केल, फिर रास्टराइज़ेशन पास आज़माता है। सबसे मज़बूत पास भी फिट न करा सके तो ईमानदारी से बताता है, टूटी फ़ाइल नहीं देता — तब दस्तावेज़ बाँटकर हिस्से अलग कंप्रेस करें।",
        },
      },
      {
        q: { en: "Does compression work offline?", hi: "क्या कंप्रेशन ऑफ़लाइन चलता है?" },
        a: {
          en: "Yes — the entire pipeline runs in your browser. Once the page has loaded you can even go offline and keep compressing.",
          hi: "हाँ — पूरी पाइपलाइन ब्राउज़र में चलती है। पेज लोड होने के बाद ऑफ़लाइन भी कंप्रेस करते रह सकते हैं।",
        },
      },
    ],
  },
  {
    slug: "compress-pdf-to-500kb",
    preset: { target: "500" },
    title: {
      en: "Compress PDF to 500 KB — Free, On-Device",
      hi: "PDF को 500 KB में कंप्रेस करें — मुफ़्त, डिवाइस पर",
    },
    description: {
      en: "Reduce PDFs under 500 KB online for free — university applications, tender portals and upload forms. Private: everything runs on your device.",
      hi: "PDF 500 KB से कम करें — यूनिवर्सिटी आवेदन, टेंडर पोर्टल और अपलोड फ़ॉर्म के लिए। गोपनीय: सब आपके डिवाइस पर चलता है।",
    },
    keywords: {
      en: "compress pdf to 500kb, pdf under 500kb, reduce pdf 500 kb",
      hi: "pdf 500 kb, pdf छोटी करें 500kb",
    },
    intro: {
      en: "The 500 KB target is preselected — drop your PDF and run.",
      hi: "500 KB का लक्ष्य पहले से चुना हुआ है — PDF डालें और रन करें।",
    },
    faq: [
      {
        q: { en: "How much quality survives a 500 KB compress?", hi: "500 KB कंप्रेशन में कितनी क्वालिटी बचती है?" },
        a: {
          en: "Usually all of it — 500 KB is roomy. Multi-page documents with normal graphics often land under 500 KB with image quality barely touched.",
          hi: "आम तौर पर सब — 500 KB काफ़ी जगह है। सामान्य ग्राफ़िक्स वाले कई-पेज दस्तावेज़ अक्सर इमेज क्वालिटी को छेड़े बिना 500 KB में आ जाते हैं।",
        },
      },
      {
        q: { en: "Can I compress many PDFs to 500 KB at once?", hi: "एक साथ कई PDF 500 KB में कर सकते हैं?" },
        a: {
          en: "Yes — the tool accepts a batch and compresses each file against the target; you download all results together.",
          hi: "हाँ — टूल बैच लेता है और हर फ़ाइल को लक्ष्य के हिसाब से कंप्रेस करता है; सारे नतीजे साथ डाउनलोड करते हैं।",
        },
      },
      {
        q: { en: "Which portals ask for 500 KB?", hi: "कौन-से पोर्टल 500 KB माँगते हैं?" },
        a: {
          en: "University applications, government tenders and several banks use 500 KB as their document upload cap — the roomiest of the common limits.",
          hi: "यूनिवर्सिटी आवेदन, सरकारी टेंडर और कई बैंक दस्तावेज़ अपलोड की कैप 500 KB रखते हैं — आम लिमिटों में सबसे खुली।",
        },
      },
    ],
  },
  {
    slug: "compress-pdf-to-1mb",
    preset: { target: "1000" },
    title: {
      en: "Compress PDF to 1 MB — Free, On-Device",
      hi: "PDF को 1 MB में कंप्रेस करें — मुफ़्त, डिवाइस पर",
    },
    description: {
      en: "Shrink PDFs under 1 MB online for free — email attachments, submission portals and sharing. 100% on-device, nothing uploaded.",
      hi: "PDF 1 MB से कम करें — ईमेल अटैचमेंट, सबमिशन पोर्टल और शेयरिंग के लिए। 100% डिवाइस पर, कुछ अपलोड नहीं।",
    },
    keywords: {
      en: "compress pdf to 1mb, pdf under 1 mb, reduce pdf to 1mb",
      hi: "pdf 1 mb, pdf छोटी करें 1mb",
    },
    intro: {
      en: "The 1 MB target is preselected — drop your PDF and run.",
      hi: "1 MB का लक्ष्य पहले से चुना हुआ है — PDF डालें और रन करें।",
    },
    faq: [
      {
        q: { en: "Why compress to 1 MB for email?", hi: "ईमेल के लिए 1 MB क्यों?" },
        a: {
          en: "Many offices and portals silently reject attachments over 1 MB. Landing under 1 MB keeps your mail deliverable everywhere without visible quality loss in most documents.",
          hi: "कई दफ़्तर और पोर्टल 1 MB से बड़े अटैचमेंट चुपचाप ठुकरा देते हैं। 1 MB से नीचे रहने से मेल हर जगह पहुँचती है, और ज़्यादातर दस्तावेज़ों में दिखने लायक नुक़सान भी नहीं होता।",
        },
      },
      {
        q: { en: "Is 1 MB compression lossless?", hi: "1 MB कंप्रेशन बिना नुक़सान का है?" },
        a: {
          en: "Text and vector graphics stay lossless throughout; only images are re-encoded, and just enough to fit. Documents that already fit under 1 MB pass through untouched.",
          hi: "टेक्स्ट और वेक्टर ग्राफ़िक्स पूरे बिना नुक़सान रहते हैं; सिर्फ़ इमेज दोबारा एनकोड होती हैं, वह भी फिट होने भर के लिए। जो फ़ाइल पहले से 1 MB में है, वह अछूती निकलती है।",
        },
      },
      {
        q: { en: "How long does it take?", hi: "कितना समय लगता है?" },
        a: {
          en: "A typical document compresses in a few seconds — the work happens in your browser with live progress per page.",
          hi: "आम दस्तावेज़ कुछ सेकंड में कंप्रेस होता है — काम ब्राउज़र में होता है, हर पेज का लाइव प्रोग्रेस के साथ।",
        },
      },
    ],
  },
  {
    slug: "compress-pdf-to-2mb",
    preset: { target: "custom", customKB: 2048 },
    title: {
      en: "Compress PDF to 2 MB — Free, On-Device",
      hi: "PDF को 2 MB में कंप्रेस करें — मुफ़्त, डिवाइस पर",
    },
    description: {
      en: "Bring PDFs under 2 MB online for free — email limits, portal uploads and faster sharing. Everything happens on your device, privately.",
      hi: "PDF 2 MB से कम करें — ईमेल लिमिट, पोर्टल अपलोड और तेज़ शेयरिंग के लिए। सब आपके डिवाइस पर, गोपनीय रूप से।",
    },
    keywords: {
      en: "compress pdf to 2mb, pdf under 2 mb, reduce pdf to 2mb",
      hi: "pdf 2 mb, pdf छोटी करें 2mb",
    },
    intro: {
      en: "The 2 MB target is preselected — drop your PDF and run.",
      hi: "2 MB का लक्ष्य पहले से चुना हुआ है — PDF डालें और रन करें।",
    },
    faq: [
      {
        q: { en: "When do I need 2 MB instead of 1 MB?", hi: "1 MB की जगह 2 MB कब चाहिए?" },
        a: {
          en: "Image-heavy documents — scanned contracts, portfolios, photo reports — keep noticeably better quality under 2 MB. Choose it when the portal allows and the file is visual.",
          hi: "इमेज-भरे दस्तावेज़ — स्कैन किए ठेके, पोर्टफ़ोलियो, फ़ोटो रिपोर्ट — 2 MB में साफ़ बेहतर क्वालिटी रखते हैं। पोर्टल इजाज़त दे और फ़ाइल दिखने वाली हो तो यही चुनें।",
        },
      },
      {
        q: { en: "Can I set my own custom limit?", hi: "अपनी ख़ुद की लिमिट सेट कर सकते हैं?" },
        a: {
          en: "Yes — switch the target to Custom and type any limit from 30 KB to 10 MB. This page just preselects 2048 KB for you.",
          hi: "हाँ — लक्ष्य को कस्टम पर रखकर 30 KB से 10 MB तक कोई भी लिमिट लिखें। यह पेज बस 2048 KB पहले से चुन देता है।",
        },
      },
      {
        q: { en: "Does it work on phones?", hi: "फ़ोन पर चलता है?" },
        a: {
          en: "Yes — the page and the tool are fully responsive; compressing on a phone works exactly like on a laptop.",
          hi: "हाँ — पेज और टूल दोनों पूरी तरह रेस्पॉन्सिव हैं; फ़ोन पर कंप्रेशन लैपटॉप जैसा ही चलता है।",
        },
      },
    ],
  },
  {
    slug: "compress-pdf-for-email",
    preset: { target: "custom", customKB: 5120 },
    title: {
      en: "Compress PDF for Email — Free, On-Device",
      hi: "ईमेल के लिए PDF कंप्रेस करें — मुफ़्त, डिवाइस पर",
    },
    description: {
      en: "Make PDFs emailable for free — fit attachment limits, avoid bounced mail, keep it private on your device. The 5 MB email-safe target is preselected.",
      hi: "PDF को ईमेल के लायक बनाएँ — अटैचमेंट लिमिट फ़िट करें, बाउंस मेल से बचें, डिवाइस पर गोपनीय रखें। 5 MB ईमेल-सुरक्षित लक्ष्य पहले से चुना है।",
    },
    keywords: {
      en: "compress pdf for email, pdf email attachment size, shrink pdf for outlook gmail",
      hi: "ईमेल के लिए pdf कंप्रेस, pdf अटैचमेंट साइज़",
    },
    intro: {
      en: "The 5 MB email-safe target is preselected — drop your PDF and run.",
      hi: "5 MB ईमेल-सुरक्षित लक्ष्य पहले से चुना हुआ है — PDF डालें और रन करें।",
    },
    faq: [
      {
        q: { en: "What's the safe PDF size for email?", hi: "ईमेल के लिए PDF का सुरक्षित साइज़ क्या है?" },
        a: {
          en: "Gmail allows 25 MB, Outlook 20 MB — but mail servers in between often reject 10 MB+. A 5 MB PDF sails through every provider, which is why this page preselects it.",
          hi: "Gmail 25 MB, Outlook 20 MB देते हैं — पर बीच के मेल सर्वर अक्सर 10 MB से ऊपर ठुकरा देते हैं। 5 MB की PDF हर प्रोवाइडर से आसानी से निकलती है, इसीलिए यह पेज वही पहले से चुनता है।",
        },
      },
      {
        q: { en: "How do I attach many PDFs to one email?", hi: "एक ईमेल में कई PDF कैसे जोड़ूँ?" },
        a: {
          en: "Compress each to the email-safe target, then merge them into one file with Merge PDF — a single compact attachment is friendlier to every mail server.",
          hi: "हर एक को ईमेल-सुरक्षित लक्ष्य तक कंप्रेस करें, फिर PDF जोड़ें से एक फ़ाइल बनाएँ — एक ही कॉम्पैक्ट अटैचमेंट हर मेल सर्वर को ज़्यादा पसंद आता है।",
        },
      },
      {
        q: { en: "Will the receiver see quality loss?", hi: "पाने वाले को क्वालिटी गिरती दिखेगी?" },
        a: {
          en: "At 5 MB, almost never — that's generous room for text documents with images. The tool only re-encodes images and only as much as the target demands.",
          hi: "5 MB पर, लगभग कभी नहीं — इमेज वाले टेक्स्ट दस्तावेज़ों के लिए यह भरपूर जगह है। टूल सिर्फ़ इमेज दोबारा एनकोड करता है, वह भी लक्ष्य जितना माँगे उतना।",
        },
      },
    ],
  },
];

const LANDING_BY_SLUG = new Map(COMPRESS_LANDINGS.map((l) => [l.slug, l]));

export function getLanding(slug: string): CompressLanding | undefined {
  return LANDING_BY_SLUG.get(slug);
}

export const LANDING_SLUGS: readonly string[] = COMPRESS_LANDINGS.map((l) => l.slug);
