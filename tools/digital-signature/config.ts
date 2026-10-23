import type { ToolConfig } from "@/lib/tools/config-types";
import { p12AssetFiles } from "./p12-store";

/**
 * Digital signature (RB6-FIN-a4 — the 94th tool, security family). The
 * honest ON-DEVICE certificate-based signer (mode D):
 *
 *  - the surface owns every value (split-tool pattern, lock-pdf recipe):
 *    the .pfx/.p12 certificate (an in-memory store; collectAssets rides
 *    it to the worker — never the network), its password, the reason /
 *    location, the page + position picker and the visible toggle;
 *  - the worker parses + decrypts the container with the pure-TS PKCS#12
 *    core (MAC-verified, PBES2/AES via WebCrypto, legacy 3DES/RC2), then
 *    builds a REAL PAdES (adbe.pkcs7.detached) signature: a proper
 *    AcroForm /Sig field, a CMS SignedData with signedAttrs, an RSA
 *    PKCS#1 v1.5 signature over the /ByteRange digest — byte-level
 *    surgery on the saved file, nothing re-uploaded;
 *  - an optional visible signature block (vector ink) with the signer's
 *    CN, the date, the reason and the location — WinAnsi text via
 *    base-14 Helvetica, Devanagari via the embedded Noto face;
 *  - chain straight into Verify PDF signatures to check the result.
 */
