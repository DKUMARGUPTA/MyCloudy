import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * PDF to PDF/A (RB7-a, the 96th tool, optimize family). The honest
 * ON-DEVICE converter to the PDF/A-1b/2b/3b basic levels:
 *
 *  - the surface owns every value (split-tool pattern): the conformance
 *    target radio (1b/2b/3b, default 2b) + the run labels for the
 *    report's localized sentences;
 *  - the worker runs the REAL conversion (pdf-lib + the pure model):
 *    soft masks/alpha are rejected for -1b (allowed at -2b+), every font
 *    actually used is embedded or substituted (the standard-14 may stay
 *    unembedded at -1b — the spec's only font exception; at -2b/-3b they
 *    get metric-compatible substitute programs from the self-hosted
 *    pdf.js assets), device gray/CMYK color operators in page + form
 *    content streams are rewritten to DeviceRGB (documented naive
 *    formulas — no ICC source profiles are invented), the
 *    /Names/JavaScript tree, forbidden /OpenAction + /AA actions and
 *    multimedia annotations are removed, and embedded files are dropped
 *    (-1b/-2b) or kept + /AFRelationship-patched (-3b);
 *  - a fresh XMP packet (dc:title from /Info + pdfaid:part + conformance
 *    B) becomes the catalog /Metadata, a REAL hand-rolled sRGB ICC v2.1
 *    profile becomes the /DestOutputProfile of a /GTS_PDFA1
 *    OutputIntent, the trailer /ID is ensured and the header is stamped
 *    %PDF-1.4 (-1b) / %PDF-1.7 (-2b/-3b);
 *  - the output ships with a plain-text change report that says exactly
 *    what was changed and what could not be (including the -b vs -a
 *    tagging honesty) — never a certified ISO 19005 validation.
 */
