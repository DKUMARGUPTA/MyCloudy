/**
 * P12 Enterprise merge: auth + account + bug-reports + admin-console i18n.
 * Additive-only (refuses clobber/duplicates), verifies en↔hi leaf parity.
 * Run: bun scripts/merge-p12-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const patch: Record<string, Record<"en" | "hi", string>> = {
  /* ---- common additions ---- */
  "common.confirm": { en: "Confirm", hi: "पुष्टि करें" },
  "common.save": { en: "Save", hi: "सहेजें" },
  "common.loading": { en: "Loading…", hi: "लोड हो रहा है…" },
  "common.refresh": { en: "Refresh", hi: "रिफ़्रेश" },
  "common.search": { en: "Search", hi: "खोजें" },
  "common.none": { en: "Nothing here yet", hi: "अभी यहाँ कुछ नहीं है" },
  "common.retry": { en: "Try again", hi: "फिर कोशिश करें" },

  /* ---- auth (login/signup modal + session) ---- */
  "auth.loginTitle": { en: "Welcome back", hi: "वापसी पर स्वागत है" },
  "auth.signupTitle": { en: "Create your account", hi: "अपना खाता बनाएँ" },
  "auth.email": { en: "Email", hi: "ईमेल" },
  "auth.password": { en: "Password", hi: "पासवर्ड" },
  "auth.name": { en: "Name", hi: "नाम" },
  "auth.loginCta": { en: "Log in", hi: "लॉग इन" },
  "auth.signupCta": { en: "Create account", hi: "खाता बनाएँ" },
  "auth.toSignup": { en: "New here? Create an account", hi: "नए हैं? खाता बनाएँ" },
  "auth.toLogin": { en: "Already have an account? Log in", hi: "पहले से खाता है? लॉग इन करें" },
  "auth.privacyNote": {
    en: "Optional account — your files always stay on your device. We only store your email and settings.",
    hi: "खाता वैकल्पिक है — आपकी फ़ाइलें हमेशा आपके डिवाइस पर रहती हैं। हम सिर्फ़ आपका ईमेल और सेटिंग्स रखते हैं।",
  },
  "auth.signedOut": { en: "Signed out", hi: "लॉग आउट हो गया" },
  "auth.welcome": { en: "Welcome, {name}!", hi: "स्वागत है, {name}!" },
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

  /* ---- account view ---- */
  "account.title": { en: "My account", hi: "मेरा खाता" },
  "account.profile": { en: "Profile", hi: "प्रोफ़ाइल" },
  "account.memberSince": { en: "Member since {date}", hi: "सदस्य {date} से" },
  "account.plan": { en: "Plan", hi: "योजना" },
  "account.planFree": { en: "Free", hi: "फ़्री" },
  "account.changePassword": { en: "Change password", hi: "पासवर्ड बदलें" },
  "account.currentPassword": { en: "Current password", hi: "वर्तमान पासवर्ड" },
  "account.newPassword": { en: "New password", hi: "नया पासवर्ड" },
  "account.saved": { en: "Saved", hi: "सहेज लिया" },
  "account.passwordMismatch": { en: "Passwords do not match.", hi: "पासवर्ड मेल नहीं खाते।" },
  "account.logoutAll": { en: "Log out everywhere", hi: "हर जगह से लॉग आउट" },
  "account.logoutAllHint": { en: "Signs you out on all devices.", hi: "सभी डिवाइसों से लॉग आउट कर देता है।" },
  "account.deleteAccount": { en: "Delete account", hi: "खाता हटाएँ" },
  "account.deleteWarning": {
    en: "This permanently removes your account. Your files never leave your device, so nothing of yours is stored with us. This cannot be undone.",
    hi: "इससे आपका खाता हमेशा के लिए हट जाता है। आपकी फ़ाइलें कभी डिवाइस से बाहर नहीं जातीं, इसलिए आपका कुछ भी हमारे पास जमा नहीं है। इसे वापस नहीं किया जा सकता।",
  },
  "account.myFiles": { en: "My files", hi: "मेरी फ़ाइलें" },
  "account.filesPrivacy": {
    en: "Stored only on this device (browser storage) — never uploaded.",
    hi: "सिर्फ़ इसी डिवाइस पर (ब्राउज़र स्टोरेज) — कभी अपलोड नहीं होतीं।",
  },
  "account.filesEmpty": { en: "No recent files on this device", hi: "इस डिवाइस पर कोई हाल की फ़ाइल नहीं" },
  "account.removeFile": { en: "Remove", hi: "हटाएँ" },
  "account.reportBug": { en: "Report a problem", hi: "समस्या बताएँ" },
  "account.bugHint": { en: "Found a bug or have an idea? Tell us.", hi: "कोई बग मिला या सुझाव है? बताइए।" },
  "account.myReports": { en: "My reports", hi: "मेरी रिपोर्ट्स" },
  "account.noReports": { en: "You have not reported anything yet.", hi: "आपने अभी तक कुछ रिपोर्ट नहीं किया।" },
  "account.adminConsole": { en: "Admin console", hi: "एडमिन कंसोल" },
  "account.nav": { en: "Account", hi: "खाता" },
  "account.signInPrompt": {
    en: "Sign in to sync your settings across devices — or keep working without an account.",
    hi: "सेटिंग्स सिंक करने के लिए साइन इन करें — या बिना खाते भी काम जारी रखें।",
  },
  "account.signInCta": { en: "Sign in", hi: "साइन इन" },

  /* ---- bug report form ---- */
  "bugs.title": { en: "Report a problem", hi: "समस्या रिपोर्ट करें" },
  "bugs.category": { en: "Type", hi: "प्रकार" },
  "bugs.category.bug": { en: "Bug", hi: "बग" },
  "bugs.category.feature": { en: "Feature request", hi: "सुविधा का सुझाव" },
  "bugs.category.other": { en: "Other", hi: "अन्य" },
  "bugs.severity": { en: "Severity", hi: "गंभीरता" },
  "bugs.severity.low": { en: "Low", hi: "कम" },
  "bugs.severity.medium": { en: "Medium", hi: "मध्यम" },
  "bugs.severity.high": { en: "High", hi: "ज़्यादा" },
  "bugs.severity.critical": { en: "Critical", hi: "गंभीर" },
  "bugs.subject": { en: "Summary", hi: "सारांश" },
  "bugs.subjectPlaceholder": { en: "What happened?", hi: "क्या हुआ?" },
  "bugs.details": { en: "Details", hi: "विवरण" },
  "bugs.detailsPlaceholder": {
    en: "Steps, expected vs actual result…",
    hi: "कदम, अपेक्षित बनाम असली नतीजा…",
  },
  "bugs.tool": { en: "Tool (optional)", hi: "टूल (वैकल्पिक)" },
  "bugs.tool.none": { en: "Not tool-specific", hi: "कोई खास टूल नहीं" },
  "bugs.emailOptional": { en: "Email (optional)", hi: "ईमेल (वैकल्पिक)" },
  "bugs.submit": { en: "Send report", hi: "रिपोर्ट भेजें" },
  "bugs.submitted": { en: "Thank you — report received.", hi: "धन्यवाद — रिपोर्ट मिल गई।" },
  "bugs.error": { en: "Could not send — please retry.", hi: "भेजा नहीं जा सका — दोबारा कोशिश करें।" },

  /* ---- admin console ---- */
  "admin.title": { en: "Admin console", hi: "एडमिन कंसोल" },
  "admin.backToSite": { en: "Back to site", hi: "साइट पर वापस" },
  "admin.notAdmin": { en: "Admins only", hi: "सिर्फ़ एडमिन के लिए" },
  "admin.notAdminHint": {
    en: "Sign in with an admin account to open the console.",
    hi: "कंसोल खोलने के लिए एडमिन खाते से साइन इन करें।",
  },
  "admin.nav.dashboard": { en: "Dashboard", hi: "डैशबोर्ड" },
  "admin.nav.tools": { en: "Tools", hi: "टूल्स" },
  "admin.nav.users": { en: "Users", hi: "उपयोगकर्ता" },
  "admin.nav.bugs": { en: "Bug reports", hi: "बग रिपोर्ट्स" },
  "admin.nav.messages": { en: "Messages", hi: "संदेश" },
  "admin.nav.feedback": { en: "Feedback", hi: "फ़ीडबैक" },
  "admin.nav.announcements": { en: "Announcements", hi: "घोषणाएँ" },
  "admin.nav.audit": { en: "Audit log", hi: "ऑडिट लॉग" },
  "admin.nav.settings": { en: "Settings", hi: "सेटिंग्स" },
  "admin.dash.title": { en: "Overview", hi: "एक नज़र में" },
  "admin.dash.users": { en: "Users", hi: "उपयोगकर्ता" },
  "admin.dash.bugsNew": { en: "New bugs", hi: "नए बग" },
  "admin.dash.bugsOpen": { en: "Open bugs", hi: "खुले बग" },
  "admin.dash.messagesNew": { en: "New messages", hi: "नए संदेश" },
  "admin.dash.feedback": { en: "Feedback", hi: "फ़ीडबैक" },
  "admin.dash.usageToday": { en: "Tool runs today", hi: "आज के टूल रन" },
  "admin.dash.topTools": { en: "Top tools (7 days)", hi: "टॉप टूल्स (7 दिन)" },
  "admin.dash.recentSignups": { en: "Recent signups", hi: "हाल के साइन-अप" },
  "admin.dash.updated": { en: "Updated just now", hi: "अभी अपडेट हुआ" },
  "admin.tools.hint": { en: "Turn any tool off for maintenance — it shows a friendly note instead of the workspace.", hi: "किसी भी टूल को रखरखाव के लिए बंद करें — वर्कस्पेस की जगह एक सूचना दिखेगी।" },
  "admin.tools.search": { en: "Search tools…", hi: "टूल खोजें…" },
  "admin.tools.enabled": { en: "On", hi: "चालू" },
  "admin.tools.disabled": { en: "Off", hi: "बंद" },
  "admin.tools.note": { en: "Maintenance note (optional)", hi: "रखरखाव सूचना (वैकल्पिक)" },
  "admin.tools.saved": { en: "Tool status saved", hi: "टूल स्थिति सहेजी गई" },
  "admin.users.search": { en: "Search by email or name…", hi: "ईमेल या नाम से खोजें…" },
  "admin.users.role": { en: "Role", hi: "भूमिका" },
  "admin.users.plan": { en: "Plan", hi: "योजना" },
  "admin.users.joined": { en: "Joined", hi: "जुड़े" },
  "admin.users.status": { en: "Status", hi: "स्थिति" },
  "admin.users.banned": { en: "Suspended", hi: "निलंबित" },
  "admin.users.active": { en: "Active", hi: "सक्रिय" },
  "admin.users.ban": { en: "Suspend", hi: "निलंबित करें" },
  "admin.users.unban": { en: "Restore", hi: "बहाल करें" },
  "admin.users.makeAdmin": { en: "Make admin", hi: "एडमिन बनाएँ" },
  "admin.users.removeAdmin": { en: "Remove admin", hi: "एडमिन हटाएँ" },
  "admin.users.delete": { en: "Delete", hi: "हटाएँ" },
  "admin.users.deleteConfirm": { en: "Delete this account? This cannot be undone.", hi: "यह खाता हटाएँ? इसे वापस नहीं किया जा सकता।" },
  "admin.bugs.status.new": { en: "New", hi: "नया" },
  "admin.bugs.status.confirmed": { en: "Confirmed", hi: "पुष्ट" },
  "admin.bugs.status.in_progress": { en: "In progress", hi: "काम चालू" },
  "admin.bugs.status.fixed": { en: "Fixed", hi: "ठीक हुआ" },
  "admin.bugs.status.wontfix": { en: "Won't fix", hi: "ठीक नहीं होगा" },
  "admin.bugs.note": { en: "Admin note", hi: "एडमिन नोट" },
  "admin.bugs.reporter": { en: "Reporter", hi: "रिपोर्टर" },
  "admin.bugs.updated": { en: "Report updated", hi: "रिपोर्ट अपडेट हुई" },
  "admin.msg.markRead": { en: "Mark read", hi: "पढ़ा हुआ करें" },
  "admin.msg.markDone": { en: "Mark done", hi: "निपटाया हुआ करें" },
  "admin.msg.status.new": { en: "New", hi: "नया" },
  "admin.msg.status.read": { en: "Read", hi: "पढ़ा गया" },
  "admin.msg.status.done": { en: "Done", hi: "निपटाया" },
  "admin.fb.up": { en: "👍 up", hi: "👍 पसंद" },
  "admin.fb.down": { en: "👎 down", hi: "👎 नापसंद" },
  "admin.ann.textEn": { en: "Text (English)", hi: "पाठ (अंग्रेज़ी)" },
  "admin.ann.textHi": { en: "Text (Hindi)", hi: "पाठ (हिंदी)" },
  "admin.ann.variant": { en: "Style", hi: "शैली" },
  "admin.ann.variant.info": { en: "Info", hi: "सूचना" },
  "admin.ann.variant.success": { en: "Success", hi: "सफलता" },
  "admin.ann.variant.warning": { en: "Warning", hi: "चेतावनी" },
  "admin.ann.until": { en: "Show until (optional)", hi: "इस तक दिखाएँ (वैकल्पिक)" },
  "admin.ann.add": { en: "Publish", hi: "प्रकाशित करें" },
  "admin.ann.remove": { en: "Remove", hi: "हटाएँ" },
  "admin.ann.saved": { en: "Announcement saved", hi: "घोषणा सहेजी गई" },
  "admin.set.registration": { en: "Allow new signups", hi: "नए साइन-अप की अनुमति दें" },
  "admin.set.registrationHint": { en: "Turn off to freeze new account creation.", hi: "बंद करने पर नए खाते नहीं बनेंगे।" },
  "admin.set.saved": { en: "Settings saved", hi: "सेटिंग्स सहेजी गईं" },
  "admin.audit.actor": { en: "Actor", hi: "कर्ता" },
  "admin.audit.action": { en: "Action", hi: "क्रिया" },
  "admin.audit.time": { en: "Time", hi: "समय" },
};

/* ---- key-by-key additive merge with clobber refusal ---- */
for (const [dotted, values] of Object.entries(patch)) {
  const parts = dotted.split(".");
  // Support 2-level (common.save) and 3-level (auth.err.bad_request) keys;
  // missing sections (auth/account/bugs/admin) are created fresh.
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
console.log(`P12 i18n merged: +${Object.keys(patch).length} keys → ${enLeaves.length} = ${hiLeaves.length} leaves OK`);
