import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Validate PDF/A (RB7-b, the 97th tool): a REAL conformance checker —
 * a veraPDF-inspired honest subset — 100% on-device. It reads the raw
 * bytes, walks xref/trailer (+ linear-scan and object-stream recovery),
 * the pages tree, the inflated content streams, fonts, XMP and
 * OutputIntents, then reports per-check PASS/FAIL/WARNING with page
 * references: XMP identification vs the declared level (1b/2b/3b or
 * auto-detected), font embedding (the -1b standard-14 exemption), device
 * CMYK, transparency rules per level, PostScript functions, encryption,
 * JavaScript, Launch actions, /OpenAction form, embedded files (-3b
 * allows them), multimedia, OutputIntent, level-a structure rules and
 * the /Info↔XMP mirror — plus advisory PDF/UA hints (MarkInfo, /Lang,
 * /Alt scan) that never affect the PDF/A verdict. Downloadable plain-text
 * report, EN+हिंदी.
 *
 * HONEST LIMITS (mirrored in the FAQ + the report footer):
 *  - roughly 15 rule families, NOT the full ISO 19005 standard — a
 *    COMPLIANT verdict means "passed every check in this subset";
 *  - no ICC profile validation (presence is checked, bytes are not);
 *  - the PDF/UA rows are advisory hints, not PDF/UA validation.
 */
