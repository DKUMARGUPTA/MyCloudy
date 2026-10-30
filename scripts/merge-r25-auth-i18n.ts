/**
 * R25 Phase-10 auth-UI merge: the auth.* keys the AuthModal + AccountMenu
 * actually render (used-keys-only — the P12 script's account/bugs/admin
 * groups stay out until their UI ships). Additive-only (refuses
 * clobber/duplicates), verifies en↔hi leaf parity.
 * Run: bun scripts/merge-r25-auth-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch: Record<string, Record<"en" | "hi", string>> = {
  /* ---- auth modal (login/signup) ---- */
  "auth.loginTitle": { en: "Welcome back", hi: "वापसी पर स्वागत है" },
  "auth.loginDesc": {
    en: "Log in to keep your preferences in sync. The tools always stay free.",
    hi: "अपनी प्राथमिकताएँ सिंक रखने के लिए लॉग इन करें। टूल हमेशा मुफ़्त रहेंगे।",
  },
  "auth.signupTitle": { en: "Create your account", hi: "अपना खाता बनाएँ" },
  "auth.signupDesc": {
    en: "An account is optional — your files never leave your device either way.",
    hi: "खाता वैकल्पिक है — आपकी फ़ाइलें किसी भी सूरत में डिवाइस से बाहर नहीं जातीं।",
  },
  "auth.tabLogin": { en: "Log in", hi: "लॉग इन" },
  "auth.tabSignup": { en: "Sign up", hi: "साइन अप" },
  "auth.name": { en: "Name (optional)", hi: "नाम (वैकल्पिक)" },
  "auth.email": { en: "Email", hi: "ईमेल" },
  "auth.password": { en: "Password", hi: "पासवर्ड" },
  "auth.passwordHint": { en: "At least 8 characters.", hi: "कम से कम 8 अक्षर।" },
  "auth.loginCta": { en: "Log in", hi: "लॉग इन करें" },
  "auth.signupCta": { en: "Create account", hi: "खाता बनाएँ" },
  "auth.working": { en: "Please wait…", hi: "कृपया प्रतीक्षा करें…" },
  "auth.toSignup": { en: "New here? Create an account", hi: "नए हैं? खाता बनाएँ" },
  "auth.toLogin": { en: "Already have an account? Log in", hi: "पहले से खाता है? लॉग इन करें" },
  "auth.privacyNote": {
    en: "Optional account — your files always stay on your device. We only store your email and settings.",
    hi: "खाता वैकल्पिक है — आपकी फ़ाइलें हमेशा आपके डिवाइस पर रहती हैं। हम सिर्फ़ आपका ईमेल और सेटिंग्स रखते हैं।",
  },
  "auth.signedOut": { en: "Signed out", hi: "लॉग आउट हो गया" },
  "auth.welcome": { en: "Welcome, {name}!", hi: "स्वागत है, {name}!" },

  /* ---- auth error codes (1:1 with the API contract) ---- */
  "auth.err.bad_request": { en: "Please check the form and try again.", hi: "कृपया फ़ॉर्म जाँचकर दोबारा कोशिश करें।" },
  "auth.err.invalid_credentials": { en: "Wrong email or password.", hi: "ईमेल या पासवर्ड ग़लत है।" },
  "auth.err.email_taken": { en: "An account with this email already exists.", hi: "इस ईमेल से खाता पहले से मौजूद है।" },
  "auth.err.rate_limited": { en: "Too many attempts — please wait a minute.", hi: "बहुत ज़्यादा कोशिशें — कृपया एक मिनट रुकें।" },
  "auth.err.weak_password": { en: "Use at least 8 characters.", hi: "कम से कम 8 अक्षर इस्तेमाल करें।" },
  "auth.err.invalid_email": { en: "Enter a valid email address.", hi: "मान्य ईमेल पता डालें।" },
  "auth.err.banned": { en: "This account has been suspended.", hi: "यह खाता निलंबित कर दिया गया है।" },
  "auth.err.forbidden": { en: "You do not have access to this.", hi: "आपके पास इसकी पहुँच नहीं है।" },
  "auth.err.not_found": { en: "Not found.", hi: "नहीं मिला।" },
  "auth.err.server_error": { en: "Something went wrong. Please retry.", hi: "कुछ ग़लत हो गया। कृपया दोबारा कोशिश करें।" },

  /* ---- account menu (header + mobile sheet) ---- */
  "auth.accountLabel": { en: "Account", hi: "खाता" },
  "auth.openMenuLabel": { en: "Open account menu", hi: "खाता मेन्यू खोलें" },
  "auth.menuPlanFree": { en: "Free plan", hi: "मुफ़्त प्लान" },
  "auth.menuPlanPro": { en: "Pro", hi: "प्रो" },
  "auth.proThanks": { en: "Thanks for backing DocoPDF", hi: "DocoPDF को सहयोग देने के लिए धन्यवाद" },
  "auth.menuAdmin": { en: "Admin", hi: "एडमिन" },
  "auth.menuLogout": { en: "Log out", hi: "लॉग आउट करें" },
};

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
console.log(`R25 auth i18n merged: +${Object.keys(patch).length} keys → ${enLeaves.length} = ${hiLeaves.length} leaves OK`);
