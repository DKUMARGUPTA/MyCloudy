/**
 * R26 Phase-10 billing/account merge: the account.* + pricing.* +
 * billing.err.* keys the AccountPage + PricingModal render, plus
 * auth.menuSettings for the new menu entry. Also RETIRES the old
 * placeholder pro.title/pro.body/pro.action group (the "Pro is coming"
 * modal was replaced by the real pricing modal; tool-shell's help
 * dialog now uses common.gotIt).
 * Additive-only for new keys (refuses clobber), removal-only for the
 * retired ones, verifies en↔hi leaf parity.
 * Run: bun scripts/merge-r26-billing-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch: Record<string, Record<"en" | "hi", string>> = {
  /* ---- account menu entry ---- */
  "auth.menuSettings": { en: "Account settings", hi: "खाता सेटिंग्स" },

  /* ---- account page ---- */
  "account.loading": { en: "Loading…", hi: "लोड हो रहा है…" },
  "account.badge": { en: "Account", hi: "खाता" },
  "account.title": { en: "Account settings", hi: "खाता सेटिंग्स" },
  "account.lede": {
    en: "Your profile, plan and security in one place.",
    hi: "आपकी प्रोफ़ाइल, प्लान और सुरक्षा — सब एक जगह।",
  },
  "account.signInTitle": {
    en: "Sign in to manage your account",
    hi: "खाता प्रबंधित करने के लिए लॉग इन करें",
  },
  "account.signInDesc": {
    en: "Account settings hold your profile, plan and security. The tools stay free without an account too.",
    hi: "खाता सेटिंग्स में आपकी प्रोफ़ाइल, प्लान और सुरक्षा है। बिना खाते भी सारे टूल मुफ़्त चलते रहेंगे।",
  },
  "account.memberSince": {
    en: "Member since {date}",
    hi: "सदस्य बने: {date}",
  },
  "account.sectionProfile": { en: "Profile", hi: "प्रोफ़ाइल" },
  "account.sectionPlan": { en: "Plan & billing", hi: "प्लान और बिलिंग" },
  "account.planFreeDesc": {
    en: "All 97 device tools, unlimited use, both languages. Free forever — that's the promise.",
    hi: "सभी 97 डिवाइस टूल, असीमित उपयोग, दोनों भाषाएँ। हमेशा मुफ़्त — यह वादा है।",
  },
  "account.planProDesc": {
    en: "Pro perks activate as server tools launch. Thanks for backing DocoPDF!",
    hi: "प्रो की सुविधाएँ सर्वर टूल्स लॉन्च होते ही सक्रिय हो जाएँगी। DocoPDF को सहयोग देने के लिए धन्यवाद!",
  },
  "account.planPeriodEnd": {
    en: "Active until {date}",
    hi: "{date} तक सक्रिय",
  },
  "account.upgradeCta": { en: "Get Pro", hi: "प्रो लें" },
  "account.manageCancel": { en: "Cancel Pro", hi: "प्रो रद्द करें" },
  "account.cancelConfirmTitle": {
    en: "Cancel Pro?",
    hi: "प्रो रद्द करें?",
  },
  "account.cancelConfirmBody": {
    en: "You'll drop back to the Free plan immediately. All 97 tools stay available.",
    hi: "आप तुरंत मुफ़्त प्लान पर चले जाएँगे। सभी 97 टूल उपलब्ध रहेंगे।",
  },
  "account.cancelKeepTools": {
    en: "Every tool keeps working exactly as before — only the Pro perks go away.",
    hi: "रद्द करने के बाद भी सारे टूल वैसे ही चलते रहेंगे — बस प्रो सुविधाएँ हट जाएँगी।",
  },
  "account.cancelConfirmCta": {
    en: "Yes, cancel Pro",
    hi: "हाँ, प्रो रद्द करें",
  },
  "account.cancelledToast": {
    en: "Pro cancelled — you're on the Free plan now.",
    hi: "प्रो रद्द हो गया — अब आप मुफ़्त प्लान पर हैं।",
  },
  "account.sectionHistory": { en: "Billing history", hi: "बिलिंग इतिहास" },
  "account.historyEmpty": { en: "No payments yet.", hi: "अभी कोई भुगतान नहीं।" },
  "account.statusPaid": { en: "Paid", hi: "भुगतान हो गया" },
  "account.statusPending": { en: "Pending", hi: "प्रतीक्षित" },
  "account.statusFailed": { en: "Failed", hi: "असफल" },
  "account.statusRefunded": { en: "Refunded", hi: "रिफ़ंड हुआ" },
  "account.sectionSecurity": { en: "Security", hi: "सुरक्षा" },
  "account.pwHint": {
    en: "At least 8 characters. Other devices sign out after the change.",
    hi: "कम से कम 8 अक्षर। बदलने के बाद दूसरे डिवाइस से लॉग आउट हो जाएँगे।",
  },
  "account.pwCurrent": { en: "Current password", hi: "वर्तमान पासवर्ड" },
  "account.pwNew": { en: "New password", hi: "नया पासवर्ड" },
  "account.pwConfirm": {
    en: "Confirm new password",
    hi: "नए पासवर्ड की पुष्टि करें",
  },
  "account.pwMismatch": {
    en: "The new passwords don't match.",
    hi: "नए पासवर्ड मेल नहीं खा रहे।",
  },
  "account.pwCta": { en: "Update password", hi: "पासवर्ड अपडेट करें" },
  "account.pwUpdated": { en: "Password updated.", hi: "पासवर्ड अपडेट हो गया।" },
  "account.sectionDanger": { en: "Danger zone", hi: "संवेदनशील क्षेत्र" },
  "account.delDesc": {
    en: "Soft-deletes your account and signs you out everywhere. Account settings and Pro status go away; your tools and files were always device-only and stay untouched.",
    hi: "खाता सॉफ़्ट-डिलीट होकर हर जगह से लॉग आउट हो जाएगा। खाता सेटिंग्स और प्रो स्टेटस हट जाएँगे; आपके टूल और फ़ाइलें हमेशा से ही डिवाइस-ओनली थीं — वैसी ही रहेंगी।",
  },
  "account.delCta": { en: "Delete account", hi: "खाता डिलीट करें" },
  "account.delConfirmTitle": {
    en: "Really delete your account?",
    hi: "सच में खाता डिलीट करें?",
  },
  "account.delConfirmBody": {
    en: "This cannot be undone. Enter your password to confirm.",
    hi: "इसे वापस नहीं किया जा सकता। पुष्टि के लिए अपना पासवर्ड डालें।",
  },
  "account.delConfirmCta": {
    en: "Delete forever",
    hi: "हमेशा के लिए डिलीट करें",
  },
  "account.deletedToast": {
    en: "Account deleted. Take care!",
    hi: "खाता डिलीट हो गया। अलविदा!",
  },

  /* ---- pricing modal ---- */
  "pricing.title": { en: "Choose your plan", hi: "अपना प्लान चुनें" },
  "pricing.desc": {
    en: "Simple pricing. Device-only tools are always free — Pro adds the server-powered perks.",
    hi: "सीधा-सादा प्राइसिंग। डिवाइस-ओनली टूल हमेशा मुफ़्त — प्रो सर्वर-वाली सुविधाएँ जोड़ता है।",
  },
  "pricing.cycleLabel": { en: "Billing cycle", hi: "बिलिंग अवधि" },
  "pricing.monthly": { en: "Monthly", hi: "मासिक" },
  "pricing.yearly": { en: "Yearly", hi: "सालाना" },
  "pricing.save": { en: "Save 17%", hi: "17% बचत" },
  "pricing.freeName": { en: "Free", hi: "मुफ़्त" },
  "pricing.currentPlan": { en: "Current plan", hi: "वर्तमान प्लान" },
  "pricing.proIncludesFree": { en: "Free included", hi: "मुफ़्त शामिल" },
  "pricing.forever": { en: "forever", hi: "हमेशा के लिए" },
  "pricing.freeF1": { en: "All 97 device tools", hi: "सभी 97 डिवाइस टूल" },
  "pricing.freeF2": {
    en: "Unlimited use, no watermarks",
    hi: "असीमित उपयोग, कोई वॉटरमार्क नहीं",
  },
  "pricing.freeF3": { en: "English + हिंदी", hi: "अंग्रेज़ी + हिंदी" },
  "pricing.freeF4": {
    en: "Dark mode & offline PWA",
    hi: "डार्क मोड और ऑफ़लाइन PWA",
  },
  "pricing.proName": { en: "Pro", hi: "प्रो" },
  "pricing.perMonth": { en: "/ month", hi: "/ महीना" },
  "pricing.perYear": { en: "/ year", hi: "/ साल" },
  "pricing.proF1": { en: "Everything in Free", hi: "मुफ़्त का सब कुछ" },
  "pricing.proF2": {
    en: "Larger files on server tools (coming)",
    hi: "सर्वर टूल्स पर बड़ी फ़ाइलें (आ रहा है)",
  },
  "pricing.proF3": {
    en: "Batch queue & priority processing (coming)",
    hi: "बैच क्यू और प्राथमिकता प्रोसेसिंग (आ रहा है)",
  },
  "pricing.proF4": {
    en: "Early access to new server tools",
    hi: "नए सर्वर टूल्स की अर्ली ऐक्सेस",
  },
  "pricing.proF5": { en: "Email support", hi: "ईमेल सहायता" },
  "pricing.proActive": { en: "Pro is active", hi: "प्रो सक्रिय है" },
  "pricing.upgradeCta": { en: "Upgrade to Pro", hi: "प्रो लें" },
  "pricing.signUpCta": {
    en: "Create account & get Pro",
    hi: "खाता बनाकर प्रो लें",
  },
  "pricing.guestHint": {
    en: "You'll need an account to upgrade — it takes 20 seconds.",
    hi: "अपग्रेड के लिए खाता चाहिए — 20 सेकंड का काम है।",
  },
  "pricing.notConfiguredTitle": {
    en: "Payments aren't live yet",
    hi: "भुगतान अभी लाइव नहीं है",
  },
  "pricing.notConfiguredBody": {
    en: "Pro checkout launches together with the payment providers. Nothing was charged — the Free tools keep flowing meanwhile.",
    hi: "प्रो चेकआउट पेमेंट प्रोवाइडर के साथ लॉन्च होगा। कुछ भी चार्ज नहीं हुआ — तब तक मुफ़्त टूल पूरे चलते रहेंगे।",
  },
  "pricing.promise": {
    en: "Device-only tools stay free forever — that's a promise.",
    hi: "डिवाइस-ओनली टूल हमेशा मुफ़्त रहेंगे — यह वादा है।",
  },
  "pricing.upgradedToast": {
    en: "Welcome to Pro! Thanks for backing DocoPDF.",
    hi: "प्रो में आपका स्वागत है! DocoPDF को सहयोग देने के लिए धन्यवाद।",
  },

  /* ---- billing error codes (1:1 with the API contract) ---- */
  "billing.err.bad_request": {
    en: "Something's off — please try again.",
    hi: "कुछ गड़बड़ है — दोबारा कोशिश करें।",
  },
  "billing.err.forbidden": { en: "Please log in first.", hi: "पहले लॉग इन करें।" },
  "billing.err.not_found": { en: "That order was not found.", hi: "यह ऑर्डर नहीं मिला।" },
  "billing.err.rate_limited": {
    en: "Too many attempts — try again in a bit.",
    hi: "बहुत ज़्यादा कोशिशें — कुछ देर बाद कोशिश करें।",
  },
  "billing.err.billingNotConfigured": {
    en: "Payments aren't available yet.",
    hi: "भुगतान अभी उपलब्ध नहीं है।",
  },
  "billing.err.server_error": {
    en: "Something went wrong. Please retry.",
    hi: "कुछ ग़लत हो गया। कृपया दोबारा कोशिश करें।",
  },
};

