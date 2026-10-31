/**
 * R26 billing smoke — locks the Phase-10 account/billing contract:
 *
 *  A. i18n: every account.* / pricing.* / billing.err.* key the surfaces
 *     render exists in BOTH en + hi with real copy (Devanagari check on hi);
 *     tabs.account exists; the retired pro.* placeholder group is GONE.
 *  B. Error-code parity: every BillingErrorCode has billing.err.<code> in
 *     both locales (new server code without copy fails here).
 *  C. Wiring: app-shell renders AccountPage + PricingModal; account-menu
 *     links /account; bottom tab bar carries the account tab; use-hash-route
 *     parses "/account"; SSR routes exist (EN + hi catch-all) with noindex;
 *     confirm route is demo-guarded BEFORE the auth gate.
 *  D. LIVE API journey (http://localhost:3000, own QA account):
 *     unauth 401s → signup → checkout zod/bad-plan gates → demo checkout →
 *     confirm (bogus id 404) → real confirm (plan=pro, cookie refreshed) →
 *     status (active sub + paid payment history) → cancel (plan=free) →
 *     password change (wrong current 401 → real change 200 → new pw logs
 *     in) → delete account (soft delete + login refused).
 *
 * Run: bun scripts/smoke-billing.ts   (dev server must be up on :3000)
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    fail += 1;
    console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const root = new URL("..", import.meta.url).pathname;
const en = JSON.parse(readFileSync(`${root}src/i18n/en.json`, "utf8")) as Record<string, unknown>;
const hi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8")) as Record<string, unknown>;

type Dict = { [k: string]: string | Dict };

/* ------------------------------------------------------------------ */
console.log("A. i18n presence + real copy");

const accountKeys = [
  "loading", "badge", "title", "lede", "signInTitle", "signInDesc",
  "memberSince", "sectionProfile", "sectionPlan", "planFreeDesc", "planProDesc",
  "planPeriodEnd", "upgradeCta", "manageCancel", "cancelConfirmTitle",
  "cancelConfirmBody", "cancelKeepTools", "cancelConfirmCta", "cancelledToast",
  "sectionHistory", "historyEmpty", "statusPaid", "statusPending", "statusFailed",
  "statusRefunded", "sectionSecurity", "pwHint", "pwCurrent", "pwNew", "pwConfirm",
  "pwMismatch", "pwCta", "pwUpdated", "sectionDanger", "delDesc", "delCta",
  "delConfirmTitle", "delConfirmBody", "delConfirmCta", "deletedToast",
];
const enAccount = en.account as Dict;
const hiAccount = hi.account as Dict;
for (const key of accountKeys) {
  check(
    `account.${key} in en+hi`,
    typeof enAccount[key] === "string" && typeof hiAccount[key] === "string"
  );
}
check(
  "account.memberSince carries {date} in both",
  (enAccount.memberSince as string)?.includes("{date}") &&
    (hiAccount.memberSince as string)?.includes("{date}")
);
check(
  "hi account copy is real Devanagari",
  /[\u0900-\u097F]/.test(hiAccount.title as string)
);

const pricingKeys = [
  "title", "desc", "cycleLabel", "monthly", "yearly", "save", "freeName",
  "currentPlan", "proIncludesFree", "forever", "freeF1", "freeF2", "freeF3",
  "freeF4", "freeF5", "proName", "perMonth", "perYear", "proF1", "proF2",
  "proF3", "proF4", "proF5", "proActive", "upgradeCta", "signUpCta",
  "guestHint", "notConfiguredTitle", "notConfiguredBody", "weekTitle",
  "weekDesc", "weekOnce", "weekCta", "gstNote", "promise", "upgradedToast",
];
const enPricing = en.pricing as Dict;
const hiPricing = hi.pricing as Dict;
for (const key of pricingKeys) {
  check(
    `pricing.${key} in en+hi`,
    typeof enPricing[key] === "string" && typeof hiPricing[key] === "string"
  );
}
check(
  "hi pricing copy is real Devanagari",
  /[\u0900-\u097F]/.test(hiPricing.title as string)
);

check(
  "auth.menuSettings in en+hi",
  typeof (en.auth as Dict).menuSettings === "string" &&
    typeof (hi.auth as Dict).menuSettings === "string"
);
check(
  "tabs.account in en+hi",
  typeof (en.tabs as Dict).account === "string" &&
    typeof (hi.tabs as Dict).account === "string"
);
check(
  "placeholder pro.* group retired from both locales",
  en.pro === undefined && hi.pro === undefined
);

