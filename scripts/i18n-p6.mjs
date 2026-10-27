// P6-STATIC i18n injection — adds pages/about/contact/privacy/terms + footer keys.
import { readFileSync, writeFileSync } from "node:fs";

const en = JSON.parse(readFileSync("/home/z/my-project/src/i18n/en.json", "utf8"));
const hi = JSON.parse(readFileSync("/home/z/my-project/src/i18n/hi.json", "utf8"));

/* ---------------- pages (shared shell) ---------------- */
en.pages = {
  backHome: "Back to home",
  updated: "Last updated: {date}",
  notFoundTitle: "Page not found",
  notFoundDesc: "The page you are looking for does not exist or was moved.",
  notFoundAction: "Go to home",
};
hi.pages = {
  backHome: "होम पर वापस जाएँ",
  updated: "अंतिम अपडेट: {date}",
  notFoundTitle: "पेज नहीं मिला",
  notFoundDesc: "आप जो पेज खोज रहे हैं वह मौजूद नहीं है या हटा दिया गया है।",
  notFoundAction: "होम पर जाएँ",
};

/* ---------------- footer columns ---------------- */
en.footer.popularLabel = "Popular tools";
en.footer.companyLabel = "Company";
en.footer.legalLabel = "Legal";
en.footer.about = "About us";
en.footer.contact = "Contact";
en.footer.privacy = "Privacy Policy";
en.footer.terms = "Terms of Service";
hi.footer.popularLabel = "लोकप्रिय टूल्स";
hi.footer.companyLabel = "कंपनी";
hi.footer.legalLabel = "कानूनी";
hi.footer.about = "हमारे बारे में";
hi.footer.contact = "संपर्क करें";
hi.footer.privacy = "गोपनीयता नीति";
hi.footer.terms = "सेवा की शर्तें";

