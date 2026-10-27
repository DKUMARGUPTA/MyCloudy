/**
 * Adds the legal.* i18n namespace (Phase-6 static pages: privacy, terms,
 * about, contact) to src/i18n/en.json + hi.json, and writes the reference
 * copy to components/doco/pages/i18n.json. Idempotent: re-running replaces
 * the namespace with this definition. Verifies flat-leaf parity at the end.
 *
 * Run: bun scripts/merge-legal-i18n.ts
 */
import fs from "node:fs";

const LEGAL_EN = {
  nav: {
    privacy: "Privacy Policy",
    terms: "Terms of Use",
    about: "About",
    contact: "Contact",
    groupCompany: "Company",
    groupLegal: "Legal",
  },
  backHome: "Back to home",
  lastUpdated: "Last updated: {date}",
  ctaTitle: "Ready to work on your documents?",
  ctaBody:
    "Every tool is free, needs no account, and most run entirely on your device.",
  ctaAction: "Browse all tools",
  privacy: {
    title: "Privacy Policy",
    subtitle:
      "DocoPDF is built so your documents never have to leave your device. This page explains exactly what is stored, where, and for how long.",
    updated: "October 2026",
    sections: {
      summary: {
        title: "The short version",
        body: "DocoPDF processes your documents inside your browser. We do not run accounts, we do not sell data, and for on-device tools we never even see your files — nothing is uploaded anywhere.\n\nThe only things that can reach our servers are optional tool ratings and contact-form messages, described below.",
      },
      files: {
        title: "Your files stay on your device",
        body: "All live tools today — merge, split, edit, sign, compress, OCR, invoice and photo-sheet creation, conversions — run 100% in your browser using WebAssembly and web workers. Documents are read, processed and saved entirely on your device.\n\nIf server-based tools are added later (for formats browsers cannot process), those tool pages will say so clearly, and files will be deleted from the server immediately after the result is returned.",
      },
      stored: {
        title: "What we do store",
        body: "Tool ratings: when you rate a result, we store the tool id, your rating, an optional reason and an optional short message. No file names, no IP addresses, no user agents.\n\nContact messages: if you write to us through the contact form, we store your name, email, chosen topic and message — only to reply to you.\n\nBoth endpoints use an in-memory rate limiter that keeps request timestamps for under a minute and never persists them.",
      },
      local: {
        title: "What is stored on your device",
        body: "DocoPDF keeps the following in your browser's local storage — never on our servers:\n\n- Your language and theme choice\n- Your cookie-consent choice\n- Favorite and recently used tools\n- Recent-file entries: a display label, size, page count and a small page-1 thumbnail, so you can continue where you left off\n\nThe recent list is visible only to you, can be cleared anytime from the home page, and never includes file contents — only this small metadata.",
      },
      cookies: {
        title: "Cookies and consent",
        body: "DocoPDF does not use third-party analytics, advertising cookies or fingerprinting. Fonts are self-hosted.\n\nThe consent banner stores your choice in local storage. Clearing your browser data resets it, and you can change your choice anytime from the footer.",
      },
      thirdParty: {
        title: "Third parties",
        body: "None for document processing. No trackers are embedded, and no data is shared with advertising networks. If a server-based tool is ever introduced, this section will list exactly what it processes and for how long.",
      },
      dpdp: {
        title: "DPDP Act, 2023",
        body: "We align with India's Digital Personal Data Protection Act, 2023: minimal collection, purpose limitation (ratings improve tools, contact messages get you a reply), and no tracking-based profiling.\n\nSince almost everything runs on-device, there is very little personal data to protect in the first place — by design, not by afterthought.",
      },
      retention: {
        title: "Data retention",
        body: "Tool ratings and contact messages are kept for up to 12 months, then deleted. Rate-limit timestamps live in memory for under a minute.\n\nRecent-file metadata lives on your device until you clear it — there is nothing to delete on our side.",
      },
      children: {
        title: "Children",
        body: "DocoPDF is a general-purpose utility, not directed at children under 13. Since we do not collect personal information by default, no parental-consent flow is needed. A contact message from a child is treated like any other message and deleted on request.",
      },
      changes: {
        title: "Changes to this policy",
        body: "If this policy changes, the \"last updated\" date above changes with it, and material changes are announced on the home page. Continuing to use DocoPDF after a change means you accept the updated policy.",
      },
      contact: {
        title: "Contact",
        body: "Questions about privacy? Write to us from the contact page, or use the feedback buttons on any result page and mention \"privacy\" in the message.",
      },
    },
  },
  terms: {
    title: "Terms of Use",
    subtitle:
      "The simple rules for using DocoPDF. Short on purpose — the whole point is a tool you can trust.",
    updated: "October 2026",
    sections: {
      acceptance: {
        title: "Acceptance",
        body: "By using DocoPDF you agree to these terms. If you disagree, please stop using the service.",
      },
      service: {
        title: "The service",
        body: "DocoPDF provides free online document tools — organizing, editing, creating, converting and securing PDFs and images. Tools are provided as-is and may change, gain or lose features, or be retired over time.",
      },
      acceptableUse: {
        title: "Acceptable use",
        body: "Do not use DocoPDF to break the law, to process documents you have no right to use, or to attempt to disrupt the service. Automated bulk abuse of the (future) server-based endpoints may be rate-limited or blocked.",
      },
      responsibility: {
        title: "Your responsibility for outputs",
        body: "You are responsible for the documents you process and for reviewing outputs before relying on them.\n\nDocoPDF is engineered carefully — automated per-tool test suites where practical — but automated processing can rarely differ from what a professional would produce. Always review official, legal, tax or government paperwork yourself (or with a professional) before submitting it.",
      },
      ip: {
        title: "Intellectual property",
        body: "You keep all rights to your documents — they are yours, and for on-device tools we never even see them.\n\nThe DocoPDF name, design and code are ours. Other product names and trademarks belong to their respective owners.",
      },
      warranty: {
        title: "No warranty",
        body: "The service is provided \"as is\", without warranties of any kind, express or implied. We do not promise uninterrupted or error-free operation.",
      },
      liability: {
        title: "Limitation of liability",
        body: "To the maximum extent permitted by law, DocoPDF is not liable for indirect or consequential damages, or for data loss caused by browser crashes, interrupted downloads or misunderstood output.\n\nKeep your own backups — of everything, always.",
      },
      changes: {
        title: "Changes to these terms",
        body: "These terms may change; the \"last updated\" date above will change with them. The current version always applies to your use of the service.",
      },
      law: {
        title: "Governing law",
        body: "These terms are governed by the laws of India, with exclusive jurisdiction in the courts of India.",
      },
      contact: {
        title: "Contact",
        body: "Questions about these terms? Use the contact page — a real person reads every message.",
      },
    },
  },
  about: {
    title: "About DocoPDF",
    subtitle:
      "A free, bilingual document toolkit that runs in your browser — no accounts, no uploads, no tricks.",
    sections: {
      what: {
        title: "What is DocoPDF?",
        body: "DocoPDF is a free suite of {tools}+ document tools that runs in your browser: merge and split PDFs, edit text and images, sign, stamp and watermark, OCR in English and Hindi, create invoices, resumes, QR codes and passport photo sheets, convert between formats, and much more.\n\nNo account. No watermarks on your output. No \"free trial\" timers.",
      },
      onDevice: {
        title: "On-device by default",
        body: "Whenever a task can be done on your device, it is. PDF rendering, cryptography and OCR run as WebAssembly — your documents never travel to a server, keep working offline once loaded, and finish at the speed of your own CPU.\n\nThis is not just privacy — it is also why the tools are fast and free to run.",
      },
      modes: {
        title: "Honest modes",
        body: "Every tool carries a mode badge. On-device means everything happens in your browser — all live tools today.\n\nIf server-based tools are added for formats browsers cannot process (Office conversions, for example), those pages will say so clearly, and files will be deleted from the server right after the result is returned. Nothing is ambiguous, nothing is hidden.",
      },
      bilingual: {
        title: "Bilingual by design",
        body: "Every surface — tool pages, forms, tooltips, this page — is available in English and हिंदी, with a persistent language switch. More languages can follow the same pattern.",
      },
      tech: {
        title: "Built with",
        body: "Next.js, TypeScript, pdf-lib, WebAssembly (with Tesseract for OCR), self-hosted fonts and shadcn/ui — no cloud dependency in the tool pipeline.",
      },
      roadmap: {
        title: "Roadmap",
        body: "The registry holds {total} tools: {live} are live, the rest are on the roadmap — e-invoices (Factur-X family), PDF signature verification, PDF repair, and server-based Office conversions.\n\nGot a tool idea or found a gap? The contact page is the fastest way to reach us.",
      },
    },
  },
  contact: {
    title: "Contact",
    subtitle:
      "Bug, idea or question — it all helps. A real person reads every message.",
    formTitle: "Send a message",
    formNote:
      "Your message is stored only to reply to you — see the privacy policy.",
    nameLabel: "Name",
    namePlaceholder: "Your name",
    emailLabel: "Email",
    emailPlaceholder: "you@example.com",
    categoryLabel: "Topic",
    categories: {
      bug: "Bug report",
      idea: "Tool idea",
      question: "Question",
      other: "Other",
    },
    messageLabel: "Message",
    messagePlaceholder:
      "What happened, what did you expect, which tool were you using?",
    messageHint: "{count} / {max} characters",
    submit: "Send message",
    submitting: "Sending…",
    successTitle: "Message sent",
    successBody:
      "Thanks! We read everything. If a reply is needed, you will hear from us within a few working days.",
    sendAnother: "Send another message",
    errorTitle: "Message not sent",
    errorBody: "Please try again in a little while.",
    errName: "Please enter your name (2–80 characters).",
    errEmail: "Please enter a valid email address.",
    errMessage: "Please write a message of at least 10 characters.",
    errRate: "Too many messages — please try again later.",
    nextTitle: "What happens next",
    nextBody:
      "Messages are triaged weekly. Bugs get priority, tool ideas feed the roadmap, and questions get a reply whenever an email is provided.",
    fasterTitle: "Faster than a form",
    fasterBody:
      "For a specific tool, use the rating buttons right on its result page — it reaches the same team with the tool's name attached, no typing needed.",
    fasterAction: "Browse tools",
  },
};

