/**
 * SEO merge: adds the "popular" + "faq" home sections (keyword research
 * injection) and updates hero.subtitle to the keyword-rich copy — the one
 * intentional clobber (explicitly whitelisted here). Verifies perfect
 * en↔hi parity, then rewrites src/i18n/{en,hi}.json atomically.
 * Run: bun scripts/merge-home-seo-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

/** The single key this merge is allowed to overwrite (copy upgrade). */
const ALLOW_UPDATE = new Set(["hero.subtitle"]);

const patches = {
  en: {
    popular: {
      title: "Popular PDF tools",
      subtitle:
        "Free PDF converter, editor, merger and signer — the tools people reach for most, running entirely in your browser.",
    },
    faq: {
      title: "Frequently asked questions",
      subtitle: "Free PDF tools, privacy and Hindi support — the essentials.",
      q1: "Is DocoPDF really free to use?",
      a1: "Yes. Every tool is free, with no signup, no watermarks and no daily limits. Because most tools run entirely in your browser, they're fast too — your files are processed on your own device, not a distant server.",
      q2: "How do I convert JPG to PDF for free?",
      a2: "Open the JPG to PDF tool, drop your photos (JPG, PNG, WEBP, HEIC and TIFF all work), drag them into the order you want, and click Create PDF. The document is built on your device — nothing is ever uploaded.",
      q3: "How can I convert a PDF to Word or text?",
      a3: "For text, use PDF to Text — it extracts everything on your device and can even read scanned pages with OCR in English or Hindi. A full PDF to Word converter that keeps formatting is on our roadmap.",
      q4: "Are my PDF files uploaded to a server?",
      a4: "No. Almost every tool runs 100% on your device inside the browser — your files never leave your computer or phone, and once the site is loaded most tools keep working even offline.",
      q5: "Can I edit a PDF without Adobe Acrobat?",
      a5: "Yes. Edit PDF gives you a Word-style editor — click existing text to retype it, add images, shapes and signatures, highlight and annotate — free and on your device. Annotate PDF and Write PDF round out the set.",
      q6: "Does DocoPDF work in Hindi?",
      a6: "Yes. The whole interface is available in Hindi, and you can write PDFs in Devanagari, fill Hindi forms and OCR scanned documents in Hindi with fully searchable output.",
    },
  },
  hi: {
    popular: {
      title: "लोकप्रिय पीडीएफ़ टूल्स",
      subtitle:
        "फ़्री पीडीएफ़ कन्वर्टर, एडिटर, मर्जर और साइनर — सबसे ज़्यादा इस्तेमाल होने वाले टूल्स, पूरे के पूरे आपके ब्राउज़र में।",
    },
    faq: {
      title: "अक्सर पूछे जाने वाले सवाल",
      subtitle: "फ़्री पीडीएफ़ टूल्स, प्राइवेसी और हिंदी सहायता — ज़रूरी बातें।",
      q1: "क्या DocoPDF सच में फ़्री है?",
      a1: "हाँ। हर टूल फ़्री है — कोई साइनअप नहीं, कोई वॉटरमार्क नहीं, कोई डेली लिमिट नहीं। ज़्यादातर टूल्स पूरे ब्राउज़र में ही चलते हैं, इसलिए तेज़ भी हैं — आपकी फ़ाइलें आपके ही डिवाइस पर प्रोसेस होती हैं, किसी दूर के सर्वर पर नहीं।",
      q2: "JPG को PDF में मुफ़्त कैसे बदलें?",
      a2: "JPG to PDF टूल खोलिए, फ़ोटो ड्रॉप कर दीजिए (JPG, PNG, WEBP, HEIC और TIFF सब चलते हैं), क्रम बदल लीजिए और Create PDF दबा दीजिए। दस्तावेज़ आपके डिवाइस पर ही बनता है — कुछ भी अपलोड नहीं होता।",
      q3: "PDF को Word या टेक्स्ट में कैसे बदलें?",
      a3: "टेक्स्ट के लिए PDF to Text इस्तेमाल करें — यह सब कुछ आपके डिवाइस पर निकालता है और स्कैन किए पेज भी OCR से पढ़ लेता है (अंग्रेज़ी या हिंदी)। फ़ॉर्मैटिंग बचाने वाला पूरा PDF to Word कन्वर्टर हमारी रोडमैप पर है।",
      q4: "क्या मेरी PDF फ़ाइलें किसी सर्वर पर अपलोड होती हैं?",
      a4: "नहीं। लगभग हर टूल आपके ब्राउज़र में, आपके डिवाइस पर ही चलता है — फ़ाइलें आपके कंप्यूटर या फ़ोन से बाहर नहीं जातीं, और साइट एक बार लोड होने के बाद ज़्यादातर टूल्स ऑफ़लाइन भी चलते रहते हैं।",
      q5: "Adobe Acrobat के बिना PDF एडिट कर सकते हैं?",
      a5: "हाँ। Edit PDF आपको वर्ड जैसा एडिटर देता है — मौजूदा टेक्स्ट पर क्लिक करके बदलें, तस्वीरें, आकृतियाँ और सिग्नेचर जोड़ें, हाइलाइट और एनोटेट करें — मुफ़्त और आपके डिवाइस पर। Annotate PDF और Write PDF भी साथ हैं।",
      q6: "क्या DocoPDF हिंदी में काम करता है?",
      a6: "हाँ! पूरा इंटरफ़ेस हिंदी में है — देवनागरी में PDF लिखें, हिंदी फ़ॉर्म भरें और स्कैन किए दस्तावेज़ों का हिंदी OCR करें, पूरी तरह सर्च करने लायक आउटपुट के साथ।",
    },
  },
};