export const config: ToolConfig = {
  toolId: "validate-pdfa",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  howKeys: ["vpa.how1", "vpa.how2", "vpa.how3"],
  chainToolIds: ["view-pdf", "verify-pdf-signatures", "repair-pdf"],
  options: [],
  features: [
    {
      en: "Real conformance checking, on-device: the raw PDF bytes are walked — xref/trailer with a linear object-scan recovery for slightly broken files, the pages tree, every content stream inflated and scanned — nothing is trusted on the document's say-so.",
      hi: "असली अनुरूपता जाँच, पूरी डिवाइस पर: थोड़ी टूटी फ़ाइलों के लिए लीनियर ऑब्जेक्ट-स्कैन रिकवरी के साथ xref/ट्रेलर, पेज ट्री और हर कंटेंट स्ट्रीम इन्फ्लेट करके स्कैन — काग़ज़ के दावे पर भरोसा नहीं, बाइट्स पर।",
    },
    {
      en: "Pick the target — PDF/A-1b, -2b, -3b — or let the checker auto-detect from the XMP pdfaid:part, with an honest \"detected X (declared Y)\" line when the file claims something else than you asked for.",
      hi: "लक्ष्य चुनें — PDF/A-1b, -2b, -3b — या XMP pdfaid:part से अपने-आप पहचानने दें; जब फ़ाइल कुछ और दावा करे तो ईमानदार \"पता चला X (आपने माँगा Y)\" पंक्ति के साथ।",
    },
    {
      en: "Fonts judged by USE: only fonts actually referenced by page content (/Name … Tf, Form XObjects included) are checked; -1b's standard-14 exemption is honoured; -2b/-3b list every unembedded font with the pages that used it.",
      hi: "फ़ॉन्ट उपयोग के आधार पर जाँचे जाते हैं: केवल वही फ़ॉन्ट जो पेज कंटेंट में सच में प्रयुक्त हुए (Form XObject समेत); -1b की स्टैंडर्ड-14 छूट मान्य; -2b/-3b हर ग़ैर-एम्बेडेड फ़ॉन्ट उसके पेजों के साथ सूचीबद्ध करते हैं।",
    },
    {
      en: "Color and transparency rules per level: device CMYK (k/K operators, /DeviceCMYK resources) is flagged, /SMask and transparency groups fail -1b but pass -2b+, PostScript calculator functions fail everywhere — each finding with its page references.",
      hi: "स्तर के अनुसार रंग और पारदर्शिता नियम: डिवाइस CMYK (k/K ऑपरेटर, /DeviceCMYK रिसोर्स) पकड़ा जाता है, /SMask और ट्रांसपेरेंसी ग्रुप -1b में फ़ेल पर -2b+ में पास, PostScript फ़ंक्शन हर जगह फ़ेल — हर निष्कर्ष अपने पेज संदर्भों के साथ।",
    },
    {
      en: "Forbidden content and honest levels: encryption, JavaScript, /Launch, multimedia and wrong /OpenAction form fail every level; embedded files fail -1b/-2b and are ALLOWED at -3b; the OutputIntent and /Info↔XMP mirror are warning-level, exactly as honest producers experience them.",
      hi: "निषिद्ध सामग्री और ईमानदार स्तर: एन्क्रिप्शन, JavaScript, /Launch, मल्टीमीडिया और ग़लत /OpenAction रूप हर स्तर पर फ़ेल; एम्बेडेड फ़ाइलें -1b/-2b में फ़ेल और -3b में अनुमत; OutputIntent और /Info↔XMP मिरर चेतावनी-स्तर पर — जैसा ईमानदार निर्माता अनुभव करते हैं।",
    },
    {
      en: "Runs entirely on your device — the document never leaves the browser, and nothing about it is uploaded anywhere. The downloadable plain-text report is generated in the same worker.",
      hi: "पूरा काम आपके डिवाइस पर — दस्तावेज़ ब्राउज़र से बाहर कहीं नहीं जाता, कुछ भी अपलोड नहीं होता। डाउनलोड होने वाली सादी टेक्स्ट रिपोर्ट उसी वर्कर में बनती है।",
    },
  ],
  faq: [
    {
      q: {
        en: "Is this a certified PDF/A validator like veraPDF?",
        hi: "क्या यह veraPDF जैसा प्रमाणित PDF/A वैलिडेटर है?",
      },
      a: {
        en: "No — and it says so in every report. This is an honest subset inspired by veraPDF's rule categories: roughly 15 rule families covering identification, fonts, colour, transparency, forbidden content, structure and metadata mirroring. A COMPLIANT verdict means \"passed every check in this subset\", never \"certified by an accredited lab\". For archive-grade acceptance decisions, run the file through a certified validator as well.",
        hi: "नहीं — और यह हर रिपोर्ट में स्वयं कहता है। यह veraPDF की श्रेणियों से प्रेरित एक ईमानदार उपसमुच्चय है: लगभग 15 नियम-परिवार — पहचान, फ़ॉन्ट, रंग, पारदर्शिता, निषिद्ध सामग्री, संरचना और मेटाडेटा मिरर। COMPLIANT का मतलब केवल \"इस उपसमुच्चय की हर जाँच पास\" है, कभी भी \"प्रमाणित प्रयोगशाला से प्रमाणित\" नहीं। अभिलेख-स्तर के निर्णयों के लिए प्रमाणित वैलिडेटर से भी जाँच लें।",
      },
    },
    {
      q: {
        en: "What do the three levels mean, and which should I pick?",
        hi: "तीन स्तरों का क्या मतलब है, और मैं कौन-सा चुनूँ?",
      },
      a: {
        en: "Pick Auto and the level comes from the file's own XMP pdfaid:part — when the XMP says something else than you declared, the mismatch is reported honestly. -1b is the original 2005 archival level (no transparency, no embedded files, standard-14 fonts may stay unembedded); -2b (2011) allows transparency and JPEG2000; -3b (2012) additionally allows embedded files — that is how Factur-X/ZUGFeRD invoices work. Most archives ask for -1b or -2b.",
        hi: "ऑटो चुनें तो स्तर फ़ाइल के अपने XMP pdfaid:part से आता है — और जब XMP आपके घोषित स्तर से अलग कुछ कहे, तो वह बेमेल ईमानदारी से रिपोर्ट होता है। -1b मूल 2005 अभिलेख स्तर है (न पारदर्शिता, न एम्बेडेड फ़ाइलें, स्टैंडर्ड-14 फ़ॉन्ट बिना एम्बेड चल सकते हैं); -2b (2011) पारदर्शिता और JPEG2000 अनुमत करता है; -3b (2012) एम्बेडेड फ़ाइलें भी — फ़ैक्चर-X/ZUGFeRD इनवॉइस इसी से काम करते हैं। ज़्यादातर अभिलेखागार -1b या -2b माँगते हैं।",
      },
    },
    {
      q: {
        en: "A warning appeared for the OutputIntent — is my file broken?",
        hi: "OutputIntent पर चेतावनी आई — क्या मेरी फ़ाइल ख़राब है?",
      },
      a: {
        en: "No. Many perfectly honest PDF/A producers omit the OutputIntent with an ICC profile, so that check is deliberately warning-level, not a failure: the document may still render identically everywhere. The /Info↔XMP mirror is warning-level for the same reason — the values the spec wants mirrored usually agree, and when they don't you get told exactly which key differs. Warnings never turn a COMPLIANT verdict into NOT COMPLIANT.",
        hi: "नहीं। कई बिल्कुल ईमानदार PDF/A निर्माता ICC प्रोफ़ाइल वाला OutputIntent नहीं लिखते, इसलिए वह जाँच जानबूझकर चेतावनी-स्तर की है, फ़ेल नहीं: दस्तावेज़ हर जगह एक जैसा ही रेंडर हो सकता है। /Info↔XMP मिरर भी इसीलिए चेतावनी-स्तर पर है — विनिर्देश जिन मानों का मिलन चाहता है वे प्रायः मेल खाते हैं, और जब नहीं खाते तो ठीक वही कुंजी बताई जाती है जिसमें फ़र्क़ है। चेतावनियाँ कभी COMPLIENT को NOT COMPLIANT नहीं बनातीं।",
      },
    },
    {
      q: {
        en: "Does the PDF/UA section mean my file is also checked for accessibility?",
        hi: "PDF/UA अनुभाग का मतलब यह है कि मेरी फ़ाइल की सुगम्यता भी जाँची गई?",
      },
      a: {
        en: "Only lightly, and it says so on every row: three advisory hints — MarkInfo /Marked (is the document tagged), the catalog /Lang, and an /Alt scan of the structure tree. These never affect the PDF/A verdict, and full PDF/UA validation (which has over a hundred rules of its own) is NOT performed here. Treat them as a quick accessibility smell-test, nothing more.",
        hi: "केवल हल्के स्तर पर, और हर पंक्ति पर यही लिखा है: तीन सलाहकारी संकेत — MarkInfo /Marked (दस्तावेज़ टैग किया गया है या नहीं), कैटलॉग /Lang, और संरचना-वृक्ष का /Alt स्कैन। ये कभी PDF/A फ़ैसले को नहीं बदलते, और पूरी PDF/UA जाँच (जिसके अपने सौ से ज़्यादा नियम हैं) यहाँ नहीं होती। इन्हें सुगम्यता की त्वरित परख समझें, बस।",
      },
    },
    {
      q: {
        en: "Is my document safe? Where does this happen?",
        hi: "क्या मेरा दस्तावेज़ सुरक्षित है? यह सब कहाँ होता है?",
      },
      a: {
        en: "Entirely inside your browser — a Web Worker reads the raw bytes, walks the structure and runs every check on this device. Nothing is uploaded, no account, no queue; the downloadable report is generated in the same worker, on-device too.",
        hi: "पूरा काम आपके ब्राउज़र में — एक वर्कर थ्रेड कच्ची बाइट्स पढ़ती है, संरचना चलती है और हर जाँच इसी डिवाइस पर होती है। कुछ अपलोड नहीं होता, न खाता, न क़तार; डाउनलोड होने वाली रिपोर्ट भी उसी वर्कर में, डिवाइस पर बनती है।",
      },
    },
  ],
};