/* ------------------------------------------------------------------ */
console.log("B. BillingErrorCode ↔ billing.err parity");

const authClient = readFileSync(`${root}src/lib/auth-client.ts`, "utf8");
const codeMatch = authClient.match(/export type BillingErrorCode =\s*\n([^;]+);/);
const codes = codeMatch
  ? codeMatch[1]
      .split("|")
      .map((c) => c.trim().replace(/^"|"$/g, ""))
      .filter((c) => c.length > 0)
  : [];
check("BillingErrorCode union parsed", codes.length >= 6, codes.join(","));
const enBillErr = (en.billing as Dict).err as Dict;
const hiBillErr = (hi.billing as Dict).err as Dict;
for (const code of codes) {
  check(
    `billing.err.${code} mapped in en`,
    typeof enBillErr[code] === "string" && (enBillErr[code] as string).length > 0
  );
  check(
    `billing.err.${code} mapped in hi`,
    typeof hiBillErr[code] === "string" && (hiBillErr[code] as string).length > 0
  );
}

const toolI18n = readFileSync(`${root}src/i18n/en.json`, "utf8");
const toolEn = JSON.parse(toolI18n) as Record<string, Dict>;
const toolHi = JSON.parse(readFileSync(`${root}src/i18n/hi.json`, "utf8")) as Record<string, Dict>;
for (const key of [
  "limitNearTitle", "limitNearDesc", "limitAtTitle", "limitAtDesc",
  "limitBlockedTitle", "limitBlockedDesc",
]) {
  check(
    `tool.${key} in en+hi`,
    typeof (toolEn.tool as Dict)[key] === "string" &&
      typeof (toolHi.tool as Dict)[key] === "string"
  );
}
check(
  "tool.limitNearTitle carries {used}+{max} in both",
  ((toolEn.tool as Dict).limitNearTitle as string)?.includes("{used}") &&
    ((toolEn.tool as Dict).limitNearTitle as string)?.includes("{max}") &&
    ((toolHi.tool as Dict).limitNearTitle as string)?.includes("{used}") &&
    ((toolHi.tool as Dict).limitNearTitle as string)?.includes("{max}")
);

/* ------------------------------------------------------------------ */
console.log("B2. R28 price catalog (decided 16-BILLING-RESEARCH §2)");

const plansSrc = readFileSync(`${root}src/lib/billing/plans.ts`, "utf8");
check(
  "pro_yearly INR is ₹1,499 (149900 paise)",
  plansSrc.includes("priceInr: 1499") && plansSrc.includes("amountInrMinor: 149900")
);
check(
  "pro_monthly USD is $1.99",
  plansSrc.includes("priceUsd: 1.99") && plansSrc.includes("amountUsdMinor: 199,")
);
check(
  "pro_yearly USD is $22.99",
  plansSrc.includes("priceUsd: 22.99") && plansSrc.includes("amountUsdMinor: 2299")
);
check(
  "pro_week SKU exists (₹49 / $0.99 / 7 days)",
  plansSrc.includes('"pro_week"') && plansSrc.includes("priceInr: 49") &&
    plansSrc.includes("periodDays: 7")
);
check(
  "limits constants + billingLimitsActive() shipped",
  plansSrc.includes("FREE_DAILY_TASKS = 25") &&
    plansSrc.includes("PRO_DAILY_TASKS = 1000") &&
    plansSrc.includes("billingLimitsActive")
);

const postSrc = readFileSync(`${root}src/lib/accounting/post.ts`, "utf8");
check(
  "accounting recognizes pro_week immediately (monthly treatment)",
  postSrc.includes('plan === "pro_monthly" || plan === "pro_week"')
);
const limitsRoute = readFileSync(`${root}src/app/api/limits/route.ts`, "utf8");
check(
  "/api/limits route exists with shadow-mode hard flag",
  limitsRoute.includes("billingLimitsActive") && limitsRoute.includes("demoHard")
);
const usageRoute = readFileSync(`${root}src/app/api/usage/route.ts`, "utf8");
check(
  "/api/usage counts quota on success only",
  usageRoute.includes("if (success)")
);
const toolShellSrc = readFileSync(`${root}src/components/doco/tool/tool-shell.tsx`, "utf8");
check(
  "tool-shell wires beacon + hard gate + nudge",
  toolShellSrc.includes("sendUsageBeacon") &&
    toolShellSrc.includes("runBlockedByLimits") &&
    toolShellSrc.includes("maybeNudge")
);
const pricingModalSrc = readFileSync(`${root}src/components/doco/billing/pricing-modal.tsx`, "utf8");
check(
  "pricing modal carries the week pass + GST note",
  pricingModalSrc.includes('handleUpgrade("pro_week")') &&
    pricingModalSrc.includes("gstNote") && pricingModalSrc.includes("weekTitle")
);