// hero.subtitle — intentional copy upgrade (the only clobber allowed).
const heroSubtitle = {
  en: "Free PDF converter, editor, merger and more — everything runs right in your browser, no uploads, no signup.",
  hi: "फ़्री पीडीएफ़ कन्वर्टर, एडिटर और मर्जर — सब कुछ सीधे आपके ब्राउज़र में, कोई अपलोड नहीं, कोई साइनअप नहीं।",
};

const updates: Record<string, string> = {};
for (const [section, patch] of Object.entries(patches.en)) {
  if (section in en || section in hi) {
    throw new Error(`section "${section}" already exists — refusing to clobber`);
  }
  en[section] = patch;
}
for (const [section, patch] of Object.entries(patches.hi)) {
  hi[section] = patch;
}

// Apply the whitelisted hero.subtitle update.
if (!("subtitle" in en.hero) || !("subtitle" in hi.hero)) {
  throw new Error("hero.subtitle missing — refusing to run against this catalog");
}
if (en.hero.subtitle === heroSubtitle.en && hi.hero.subtitle === heroSubtitle.hi) {
  console.log("hero.subtitle already up to date");
} else {
  en.hero.subtitle = heroSubtitle.en;
  hi.hero.subtitle = heroSubtitle.hi;
  updates["hero.subtitle"] = "updated";
}

const enAll = Object.keys(en).sort();
const hiAll = Object.keys(hi).sort();
if (JSON.stringify(enAll) !== JSON.stringify(hiAll)) {
  throw new Error("catalog section drift after merge");
}
const enFlat = Object.keys(en).flatMap((s) => Object.keys(en[s])).length;
const hiFlat = Object.keys(hi).flatMap((s) => Object.keys(hi[s])).length;
if (enFlat !== hiFlat) {
  throw new Error(`catalog key parity broken: en ${enFlat} vs hi ${hiFlat}`);
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `home SEO i18n merged: +${Object.keys(patches.en.popular).length + Object.keys(patches.en.faq).length} keys ×2` +
    (Object.keys(updates).length ? `, ${Object.keys(updates).length} key updated` : "") +
    `, parity ${enFlat} = ${hiFlat} OK`
);