/* ---------------- about ---------------- */
en.about = {
  title: "About Sidocs",
  lede: "Free, honest, privacy-first PDF tools — built in India, for everyone.",
  missionTitle: "Our mission",
  missionBody:
    "PDF software should not demand your files, your email address or your money for the basics. Sidocs exists so anyone — a student filling an exam form, a shop owner making a GST invoice, a professional redacting a contract — can get everyday PDF work done in seconds, in English or Hindi, without signing up.",
  missionBody2:
    "Every tool that says “Device-only” runs entirely inside your browser. Your files never travel to a server, because there is no upload in the first place.",
  statsTitle: "Sidocs today",
  statTools: "{live} of {total}",
  statToolsLabel: "tools ready to use",
  statCategoriesLabel: "tool categories",
  statLanguagesLabel: "languages (EN + हिंदी)",
  statUploadsLabel: "files uploaded — ever",
  statsNote:
    "Counts update live from our tool registry. “0 files uploaded” is not a promise we plan to break: device-only tools cannot upload even if they wanted to.",
  storyTitle: "Why we built it",
  storyBody:
    "It started with the same frustration you probably know: a government form that needed a 50 KB photo, a PDF that needed one page removed, and a maze of sites that wanted uploads, sign-ups and watermarks. We decided the browser was already powerful enough to do all of it locally — so we built the toolbox we wished existed.",
  storyBody2:
    "Along the way we self-hosted every engine: the PDF renderer, the OCR models, the Hindi fonts, even the QR generator. Nothing loads from a third-party CDN, so the tools work offline and your usage cannot leak.",
  madeInIndia: "Made in India 🇮🇳 — built for Indian forms, invoices and paperwork first, useful everywhere.",
  privacyTitle: "How your files stay private",
  privacyBody:
    "Most Sidocs tools are “Device-only” tools. Here is exactly what that means, in three steps:",
  flow1: "You pick a tool and open a file — it loads straight into your browser’s memory. No upload happens.",
  flow2: "The work (merging, converting, signing, redacting…) runs in background threads inside your own device.",
  flow3: "You get the finished PDF. It was created on your machine and only ever existed on your machine.",
  calloutTitle: "Files never leave your browser",
  calloutBody:
    "For device-only tools there is no “we delete your files after N hours” clause — there is nothing to delete, because nothing was ever received.",
  principlesTitle: "Principles we build by",
  principle1: "No file, no fee, no watermark — the everyday tools stay free, forever.",
  principle2: "No accounts required. Nothing to sign up for, nothing to cancel.",
  principle3: "Every engine self-hosted — fonts, OCR, codecs and PDF libraries ship from our own origin, never a third-party CDN.",
  principle4: "Bilingual by design, not by afterthought — English and real Hindi everywhere, including inside generated PDFs.",
  principle5: "Honest labels — a tool that needs a server says so on its face; a tool that works offline says that too.",
  ctaTitle: "Try it with your own file",
  ctaBody:
    "Pick any tool, drop a file, and watch your browser do the work. Or write to us — we read every message.",
  ctaContact: "Contact us",
};
hi.about = {
  title: "Sidocs के बारे में",
  lede: "मुफ़्त, ईमानदार और गोपनीयता-पहले PDF टूल्स — भारत में बने, सबके लिए।",
  missionTitle: "हमारा मिशन",
  missionBody:
    "PDF सॉफ़्टवेयर को बुनियादी काम के लिए आपकी फ़ाइलें, ईमेल या पैसे नहीं मांगने चाहिए। Sidocs इसलिए है ताकि कोई भी — एग्ज़ाम फ़ॉर्म भरता स्टूडेंट, GST इनवॉइस बनाता दुकानदार, या कॉन्ट्रैक्ट रिडैक्ट करता प्रोफेशनल — बिना साइन-अप किए हर रोज़ का PDF काम सेकंडों में, अंग्रेज़ी या हिंदी में कर सके।",
  missionBody2:
    "हर वह टूल जिस पर “डिवाइस-ओनली” लिखा है, पूरी तरह आपके ब्राउज़र के अंदर चलता है। आपकी फ़ाइलें किसी सर्वर पर जाती ही नहीं, क्योंकि अपलोड होता ही नहीं।",
  statsTitle: "आज का Sidocs",
  statTools: "{total} में से {live}",
  statToolsLabel: "टूल उपयोग के लिए तैयार",
  statCategoriesLabel: "टूल श्रेणियाँ",
  statLanguagesLabel: "भाषाएँ (EN + हिंदी)",
  statUploadsLabel: "फ़ाइलें कभी अपलोड हुईं",
  statsNote:
    "गिनती सीधे हमारे टूल रजिस्ट्री से अपडेट होती है। “0 फ़ाइलें अपलोड” एक ऐसा वादा है जो हम कभी नहीं तोड़ेंगे — डिवाइस-ओनली टूल चाहकर भी अपलोड नहीं कर सकते।",
  storyTitle: "हमने इसे क्यों बनाया",
  storyBody:
    "शुरुआत उसी झंझट से हुई जो शायद आपको भी जानी होगी: एक सरकारी फ़ॉर्म जिसमें 50 KB की फोटो चाहिए थी, एक PDF जिसमें से एक पेज हटाना था — और ऐसी साइटों का भूलभुलैया जो अपलोड, साइन-अप और वॉटरमार्क मांगती थीं। हमने तय किया कि ब्राउज़र इतना ताक़तवर है कि यह सब वहीं लोकल चला सके — तो हमने वही टूलबॉक्स बनाया जो हमें खुद चाहिए था।",
  storyBody2:
    "रास्ते में हमने हर इंजन खुद होस्ट किया: PDF रेंडरर, OCR मॉडल, हिंदी फ़ॉन्ट, यहाँ तक कि QR जेनरेटर तक। किसी थर्ड-पार्टी CDN से कुछ नहीं लोड होता, इसलिए टूल्स ऑफ़लाइन भी चलते हैं और आपका इस्तेमाल बाहर नहीं जाता।",
  madeInIndia: "भारत में बना 🇮🇳 — पहले भारतीय फ़ॉर्म, इनवॉइस और काग़ज़ात के लिए, हर जगह उपयोगी।",
  privacyTitle: "आपकी फ़ाइलें गोपनीय कैसे रहती हैं",
  privacyBody:
    "Sidocs के ज़्यादातर टूल “डिवाइस-ओनली” हैं। इसका सही मतलब, तीन क़दमों में:",
  flow1: "आप टूल चुनते हैं और फ़ाइल खोलते हैं — वह सीधे आपके ब्राउज़र की मेमोरी में लोड होती है। कोई अपलोड नहीं होता।",
  flow2: "काम (मर्ज, कन्वर्ट, साइन, रिडैक्ट…) आपके ही डिवाइस के अंदर बैकग्राउंड थ्रेड्स में चलता है।",
  flow3: "आपको तैयार PDF मिलती है। वह आपकी मशीन पर बनी और केवल आपकी मशीन पर ही रही।",
  calloutTitle: "फ़ाइलें कभी आपके ब्राउज़र से बाहर नहीं जातीं",
  calloutBody:
    "डिवाइस-ओनली टूल्स के लिए “हम आपकी फ़ाइलें N घंटे बाद मिटा देते हैं” जैसा कोई क्लॉज़ नहीं — मिटाने को कुछ है ही नहीं, क्योंकि कुछ मिला ही नहीं था।",
  principlesTitle: "सिद्धांत जिन पर हम बनाते हैं",
  principle1: "कोई फ़ाइल नहीं, कोई फ़ीस नहीं, कोई वॉटरमार्क नहीं — रोज़ के टूल्स हमेशा मुफ़्त।",
  principle2: "कोई अकाउंट ज़रूरी नहीं। न साइन-अप करना है, न कैंसल करना।",
  principle3: "हर इंजन खुद होस्टेड — फ़ॉन्ट, OCR, कोडेक्स और PDF लाइब्रेरी हमारे ही ओरिजिन से, कभी थर्ड-पार्टी CDN से नहीं।",
  principle4: "डिज़ाइन से ही द्विभाषी, बाद में जोड़ा नहीं — अंग्रेज़ी और असली हिंदी हर जगह, बनने वाली PDF के अंदर तक।",
  principle5: "ईमानदार लेबल — जो टूल सर्वर मांगता है वह अपने मुँह से कहता है; जो ऑफ़लाइन चलता है वह भी।",
  ctaTitle: "अपनी ही फ़ाइल से आज़माइए",
  ctaBody:
    "कोई भी टूल चुनिए, फ़ाइल छोड़िए और देखिए आपका ब्राउज़र काम करता है। या हमें लिखिए — हम हर संदेश पढ़ते हैं।",
  ctaContact: "संपर्क करें",
};

