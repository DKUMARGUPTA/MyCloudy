import crypto from "node:crypto";

import { db } from "@/lib/db";

/**
 * Sidocs session auth (P12) — stateless JWT (HS256) in an httpOnly cookie.
 *
 * Design goals (PRD §2.5 + P12 enterprise plan):
 *  - Minimal DB usage: sessions are stateless (zero `sessions` rows — that
 *    table stays reserved for future OAuth flows). Turso row count stays tiny.
 *  - Zero new npm deps: HS256 + scrypt via node:crypto only (jose/bcryptjs
 *    would violate the house "no new packages" rule).
 *  - Enterprise basics: ban enforcement on every request, force-logout via
 *    tokenVersion, admin auto-claim for ADMIN_EMAILS, audit logging helper.
 *
 * Error-code contract (client maps these to i18n keys auth.err.*):
 *   bad_request | invalid_credentials | email_taken | rate_limited |
 *   weak_password | invalid_email | banned | forbidden | not_found | server_error
 */

export const ADMIN_EMAILS = ["araj.dkg@gmail.com"];
export const SESSION_COOKIE = "sidocs_session";
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/* ---------------- password hashing (scrypt, node:crypto) ---------------- */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const key = crypto.scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/* ---------------- JWT (HS256, hand-rolled — no jose) ---------------- */

export interface SessionPayload {
  sub: string;
  role: string;
  ver: number;
  iat: number;
  exp: number;
}

let cachedSecret: string | null = null;

function getAuthSecret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET is missing — set it in the environment");
    }
    console.warn("[auth] AUTH_SECRET missing — using insecure dev fallback");
    cachedSecret = "sidocs-dev-secret-do-not-use-in-production";
    return cachedSecret;
  }
  cachedSecret = s;
  return cachedSecret;
}

export function signSessionJwt(user: {
  id: string;
  role: string;
  tokenVersion: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
    iat: now,
    exp: now + SESSION_MAX_AGE_SEC,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getAuthSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifySessionJwt(token: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = crypto
    .createHmac("sha256", getAuthSecret())
    .update(`${header}.${body}`)
    .digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as SessionPayload;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.ver !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- cookie serialization ---------------- */

export function sessionCookieHeader(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function parseSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

/* ---------------- user helpers ---------------- */

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  plan: string;
  locale: string;
  createdAt: string;
}

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  plan: string;
  locale: string;
  createdAt: Date;
};

export function toSafeUser(u: UserRow): SafeUser {
  return {
    id: u.id,
    email: u.email ?? "",
    name: u.name,
    role: u.role,
    plan: u.plan,
    locale: u.locale,
    createdAt: u.createdAt.toISOString(),
  };
}

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export interface AuthUser extends SafeUser {
  tokenVersion: number;
}

/**
 * Resolve the signed-in user from the request cookie. Returns null when the
 * JWT is missing/expired, the user was deleted or banned, or tokenVersion
 * changed (password change / delete = force logout everywhere).
 */
export async function getSessionUser(req: Request): Promise<AuthUser | null> {
  const token = parseSessionCookie(req);
  if (!token) return null;
  const payload = verifySessionJwt(token);
  if (!payload) return null;
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.deletedAt || user.bannedAt) return null;
  if (user.tokenVersion !== payload.ver) return null;
  return { ...toSafeUser(user), tokenVersion: user.tokenVersion };
}

/** Admin-only guard; null when not signed in or not an admin. */
export async function getAdminUser(req: Request): Promise<AuthUser | null> {
  const user = await getSessionUser(req);
  if (!user || user.role !== "admin") return null;
  return user;
}

/* ---------------- audit trail (enterprise compliance) ---------------- */

export async function audit(
  actor: string,
  action: string,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await db.auditLog.create({
      data: { actor, action, metaJson: meta ? JSON.stringify(meta) : null },
    });
  } catch (err) {
    console.error("[audit] failed to write", action, err);
  }
}