export const config: ToolConfig = {
  toolId: "pdf-to-pdfa",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  howKeys: ["pa.how1", "pa.how2", "pa.how3"],
  chainToolIds: ["validate-pdfa", "view-pdf", "verify-pdf-signatures"],
  features: [
    {
      en: "A real PDF/A-1b/2b/3b conversion, entirely on your device: the document is loaded in a worker thread, its content streams are inflated and rewritten operator by operator, and a fresh file with the XMP identification, an OutputIntent and a flat xref is saved — nothing is uploaded anywhere.",
      hi: "असली PDF/A-1b/2b/3b रूपांतरण, पूरी तरह आपके डिवाइस पर: दस्तावेज़ वर्कर थ्रेड में लोड होता है, उसके कंटेंट स्ट्रीम इन्फ्लेट करके ऑपरेटर-दर-ऑपरेटर फिर लिखे जाते हैं, और XMP पहचान, OutputIntent और फ़्लैट xref के साथ नई फ़ाइल सेव होती है — कुछ भी अपलोड नहीं होता।",
    },
    {
      en: "Device colors are normalized honestly: every g/G and k/K operator and every gray/CMYK cs/CS + sc/scn in page and Form XObject content streams is rewritten to its DeviceRGB equivalent with the documented naive formulas — shadings, patterns, Separation/Indexed spaces and inline images are counted and left untouched, never silently altered.",
      hi: "डिवाइस रंग ईमानदारी से सामान्य किए जाते हैं: पेज और फ़ॉर्म XObject कंटेंट स्ट्रीम का हर g/G और k/K ऑपरेटर तथा हर ग्रे/CMYK cs/CS + sc/scn दस्तावेज़ सूत्रों से अपने DeviceRGB रूप में लिखा जाता है — शेडिंग, पैटर्न, Separation/Indexed स्पेस और इनलाइन इमेज गिनकर वैसे ही छोड़े जाते हैं, चुपचाप बदले नहीं जाते।",
    },
    {
      en: "Fonts by USE, per level: fonts already embedded pass through untouched; the standard-14 may stay unembedded at PDF/A-1b (the spec's only font exception) and get metric-compatible substitute programs at -2b/-3b (Liberation Sans and the Foxit serif/mono programs, self-hosted, /Widths rewritten from the canonical AFM); a font that is neither embedded nor standard-14 is an honest rejection with the page list.",
      hi: "फ़ॉन्ट उपयोग के आधार पर, स्तर के अनुसार: पहले से एम्बेडेड फ़ॉन्ट वैसे ही रहते हैं; स्टैंडर्ड-14 PDF/A-1b पर बिना एम्बेड चल सकते हैं (विनिर्देश की एकमात्र फ़ॉन्ट छूट) और -2b/-3b पर मीट्रिक-संगत विकल्प प्रोग्राम पाते हैं (Liberation Sans और Foxit सेरिफ़/मोनो, सेल्फ़-होस्टेड, /Widths कैननिकल AFM से लिखे जाते हैं); जो फ़ॉन्ट न एम्बेडेड है न स्टैंडर्ड-14, वह पेज सूची के साथ ईमानदार अस्वीकृति है।",
    },
    {
      en: "Forbidden content is removed and counted: the /Names/JavaScript tree, JavaScript/Launch/Sound/Movie/GoToR/GoToE/Rendition actions and multimedia annotations are stripped; embedded files are dropped at -1b/-2b and kept with /AFRelationship patched at -3b (how Factur-X archives work); encrypted inputs are refused — PDF/A forbids encryption.",
      hi: "निषिद्ध सामग्री हटाई जाती है और गिनी जाती है: /Names/JavaScript ट्री, JavaScript/Launch/Sound/Movie/GoToR/GoToE/Rendition एक्शन और मल्टीमीडिया एनोटेशन हटाए जाते हैं; एम्बेडेड फ़ाइलें -1b/-2b पर हटती हैं और -3b पर /AFRelationship पैच करके रहती हैं (फ़ैक्चर-X अभिलेख इसी से काम करते हैं); एन्क्रिप्टेड इनपुट मना है — PDF/A एन्क्रिप्शन को मना करता है।",
    },
    {
      en: "The identification is real: a fresh XMP packet (dc:title mirrored from /Info, pdfaid:part, conformance B) plus an OutputIntent carrying a genuine hand-rolled sRGB ICC v2.1 profile (matrix/TRC, Bradford-adapted primaries, the true piecewise tone curve at 1024 samples), a trailer /ID and the right %PDF- header version.",
      hi: "पहचान असली है: ताज़ा XMP पैकेट (/Info से मिरर किया dc:title, pdfaid:part, conformance B) और साथ में असली हैंड-रोल्ड sRGB ICC v2.1 प्रोफ़ाइल वाला OutputIntent (matrix/TRC, ब्रैडफ़ोर्ड-एडाप्टेड प्राइमरी, 1024 सैंपल पर सच्चा पीसवाइज़ टोन कर्व), ट्रेलर /ID और सही %PDF- हेडर संस्करण।",
    },
    {
      en: "A plain-text change report ships with every conversion — what was changed, what could not be, per-page notes and the honest limits (no tagging at -b levels, no certified ISO 19005 validation). Chain straight into Validate PDF/A to see an independent on-device check of the result.",
      hi: "हर रूपांतरण के साथ सादा टेक्स्ट बदलाव रिपोर्ट आती है — क्या बदला, क्या नहीं बदल सका, प्रति-पेज टिप्पणियाँ और ईमानदार सीमाएँ (-b स्तरों पर कोई टैगिंग नहीं, कोई प्रमाणित ISO 19005 सत्यापन नहीं)। नतीजे की स्वतंत्र जाँच देखने के लिए सीधे PDF/A जाँच टूल में जाएँ।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is the output a certified PDF/A file?",
        hi: "क्या नतीजा प्रमाणित PDF/A फ़ाइल है?",
      },
      a: {
        en: "No — and the report says so on every run. This tool performs the honest -b level conversion: fonts, colors, forbidden content, XMP identification and the OutputIntent are genuinely brought into the PDF/A-1b/2b/3b shape, and the change report lists exactly what was done. But it is not an ISO 19005 certification lab, and its report is not a validation. For archive-grade acceptance, run the result through our Validate PDF/A tool and, where it matters, a certified validator such as veraPDF.",
        hi: "नहीं — और हर रन की रिपोर्ट में यही लिखा है। यह टूल ईमानदार -b स्तर का रूपांतरण करता है: फ़ॉन्ट, रंग, निषिद्ध सामग्री, XMP पहचान और OutputIntent सचमुच PDF/A-1b/2b/3b आकार में लाए जाते हैं, और बदलाव रिपोर्ट ठीक वही सूची देती है जो किया गया। पर यह ISO 19005 प्रमाणन प्रयोगशाला नहीं है, और इसकी रिपोर्ट सत्यापन नहीं है। अभिलेख-स्तर के स्वीकृति निर्णयों के लिए नतीजा हमारे PDF/A जाँच टूल से और जहाँ ज़रूरी हो, veraPDF जैसे प्रमाणित वैलिडेटर से भी जाँचें।",
      },
    },
    {
      q: {
        en: "What do 1b, 2b and 3b mean, and why no 1a/2a/3a?",
        hi: "1b, 2b और 3b का क्या मतलब है, और 1a/2a/3a क्यों नहीं?",
      },
      a: {
        en: "The letter is the conformance level: -b (basic) guarantees the document renders identically forever; -a (accessible) additionally requires a tagged structure tree, alternative text and reading order — a different, much larger job that this tool honestly does not attempt: it produces -b and adds no tags. The number is the part: -1b (2005) is the strictest — no transparency, no embedded files; -2b (2011) allows transparency and JPEG2000; -3b (2012) additionally allows embedded files, which is how Factur-X/ZUGFeRD invoices are archived.",
        hi: "अक्षर अनुरूपता स्तर है: -b (बेसिक) गारंटी देता है कि दस्तावेज़ हमेशा एक जैसा रेंडर होगा; -a (सुगम) उस पर टैग किया संरचना-वृक्ष, वैकल्पिक टेक्स्ट और पढ़ने का क्रम भी माँगता है — यह अलग और बहुत बड़ा काम है जो यह टूल ईमानदारी से नहीं करता: यह -b बनाता है और कोई टैग नहीं जोड़ता। संख्या भाग है: -1b (2005) सबसे सख़्त — न पारदर्शिता, न एम्बेडेड फ़ाइलें; -2b (2011) पारदर्शिता और JPEG2000 अनुमत करता है; -3b (2012) एम्बेडेड फ़ाइलें भी — फ़ैक्चर-X/ZUGFeRD इनवॉइस इसी से अभिलेखित होते हैं।",
      },
    },
    {
      q: {
        en: "Why was my file rejected?",
        hi: "मेरी फ़ाइल अस्वीकृत क्यों हुई?",
      },
      a: {
        en: "Because pretending would have broken it. Soft masks or constant alpha make PDF/A-1b impossible — re-run at 2b or 3b, where transparency is allowed. A font that is neither embedded nor one of the standard-14 cannot be re-typeset honestly, so the file is refused with the exact pages that use it (at -2b/-3b the standard-14 themselves get substituted). Encrypted files are refused outright — PDF/A forbids encryption, and your documents deserve the truth rather than a silently broken output.",
        hi: "क्योंकि दिखावा करने से वह टूट जाती। सॉफ़्ट मास्क या स्थिर अल्फ़ा PDF/A-1b को असंभव बनाते हैं — 2b या 3b पर दोबारा चलाएँ, जहाँ पारदर्शिता अनुमत है। जो फ़ॉन्ट न एम्बेडेड है न स्टैंडर्ड-14, उसे ईमानदारी से दोबारा टाइप नहीं किया जा सकता, इसलिए फ़ाइल उन पेजों के साथ मना होती है जो उसे इस्तेमाल करते हैं (-2b/-3b पर स्टैंडर्ड-14 को विकल्प मिल जाता है)। एन्क्रिप्टेड फ़ाइलें सीधे मना हैं — PDF/A एन्क्रिप्शन मना करता है, और आपके दस्तावेज़ चुपचाप टूटी फ़ाइल की जगह सच जानने के हक़दार हैं।",
      },
    },
    {
      q: {
        en: "What happens to my colors, and what is the OutputIntent profile?",
        hi: "मेरे रंगों का क्या होता है, और OutputIntent प्रोफ़ाइल क्या है?",
      },
      a: {
        en: "Device gray and CMYK operators are converted with the naive, documented formulas every browser canvas uses — an honest approximation that can shift press-intent colors slightly; the change report says exactly this. ICC-based source profiles are not interpreted (that would need the originating color engine). The OutputIntent carries a genuine hand-rolled sRGB ICC v2.1 profile — real Bradford-adapted primaries and the true piecewise tone curve, built from the IEC 61966-2-1 constants, not faked bytes.",
        hi: "डिवाइस ग्रे और CMYK ऑपरेटर उन सरल, दस्तावेज़ सूत्रों से बदले जाते हैं जो हर ब्राउज़र कैनवस इस्तेमाल करता है — ईमानदार अनुमान, जिससे प्रेस-इंटेंट रंग ज़रा खिसक सकते हैं; बदलाव रिपोर्ट यही कहती है। ICC-आधारित सोर्स प्रोफ़ाइल की व्याख्या नहीं होती (उसके लिए मूल रंग-इंजन चाहिए)। OutputIntent में असली हैंड-रोल्ड sRGB ICC v2.1 प्रोफ़ाइल है — असली ब्रैडफ़ोर्ड-एडाप्टेड प्राइमरी और सच्चा पीसवाइज़ टोन कर्व, IEC 61966-2-1 स्थिरांकों से बना, नक़ली बाइट्स नहीं।",
      },
    },
    {
      q: {
        en: "Is my document safe? Where does this happen?",
        hi: "क्या मेरा दस्तावेज़ सुरक्षित है? यह सब कहाँ होता है?",
      },
      a: {
        en: "Entirely inside your browser. A Web Worker thread loads the file, rewrites it and hands the result back as a blob — the document never leaves the device, no account, no upload, no queue. The only things fetched are the self-hosted substitute font programs and nothing else: they are public font files from this site's own origin, not your data.",
        hi: "पूरा काम आपके ब्राउज़र में। एक वर्कर थ्रेड फ़ाइल लोड करती है, उसे फिर लिखती है और नतीजा ब्लॉब के रूप में लौटाती है — दस्तावेज़ डिवाइस से बाहर नहीं जाता, न खाता, न अपलोड, न क़तार। केवल सेल्फ़-होस्टेड विकल्प फ़ॉन्ट प्रोग्राम फ़ेच होते हैं, और कुछ नहीं: वे इसी साइट के पब्लिक फ़ॉन्ट फ़ाइलें हैं, आपका डेटा नहीं।",
      },
    },
  ],
};