const LEGAL_HI = {
  nav: {
    privacy: "गोपनीयता नीति",
    terms: "उपयोग की शर्तें",
    about: "हमारे बारे में",
    contact: "संपर्क करें",
    groupCompany: "कंपनी",
    groupLegal: "कानूनी",
  },
  backHome: "मुख्य पृष्ठ पर वापस जाएँ",
  lastUpdated: "अंतिम अपडेट: {date}",
  ctaTitle: "अपने दस्तावेज़ों पर काम शुरू करने के लिए तैयार हैं?",
  ctaBody:
    "हर टूल मुफ़्त है, खाते की ज़रूरत नहीं, और ज़्यादातर पूरी तरह आपके डिवाइस पर चलते हैं।",
  ctaAction: "सभी टूल देखें",
  privacy: {
    title: "गोपनीयता नीति",
    subtitle:
      "DocoPDF इस तरह बनाया गया है कि आपके दस्तावेज़ आपके डिवाइस से बाहर न जाएँ। यह पृष्ठ बताता है कि क्या, कहाँ और कितने समय के लिए सहेजा जाता है।",
    updated: "अक्टूबर 2026",
    sections: {
      summary: {
        title: "संक्षेप में",
        body: "DocoPDF आपके दस्तावेज़ आपके ब्राउज़र के अंदर प्रोसेस करता है। हम खाते नहीं चलाते, डेटा नहीं बेचते, और on-device टूलों के लिए आपकी फ़ाइलें हमें दिखती भी नहीं — कुछ भी अपलोड नहीं होता।\n\nहमारे सर्वर तक सिर्फ़ वैकल्पिक टूल रेटिंग और संपर्क फ़ॉर्म के संदेश पहुँच सकते हैं — दोनों नीचे वर्णित हैं।",
      },
      files: {
        title: "आपकी फ़ाइलें आपके डिवाइस पर रहती हैं",
        body: "आज के सभी सक्रिय टूल — मर्ज, स्प्लिट, एडिट, साइन, कंप्रेस, OCR, इनवॉइस और फ़ोटो-शीट बनाना, कन्वर्ज़न — WebAssembly और web workers का उपयोग करके 100% आपके ब्राउज़र में चलते हैं। दस्तावेज़ पढ़े, प्रोसेस और सेव — सब आपके डिवाइस पर ही होता है।\n\nभविष्य में अगर सर्वर-आधारित टूल जुड़ें (जिन फ़ॉर्मैट को ब्राउज़र प्रोसेस नहीं कर सकता), तो वे पृष्ठ साफ़ बताएँगे, और परिणाम देने के तुरंत बाद फ़ाइलें सर्वर से हटा दी जाएँगी।",
      },
      stored: {
        title: "हम क्या सहेजते हैं",
        body: "टूल रेटिंग: जब आप किसी परिणाम की रेटिंग देते हैं, तो हम टूल की पहचान, आपकी रेटिंग, वैकल्पिक कारण और वैकल्पिक छोटा संदेश सहेजते हैं। न फ़ाइल के नाम, न IP पते, न user agent।\n\nसंपर्क संदेश: अगर आप संपर्क फ़ॉर्म से लिखते हैं, तो हम आपका नाम, ईमेल, चुना विषय और संदेश सहेजते हैं — सिर्फ़ आपको जवाब देने के लिए।\n\nदोनों एक in-memory रेट-लिमिटर का उपयोग करते हैं जो अनुरोधों का समय-स्टैम्प एक मिनट से कम रखता है और कभी सहेजता नहीं।",
      },
      local: {
        title: "आपके डिवाइस पर क्या सहेजा जाता है",
        body: "DocoPDF निम्नलिखित आपके ब्राउज़र के local storage में रखता है — कभी हमारे सर्वर पर नहीं:\n\n- आपकी भाषा और थीम की पसंद\n- आपकी cookie-consent पसंद\n- पसंदीदा और हाल में उपयोग किए गए टूल\n- हाल की फ़ाइलों की प्रविष्टियाँ: एक नाम, आकार, पृष्ठ-संख्या और पहले पृष्ठ का छोटा थंबनेल — ताकि आप वहीं से जारी रख सकें\n\nहाल की सूची सिर्फ़ आपको दिखती है, मुख्य पृष्ठ से कभी भी मिटाई जा सकती है, और इसमें कभी फ़ाइल की सामग्री नहीं होती — सिर्फ़ यह छोटा मेटाडेटा।",
      },
      cookies: {
        title: "कुकीज़ और सहमति",
        body: "DocoPDF तीसरे पक्ष के analytics, विज्ञापन कुकीज़ या फ़िंगरप्रिंटिंग का उपयोग नहीं करता। फ़ॉन्ट self-hosted हैं।\n\nसहमति बैनर आपकी पसंद local storage में रखता है। ब्राउज़र का डेटा मिटाने पर वह रीसेट हो जाता है, और आप फ़ुटर से कभी भी अपनी पसंद बदल सकते हैं।",
      },
      thirdParty: {
        title: "तीसरे पक्ष",
        body: "दस्तावेज़ प्रोसेसिंग के लिए कोई नहीं। कोई ट्रैकर एम्बेड नहीं है, और विज्ञापन नेटवर्क के साथ कोई डेटा साझा नहीं होता। भविष्य में अगर कोई सर्वर-आधारित टूल आए, तो यह अनुभाग साफ़ बताएगा कि वह क्या प्रोसेस करता है और कितने समय तक।",
      },
      dpdp: {
        title: "DPDP अधिनियम, 2023",
        body: "हम भारत के डिजिटल व्यक्तिगत डेटा संरक्षण अधिनियम, 2023 के अनुरूप हैं: न्यूनतम संग्रह, उद्देश्य-सीमा (रेटिंग टूल सुधारती हैं, संपर्क संदेशों का जवाब देते हैं), और कोई ट्रैकिंग-आधारित प्रोफ़ाइलिंग नहीं।\n\nचूँकि लगभग सब कुछ on-device चलता है, पहले से ही बहुत कम व्यक्तिगत डेटा बचता है — यह design की वजह से है, afterthought से नहीं।",
      },
      retention: {
        title: "डेटा अवधि",
        body: "टूल रेटिंग और संपर्क संदेश अधिकतम 12 महीने तक रखे जाते हैं, फिर मिटा दिए जाते हैं। रेट-लिमिट के समय-स्टैम्प मेमोरी में एक मिनट से कम रहते हैं।\n\nहाल की फ़ाइलों का मेटाडेटा आपके डिवाइस पर तब तक रहता है जब तक आप उसे न मिटाएँ — हमारी तरफ़ मिटाने के लिए कुछ है ही नहीं।",
      },
      children: {
        title: "बच्चे",
        body: "DocoPDF एक सामान्य उपयोगिता है, 13 साल से कम उम्र के बच्चों को ध्यान में रखकर नहीं बनी। चूँकि हम डिफ़ॉल्ट रूप से व्यक्तिगत जानकारी एकत्र नहीं करते, अभिभावकीय सहमति की प्रक्रिया की ज़रूरत नहीं है। बच्चे का संपर्क संदेश भी सामान्य संदेश जैसा ही माना जाता है और अनुरोध पर मिटा दिया जाता है।",
      },
      changes: {
        title: "इस नीति में बदलाव",
        body: "अगर यह नीति बदलती है, तो ऊपर की \"अंतिम अपडेट\" तिथि भी बदल जाएगी, और बड़े बदलाव मुख्य पृष्ठ पर घोषित होंगे। बदलाव के बाद DocoPDF का उपयोग जारी रखने का मतलब है कि आप अपडेटेड नीति से सहमत हैं।",
      },
      contact: {
        title: "संपर्क",
        body: "गोपनीयता पर सवाल? संपर्क पृष्ठ से लिखें, या किसी परिणाम पृष्ठ के फ़ीडबैक बटन इस्तेमाल करें और संदेश में \"privacy\" लिखें।",
      },
    },
  },
  terms: {
    title: "उपयोग की शर्तें",
    subtitle:
      "DocoPDF इस्तेमाल करने के सीधे नियम। जान-बूझकर छोटा रखा गया है — भरोसे वाला टूल इसी में है।",
    updated: "अक्टूबर 2026",
    sections: {
      acceptance: {
        title: "स्वीकृति",
        body: "DocoPDF का उपयोग करके आप इन शर्तों से सहमत होते हैं। असहमत हैं तो कृपया सेवा का उपयोग न करें।",
      },
      service: {
        title: "सेवा",
        body: "DocoPDF मुफ़्त ऑनलाइन दस्तावेज़ टूल देता है — PDF और इमेज को व्यवस्थित करना, एडिट करना, बनाना, कन्वर्ट करना और सुरक्षित करना। टूल जैसे हैं वैसे दिए जाते हैं और समय के साथ बदल, बढ़ या बंद हो सकते हैं।",
      },
      acceptableUse: {
        title: "स्वीकार्य उपयोग",
        body: "DocoPDF का उपयोग कानून तोड़ने, जिन दस्तावेज़ों पर आपका अधिकार नहीं उन्हें प्रोसेस करने, या सेवा में बाधा डालने के लिए न करें। (भविष्य के) सर्वर-आधारित endpoints का स्वचालित थोक दुरुपयोग रेट-लिमिट या ब्लॉक हो सकता है।",
      },
      responsibility: {
        title: "परिणामों के लिए आपकी ज़िम्मेदारी",
        body: "आप जिन दस्तावेज़ों को प्रोसेस करते हैं और भरोसा करने से पहले परिणामों की समीक्षा — दोनों आपकी ज़िम्मेदारी हैं।\n\nDocoPDF को बड़ी लगन से बनाया गया है — जहाँ संभव है प्रत्येक टूल के स्वचालित टेस्ट सूट चलते हैं — लेकिन स्वचालित प्रोसेसिंग कभी-कभी पेशेवर से अलग परिणाम दे सकती है। सरकारी, कानूनी, कर या आधिकारिक काग़ज़ात जमा करने से पहले ज़रूर खुद (या किसी पेशेवर से) जाँच लें।",
      },
      ip: {
        title: "बौद्धिक संपदा",
        body: "आपके दस्तावेज़ों के सारे अधिकार आपके हैं — वे आपके हैं, और on-device टूलों के लिए हम उन्हें देखते भी नहीं।\n\nDocoPDF का नाम, design और कोड हमारा है। अन्य उत्पादों के नाम और ट्रेडमार्क उनके स्वामियों के हैं।",
      },
      warranty: {
        title: "कोई वारंटी नहीं",
        body: "सेवा \"जैसी है\" दी जाती है, किसी भी तरह की वारंटी के बिना। हम निर्बाध या त्रुटि-रहित संचालन का वादा नहीं करते।",
      },
      liability: {
        title: "देयता की सीमा",
        body: "कानून द्वारा अनुमत अधिकतम सीमा तक, DocoPDF अप्रत्यक्ष या परिणामी नुकसान, या ब्राउज़र क्रैश, बीच में कटे डाउनलोड या ग़लत समझे परिणाम से हुए डेटा नुकसान का उत्तरदायी नहीं।\n\nअपने बैकअप खुद रखें — हर चीज़ के, हमेशा।",
      },
      changes: {
        title: "इन शर्तों में बदलाव",
        body: "ये शर्तें बदल सकती हैं; ऊपर की \"अंतिम अपडेट\" तिथि उनके साथ बदलेगी। वर्तमान संस्करण हमेशा आपके उपयोग पर लागू होता है।",
      },
      law: {
        title: "लागू कानून",
        body: "इन शर्तों पर भारत के कानून लागू होते हैं, और विवादों का क्षेत्राधिकार भारत की अदालतों में है।",
      },
      contact: {
        title: "संपर्क",
        body: "इन शर्तों पर सवाल? संपर्क पृष्ठ का उपयोग करें — हर संदेश एक असली इंसान पढ़ता है।",
      },
    },
  },
  about: {
    title: "DocoPDF के बारे में",
    subtitle:
      "आपके ब्राउज़र में चलने वाला मुफ़्त, द्विभाषी दस्तावेज़ टूलकिट — न खाता, न अपलोड, न चालाकी।",
    sections: {
      what: {
        title: "DocoPDF क्या है?",
        body: "DocoPDF {tools}+ दस्तावेज़ टूलों का मुफ़्त सूट है जो आपके ब्राउज़र में चलता है: PDF मर्ज और स्प्लिट, टेक्स्ट व इमेज एडिट, साइन, स्टैम्प और वॉटरमार्क, अंग्रेज़ी और हिंदी में OCR, इनवॉइस, रिज़्यूमे, QR कोड और पासपोर्ट फ़ोटो शीट बनाना, फ़ॉर्मैट कन्वर्ज़न, और बहुत कुछ।\n\nन खाता। न आउटपुट पर वॉटरमार्क। न \"फ्री ट्रायल\" के टाइमर।",
      },
      onDevice: {
        title: "डिफ़ॉल्ट रूप से on-device",
        body: "जब कोई काम आपके डिवाइस पर हो सकता है, वहीं होता है। PDF रेंडरिंग, क्रिप्टोग्राफ़ी और OCR WebAssembly में चलते हैं — आपके दस्तावेज़ कभी सर्वर तक नहीं जाते, एक बार लोड होने के बाद ऑफ़लाइन चलते रहते हैं, और आपके CPU की रफ़्तार से पूरे होते हैं।\n\nयह सिर्फ़ गोपनीयता नहीं — इसीलिए टूल तेज़ और चलाने में मुफ़्त भी हैं।",
      },
      modes: {
        title: "ईमानदार मोड",
        body: "हर टूल पर एक मोड बैज है। On-device का मतलब है सब कुछ आपके ब्राउज़र में — आज के सभी सक्रिय टूल ऐसे ही हैं।\n\nअगर भविष्य में सर्वर-आधारित टूल आएँ (जिन फ़ॉर्मैट को ब्राउज़र प्रोसेस नहीं कर सकता, जैसे Office कन्वर्ज़न), तो वे पृष्ठ साफ़ बताएँगे और परिणाम देने के तुरंत बाद फ़ाइलें सर्वर से मिट जाएँगी। कुछ अस्पष्ट नहीं, कुछ छिपा नहीं।",
      },
      bilingual: {
        title: "जन्म से द्विभाषी",
        body: "हर सतह — टूल पृष्ठ, फ़ॉर्म, टूलटिप, यह पृष्ठ — अंग्रेज़ी और हिंदी दोनों में है, एक स्थायी भाषा-स्विच के साथ। और भाषाएँ इसी पैटर्न पर आ सकती हैं।",
      },
      tech: {
        title: "किससे बना है",
        body: "Next.js, TypeScript, pdf-lib, WebAssembly (OCR के लिए Tesseract), self-hosted फ़ॉन्ट और shadcn/ui — टूल पाइपलाइन में कोई cloud निर्भरता नहीं।",
      },
      roadmap: {
        title: "रोडमैप",
        body: "रजिस्ट्री में {total} टूल हैं: {live} सक्रिय हैं, बाक़ी रोडमैप पर हैं — e-invoice (Factur-X परिवार), PDF सिग्नेचर सत्यापन, PDF रिपेयर, और सर्वर-आधारित Office कन्वर्ज़न।\n\nकोई टूल-आइडिया है या कोई कमी दिखी? संपर्क पृष्ठ सबसे तेज़ रास्ता है।",
      },
    },
  },
  contact: {
    title: "संपर्क करें",
    subtitle:
      "बग, आइडिया या सवाल — सब काम आता है। हर संदेश एक असली इंसान पढ़ता है।",
    formTitle: "संदेश भेजें",
    formNote:
      "आपका संदेश सिर्फ़ जवाब देने के लिए सहेजा जाता है — गोपनीयता नीति देखें।",
    nameLabel: "नाम",
    namePlaceholder: "आपका नाम",
    emailLabel: "ईमेल",
    emailPlaceholder: "you@example.com",
    categoryLabel: "विषय",
    categories: {
      bug: "बग रिपोर्ट",
      idea: "टूल आइडिया",
      question: "सवाल",
      other: "अन्य",
    },
    messageLabel: "संदेश",
    messagePlaceholder:
      "क्या हुआ, क्या उम्मीद थी, आप कौन-सा टूल इस्तेमाल कर रहे थे?",
    messageHint: "{count} / {max} अक्षर",
    submit: "संदेश भेजें",
    submitting: "भेज रहे हैं…",
    successTitle: "संदेश भेज दिया गया",
    successBody:
      "धन्यवाद! हम सब कुछ पढ़ते हैं। जवाब ज़रूरी हो तो कुछ कार्य-दिवसों में आप तक पहुँचेगा।",
    sendAnother: "एक और संदेश भेजें",
    errorTitle: "संदेश नहीं भेजा गया",
    errorBody: "कृपया थोड़ी देर बाद फिर कोशिश करें।",
    errName: "कृपया अपना नाम डालें (2–80 अक्षर)।",
    errEmail: "कृपया मान्य ईमेल पता डालें।",
    errMessage: "कृपया कम-से-कम 10 अक्षरों का संदेश लिखें।",
    errRate: "बहुत ज़्यादा संदेश — कृपया बाद में कोशिश करें।",
    nextTitle: "आगे क्या होता है",
    nextBody:
      "संदेशों की साप्ताहिक छँटाई होती है। बग को प्राथमिकता मिलती है, टूल-आइडिया रोडमैप में जाते हैं, और सवालों के जवाब तब जाते हैं जब ईमेल दिया गया हो।",
    fasterTitle: "फ़ॉर्म से भी तेज़",
    fasterBody:
      "किसी ख़ास टूल के लिए उसके परिणाम पृष्ठ पर ही रेटिंग बटन इस्तेमाल करें — टूल का नाम जुड़कर वही टीम तक पहुँचता है, कुछ लिखने की ज़रूरत नहीं।",
    fasterAction: "टूल देखें",
  },
};