/* Keys retired with the old placeholder "Pro is coming" modal. */
const retire = ["pro.title", "pro.body", "pro.action"];

/* ---- key-by-key additive merge with clobber refusal ---- */
for (const [dotted, values] of Object.entries(patch)) {
  const parts = dotted.split(".");
  const section = parts[0];
  if (typeof en[section] !== "object" || en[section] === null) en[section] = {};
  if (typeof hi[section] !== "object" || hi[section] === null) hi[section] = {};
  let enNode: Record<string, unknown> = en[section];
  let hiNode: Record<string, unknown> = hi[section];
  for (let i = 1; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof enNode[k] !== "object" || enNode[k] === null) enNode[k] = {};
    if (typeof hiNode[k] !== "object" || hiNode[k] === null) hiNode[k] = {};
    enNode = enNode[k] as Record<string, unknown>;
    hiNode = hiNode[k] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (typeof enNode[leaf] !== "undefined") {
    throw new Error(`en.${dotted} already exists — refusing to clobber`);
  }
  if (typeof hiNode[leaf] !== "undefined") {
    throw new Error(`hi.${dotted} already exists — refusing to clobber`);
  }
  enNode[leaf] = values.en;
  hiNode[leaf] = values.hi;
}

/* ---- retire the placeholder pro.* group ---- */
for (const dotted of retire) {
  const parts = dotted.split(".");
  for (const dict of [en, hi]) {
    let node: Record<string, unknown> = dict;
    for (let i = 0; i < parts.length - 1; i++) {
      node = node[parts[i]] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    if (typeof node[leaf] === "undefined") {
      throw new Error(`${dotted} expected but missing — nothing to retire`);
    }
    delete node[leaf];
  }
}
/* Drop the now-empty pro section itself. */
if (Object.keys(en.pro ?? {}).length === 0) delete en.pro;
if (Object.keys(hi.pro ?? {}).length === 0) delete hi.pro;

/* ---- whole-catalog parity (recursive leaf count) ---- */
function leaves(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? leaves(v, prefix ? `${prefix}.${k}` : k)
      : [prefix ? `${prefix}.${k}` : k]
  );
}
const enLeaves = leaves(en).sort();
const hiLeaves = leaves(hi).sort();
if (enLeaves.length !== hiLeaves.length) {
  throw new Error(`parity broken after merge: en=${enLeaves.length} hi=${hiLeaves.length}`);
}
for (let i = 0; i < enLeaves.length; i++) {
  if (enLeaves[i] !== hiLeaves[i]) {
    throw new Error(`parity key mismatch: ${enLeaves[i]} vs ${hiLeaves[i]}`);
  }
}

writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(
  `R26 billing i18n merged: +${Object.keys(patch).length} keys, -${retire.length} retired → ${enLeaves.length} = ${hiLeaves.length} leaves OK`
);
