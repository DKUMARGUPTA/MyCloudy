/**
 * R25 auth-UI smoke — locks the auth frontend contract:
 *  1. i18n: every auth.* key the UI renders exists in BOTH en + hi with
 *     real copy (no tofu — Devanagari check on hi).
 *  2. Error-code mapping: every AuthErrorCode the client can receive has
 *     an auth.err.<code> i18n key (a new server code without copy fails
 *     here instead of rendering a raw key in production).
 *  3. auth-client: exports the store API the components consume; signup
 *     takes (name, email, password) in that order; SafeUser carries the
 *     plan/role fields the account menu branches on.
 *  4. Wiring: app-shell bootstraps the session + renders the AuthModal;
 *     site-header renders the AccountMenu; the mobile sheet has an
 *     account section for both guest and signed-in states.
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
const enAuth = en.auth as Dict;
const hiAuth = hi.auth as Dict;

/* ---- 1. i18n presence + real copy ---- */
const requiredKeys = [
  "loginTitle", "loginDesc", "signupTitle", "signupDesc",
  "tabLogin", "tabSignup", "name", "email", "password", "passwordHint",
  "loginCta", "signupCta", "working", "toSignup", "toLogin",
  "privacyNote", "signedOut", "welcome",
  "accountLabel", "openMenuLabel",
  "menuPlanFree", "menuPlanPro", "proThanks", "menuAdmin", "menuLogout",
];
for (const key of requiredKeys) {
  const enVal = enAuth[key];
  const hiVal = hiAuth[key];
  check(`i18n en auth.${key}`, typeof enVal === "string" && (enVal as string).length > 0);
  check(`i18n hi auth.${key}`, typeof hiVal === "string" && (hiVal as string).length > 0);
}
check(
  "i18n hi welcome is real Devanagari",
  typeof hiAuth.welcome === "string" && /[\u0900-\u097F]/.test(hiAuth.welcome as string)
);
check(
  "i18n auth.welcome carries {name} interpolation",
  enAuth.welcome === "Welcome, {name}!" && hiAuth.welcome === "स्वागत है, {name}!"
);

/* ---- 2. error-code ↔ i18n parity ---- */
const authClient = readFileSync(`${root}src/lib/auth-client.ts`, "utf8");
const codeMatch = authClient.match(
  /export type AuthErrorCode =\s*\n([^;]+);/
);
const codes = codeMatch
  ? codeMatch[1].split("|").map((c) => c.trim().replace(/^"|"$/g, "")).filter((c) => c.length > 0)
  : [];
check("AuthErrorCode union parsed", codes.length >= 10, codes.join(","));
const enErr = enAuth.err as Dict;
const hiErr = hiAuth.err as Dict;
for (const code of codes) {
  check(
    `auth.err.${code} mapped in en`,
    typeof enErr[code] === "string" && (enErr[code] as string).length > 0
  );
  check(
    `auth.err.${code} mapped in hi`,
    typeof hiErr[code] === "string" && (hiErr[code] as string).length > 0
  );
}

/* ---- 3. auth-client store contract ---- */
check("exports login(email, password)", /export async function login\(\s*email: string,\s*password: string/.test(authClient));
check("exports signup(name, email, password)", /export async function signup\(\s*name: string,\s*email: string,\s*password: string/.test(authClient));
check("SafeUser has plan + role", /plan: string;/.test(authClient) && /role: "user" \| "admin";/.test(authClient));
check("exports openAuthModal + closeAuthModal + bootstrapAuth", /export function openAuthModal/.test(authClient) && /export function closeAuthModal/.test(authClient) && /export function bootstrapAuth/.test(authClient));

/* ---- 4. component wiring ---- */
const shell = readFileSync(`${root}src/components/doco/app-shell.tsx`, "utf8");
check("app-shell bootstraps the session", /bootstrapAuth\(\);/.test(shell));
check("app-shell renders the AuthModal", /<AuthModal \/>/.test(shell));

const header = readFileSync(`${root}src/components/doco/site-header.tsx`, "utf8");
check("site-header renders the AccountMenu", /<AccountMenu \/>/.test(header));
check(
  "mobile sheet has a guest login entry",
  /openAuthModal\("login"\)/.test(header) && header.includes("UserRound")
);
check(
  "mobile sheet has a signed-in section",
  /user\.plan === "pro"/.test(header) && /void logout\(\);/.test(header)
);

const modal = readFileSync(`${root}src/components/doco/auth/auth-modal.tsx`, "utf8");
check("modal maps codes via auth.err.<code>", /auth\.err\.\$\{errorCode\}/.test(modal));
check("modal has a client-side weak-password gate", /password\.length < 8/.test(modal));
check("modal submit disables while busy", /disabled=\{busy\}/.test(modal));

const menu = readFileSync(`${root}src/components/doco/auth/account-menu.tsx`, "utf8");
check("menu branches on plan pro", /user\.plan === "pro"/.test(menu));
check("menu shows admin badge for role admin", /user\.role === "admin"/.test(menu));
check("menu logout tracks + toasts", /track\("logout"\)/.test(menu));

console.log(
  `\nauth-ui smoke: ${pass} passed, ${fail} failed`
);
if (fail > 0) process.exit(1);