function flatten(obj: unknown, prefix = "", out: string[] = []): string[] {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push(prefix);
  }
  return out;
}

function main() {
  for (const [file, namespace] of [
    ["src/i18n/en.json", LEGAL_EN],
    ["src/i18n/hi.json", LEGAL_HI],
  ] as const) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.legal = namespace;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    console.log(`${file}: legal namespace written (${flatten(namespace).length} leaves)`);
  }

  fs.mkdirSync("src/components/doco/pages", { recursive: true });
  fs.writeFileSync(
    "src/components/doco/pages/i18n.json",
    JSON.stringify({ en: LEGAL_EN, hi: LEGAL_HI }, null, 2) + "\n"
  );
  console.log("src/components/doco/pages/i18n.json: reference copy written");

  const en = flatten(JSON.parse(fs.readFileSync("src/i18n/en.json", "utf8")));
  const hi = flatten(JSON.parse(fs.readFileSync("src/i18n/hi.json", "utf8")));
  const enSet = new Set(en);
  const hiSet = new Set(hi);
  const missingHi = en.filter((key) => !hiSet.has(key));
  const missingEn = hi.filter((key) => !enSet.has(key));
  console.log(`parity: en ${en.length} leaves, hi ${hi.length} leaves`);
  if (missingHi.length || missingEn.length) {
    console.error("PARITY FAIL", { missingHi, missingEn });
    process.exit(1);
  }
  console.log("parity OK: en = hi");
}

main();