/* ------------------------------------------------------------------ */
console.log("C. Source wiring");

const appShell = readFileSync(`${root}src/components/doco/app-shell.tsx`, "utf8");
check(
  "app-shell renders AccountPage for the account view",
  appShell.includes('route.view === "account"') &&
    appShell.includes("<AccountPage onGetPro={openPro} />")
);
check(
  "app-shell renders PricingModal (old placeholder modal gone)",
  appShell.includes("<PricingModal open={proOpen} onOpenChange={setProOpen} />") &&
    !appShell.includes('t("pro.title")')
);

const accountMenu = readFileSync(`${root}src/components/doco/auth/account-menu.tsx`, "utf8");
check(
  "account-menu has the settings item → /account",
  accountMenu.includes("ROUTES.account") && accountMenu.includes("auth.menuSettings")
);

const tabBar = readFileSync(`${root}src/components/doco/bottom-tab-bar.tsx`, "utf8");
check(
  "bottom tab bar carries the account tab (guest → login modal)",
  tabBar.includes("tabs.account") && tabBar.includes("openAuthModal")
);

const router = readFileSync(`${root}src/hooks/use-hash-route.ts`, "utf8");
check(
  "router parses /account + ROUTES.account",
  router.includes('path === "/account"') && router.includes('account: "/account"')
);

const ssrAccount = readFileSync(`${root}src/app/account/page.tsx`, "utf8");
check(
  "SSR /account exists and is noindex",
  ssrAccount.includes("noindex") || ssrAccount.includes("index: false")
);
const hiCatchAll = readFileSync(`${root}src/app/hi/[[...path]]/page.tsx`, "utf8");
check(
  "hi catch-all resolves account (noindex, Hindi metadata)",
  hiCatchAll.includes('"account"') && hiCatchAll.includes("index: false")
);

const confirmRoute = readFileSync(`${root}src/app/api/billing/confirm/route.ts`, "utf8");
check(
  "confirm route demo-guards BEFORE the auth gate",
  confirmRoute.indexOf("billingDemoMode()") !== -1 &&
    confirmRoute.indexOf("billingDemoMode()") < confirmRoute.indexOf("gateUser(")
);

const checkoutRoute = readFileSync(`${root}src/app/api/billing/checkout/route.ts`, "utf8");
check(
  "checkout route: rate limit + zod + honest 503 branch",
  checkoutRoute.includes("rateLimit") &&
    checkoutRoute.includes("billingNotConfigured") &&
    checkoutRoute.includes("isProPlanId")
);

const sitemapRoute = readFileSync(`${root}src/app/sitemap.xml/route.ts`, "utf8");
check(
  "sitemap does NOT list /account (private page)",
  !sitemapRoute.includes('"/account"')
);

const toolShell = readFileSync(`${root}src/components/doco/tool/tool-shell.tsx`, "utf8");
check(
  "tool-shell help dialog uses common.gotIt (pro.action retired)",
  toolShell.includes('t("common.gotIt")') && !toolShell.includes('t("pro.action")')
);

/* ------------------------------------------------------------------ */
console.log("D. LIVE API journey (localhost:3000)");

const BASE = "http://localhost:3000";
const stamp = Date.now().toString(36);
const email = `billing-qa-${stamp}@docopdf.test`;
const password = "test-password-123";

/* Distinct client IP per run — the rate limiter is proxy-aware
 * (x-forwarded-for), so every QA run gets fresh buckets and leftover
 * state from a previous run can never flake the journey. */
const qaIp = `10.42.${1 + (Date.now() % 250)}.${1 + (Math.random() * 250 | 0)}`;

