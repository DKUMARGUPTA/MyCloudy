"use client";

import type { AuthErrorCode } from "@/lib/auth-client";

/**
 * Account-folder API helpers (P12 task 12-b).
 *
 * login / signup / logout / me live in src/lib/auth-client.ts (single source
 * of truth for the auth cookie) — these cover only the endpoints the account
 * UI owns directly: password change, account deletion and bug reports.
 * Contracts match the API routes task 12-a ships.
 */

export interface AuthApiResult {
  ok: boolean;
  code?: AuthErrorCode;
}

async function postJson(
  url: string,
  body: unknown
): Promise<AuthApiResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: res.ok,
      code: (data.error as AuthErrorCode | undefined) ?? undefined,
    };
  } catch {
    return { ok: false, code: "server_error" };
  }
}

/** POST /api/auth/password — 200 {ok} | {error} */
export function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<AuthApiResult> {
  return postJson("/api/auth/password", { currentPassword, newPassword });
}

/** POST /api/auth/delete — 200 {ok}; caller then treats the user as logged out. */
export function deleteAccount(password: string): Promise<AuthApiResult> {
  return postJson("/api/auth/delete", { password });
}

export type BugCategory = "bug" | "feature" | "other";
export type BugSeverity = "low" | "medium" | "high" | "critical";

export interface BugReportInput {
  title: string;
  message: string;
  category: BugCategory;
  severity: BugSeverity;
  toolId?: string;
  email?: string;
}

/** POST /api/bug-reports — 201 {id} | 4xx {error} */
export function submitBugReport(
  input: BugReportInput
): Promise<AuthApiResult> {
  return postJson("/api/bug-reports", input);
}

export interface MyBugReport {
  id: string;
  title: string;
  message: string;
  category: string;
  severity: string;
  status: string;
  toolId?: string | null;
  adminNote?: string | null;
  createdAt: string;
}

/** GET /api/bug-reports/mine — {reports: [...]} */
export async function fetchMyReports(): Promise<{
  ok: boolean;
  reports: MyBugReport[];
}> {
  try {
    const res = await fetch("/api/bug-reports/mine", { cache: "no-store" });
    if (!res.ok) return { ok: false, reports: [] };
    const data = (await res.json()) as { reports?: MyBugReport[] };
    return {
      ok: true,
      reports: Array.isArray(data.reports) ? data.reports : [],
    };
  } catch {
    return { ok: false, reports: [] };
  }
}