/* ---------------- contact ---------------- */
en.contact = {
  title: "Contact us",
  lede: "Bug, idea, billing question or a legal note — write to us and a human will reply.",
  nameLabel: "Your name",
  namePlaceholder: "e.g. Priya Sharma",
  emailLabel: "Email address",
  emailPlaceholder: "you@example.com",
  categoryLabel: "What is this about?",
  categoryPlaceholder: "Choose a topic",
  categoryHint: "Picking the right topic helps us route your message faster.",
  catBug: "Bug report",
  catFeature: "Feature request",
  catBilling: "Billing",
  catBusiness: "Business / API",
  catLegal: "Legal / DMCA",
  catOther: "Other",
  messageLabel: "Message",
  messagePlaceholder:
    "Tell us what happened, which tool you used, and what you expected. Details help us fix things faster.",
  messageHint: "10–5000 characters. Please do not paste confidential file contents.",
  consentLabel:
    "I agree that Sidocs may store this message and my email to reply to me, as described in the Privacy Policy.",
  submit: "Send message",
  sending: "Sending…",
  spamNote: "Spam-protected without trackers: an invisible honeypot plus rate limiting.",
  successTitle: "Message received",
  successBody:
    "Thanks for writing in! Your message is with us and a human will reply within 24–48 hours.",
  ticketLabel: "Your ticket id",
  copyTicket: "Copy ticket id",
  successNote: "Save this id — quoting it in follow-up emails gets you faster answers.",
  backTools: "Back to all tools",
  sendAnother: "Send another message",
  slaTitle: "Response time",
  slaBody: "We answer within 24–48 hours, Monday to Saturday.",
  emailTitle: "Email",
  emailNote: "For anything urgent or sensitive, email works best.",
  officeTitle: "Registered office",
  officeBody:
    "Sidocs, 2nd Floor, Plot 14, Sector 8, IMT Manesar, Gurugram, Haryana 122051, India",
  privacyTitle: "Your data",
  privacyBody:
    "Only your name, email, topic and message are stored — solely to answer you.",
  privacyLink: "Read the Privacy Policy",
  errRateTitle: "Too many messages",
  errRateBody: "Please wait a minute before sending again.",
  errSendTitle: "Could not send",
  errSendBody: "Something went wrong on our side. Please try again in a moment.",
};
hi.contact = {
  title: "संपर्क करें",
  lede: "बग, सुझाव, बिलिंग का सवाल या कानूनी बात — हमें लिखिए, इंसान जवाब देगा।",
  nameLabel: "आपका नाम",
  namePlaceholder: "जैसे प्रिया शर्मा",
  emailLabel: "ईमेल पता",
  emailPlaceholder: "aap@example.com",
  categoryLabel: "यह किस बारे में है?",
  categoryPlaceholder: "विषय चुनें",
  categoryHint: "सही विषय चुनने से आपका संदेश जल्दी सही जगह पहुँचता है।",
  catBug: "बग रिपोर्ट",
  catFeature: "नई सुविधा का सुझाव",
  catBilling: "बिलिंग",
  catBusiness: "बिज़नेस / API",
  catLegal: "कानूनी / DMCA",
  catOther: "अन्य",
  messageLabel: "संदेश",
  messagePlaceholder:
    "क्या हुआ, कौन-सा टूल इस्तेमाल किया और क्या उम्मीद थी — ज़रा बताइए। ब्योरे मिलेंगे तो जल्दी ठीक होगा।",
  messageHint: "10–5000 अक्षर। कृपया गोपनीय फ़ाइलों की सामग्री पेस्ट न करें।",
  consentLabel:
    "मैं सहमत हूँ कि Sidocs जवाब देने के लिए यह संदेश और मेरा ईमेल रख सके — जैसा गोपनीयता नीति में लिखा है।",
  submit: "संदेश भेजें",
  sending: "भेज रहे हैं…",
  spamNote: "बिना ट्रैकर के स्पैम-सुरक्षा: अदृश्य हनीपॉट और रेट लिमिट।",
  successTitle: "संदेश मिल गया",
  successBody:
    "लिखने के लिए धन्यवाद! आपका संदेश हमारे पास है — 24–48 घंटे में इंसान जवाब देगा।",
  ticketLabel: "आपका टिकट आईडी",
  copyTicket: "टिकट आईडी कॉपी करें",
  successNote: "इस आईडी को रख लीजिए — आगे के ईमेल में लिखेंगे तो जवाब और जल्दी मिलेगा।",
  backTools: "सारे टूल्स पर वापस",
  sendAnother: "एक और संदेश भेजें",
  slaTitle: "जवाब का समय",
  slaBody: "सोमवार से शनिवार, 24–48 घंटे के भीतर जवाब।",
  emailTitle: "ईमेल",
  emailNote: "कुछ भी ज़रूरी या संवेदनशील हो तो ईमेल सबसे अच्छा।",
  officeTitle: "रजिस्टर्ड कार्यालय",
  officeBody:
    "Sidocs, 2nd Floor, Plot 14, Sector 8, IMT Manesar, Gurugram, Haryana 122051, India",
  privacyTitle: "आपका डेटा",
  privacyBody:
    "केवल आपका नाम, ईमेल, विषय और संदेश रखा जाता है — सिर्फ़ जवाब देने के लिए।",
  privacyLink: "गोपनीयता नीति पढ़ें",
  errRateTitle: "बहुत ज़्यादा संदेश",
  errRateBody: "कृपया एक मिनट रुककर दोबारा भेजें।",
  errSendTitle: "भेजा नहीं जा सका",
  errSendBody: "हमारी तरफ़ से कुछ गड़बड़ हुई। थोड़ी देर में फिर कोशिश करें।",
};