async function post(url: string, body?: unknown, cookie?: string) {
  const res = await fetch(BASE + url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": qaIp,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data, cookie: setCookie.split(";")[0] || cookie || "" };
}
async function get(url: string, cookie?: string) {
  const res = await fetch(BASE + url, {
    headers: { "x-forwarded-for": qaIp, ...(cookie ? { cookie } : {}) },
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

async function journey(): Promise<void> {
  /* Unauthenticated gates. */
  let r = await post("/api/billing/checkout", { plan: "pro_monthly" });
  check("checkout unauth → 401 forbidden", r.status === 401 && r.data.error === "forbidden");
  r = await post("/api/billing/confirm", { subscriptionId: "x" });
  check("confirm unauth → 401 forbidden", r.status === 401 && r.data.error === "forbidden");
  r = await post("/api/billing/cancel");
  check("cancel unauth → 401 forbidden", r.status === 401 && r.data.error === "forbidden");
  r = await get("/api/billing/status");
  check("status unauth → 401 forbidden", r.status === 401 && r.data.error === "forbidden");

  /* Signup. */
  r = await post("/api/auth/signup", { name: "Billing QA", email, password });
  check("signup → 201 ok", r.status === 201 || (r.status === 200 && r.data.ok), `status=${r.status}`);
  const cookie = r.cookie;
  check("signup issued a session cookie", cookie.includes("sidocs_session"));

  /* Checkout gates. */
  r = await post("/api/billing/checkout", { plan: "pro_decade" }, cookie);
  check("checkout bogus plan → 400 bad_request", r.status === 400 && r.data.error === "bad_request");
  r = await post("/api/billing/checkout", { nope: 1 }, cookie);
  check("checkout malformed body → 400 bad_request", r.status === 400 && r.data.error === "bad_request");

  /* Demo checkout — yearly (R28 decided ₹1,499). */
  r = await post("/api/billing/checkout", { plan: "pro_yearly" }, cookie);
  check(
    "demo checkout → ok + subscriptionId",
    r.status === 200 && r.data.ok === true && typeof r.data.subscriptionId === "string"
  );
  const subscriptionId = r.data.subscriptionId as string;

  /* Confirm gates + real confirm. */
  r = await post("/api/billing/confirm", { subscriptionId: "bogus-id" }, cookie);
  check("confirm bogus id → 404 not_found", r.status === 404 && r.data.error === "not_found");
  r = await post("/api/billing/confirm", { subscriptionId }, cookie);
  check(
    "confirm → plan pro + periodEnd",
    r.status === 200 && r.data.plan === "pro" && typeof r.data.periodEnd === "string"
  );
  const proCookie = r.cookie.includes("sidocs_session") ? r.cookie : cookie;

  /* Status reflects the active sub + paid payment. */
  r = await get("/api/billing/status", proCookie);
  const sub = r.data.subscription as Record<string, unknown> | null;
  const payments = (r.data.payments ?? []) as Array<Record<string, unknown>>;
  check(
    "status → plan pro + active yearly sub",
    r.status === 200 &&
      r.data.plan === "pro" &&
      sub?.status === "active" &&
      sub?.plan === "pro_yearly"
  );
  check(
    "status → one paid INR payment (149900 paise = ₹1,499)",
    payments.length === 1 &&
      payments[0].status === "paid" &&
      payments[0].amount === 149900 &&
      payments[0].currency === "INR"
  );

  /* Me route carries the plan (SafeUser contract). */
  r = await get("/api/auth/me", proCookie);
  check(
    "me → plan pro for the refreshed cookie",
    r.status === 200 && (r.data.user as Record<string, unknown>)?.plan === "pro"
  );

  /* Re-confirm the same sub is refused (not pending anymore). */
  r = await post("/api/billing/confirm", { subscriptionId }, proCookie);
  check("re-confirm active sub → 400 bad_request", r.status === 400 && r.data.error === "bad_request");

  /* Cancel. */
  r = await post("/api/billing/cancel", undefined, proCookie);
  check("cancel → plan free", r.status === 200 && r.data.plan === "free");
  r = await get("/api/billing/status", proCookie);
  check(
    "status after cancel → free, sub gone, payment history kept",
    r.status === 200 &&
      r.data.plan === "free" &&
      r.data.subscription === null &&
      ((r.data.payments ?? []) as unknown[]).length >= 1
  );

  /* R28: the 7-day pass SKU — checkout, confirm, 4900 paise, +7d period. */
  r = await post("/api/billing/checkout", { plan: "pro_week" }, cookie);
  check(
    "week-pass checkout → ok",
    r.status === 200 && r.data.ok === true && typeof r.data.subscriptionId === "string"
  );
  const weekSubId = r.data.subscriptionId as string;
  r = await post("/api/billing/confirm", { subscriptionId: weekSubId }, cookie);
  const weekConfirm = r.data as Record<string, unknown>;
  check(
    "week-pass confirm → plan pro + ~7-day periodEnd",
    r.status === 200 &&
      weekConfirm.plan === "pro" &&
      typeof weekConfirm.periodEnd === "string" &&
      new Date(weekConfirm.periodEnd as string).getTime() - Date.now() >
        6 * 24 * 60 * 60 * 1000
  );
  const weekCookie = r.cookie.includes("sidocs_session") ? r.cookie : cookie;
  r = await get("/api/billing/status", weekCookie);
  const weekPayments = (r.data.payments ?? []) as Array<Record<string, unknown>>;
  check(
    "week-pass payment → 4900 paise paid",
    weekPayments.some(
      (p) => p.status === "paid" && p.amount === 4900 && p.currency === "INR"
    )
  );

  /* R28: /api/limits — shadow-mode counter (success-only quota). */
  const anonId = `smoke-anon-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const usageBody = (success: boolean) => ({
    toolId: "merge-pdf",
    mode: "D",
    success,
    durationMs: 120,
    sizeBucket: "small",
    anonId,
  });
  await post("/api/usage", usageBody(true));
  await post("/api/usage", usageBody(true));
  await post("/api/usage", usageBody(false)); // failures never eat quota
  await new Promise((res) => setTimeout(res, 400));
  let lr = await get(`/api/limits?anonId=${anonId}`);
  check(
    "limits (guest) → free, 2 used, max 25, hard=false",
    lr.status === 200 &&
      lr.data.plan === "free" &&
      lr.data.usedToday === 2 &&
      lr.data.maxToday === 25 &&
      lr.data.remaining === 23 &&
      lr.data.hard === false,
    JSON.stringify(lr.data)
  );
  lr = await get(`/api/limits?anonId=short`);
  check("limits bad anonId → 400", lr.status === 400);
  /* Pro session lifts the cap (same anonId, pro cookie). */
  const res = await fetch(BASE + `/api/limits?anonId=${anonId}`, {
    headers: { "x-forwarded-for": qaIp, cookie: weekCookie },
    cache: "no-store",
  });
  const proLimits = (await res.json()) as Record<string, unknown>;
  check(
    "limits (pro session) → max 1000",
    res.status === 200 && proLimits.plan === "pro" && proLimits.maxToday === 1000
  );

  /* Cancel the week pass so the QA account ends clean. */
  r = await post("/api/billing/cancel", undefined, weekCookie);
  check("week-pass cancel → plan free", r.status === 200 && r.data.plan === "free");

  /* Password change: wrong current → 401; real change → 200 + fresh cookie. */
  r = await post("/api/auth/password", { currentPassword: "wrong-pass", newPassword: "new-password-456" }, proCookie);
  check("password change wrong current → 401 invalid_credentials", r.status === 401 && r.data.error === "invalid_credentials");
  r = await post("/api/auth/password", { currentPassword: password, newPassword: "new-password-456" }, proCookie);
  check("password change → 200 ok", r.status === 200 && r.data.ok === true);
  r = await post("/api/auth/login", { email, password: "new-password-456" });
  check("login with the new password works", r.status === 200, `status=${r.status}`);
  const freshCookie = r.cookie.includes("sidocs_session") ? r.cookie : proCookie;
  r = await post("/api/auth/login", { email, password });
  check("old password refused after change", r.status === 401);

  /* Delete account: wrong pw → 401; real → 200 + session dead. */
  r = await post("/api/auth/delete", { password: "wrong-pass" }, freshCookie);
  check("delete wrong password → 401 invalid_credentials", r.status === 401 && r.data.error === "invalid_credentials");
  r = await post("/api/auth/delete", { password: "new-password-456" }, freshCookie);
  check("delete account → 200 ok", r.status === 200 && r.data.ok === true);
  r = await get("/api/auth/me", freshCookie);
  check("session dead after delete → user null", r.status === 200 && r.data.user === null);
  r = await post("/api/auth/login", { email, password: "new-password-456" });
  check("login refused after soft delete", r.status === 401);
}

try {
  await journey();
} catch (err) {
  check("live journey completed without transport errors", false, String(err));
}

/* ------------------------------------------------------------------ */
console.log(`\nbilling smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