export const config: ToolConfig = {
  toolId: "digital-signature",
  createWorker: () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }),
  outputKind: "pdf",
  minFiles: 1,
  maxFiles: 1,
  options: [],
  collectAssets: () => p12AssetFiles(),
  howKeys: ["ds.how1", "ds.how2", "ds.how3"],
  chainToolIds: ["verify-pdf-signatures", "lock-pdf", "view-pdf"],
  features: [
    {
      en: "Sign with your own .pfx/.p12 certificate — a real PAdES (adbe.pkcs7.detached) signature with a SHA-256 digest, signed attributes and an RSA PKCS#1 v1.5 signature over the document bytes.",
      hi: "अपने .pfx/.p12 सर्टिफ़िकेट से हस्ताक्षर करें — असली PAdES (adbe.pkcs7.detached) हस्ताक्षर, SHA-256 डाइजेस्ट, साइन किए गए एट्रिब्यूट और दस्तावेज़ के बाइट्स पर RSA PKCS#1 v1.5 हस्ताक्षर के साथ।",
    },
    {
      en: "Works with modern packs (PBES2 + AES-256) and the legacy containers every old Windows export and OpenSSL ≤2.x file uses (3DES key bags, RC2 certificate layers) — the password and the key are checked on your device before anything is written.",
      hi: "आधुनिक पैक (PBES2 + AES-256) और वही लेगेसी कंटेनर जो हर पुराना Windows एक्सपोर्ट और OpenSSL ≤2.x फ़ाइल इस्तेमाल करती है (3DES की-बैग, RC2 सर्टिफ़िकेट लेयर) — पासवर्ड और कुंजी आपके डिवाइस पर जाँची जाती है, कुछ भी लिखे जाने से पहले।",
    },
    {
      en: "An optional visible signature block — signer name, date, reason and location as crisp vector text exactly where you pick on any page (Hindi text embeds the Noto Devanagari font).",
      hi: "वैकल्पिक दिखने वाला हस्ताक्षर ब्लॉक — साइनर का नाम, दिनांक, कारण और स्थान साफ़ वेक्टर टेक्स्ट में, किसी भी पेज पर आपकी चुनी जगह पर (हिंदी टेक्स्ट Noto देवनागरी फ़ॉन्ट एम्बेड करता है)।",
    },
    {
      en: "Tamper-evident by design: the /ByteRange covers the whole file except the signature itself, so any later edit breaks the seal — chain straight into Verify PDF signatures to see the report.",
      hi: "ज़म्मों-सबूत डिज़ाइन: /ByteRange पूरी फ़ाइल को ढकता है (हस्ताक्षर छोड़कर), इसलिए बाद की कोई भी बदलावी मुहर तोड़ देती है — रिपोर्ट देखने के लिए सीधे हस्ताक्षर जाँच टूल में जाएँ।",
    },
    {
      en: "Everything stays on your device — the certificate, its password and the document are processed by a worker thread in your browser and never uploaded. No sign-up, no server, no key escrow.",
      hi: "सब कुछ आपके डिवाइस पर — सर्टिफ़िकेट, उसका पासवर्ड और दस्तावेज़ आपके ब्राउज़र के वर्कर थ्रेड में प्रोसेस होते हैं, कहीं अपलोड नहीं होते। कोई साइन-अप नहीं, सर्वर नहीं, कुंजी ज़िम्मेदारी दूसरे पर नहीं।",
    },
  ],
  faq: [
    {
      q: {
        en: "What is the difference between this and the Sign PDF tool?",
        hi: "यह और Sign PDF टूल में क्या फ़र्क़ है?",
      },
      a: {
        en: "Sign PDF draws a picture of your signature — a visual mark, like printing, signing and scanning. This tool signs cryptographically: it reads your certificate, builds a PAdES (adbe.pkcs7.detached) signature and seals the document bytes with it. Anyone can then verify with Verify PDF signatures that the file has not changed since you signed it.",
        hi: "Sign PDF आपके हस्ताक्षर की तस्वीर बनाता है — एक दिखने वाला निशान, जैसे प्रिंट करके साइन करके स्कैन करना। यह टूल क्रिप्टोग्राफ़िक रूप से हस्ताक्षर करता है: आपका सर्टिफ़िकेट पढ़ता है, PAdES (adbe.pkcs7.detached) हस्ताक्षर बनाता है और दस्तावेज़ के बाइट्स को उससे सील करता है। इसके बाद कोई भी हस्ताक्षर जाँच टूल से पुष्टि कर सकता है कि फ़ाइल हस्ताक्षर के बाद नहीं बदली।",
      },
    },
    {
      q: {
        en: "Where does my certificate and password go?",
        hi: "मेरा सर्टिफ़िकेट और पासवर्ड कहाँ जाता है?",
      },
      a: {
        en: "Nowhere. The .pfx/.p12 file is held in this tab's memory and handed to the worker thread on your device by structured clone — the same origin, no network. The password is used to decrypt the key in that worker and is never stored: close the tab and both are gone. Nothing is uploaded to any server.",
        hi: "कहीं नहीं। .pfx/.p12 फ़ाइल इसी टैब की मेमोरी में रहती है और structured clone से आपके डिवाइस के वर्कर थ्रेड को दी जाती है — वही ओरिजिन, कोई नेटवर्क नहीं। पासवर्ड उसी वर्कर में कुंजी खोलने के लिए इस्तेमाल होता है और कहीं सेव नहीं होता: टैब बंद करते ही दोनों गायब। कुछ भी किसी सर्वर पर अपलोड नहीं होता।",
      },
    },
    {
      q: {
        en: "Why does the verification report call my self-signed certificate \"attention\"?",
        hi: "जाँच रिपोर्ट मेरे सेल्फ़-साइन्ड सर्टिफ़िकेट को \"ध्यान दें\" क्यों कहती है?",
      },
      a: {
        en: "Because that is the honest verdict. A self-signed certificate proves the document has not changed since you signed it, but it does not prove WHO signed it — anyone can mint one. The signature itself verifies as intact and cryptographically correct; the amber flag is about identity, not integrity. Certificates from a real CA (your company's, or a bought one) verify green.",
        hi: "क्योंकि यही ईमानदार फ़ैसला है। सेल्फ़-साइन्ड सर्टिफ़िकेट सिद्ध करता है कि दस्तावेज़ हस्ताक्षर के बाद नहीं बदला, पर यह सिद्ध नहीं करता कि किसने हस्ताक्षर किया — कोई भी बना सकता है। हस्ताक्षर ख़ुद अक्षत और क्रिप्टोग्राफ़िक रूप से सही जाँचा जाता है; पीला झंडा पहचान के बारे में है, अखंडता के बारे में नहीं। असली CA (आपकी कंपनी का, या ख़रीदा हुआ) का सर्टिफ़िकेट हरा जाँचा जाता है।",
      },
    },
    {
      q: {
        en: "My .p12 is from an old Windows export — will it work?",
        hi: "मेरी .p12 पुराने Windows एक्सपोर्ट से है — क्या वह चलेगी?",
      },
      a: {
        en: "Very likely yes. Old exports and OpenSSL ≤2.x \"legacy\" packs encrypt the key with 3DES and the certificates with 40-bit RC2 — the parser carries pure-TypeScript implementations of both, plus the modern PBES2 (PBKDF2 + AES-128/192/256) packs from current tools. ECDSA and EdDSA keys are honestly refused: the CMS builder speaks RSA.",
        hi: "बहुत संभावना है। पुराने एक्सपोर्ट और OpenSSL ≤2.x के \"legacy\" पैक कुंजी 3DES से और सर्टिफ़िकेट 40-बिट RC2 से एन्क्रिप्ट करते हैं — पार्सर दोनों के शुद्ध TypeScript इम्प्लीमेंटेशन लेकर आता है, साथ ही आधुनिक PBES2 (PBKDF2 + AES-128/192/256) पैक भी। ECDSA और EdDSA कुंजियाँ ईमानदारी से मना होती हैं: CMS बिल्डर RSA बोलता है।",
      },
    },
  ],
};
