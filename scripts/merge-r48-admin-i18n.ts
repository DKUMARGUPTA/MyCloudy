/**
 * R48 merge: adds the `admin.*` catalog for the recovered owner console
 * (overview / users / bugs / messages / feedback / analytics / audit /
 * settings tabs + gates + toasts) to both locales. Additive-only and
 * idempotent; whole-catalog parity must hold before writing.
 * Run: bun scripts/merge-r48-admin-i18n.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8"));
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8"));

const adminEn = {
  badge: "Owner console",
  title: "Admin Dashboard",
  lede:
    "Bug triage, the contact inbox, feedback, usage analytics and site settings — every owner surface in one place.",
  identityNote:
    "Signed in as the single admin of this site. The APIs re-check the role on every call.",
  ownerBadge: "Owner",
  ownerAccessChip: "Full access",
  signInTitle: "Sign in required",
  signInDesc:
    "The admin console is private. Sign in with the owner account to continue.",
  forbiddenTitle: "Admins only",
  forbiddenDesc:
    "This console belongs to the site owner. If you believe you should have access, contact the owner.",
  loadFailed: "Could not load the dashboard data. Please try again.",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  lastUpdated: "Last updated {time}",
  tab: {
    overview: "Overview",
    users: "Users",
    bugs: "Bugs",
    messages: "Messages",
    feedback: "Feedback",
    analytics: "Analytics",
    audit: "Audit log",
    settings: "Settings",
  },
  overview: {
    users: "Users",
    usageToday: "Tool runs today",
    bugsNew: "New bugs",
    bugsOpen: "Open bugs",
    messagesNew: "New messages",
    feedbackCount: "Feedback",
    topToolsTitle: "Top tools",
    topToolsDesc: "Most-run tools recently.",
    topToolsEmpty: "No tool runs yet.",
    recentTitle: "Recent signups",
    recentDesc: "The newest accounts.",
    recentEmpty: "No signups yet.",
    quickTitle: "Quick links",
    quickDesc: "Jump straight to the busy tabs.",
    quickUsers: "Users",
    quickUsersDesc: "Search, promote or ban accounts.",
    quickSettings: "Settings",
    quickSettingsDesc: "Registration and announcements.",
  },
  users: {
    searchPlaceholder: "Search by email or name…",
    searchCount: "{count} of {total} users",
    colName: "User",
    colPlan: "Plan",
    colRole: "Role",
    colStatus: "Status",
    colJoined: "Joined",
    colActions: "Actions",
    planFree: "Free",
    planPro: "Pro",
    roleAdmin: "Admin",
    roleUser: "User",
    statusActive: "Active",
    statusBanned: "Banned",
    you: "You",
    ban: "Ban",
    unban: "Unban",
    delete: "Delete",
    makeAdmin: "Make admin",
    makeUser: "Make user",
    confirmBanTitle: "Ban this user?",
    confirmBanDesc:
      "They stay in the database but cannot sign in until unbanned.",
    confirmBan: "Ban user",
    confirmDeleteTitle: "Delete this account?",
    confirmDeleteDesc:
      "This permanently removes the account and signs them out everywhere. This cannot be undone.",
    confirmDelete: "Delete forever",
    empty: "No users match your search.",
    page: "Page {page} of {pages}",
    prev: "Previous",
    next: "Next",
  },
  bugs: {
    filterAll: "All",
    open: "Open",
    reporter: "Reporter",
    tool: "Tool",
    browser: "Browser",
    severityLabel: "Severity",
    statusLabel: "Status",
    adminNoteLabel: "Admin note",
    adminNotePlaceholder: "Visible only to you…",
    save: "Save",
    saving: "Saving…",
    empty: "No bug reports.",
  },
  messages: {
    empty: "The contact inbox is empty.",
    markRead: "Mark read",
    markNew: "Mark new",
    markDone: "Mark done",
  },
  feedback: {
    up: "Works",
    down: "Broke",
    note: "Note",
    empty: "No feedback yet.",
  },
  analytics: {
    viewsToday: "Views today",
    visitorsToday: "Visitors today",
    views7d: "Views · 7 days",
    visitors7d: "Visitors · 7 days",
    trendTitle: "Last 30 days",
    trendDesc: "Daily views and unique visitors.",
    trendAria: "Daily traffic chart for the last 30 days",
    deviceTitle: "Devices",
    deviceDesc: "Coarse device classes.",
    refTitle: "Referrers",
    refDesc: "Where visits come from.",
    topPagesTitle: "Top pages",
    topPagesDesc: "Most-viewed routes.",
    localeTitle: "Languages",
    toolsTitle: "Tool runs · 30 days",
    toolsDesc: "Runs and success rate per tool.",
    toolRuns30d: "tool runs · 30 d",
    successRate30d: "avg success · 30 d",
    legendViews: "Views",
    legendVisitors: "Visitors",
    privacyNote:
      "Privacy-first analytics: anonymous ids, coarse devices, bucketed referrers — no cookies, no cross-site tracking.",
    shareNote:
      "Share of views",
    empty: "No traffic recorded yet.",
  },
  audit: {
    actor: "Actor",
    action: "Action",
    when: "When",
    meta: "Details",
    empty: "No audit entries yet.",
  },
  settings: {
    registrationTitle: "Signups",
    registrationDesc:
      "When closed, only existing accounts can sign in — the signup form refuses new emails.",
    enabled: "Open",
    disabled: "Closed",
    on: "On",
    off: "Off",
    overridesTitle: "Plan overrides",
    overridesDesc: "Manual Pro grants without payment.",
    overridesSearch: "Search email…",
    overridesEmpty: "No overrides.",
    overridesCount: "{count} active",
    annTitle: "Announcement banner",
    annDesc: "A dismissible site-wide notice.",
    annTextEn: "Text (English)",
    annTextHi: "Text (Hindi)",
    annVariant: "Style",
    annUntil: "Show until",
    annAdd: "Add announcement",
    annRemove: "Remove",
    annEmpty: "No announcement set.",
    save: "Save changes",
    saving: "Saving…",
  },
  toast: {
    saved: "Saved.",
    failed: "That didn't work — please retry.",
    banned: "User banned.",
    unbanned: "User unbanned.",
    deleted: "User deleted.",
    roleChanged: "Role updated.",
    bugSaved: "Bug report updated.",
    messageSaved: "Message updated.",
  },
};

const adminHi = {
  badge: "ओनर कंसोल",
  title: "एडमिन डैशबोर्ड",
  lede:
    "बग ट्राइज, संपर्क इनबॉक्स, फ़ीडबैक, उपयोग एनालिटिक्स और साइट सेटिंग्स — हर ओनर सतह एक जगह।",
  identityNote:
    "इस साइट के एकमात्र एडमिन के रूप में साइन-इन हैं। हर कॉल पर API भूमिका दोबारा जाँचती है।",
  ownerBadge: "ओनर",
  ownerAccessChip: "पूरी एक्सेस",
  signInTitle: "साइन-इन ज़रूरी है",
  signInDesc:
    "एडमिन कंसोल निजी है। जारी रखने के लिए ओनर खाते से साइन-इन करें।",
  forbiddenTitle: "सिर्फ़ एडमिन के लिए",
  forbiddenDesc:
    "यह कंसोल साइट ओनर का है। अगर आपको एक्सेस चाहिए तो ओनर से संपर्क करें।",
  loadFailed: "डैशबोर्ड डेटा लोड नहीं हो सका। दोबारा कोशिश करें।",
  refresh: "रिफ़्रेश",
  refreshing: "रिफ़्रेश हो रहा है…",
  lastUpdated: "आख़िरी अपडेट {time}",
  tab: {
    overview: "ओवरव्यू",
    users: "उपयोगकर्ता",
    bugs: "बग",
    messages: "संदेश",
    feedback: "फ़ीडबैक",
    analytics: "एनालिटिक्स",
    audit: "ऑडिट लॉग",
    settings: "सेटिंग्स",
  },
  overview: {
    users: "उपयोगकर्ता",
    usageToday: "आज के टूल रन",
    bugsNew: "नए बग",
    bugsOpen: "खुले बग",
    messagesNew: "नए संदेश",
    feedbackCount: "फ़ीडबैक",
    topToolsTitle: "टॉप टूल",
    topToolsDesc: "हाल में सबसे ज़्यादा चले टूल।",
    topToolsEmpty: "अभी कोई टूल रन नहीं।",
    recentTitle: "हाल के साइनअप",
    recentDesc: "नए खाते।",
    recentEmpty: "अभी कोई साइनअप नहीं।",
    quickTitle: "क्विक लिंक",
    quickDesc: "व्यस्त टैब पर सीधे जाएँ।",
    quickUsers: "उपयोगकर्ता",
    quickUsersDesc: "खाते खोजें, प्रमोट करें या बैन करें।",
    quickSettings: "सेटिंग्स",
    quickSettingsDesc: "रजिस्ट्रेशन और घोषणाएँ।",
  },
  users: {
    searchPlaceholder: "ईमेल या नाम से खोजें…",
    searchCount: "{total} में से {count} उपयोगकर्ता",
    colName: "उपयोगकर्ता",
    colPlan: "प्लान",
    colRole: "भूमिका",
    colStatus: "स्थिति",
    colJoined: "जॉइन किया",
    colActions: "कार्रवाइयाँ",
    planFree: "फ़्री",
    planPro: "प्रो",
    roleAdmin: "एडमिन",
    roleUser: "उपयोगकर्ता",
    statusActive: "सक्रिय",
    statusBanned: "बैन",
    you: "आप",
    ban: "बैन करें",
    unban: "अनबैन",
    delete: "मिटाएँ",
    makeAdmin: "एडमिन बनाएँ",
    makeUser: "उपयोगकर्ता बनाएँ",
    confirmBanTitle: "इस उपयोगकर्ता को बैन करें?",
    confirmBanDesc:
      "वे डेटाबेस में रहते हैं, पर अनबैन होने तक साइन-इन नहीं कर सकते।",
    confirmBan: "बैन करें",
    confirmDeleteTitle: "यह खाता मिटाएँ?",
    confirmDeleteDesc:
      "खाता हमेशा के लिए हट जाएगा और हर जगह से साइन-आउट हो जाएगा। इसे वापस नहीं किया जा सकता।",
    confirmDelete: "हमेशा के लिए मिटाएँ",
    empty: "खोज से कोई उपयोगकर्ता नहीं मिला।",
    page: "पेज {page} / {pages}",
    prev: "पिछला",
    next: "अगला",
  },
  bugs: {
    filterAll: "सभी",
    open: "खुले",
    reporter: "रिपोर्टर",
    tool: "टूल",
    browser: "ब्राउज़र",
    severityLabel: "गंभीरता",
    statusLabel: "स्थिति",
    adminNoteLabel: "एडमिन नोट",
    adminNotePlaceholder: "सिर्फ़ आपको दिखेगा…",
    save: "सेव",
    saving: "सेव हो रहा है…",
    empty: "कोई बग रिपोर्ट नहीं।",
  },
  messages: {
    empty: "संपर्क इनबॉक्स खाली है।",
    markRead: "पढ़ा हुआ करें",
    markNew: "नया करें",
    markDone: "पूर्ण करें",
  },
  feedback: {
    up: "चला",
    down: "टूटा",
    note: "नोट",
    empty: "अभी कोई फ़ीडबैक नहीं।",
  },
  analytics: {
    viewsToday: "आज के व्यू",
    visitorsToday: "आज के विज़िटर",
    views7d: "व्यू · 7 दिन",
    visitors7d: "विज़िटर · 7 दिन",
    trendTitle: "पिछले 30 दिन",
    trendDesc: "रोज़ के व्यू और अनन्य विज़िटर।",
    trendAria: "पिछले 30 दिन का रोज़ाना ट्रैफ़िक चार्ट",
    deviceTitle: "डिवाइस",
    deviceDesc: "मोटे डिवाइस वर्ग।",
    refTitle: "रेफ़रर",
    refDesc: "विज़िट कहाँ से आते हैं।",
    topPagesTitle: "टॉप पेज",
    topPagesDesc: "सबसे ज़्यादा देखे गए रूट।",
    localeTitle: "भाषाएँ",
    toolsTitle: "टूल रन · 30 दिन",
    toolsDesc: "प्रति टूल रन और सफलता दर।",
    toolRuns30d: "टूल रन · 30 दिन",
    successRate30d: "औसत सफलता · 30 दिन",
    legendViews: "व्यू",
    legendVisitors: "विज़िटर",
    privacyNote:
      "गोपनीयता-पहले एनालिटिक्स: गुमनाम आईडी, मोटे डिवाइस, बकेटेड रेफ़रर — कोई कुकी नहीं, कोई क्रॉस-साइट ट्रैकिंग नहीं।",
    shareNote: "व्यू का हिस्सा",
    empty: "अभी कोई ट्रैफ़िक दर्ज नहीं।",
  },
  audit: {
    actor: "कर्ता",
    action: "कार्रवाई",
    when: "कब",
    meta: "विवरण",
    empty: "अभी कोई ऑडिट एंट्री नहीं।",
  },
  settings: {
    registrationTitle: "साइनअप",
    registrationDesc:
      "बंद होने पर सिर्फ़ मौजूदा खाते साइन-इन कर सकते हैं — साइनअप फ़ॉर्म नए ईमेल ठुकरा देता है।",
    enabled: "खुले",
    disabled: "बंद",
    on: "चालू",
    off: "बंद",
    overridesTitle: "प्लान ओवरराइड",
    overridesDesc: "भुगतान के बिना मैनुअल प्रो अनुदान।",
    overridesSearch: "ईमेल खोजें…",
    overridesEmpty: "कोई ओवरराइड नहीं।",
    overridesCount: "{count} सक्रिय",
    annTitle: "घोषणा बैनर",
    annDesc: "एक बंद करने लायक पूरी साइट की सूचना।",
    annTextEn: "टेक्स्ट (अंग्रेज़ी)",
    annTextHi: "टेक्स्ट (हिंदी)",
    annVariant: "शैली",
    annUntil: "इस तक दिखाएँ",
    annAdd: "घोषणा जोड़ें",
    annRemove: "हटाएँ",
    annEmpty: "कोई घोषणा सेट नहीं।",
    save: "बदलाव सेव करें",
    saving: "सेव हो रहा है…",
  },
  toast: {
    saved: "सेव हो गया।",
    failed: "काम नहीं हुआ — दोबारा कोशिश करें।",
    banned: "उपयोगकर्ता बैन हुआ।",
    unbanned: "उपयोगकर्ता अनबैन हुआ।",
    deleted: "उपयोगकर्ता मिटाया गया।",
    roleChanged: "भूमिका अपडेट हुई।",
    bugSaved: "बग रिपोर्ट अपडेट हुई।",
    messageSaved: "संदेश अपडेट हुआ।",
  },
};

const leafKeys = (obj: Record<string, unknown>, prefix = ""): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      out.push(...leafKeys(v as Record<string, unknown>, key));
    } else {
      out.push(key);
    }
  }
  return out.sort();
};

console.log(`before: en=${leafKeys(en).length} hi=${leafKeys(hi).length}`);

const added: string[] = [];
for (const [key, value] of Object.entries(adminEn)) {
  if (en.admin?.[key] !== undefined) {
    console.log(`= admin.${key} already present (skipped)`);
    continue;
  }
  if (!en.admin) en.admin = {};
  if (!hi.admin) hi.admin = {};
  en.admin[key] = value;
  hi.admin[key] = adminHi[key as keyof typeof adminHi];
  added.push(`admin.${key}`);
}
console.log(`+ ${added.length} top-level admin groups (en+hi)`);

const afterEn = leafKeys(en);
const afterHi = leafKeys(hi);
if (JSON.stringify(afterEn) !== JSON.stringify(afterHi)) {
  console.error("✗ whole-catalog parity broken");
  process.exit(1);
}
const adminCount = afterEn.filter((k) => k.startsWith("admin.")).length;
console.log(`admin.* keys: ${adminCount} (en+hi)`);
writeFileSync(`${root}src/i18n/en.json`, JSON.stringify(en, null, 2) + "\n");
writeFileSync(`${root}src/i18n/hi.json`, JSON.stringify(hi, null, 2) + "\n");
console.log(`after: en=${afterEn.length} hi=${afterHi.length} — parity OK`);
