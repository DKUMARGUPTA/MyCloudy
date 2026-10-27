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