/* ---------------- privacy ---------------- */
en.privacy = {
  title: "Privacy Policy",
  lede: "What we collect, what we never touch, and the rights you have — in plain words.",
  updated: "1 November 2025",
  neverTitle: "The short version",
  neverBody:
    "Your PDF files never leave your device with our device-only tools. We do not want them, we cannot read them, and we never receive them.",
  collectTitle: "What we collect",
  collectIntro:
    "Sidocs runs without an account, so there is very little data at all. Here is the complete list:",
  collectDeviceLabel: "Nothing, by default",
  collectDeviceValue:
    "Using Sidocs does not require an account, email or any personal detail. Most visits leave nothing behind.",
  collectUsageLabel: "Anonymous usage counts",
  collectUsageValue:
    "Aggregate tool-run counters (tool id, success/fail, rough duration) stored with a random id — never tied to your name, email or IP.",
  collectContactLabel: "Contact form details",
  collectContactValue:
    "If you write to us: your name, email, chosen topic and message — used only to reply to you.",
  collectPaymentLabel: "Payment metadata (future Pro plans)",
  collectPaymentValue:
    "If you ever pay: order id, amount and plan, received from the payment provider. Card and UPI details stay with the provider; we never see them.",
  collectPrefsLabel: "Local preferences",
  collectPrefsValue:
    "Language, theme, consent choice and recently-used tools live in your own browser storage. They never reach our servers.",
  notCollectedTitle: "What we never collect",
  notCollectedBody:
    "These are not “we collect but delete later” items — they are structurally impossible for device-only tools:",
  notCollected1: "The content of your PDFs, images or any file you open in a tool.",
  notCollected2: "Your IP address or browsing history tied to tool usage.",
  notCollected3: "Advertising or cross-site tracking identifiers — we run no third-party analytics scripts.",
  notCollected4: "Accounts and passwords — there is nothing to breach.",
  purposeTitle: "Why we use what we have",
  purpose1: "Usage counts: understand which tools to improve and build next.",
  purpose2: "Contact details: answer your message, and nothing else.",
  purpose3: "Payment metadata (when Pro launches): process the payment and honour the plan.",
  purpose4: "Legal compliance: keep records a law asks us to keep, such as tax invoices.",
  retentionTitle: "How long we keep it",
  retentionBody:
    "Contact messages: until your enquiry is closed, then up to 90 days for context, then deleted. Aggregate usage counts: rotated within 90 days. Payment records: as long as tax law requires. Local preferences: until you clear your browser storage — that one is entirely in your hands.",
  sharingTitle: "Who we share it with",
  sharingBody:
    "Nobody for marketing — we do not sell, rent or trade data. Ever. We share only with the payment provider when you choose to pay (they process the transaction) and with authorities when the law genuinely compels us.",
  sharingBody2:
    "Self-hosted note: our fonts, OCR models and libraries all load from our own origin. No third-party CDN sees your requests.",
  rightsTitle: "Your rights",
  rightsIntro:
    "Wherever the DPDP Act 2023 (India) or GDPR (EU) applies, you can:",
  right1: "Access — ask what data about you we hold.",
  right2: "Correction — fix anything wrong.",
  right3: "Erasure — ask us to delete your data.",
  right4: "Withdraw consent — stop processing that relies on it.",
  right5: "Grievance redressal — write to our Data Protection contact below.",
  lawTitle: "Law we follow",
  lawBody:
    "This policy is written to comply with India’s Digital Personal Data Protection Act, 2023 (DPDP), and to meet GDPR standards for visitors from the European Union.",
  lawBody2:
    "Cross-border note: we host within India wherever possible. If any processor runs elsewhere, we bind it to the same protection level contractually.",
  childrenTitle: "Children",
  childrenBody:
    "Sidocs is a general-purpose utility. It is not directed at children under 18, we do not knowingly collect their data, and if we learn we hold any, we delete it promptly.",
  contactTitle: "Contact / Data Protection contact",
  contactBody:
    "For privacy questions or to exercise any right above, use the contact form (topic: Other) or email the Data Protection contact. We respond within 30 days, usually much sooner.",
  contactLink: "Open the contact page",
  changesTitle: "Changes to this policy",
  changesBody:
    "If we change this policy materially, we will update the date above and announce it on the site for at least 14 days. The dated version you read here is the one that applies.",
};
hi.privacy = {
  title: "गोपनीयता नीति",
  lede: "हम क्या रखते हैं, किसे कभी नहीं छूते, और आपके अधिकार — साफ़ शब्दों में।",
  updated: "1 नवंबर 2025",
  neverTitle: "छोटे में पूरी बात",
  neverBody:
    "डिवाइस-ओनली टूल्स के साथ आपकी PDF फ़ाइलें कभी आपके डिवाइस से बाहर नहीं जातीं। हम उन्हें नहीं चाहते, पढ़ नहीं सकते, और कभी मिलती ही नहीं।",
  collectTitle: "हम क्या रखते हैं",
  collectIntro:
    "Sidocs बिना अकाउंट चलता है, इसलिए डेटा बहुत कम है। पूरी सूची यह है:",
  collectDeviceLabel: "डिफ़ॉल्ट रूप से — कुछ नहीं",
  collectDeviceValue:
    "Sidocs इस्तेमाल करने के लिए अकाउंट, ईमेल या कोई निजी जानकारी ज़रूरी नहीं। ज़्यादातर विज़िट कुछ भी पीछे नहीं छोड़ती।",
  collectUsageLabel: "गुमनाम इस्तेमाल-गिनती",
  collectUsageValue:
    "कुल मिलाकर टूल-रन काउंटर (टूल आईडी, सफल/असफल, लगभग समय) एक रैंडम आईडी के साथ — आपके नाम, ईमेल या IP से कभी जुड़े नहीं।",
  collectContactLabel: "संपर्क फ़ॉर्म की जानकारी",
  collectContactValue:
    "अगर आप हमें लिखते हैं: आपका नाम, ईमेल, चुना विषय और संदेश — सिर्फ़ जवाब देने के लिए।",
  collectPaymentLabel: "भुगतान मेटाडेटा (आने वाली Pro योजनाएँ)",
  collectPaymentValue:
    "अगर कभी पैसे देते हैं: ऑर्डर आईडी, रकम और प्लान, भुगतान प्रोवाइडर से। कार्ड और UPI की जानकारी प्रोवाइडर के पास रहती है; हम देखते ही नहीं।",
  collectPrefsLabel: "लोकल प्राथमिकताएँ",
  collectPrefsValue:
    "भाषा, थीम, सहमति-चुनाव और हाल के टूल्स आपके ब्राउज़र स्टोरेज में रहते हैं। हमारे सर्वर तक कभी नहीं पहुँचते।",
  notCollectedTitle: "हम कभी नहीं रखते",
  notCollectedBody:
    "ये “रखते हैं पर बाद में मिटा देते हैं” वाली चीज़ें नहीं हैं — डिवाइस-ओनली टूल्स के लिए ये बनती ही नहीं:",
  notCollected1: "किसी भी टूल में खोली गई PDF, फोटो या किसी फ़ाइल की सामग्री।",
  notCollected2: "टूल-इस्तेमाल से जुड़ा आपका IP या ब्राउज़िंग इतिहास।",
  notCollected3: "विज्ञापन या क्रॉस-साइट ट्रैकिंग आईडी — हम कोई थर्ड-पार्टी एनालिटिक्स स्क्रिप्ट चलाते ही नहीं।",
  notCollected4: "अकाउंट और पासवर्ड — लीक होने को कुछ है ही नहीं।",
  purposeTitle: "जो है उसका उपयोग किसलिए",
  purpose1: "इस्तेमाल-गिनती: कौन-सा टूल सुधारें और आगे क्या बनाएँ — यह समझने के लिए।",
  purpose2: "संपर्क जानकारी: आपके संदेश का जवाब, और बस।",
  purpose3: "भुगतान मेटाडेटा (जब Pro आएगा): भुगतान पूरा करना और प्लान देना।",
  purpose4: "कानूनी अनुपालन: कानून जो रिकॉर्ड मांगता है, जैसे टैक्स इनवॉइस।",
  retentionTitle: "कब तक रखते हैं",
  retentionBody:
    "संपर्क संदेश: पूछ बात बंद होने तक, फिर संदर्भ के लिए 90 दिन, फिर मिटा देते हैं। कुल इस्तेमाल-गिनती: 90 दिन में घूमती रहती है। भुगतान रिकॉर्ड: जब तक टैक्स कानून मांगे। लोकल प्राथमिकताएँ: जब तक आप ब्राउज़र स्टोरेज साफ़ न करें — यह पूरा आपके हाथ में है।",
  sharingTitle: "किसके साथ बाँटते हैं",
  sharingBody:
    "मार्केटिंग के लिए किसी के साथ नहीं — हम डेटा नहीं बेचते, किराए पर देते नहीं, सौदा नहीं करते। कभी नहीं। साझा करते हैं सिर्फ़ भुगतान प्रोवाइडर से, जब आप भुगतान चुनते हैं (वे लेन-देन चलाते हैं), और अधिकारियों से, जब कानून सच में मजबूर करे।",
  sharingBody2:
    "सेल्फ़-होस्टेड नोट: हमारे फ़ॉन्ट, OCR मॉडल और लाइब्रेरी हमारे ही ओरिजिन से लोड होते हैं। कोई थर्ड-पार्टी CDN आपकी रिक्वेस्ट नहीं देखता।",
  rightsTitle: "आपके अधिकार",
  rightsIntro:
    "जहाँ DPDP एक्ट 2023 (भारत) या GDPR (EU) लागू हो, वहाँ आप कर सकते हैं:",
  right1: "जानकारी — पूछें कि हमारे पास आपका क्या डेटा है।",
  right2: "सुधार — जो ग़लत है उसे ठीक करवाएँ।",
  right3: "मिटाना — कहें कि आपका डेटा हटा दिया जाए।",
  right4: "सहमति वापस लेना — जो काम सहमति पर टिके हैं, उन्हें रोकें।",
  right5: "शिकायत निवारण — नीचे दिए डेटा प्रोटेक्शन संपर्क को लिखें।",
  lawTitle: "हम किस कानून से चलते हैं",
  lawBody:
    "यह नीति भारत के डिजिटल पर्सनल डेटा प्रोटेक्शन एक्ट, 2023 (DPDP) के अनुसार लिखी गई है और यूरोपीय संघ से आने वाले विज़िटर्स के लिए GDPR स्तर भी पूरा करती है।",
  lawBody2:
    "क्रॉस-बॉर्डर नोट: जहाँ तक हो सके हम भारत के भीतर होस्ट करते हैं। अगर कोई प्रोसेसर कहीं और चले, तो करार से उसे इतनी ही सुरक्षा दिलाते हैं।",
  childrenTitle: "बच्चे",
  childrenBody:
    "Sidocs एक सामान्य यूटिलिटी है। यह 18 साल से कम उम्र के बच्चों के लिए नहीं है, हम जान-बूझकर उनका डेटा नहीं रखते, और पता चले तो तुरंत मिटा देते हैं।",
  contactTitle: "संपर्क / डेटा प्रोटेक्शन संपर्क",
  contactBody:
    "गोपनीयता के सवालों या ऊपर लिखे किसी अधिकार के लिए संपर्क फ़ॉर्म (विषय: अन्य) इस्तेमाल करें या डेटा प्रोटेक्शन संपर्क को ईमेल करें। जवाब 30 दिन में, आमतौर पर उससे भी पहले।",
  contactLink: "संपर्क पेज खोलें",
  changesTitle: "नीति में बदलाव",
  changesBody:
    "अगर यह नीति किसी बड़े तरीके से बदले तो ऊपर की तारीख अपडेट करेंगे और साइट पर कम से कम 14 दिन ऐलान रखेंगे। यहाँ लिखी तारीख वाली ही नीति लागू रहती है।",
};

