"use client";

import { useSyncExternalStore } from "react";

/**
 * Client auth store (P12) — house pattern: module-level external store +
 * useSyncExternalStore (same as favorites.ts; zustand stays unused).
 *
 * The auth modal is store-driven so any component can open it
 * (openAuthModal("login")) without prop drilling through the page shell.
 *
 * Server error codes are mapped to i18n keys by the caller:
 *   code -> t(`auth.err.${code}`)
 */

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  plan: string;
  locale: string;
  createdAt: string;
}

export type AuthErrorCode =
  | "bad_request"
  | "invalid_credentials"
  | "email_taken"
  | "rate_limited"
  | "weak_password"
  | "invalid_email"
  | "banned"
  | "forbidden"
  | "not_found"
  | "server_error";

/** Billing API error codes (R26) — mapped to billing.err.<code> keys. */
export type BillingErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "billingNotConfigured"
  | "server_error";

interface AuthState {
  user: SafeUser | null;
  status: "loading" | "ready";
  authModal: { open: boolean; mode: "login" | "signup" };
}

let state: AuthState = {
  user: null,
  status: "loading",
  authModal: { open: false, mode: "login" },
};

const listeners = new Set<() => void>();

function set(partial: Partial<AuthState>): void {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AuthState {
  return state;
}

let bootstrapped = false;

/** Fetch /api/auth/me once per page load (call from a top-level effect). */
export function bootstrapAuth(): void {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;
  fetch("/api/auth/me", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { user: null }))
    .then((d: { user?: SafeUser | null }) =>
      set({ user: d.user ?? null, status: "ready" })
    )
    .catch(() => set({ user: null, status: "ready" }));
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function openAuthModal(mode?: "login" | "signup"): void {
  set({ authModal: { open: true, mode: mode ?? state.authModal.mode } });
}

export function closeAuthModal(): void {
  set({ authModal: { open: false, mode: state.authModal.mode } });
}

async function postJson(
  url: string,
  body: unknown
): Promise<{ ok: boolean; code?: AuthErrorCode }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, code: (data.error as AuthErrorCode | undefined) ?? undefined };
  } catch {
    return { ok: false, code: "server_error" };
  }
}

export async function login(
  email: string,
  password: string
): Promise<{ ok: boolean; code?: AuthErrorCode }> {
  const res = await postJson("/api/auth/login", { email, password });
  if (res.ok) {
    await refreshMe();
    set({ authModal: { open: false, mode: "login" } });
    return { ok: true };
  }
  return { ok: false, code: res.code ?? "server_error" };
}

export async function signup(
  name: string,
  email: string,
  password: string
): Promise<{ ok: boolean; code?: AuthErrorCode }> {
  const res = await postJson("/api/auth/signup", { name, email, password });
  if (res.ok) {
    await refreshMe();
    set({ authModal: { open: false, mode: "signup" } });
    return { ok: true };
  }
  return { ok: false, code: res.code ?? "server_error" };
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
  } catch {
    /* best-effort — clear locally regardless */
  }
  set({ user: null });
}

export async function refreshMe(): Promise<void> {
  try {
    const res = await fetch("/api/auth/me", { cache: "no-store" });
    const d = (await res.json()) as { user?: SafeUser | null };
    set({ user: d.user ?? null, status: "ready" });
  } catch {
    set({ status: "ready" });
  }
}

/** POST /api/auth/password — change password (server re-issues the
 * cookie so this device stays signed in; every other device signs out
 * via the tokenVersion bump). */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; code?: AuthErrorCode }> {
  const res = await postJson("/api/auth/password", {
    currentPassword,
    newPassword,
  });
  if (!res.ok) return { ok: false, code: res.code ?? "server_error" };
  return { ok: true };
}

/** POST /api/auth/delete — soft-delete the account (password required).
 * The API clears the cookie; locally the store resets to guest either way. */
export async function deleteAccount(
  password: string
): Promise<{ ok: boolean; code?: AuthErrorCode }> {
  const res = await postJson("/api/auth/delete", { password });
  set({ user: null });
  return res.ok ? { ok: true } : { ok: false, code: res.code ?? "server_error" };
}

/* ------------------------------------------------------------------ */
/* Billing client (R26) — thin typed wrappers over the stub API.       */
/* ------------------------------------------------------------------ */

export interface BillingPaymentRow {
  id: string;
  amount: number;
  currency: string;
  status: string;
  invoiceNo: string | null;
  createdAt: string;
}

export interface BillingStatus {
  plan: string;
  subscription: {
    id: string;
    plan: string;
    status: string;
    periodEnd: string | null;
  } | null;
  payments: BillingPaymentRow[];
}

export interface CheckoutResult {
  ok: boolean;
  mode?: "demo";
  plan?: string;
  subscriptionId?: string;
  code?: BillingErrorCode;
}

export async function startCheckout(planId: string): Promise<CheckoutResult> {
  try {
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: planId }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      mode?: "demo";
      plan?: string;
      subscriptionId?: string;
    };
    if (!res.ok) {
      return { ok: false, code: (data.error as BillingErrorCode) ?? "server_error" };
    }
    return {
      ok: true,
      mode: data.mode,
      plan: data.plan,
      subscriptionId: data.subscriptionId,
    };
  } catch {
    return { ok: false, code: "server_error" };
  }
}

export async function confirmCheckout(
  subscriptionId: string
): Promise<{ ok: boolean; plan?: string; code?: BillingErrorCode }> {
  try {
    const res = await fetch("/api/billing/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId }),
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      plan?: string;
    };
    if (!res.ok) {
      return { ok: false, code: (data.error as BillingErrorCode) ?? "server_error" };
    }
    await refreshMe();
    return { ok: true, plan: data.plan };
  } catch {
    return { ok: false, code: "server_error" };
  }
}

export async function cancelPro(): Promise<{ ok: boolean; plan?: string; code?: BillingErrorCode }> {
  try {
    const res = await fetch("/api/billing/cancel", {
      method: "POST",
      cache: "no-store",
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      plan?: string;
    };
    if (!res.ok) {
      return { ok: false, code: (data.error as BillingErrorCode) ?? "server_error" };
    }
    await refreshMe();
    return { ok: true, plan: data.plan };
  } catch {
    return { ok: false, code: "server_error" };
  }
}

export async function fetchBillingStatus(): Promise<BillingStatus | null> {
  try {
    const res = await fetch("/api/billing/status", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as BillingStatus;
  } catch {
    return null;
  }
}
