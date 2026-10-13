import type { ToolConfig } from "@/lib/tools/config-types";

/**
 * Generate Password (PRD §8.4, security) — the first NO-FILE tool: no
 * document, no worker, no run step. The surface (surface.tsx) renders
 * directly on the landing page and IS the product — Web Crypto random /
 * pronounceable / passphrase (Hindi + English word lists), strength meter,
 * copy, session-only history. Nothing is ever stored or sent.
 */
export const config: ToolConfig = {
  toolId: "generate-password",
  noFile: true,
  minFiles: 0,
  maxFiles: 0,
  options: [],
  howKeys: ["gp.how1", "gp.how2", "gp.how3"],
  features: [
    {
      en: "Three modes: fully random with your choice of character sets, pronounceable syllable soup you can actually say out loud, or passphrases built from Hindi and English word lists.",
      hi: "तीन मोड: अपने चुने कैरेक्टर सेट के साथ पूरी तरह रैंडम, बोलने लायक pronounceable, या हिंदी और अंग्रेज़ी शब्दों से बनी पासफ़्रेज़।",
    },
    {
      en: "Every character comes from the browser's Web Crypto random generator — the same engine banks use, never a weak Math.random.",
      hi: "हर कैरेक्टर ब्राउज़र के Web Crypto रैंडम जनरेटर से आता है — वही इंजन जो बैंक इस्तेमाल करते हैं, कभी कमज़ोर Math.random नहीं।",
    },
    {
      en: "Honest strength meter: entropy in bits computed from the choices actually made, plus an offline-attack crack estimate — not marketing colors.",
      hi: "ईमानदार स्ट्रेंथ मीटर: असल में हुई चुनावों से निकला एन्ट्रॉपी बिट्स में, साथ में ऑफ़लाइन अटैक का क्रैक अनुमान — मार्केटिंग वाले रंग नहीं।",
    },
    {
      en: "Session-only history — the last six values stay on this page and vanish the moment you close the tab. Nothing is saved, logged or sent.",
      hi: "सिर्फ़ सेशन वाला इतिहास — आख़िरी छह पासवर्ड इसी पेज पर रहते हैं और टैब बंद करते ही मिट जाते हैं। कुछ भी सेव, लॉग या भेजा नहीं जाता।",
    },
    {
      en: "Avoid-ambiguous option strips lookalike glyphs (0 O 1 l I |) so nothing gets mistyped on a phone or read wrong over a call.",
      hi: "Avoid-ambiguous विकल्प मिलते-जुलते अक्षरों (0 O 1 l I |) को हटा देता है, ताकि फ़ोन पर टाइप करते या कॉल पर पढ़ते समय ग़लती न हो।",
    },
  ],
  faq: [
    {
      q: {
        en: "How strong should my password be?",
        hi: "मेरा पासवर्ड कितना मज़बूत होना चाहिए?",
      },
      a: {
        en: "For accounts that matter, aim for 60+ bits on the strength meter (green). A 4–5 word passphrase from this tool already clears that; a 16+ character random password with all four character sets is stronger still. Length beats cleverness — every extra character multiplies the work an attacker must do.",
        hi: "ज़रूरी अकाउंट्स के लिए स्ट्रेंथ मीटर पर 60+ बिट्स (हरा) का लक्ष्य रखें। इस टूल की 4–5 शब्दों की पासफ़्रेज़ वहीं क्लियर कर देती है; चारों कैरेक्टर सेट के साथ 16+ कैरेक्टर का रैंडम पासवर्ड और भी मज़बूत है। लंबाई ही असली ताक़त है — हर एक्स्ट्रा कैरेक्टर हमलावर के काम को कई गुना बढ़ा देता है।",
      },
    },
    {
      q: {
        en: "Are these passwords really random and safe to use?",
        hi: "क्या ये पासवर्ड सच में रैंडम और इस्तेमाल लायक हैं?",
      },
      a: {
        en: "Yes. Every character is drawn from the browser's Web Crypto random source (crypto.getRandomValues) with bias-free sampling — no modulo bias, no Math.random, no server round-trip. The value exists only in this page's memory; there is no save, sync or analytics on it.",
        hi: "हाँ। हर कैरेक्टर ब्राउज़र के Web Crypto रैंडम सोर्स (crypto.getRandomValues) से बिना किसी बायस के निकलता है — कोई modulo बायस नहीं, कोई Math.random नहीं, कोई सर्वर कॉल नहीं। पासवर्ड सिर्फ़ इस पेज की मेमोरी में रहता है; न सेव, न सिंक, न एनालिटिक्स।",
      },
    },
    {
      q: {
        en: "Which mode should I pick?",
        hi: "मुझे कौन सा मोड चुनना चाहिए?",
      },
      a: {
        en: "Random is strongest per character — best for app passwords. Pronounceable is easier to dictate over a phone call. Passphrases are easiest to remember and type on a phone; mix Hindi and English words with a separator for a phrase you'll never forget.",
        hi: "रैंडम हर कैरेक्टर में सबसे मज़बूत है — ऐप पासवर्ड के लिए सबसे अच्छा। Pronounceable फ़ोन पर बोलकर बताने में आसान है। पासफ़्रेज़ याद रखने और फ़ोन पर टाइप करने में सबसे आसान है; हिंदी-अंग्रेज़ी शब्द मिलाकर सेपरेटर के साथ बनाइए — ऐसा वाक्य जो आप कभी नहीं भूलेंगे।",
      },
    },
  ],
};
