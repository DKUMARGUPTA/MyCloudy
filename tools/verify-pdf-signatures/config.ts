import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Verify PDF signatures (RB6): reads the raw bytes of a signed PDF and
 * reports, per signature: signer name/organization, certificate serial
 * and validity window, signing time, reason/location, the digest
 * algorithm — plus the two byte-level verdicts people actually need:
 * "document integrity intact/tampered" (digest recomputed over the exact
 * /ByteRange bytes) and "modified after signing" (coverage vs file
 * length) — and whether the signature verifies cryptographically
 * (RSASSA-PKCS1-v1_5 via WebCrypto). Runs entirely on-device in a Web
 * Worker.
 *
 * HONEST LIMITS (mirrored in the FAQ + the report footer):
 *  - no CRL/OCSP revocation check, no chain-of-trust validation (there
 *    is no trust store on the device to check against);
 *  - no timestamp (TSA) verification, no PAdES long-term validation;
 *  - a self-signed certificate is reported as exactly that:
 *    untrusted-but-valid.
 */
export const config: ToolConfig = {
  toolId: "verify-pdf-signatures",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "text",
  minFiles: 1,
  maxFiles: 1,
  howKeys: ["vps.how1", "vps.how2", "vps.how3"],
  chainToolIds: ["view-pdf", "sign-pdf", "request-signature"],
  options: [],
  features: [
    {
      en: "Finds every /FT /Sig field and reads its CMS (PKCS#7 SignedData) with a built-in DER/ASN.1 reader: signer name and organization, certificate serial, validity window, signing time, reason and location — straight from the certificate, not from what the document claims.",
      hi: "हर /FT /Sig फ़ील्ड ढूँढकर उसका CMS (PKCS#7 SignedData) पढ़ता है — साथ में बना DER/ASN.1 रीडर: हस्ताक्षरकर्ता का नाम और संस्था, सर्टिफ़िकेट सीरियल, वैधता अवधि, हस्ताक्षर समय, कारण और स्थान — दस्तावेज़ के दावे से नहीं, सर्टिफ़िकेट से सीधे।",
    },
    {
      en: "Tamper detection, for real: the digest is recomputed over the exact /ByteRange bytes (everything except the signature gap) and compared with the signedAttrs messageDigest — intact or tampered, byte for byte. SHA-1/256/384/512 supported.",
      hi: "असली छेड़छाड़ जाँच: /ByteRange के ठीक उन्हीं बाइट्स पर (सिग्नेचर गैप के अलावा सब कुछ) डाइजेस्ट दोबारा बनाकर signedAttrs के messageDigest से तुलना — बाइट-दर-बाइट अछूता या छेड़ा-छाड़ा। SHA-1/256/384/512 समर्थित।",
    },
    {
      en: "Cryptographic verification: the SignerInfo signature is checked against the signer certificate's public key (RSASSA-PKCS1-v1_5 via WebCrypto) over the properly re-tagged signedAttrs DER — plus coverage analysis that flags bytes appended after the signed ranges (modified after signing).",
      hi: "क्रिप्टोग्राफ़िक पुष्टि: SignerInfo के हस्ताक्षर की जाँच हस्ताक्षरकर्ता सर्टिफ़िकेट की सार्वजनिक कुंजी से (WebCrypto द्वारा RSASSA-PKCS1-v1_5), ठीक तरह री-टैग किए signedAttrs DER पर — साथ ही कवरेज जाँच, जो हस्ताक्षरित रेंज के बाद जुड़े बाइट्स पकड़ती है (हस्ताक्षर के बाद बदलाव)।",
    },
    {
      en: "Slightly broken files still verify: when the xref chain is unusable, a linear object scan recovers the structure (honestly reported). Signed PDFs with incremental updates, classic xref tables and xref streams all walk correctly.",
      hi: "थोड़ी टूटी फ़ाइलें भी जाँची जाती हैं: xref चेन काम न करे तो रैखिक ऑब्जेक्ट स्कैन स्ट्रक्चर वापस लाता है (ईमानदारी से बताया जाता है)। इंक्रीमेंटल अपडेट वाले, क्लासिक xref टेबल और xref स्ट्रीम — तीनों तरह की हस्ताक्षरित PDF सही चलती हैं।",
    },
    {
      en: "Per-signature verdict cards (green / amber / red), a summary badge, and a downloadable plain-text verification report. Fully honest scope: no CRL/OCSP, no chain-of-trust, no TSA verification — a self-signed certificate shows as untrusted-but-valid.",
      hi: "हर हस्ताक्षर का फ़ैसला कार्ड (हरा / पीला / लाल), सारांश बैज और डाउनलोड होने वाली सादी टेक्स्ट सत्यापन रिपोर्ट। पूरी ईमानदारी: कोई CRL/OCSP नहीं, कोई चेन-ऑफ़-ट्रस्ट नहीं, कोई TSA जाँच नहीं — सेल्फ़-साइन्ड सर्टिफ़िकेट अविश्वसनीय-पर-वैध दिखता है।",
    },
    {
      en: "Runs entirely on your device — the signed document never leaves the browser, and nothing about it is uploaded anywhere.",
      hi: "पूरा काम आपके डिवाइस पर — हस्ताक्षरित दस्तावेज़ ब्राउज़र से बाहर कहीं नहीं जाता, कुछ भी अपलोड नहीं होता।",
    },
  ],
  faq: [
    {
      q: {
        en: "What does \"valid\" actually mean here — is this a legal check?",
        hi: "यहाँ \"वैध\" का असली मतलब क्या है — क्या यह क़ानूनी जाँच है?",
      },
      a: {
        en: "A green verdict means exactly three things: the signature verifies cryptographically (the signer's certificate's public key confirms the signature over the signed attributes), the signed byte ranges are intact (the digest recomputed from the file matches the digest captured at signing time), and the coverage is complete (nothing was appended after the signed ranges). It is a technical integrity statement, not a legal one — this tool performs no identity verification, no revocation check, and no trust decision.",
        hi: "हरा फ़ैसला ठीक तीन बातें कहता है: हस्ताक्षर क्रिप्टोग्राफ़िक रूप से सही है (हस्ताक्षरकर्ता के सर्टिफ़िकेट की सार्वजनिक कुंजी हस्ताक्षरित विशेषताओं पर हस्ताक्षर की पुष्टि करती है), हस्ताक्षरित बाइट-रेंज अछूती है (फ़ाइल से दोबारा बनाया डाइजेस्ट हस्ताक्षर के समय के डाइजेस्ट से मेल खाता है), और कवरेज पूरा है (हस्ताक्षरित रेंज के बाद कुछ नहीं जुड़ा)। यह तकनीकी अखंडता का बयान है, क़ानूनी नहीं — यह टूल न पहचान की पुष्टि करता है, न निरस्तीकरण जाँच, न कोई भरोसे का निर्णय।",
      },
    },
    {
      q: {
        en: "Is the certificate checked against a trust store? What about revocation or timestamps?",
        hi: "क्या सर्टिफ़िकेट किसी ट्रस्ट स्टोर से जाँचा जाता है? निरस्तीकरण या टाइमस्टैम्प का क्या?",
      },
      a: {
        en: "Honestly, no. There is no trust store on your device that this tool consults, so no chain-of-trust validation happens: a self-signed certificate shows as self-signed — cryptographically valid but not chained to any authority you could name. No CRL or OCSP revocation check is made (the signer certificate could have been revoked after signing and this tool cannot know), and the timestamp inside a signature is read and displayed but never verified against a TSA. If you need those judgments, take the report to a qualified verifier.",
        hi: "ईमानदारी से — नहीं। आपके डिवाइस पर कोई ऐसा ट्रस्ट स्टोर नहीं जिसे यह टूल पूछे, इसलिए कोई चेन-ऑफ़-ट्रस्ट जाँच नहीं होती: सेल्फ़-साइन्ड सर्टिफ़िकेट सेल्फ़-साइन्ड दिखता है — क्रिप्टोग्राफ़िक रूप से वैध, पर किसी भरोसे लायक संस्था से जुड़ा नहीं। कोई CRL/OCSP निरस्तीकरण जाँच नहीं (हो सकता है हस्ताक्षर के बाद सर्टिफ़िकेट निरस्त कर दिया गया हो — यह टूल यह नहीं जान सकता), और हस्ताक्षर के अंदर का टाइमस्टैम्प पढ़कर दिखाया तो जाता है, पर TSA से कभी सत्यापित नहीं होता। ये निर्णय चाहिए तो रिपोर्ट किसी योग्य सत्यापक के पास ले जाएँ।",
      },
    },
    {
      q: {
        en: "How is tampering detected — and what is \"modified after signing\"?",
        hi: "छेड़छाड़ कैसे पकड़ी जाती है — और \"हस्ताक्षर के बाद बदलाव\" क्या है?",
      },
      a: {
        en: "A PDF signature covers the whole file except the /Contents gap holding the signature itself — defined by /ByteRange. This tool recomputes the digest over exactly those bytes and compares it with the messageDigest captured inside the signed attributes at signing time: any byte changed inside the covered ranges → digest mismatch → TAMPERED. Separately, the coverage is compared with the actual file length: bytes appended after the covered ranges end — a later incremental update, an appended object, or trailing junk — are reported as \"modified after signing\" (the signed content itself is still intact in that case, which is why it is amber, not red).",
        hi: "PDF हस्ताक्षर पूरी फ़ाइल को कवर करता है, सिवाय उस गैप के जहाँ /Contents में हस्ताक्षर ख़ुद बैठा है — यह दायरा /ByteRange तय करता है। यह टूल ठीक उन्हीं बाइट्स पर डाइजेस्ट दोबारा बनाकर हस्ताक्षर-समय के messageDigest से तुलना करता है: कवर की गई रेंज में कोई बाइट बदली → डाइजेस्ट बेमेल → छेड़छाड़। अलग से, कवरेज की तुलना फ़ाइल की असली लंबाई से होती है: कवर रेंज के बाद जुड़े बाइट्स — बाद का इंक्रीमेंटल अपडेट, जुड़ी ऑब्जेक्ट या पूँछ का कचरा — \"हस्ताक्षर के बाद बदलाव\" दिखते हैं (उस स्थिति में हस्ताक्षरित सामग्री अब भी अछूती होती है, इसीलिए लाल नहीं, पीला)।",
      },
    },
    {
      q: {
        en: "Is my signed document safe? Where does this happen?",
        hi: "क्या मेरा हस्ताक्षरित दस्तावेज़ सुरक्षित है? यह सब कहाँ होता है?",
      },
      a: {
        en: "Entirely inside your browser — a Web Worker reads the raw bytes, walks the structure, parses the certificates and runs the cryptography on this device. Nothing is uploaded, no account, no queue; the downloadable verification report is generated in the same worker, on-device too.",
        hi: "पूरा काम आपके ब्राउज़र में — एक वर्कर थ्रेड कच्ची बाइट्स पढ़ती है, स्ट्रक्चर चलती है, सर्टिफ़िकेट पढ़ती है और क्रिप्टोग्राफ़ी इसी डिवाइस पर चलती है। कुछ अपलोड नहीं होता, न खाता, न क़तार; डाउनलोड होने वाली सत्यापन रिपोर्ट भी उसी वर्कर में, डिवाइस पर बनती है।",
      },
    },
  ],
};