/* ---------------- terms ---------------- */
en.terms = {
  title: "Terms of Service",
  lede: "The deal between you and Sidocs — short, readable, no traps.",
  updated: "1 November 2025",
  acceptTitle: "Accepting these terms",
  acceptBody:
    "By using Sidocs you agree to these terms. If you do not agree, please do not use the service. You also confirm you are at least 18 years old, or are using Sidocs with a parent or guardian’s permission.",
  serviceTitle: "What the service is",
  serviceBody:
    "Sidocs is a collection of browser-based PDF and document tools. Tools labelled “Device-only” process your files entirely on your device; tools labelled “Server processing” (where offered) send the file to our server to complete the job and clearly say so before you start.",
  serviceBody2:
    "The service is provided as-is. Features may be added, changed or removed as we evolve the product.",
  serviceCalloutTitle: "No account needed",
  serviceCalloutBody:
    "Today, every tool works without an account. Any future paid plan will not reduce the free everyday tools.",
  useTitle: "Acceptable use",
  useIntro: "Please do not use Sidocs to:",
  use1: "Break any applicable law or process content you have no right to.",
  use2: "Infringe copyrights — for example, distributing paid books or exam papers you do not own.",
  use3: "Attack, overload or probe the service or its infrastructure.",
  use4: "Forge documents, signatures or identities — signatures tools are for your own documents.",
  use5: "Upload malware or illegal content to any server-side feature.",
  warrantyTitle: "No warranty on output",
  warrantyBody:
    "PDF conversion, OCR and compression are remarkably reliable but not perfect. Always review important output before relying on it. Sidocs is offered “as is”, without warranty of any kind, to the fullest extent permitted by law.",
  warrantyBody2:
    "We self-host every engine and test carefully, but we cannot promise every file in every format will convert exactly as you expect. For legal, medical or financial documents, verify the result yourself.",
  liabilityTitle: "Limitation of liability",
  liabilityBody:
    "To the maximum extent permitted by law, Sidocs is not liable for indirect, incidental or consequential damages, lost profits or lost data arising from use of the service. Our total liability for any claim shall not exceed the amount you paid us in the 12 months before the claim — which, for a free tool, is zero.",
  billingTitle: "Billing (for when Pro launches)",
  billingBody:
    "Any future paid plans will state their price, billing cycle and cancellation steps clearly before you pay. Device-only tools remain free — that is a permanent promise, not a marketing line.",
  terminationTitle: "Termination",
  terminationBody:
    "You may stop using Sidocs at any time — there is no account to close. We may suspend or block access for abuse of the service (see Acceptable use), with notice where practical.",
  lawTitle: "Governing law",
  lawBody:
    "These terms are governed by the laws of India. Courts at Gurugram, Haryana have exclusive jurisdiction over any dispute, unless a consumer-protection law gives you a forum closer to you — nothing here limits those rights.",
  changesTitle: "Changes to these terms",
  changesBody:
    "If we change these terms materially, we will update the date above and announce the change on the site for at least 14 days before it takes effect. Continued use after that means you accept the updated terms.",
  contactTitle: "Questions about these terms",
  contactBody:
    "Anything unclear or unfair here? Tell us — legal-sounding traps are bugs too, and we fix bugs.",
  contactLink: "Open the contact page",
};
hi.terms = {
  title: "सेवा की शर्तें",
  lede: "आप और Sidocs के बीच की बात — छोटी, पढ़ने लायक, बिना जाल।",
  updated: "1 नवंबर 2025",
  acceptTitle: "इन शर्तों से सहमति",
  acceptBody:
    "Sidocs इस्तेमाल करके आप इन शर्तों से सहमत होते हैं। सहमत नहीं हैं तो कृपया सेवा इस्तेमाल न करें। यह भी पक्का करें कि आप 18+ हैं, या माता-पिता/अभिभावक की अनुमति से इस्तेमाल कर रहे हैं।",
  serviceTitle: "यह सेवा क्या है",
  serviceBody:
    "Sidocs ब्राउज़र पर चलने वाले PDF और डॉक्यूमेंट टूल्स का संग्रह है। “डिवाइस-ओनली” लेबल वाले टूल आपकी फ़ाइलें पूरी तरह आपके डिवाइस पर संसाधित करते हैं; “सर्वर प्रोसेसिंग” वाले टूल (जहाँ उपलब्ध हों) फ़ाइल सर्वर पर भेजते हैं और शुरू करने से पहले साफ़ बताते हैं।",
  serviceBody2:
    "सेवा “जैसी है” उस रूप में दी जाती है। प्रॉडक्ट बढ़ने के साथ सुविधाएँ जुड़ सकती, बदल सकती या हट सकती हैं।",
  serviceCalloutTitle: "अकाउंट की ज़रूरत नहीं",
  serviceCalloutBody:
    "आज हर टूल बिना अकाउंट चलता है। भविष्य की कोई भी सशुल्क योजना रोज़ के मुफ़्त टूल्स नहीं कम करेगी।",
  useTitle: "स्वीकार्य इस्तेमाल",
  useIntro: "कृपया Sidocs का इस्तेमाल मत करें:",
  use1: "किसी कानून तोड़ने या उस सामग्री को संसाधित करने के लिए जिसका अधिकार आपको नहीं।",
  use2: "कॉपीराइट तोड़ने के लिए — जैसे भुगतान वाली किताबें या एग्ज़ाम पेपर बाँटना जो आपके हैं ही नहीं।",
  use3: "सेवा या उसकी ढाँचे पर हमला, ओवरलोड या छेड़छाड़ करने के लिए।",
  use4: "फर्ज़ी डॉक्यूमेंट, साइन या पहचान बनाने के लिए — साइन टूल आपके अपने दस्तावेज़ों के लिए हैं।",
  use5: "किसी सर्वर-साइड सुविधा में मैलवेयर या ग़ैर-क़ानूनी सामग्री अपलोड करने के लिए।",
  warrantyTitle: "परिणाम पर कोई वारंटी नहीं",
  warrantyBody:
    "PDF कन्वर्ज़न, OCR और कंप्रेशन भरोसेमंद हैं, पर फिर भी परफ़ेक्ट नहीं। भरोसा करने से पहले ज़रूरी परिणाम ज़रूर जाँचें। Sidocs “जैसी है” उसी रूप में दी जाती है, क़ानून की अनुमति तक, बिना किसी तरह की वारंटी के।",
  warrantyBody2:
    "हम हर इंजन खुद होस्ट करते हैं और ध्यान से परखते हैं, फिर भी हर फ़ाइल, हर फ़ॉर्मैट का हर बार वैसे ही बनने का वादा नहीं कर सकते। कानूनी, मेडिकल या वित्तीय दस्तावेज़ों के लिए परिणाम खुद जाँचें।",
  liabilityTitle: "देयता की सीमा",
  liabilityBody:
    "क़ानून की अनुमत अधिकतम सीमा तक, Sidocs सेवा के इस्तेमाल से उठने वाले अप्रत्यक्ष, संयोगवश या परिणामी नुक़सान, खोए लाभ या खोए डेटा के लिए ज़िम्मेदार नहीं है। किसी भी दावे पर हमारी कुल देयता दावे से पहले के 12 महीनों में आपने जो दिया उतनी ही — जो एक मुफ़्त टूल के लिए शून्य है।",
  billingTitle: "भुगतान (जब Pro आएगा)",
  billingBody:
    "आने वाली सशुल्क योजनाएँ क़ीमत, बिलिंग चक्र और कैंसिल करने का तरीक़ा पहले साफ़ बताएँगी। डिवाइस-ओनली टूल्स मुफ़्त रहेंगे — यह पक्का वादा है, मार्केटिंग की लाइन नहीं।",
  terminationTitle: "समाप्ति",
  terminationBody:
    "आप कभी भी Sidocs इस्तेमाल करना बंद कर सकते हैं — बंद करने को कोई अकाउंट है ही नहीं। हम सेवा के दुरुपयोग (स्वीकार्य इस्तेमाल देखें) पर पहुँच रोक सकते हैं — जहाँ व्यावहारिक हो, सूचना देकर।",
  lawTitle: "लागू कानून",
  lawBody:
    "इन शर्तों पर भारत के क़ानून लागू होते हैं। किसी विवाद पर गुरुग्राम, हरियाणा के न्यायालयों का अनन्य क्षेत्राधिकार रहेगा — सिवाय जहाँ उपभक्ता-संरक्षण क़ानून आपको अपने पास का फ़ोरम दे, वहाँ ये शर्तें उन अधिकारों को नहीं रोकतीं।",
  changesTitle: "शर्तों में बदलाव",
  changesBody:
    "अगर इन शर्तों में बड़ा बदलाव हुआ तो ऊपर की तारीख अपडेट करेंगे और लागू होने से कम से कम 14 दिन पहले साइट पर ऐलान रखेंगे। उसके बाद भी इस्तेमाल जारी रखना माने आप नई शर्तें मानते हैं।",
  contactTitle: "इन शर्तों के बारे में सवाल",
  contactBody:
    "यहाँ कुछ अस्पष्ट या अनुचित लगा? बताइए — क़ानूनी-सी आवाज़ वाले जाल भी बग हैं, और हम बग ठीक करते हैं।",
  contactLink: "संपर्क पेज खोलें",
};

writeFileSync("/home/z/my-project/src/i18n/en.json", JSON.stringify(en, null, 2) + "\n");
writeFileSync("/home/z/my-project/src/i18n/hi.json", JSON.stringify(hi, null, 2) + "\n");

// Parity check
function leaves(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...leaves(v, key));
    else out.push(key);
  }
  return out;
}
const a = leaves(en), b = leaves(hi);
console.log("EN leaves:", a.length, "HI leaves:", b.length);
const missHi = a.filter((k) => !b.includes(k));
const missEn = b.filter((k) => !a.includes(k));
if (missHi.length || missEn.length) {
  console.log("MISSING in hi:", missHi);
  console.log("MISSING in en:", missEn);
  process.exit(1);
}
console.log("PARITY OK");
