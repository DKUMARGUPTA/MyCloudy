"use client";

/**
 * Admin API client — typed fetchers for the owner's admin dashboard.
 * Follows the accounting-client pattern: JSON contract, typed results,
 * no throwing on expected errors (callers toast instead).
 */

/* ------------------------------- DTOs -------------------------------- */

export interface AdminStatsDto {
  users: number;
  bugsNew: number;
  bugsOpen: number;
  messagesNew: number;
  feedbackCount: number;
  usageToday: number;
  topTools: Array<{ toolId: string; count: number }>;
  recentSignups: Array<{
    email: string;
    name: string | null;
    createdAt: string;
  }>;
}

export interface AdminUserDto {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  plan: string;
  bannedAt: string | null;
  createdAt: string;
}

export interface AdminUsersPageDto {
  users: AdminUserDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminBugDto {
  id: string;
  title: string;
  message: string;
  category: string;
  severity: string;
  status: string;
  toolId: string | null;
  adminNote: string | null;
  browserInfo: string | null;
  createdAt: string;
  updatedAt: string;
  email: string;
}

export interface AdminMessageDto {
  id: string;
  name: string;
  email: string;
  category: string;
  message: string;
  status: string;
  createdAt: string;
}

export interface AdminFeedbackDto {
  items: Array<{
    id: string;
    toolId: string;
    rating: number;
    reason: string | null;
    message: string | null;
    createdAt: string;
  }>;
  upCount: number;
  downCount: number;
}

export interface AdminAuditDto {
  entries: Array<{
    id: string;
    actor: string;
    action: string;
    metaJson: string | null;
    createdAt: string;
  }>;
}

export interface AnnouncementDto {
  id: string;
  textEn: string;
  textHi: string;
  variant: "info" | "success" | "warning";
  until?: string;
}

export interface AdminSettingsDto {
  toolOverrides: Record<string, { enabled: boolean; note?: string }>;
  announcements: AnnouncementDto[];
  siteFlags: { registrationOpen: boolean };
}

export interface AdminAnalyticsDto {
  viewsToday: number;
  visitorsToday: number;
  views7d: number;
  visitors7d: number;
  views30d: number;
  visitors30d: number;
  /** Zero-filled last 30 days, oldest → newest. */
  series: Array<{ day: string; views: number; visitors: number }>;
  topPages: Array<{ label: string; count: number }>;
  referrers: Array<{ label: string; count: number }>;
  devices: Array<{ label: string; count: number }>;
  locales: Array<{ label: string; count: number }>;
  tools: {
    runs30d: number;
    successRate30d: number;
    avgDurationMs: number;
    top: Array<{ toolId: string; runs: number; successRate: number }>;
  };
}

/* ── R60: advanced visitor analytics (/api/admin/visitors) ───────────── */

export interface VisitorsFilter {
  range?: "today" | "yesterday" | "7d" | "30d" | "90d" | "all" | "custom";
  from?: string;
  to?: string;
  country?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
  referrer?: string;
  userType?: "all" | "known" | "anon";
  q?: string;
  minViews?: number;
}

export interface VisitorSessionDto {
  id: string;
  visitor: {
    email: string | null;
    name: string | null;
    plan: string;
    age: number | null;
  } | null;
  visitorId: string;
  country: string;
  countryName: string;
  region: string | null;
  city: string | null;
  timezone: string | null;
  browser: string;
  os: string;
  device: string;
  deviceBrand: string | null;
  screen: string | null;
  language: string | null;
  referrer: string;
  referrerHost: string | null;
  landingPath: string;
  pageviews: number;
  isBounce: boolean;
  firstSeen: string;
  lastSeen: string;
  durationMin: number;
}

export interface AdminVisitorsDto {
  range: { kind: string; from: string; to: string };
  kpis: {
    visitors: number;
    sessions: number;
    pageviews: number;
    avgPagesPerSession: number;
    bounceRate: number;
    knownSessions: number;
    avgSessionMin: number;
    countries: number;
  };
  series: Array<{ day: string; sessions: number; views: number }>;
  countries: Array<{ label: string; name: string; count: number }>;
  cities: Array<{ label: string; count: number }>;
  devices: Array<{ label: string; count: number }>;
  browsers: Array<{ label: string; name: string; count: number }>;
  osList: Array<{ label: string; name: string; count: number }>;
  referrers: Array<{ label: string; count: number }>;
  languages: Array<{ label: string; count: number }>;
  topPages: Array<{ label: string; count: number }>;
  ageGroups: Array<{ label: string; count: number }>;
  sessions: VisitorSessionDto[];
  filters: {
    countries: Array<{ code: string; name: string }>;
    cities: string[];
    browsers: string[];
    os: string[];
  };
}

/* ------------------------------ fetchers ------------------------------ */

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const fetchStats = () => jsonFetch<AdminStatsDto>("/api/admin/stats");

export const fetchUsers = (q: string, page: number, pageSize = 10) =>
  jsonFetch<AdminUsersPageDto>(
    `/api/admin/users?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`
  );

export const fetchBugs = (status: string) =>
  jsonFetch<{ reports: AdminBugDto[] }>(
    status ? `/api/admin/bugs?status=${status}` : "/api/admin/bugs"
  );

export const fetchMessages = () =>
  jsonFetch<{ messages: AdminMessageDto[] }>("/api/admin/messages");

export const fetchFeedback = () =>
  jsonFetch<AdminFeedbackDto>("/api/admin/feedback");

export const fetchAudit = () => jsonFetch<AdminAuditDto>("/api/admin/audit");

export const fetchSettings = () =>
  jsonFetch<AdminSettingsDto>("/api/admin/settings");

export const fetchAnalytics = () =>
  jsonFetch<AdminAnalyticsDto>("/api/admin/analytics");

export function fetchVisitors(filter: VisitorsFilter): Promise<AdminVisitorsDto | null> {
  const params = new URLSearchParams();
  if (filter.range) params.set("range", filter.range);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.country) params.set("country", filter.country);
  if (filter.city) params.set("city", filter.city);
  if (filter.device) params.set("device", filter.device);
  if (filter.browser) params.set("browser", filter.browser);
  if (filter.os) params.set("os", filter.os);
  if (filter.referrer) params.set("referrer", filter.referrer);
  if (filter.userType && filter.userType !== "all") params.set("userType", filter.userType);
  if (filter.q) params.set("q", filter.q);
  if (filter.minViews != null) params.set("minViews", String(filter.minViews));
  return jsonFetch<AdminVisitorsDto>(`/api/admin/visitors?${params.toString()}`);
}

/* ------------------------------- mutators ----------------------------- */

export type UserActionResult =
  | { ok: true }
  | { ok: false; status: number };

async function mutate(
  url: string,
  method: "PATCH" | "DELETE" | "PUT",
  body?: unknown
): Promise<UserActionResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** PATCH /api/admin/users/[id] — ban | unban | role. */
export function userAction(
  id: string,
  body: { action: "ban" | "unban" | "role"; role?: "user" | "admin" }
): Promise<UserActionResult> {
  return mutate(`/api/admin/users/${id}`, "PATCH", body);
}

/** DELETE /api/admin/users/[id] — soft delete. */
export function userDelete(id: string): Promise<UserActionResult> {
  return mutate(`/api/admin/users/${id}`, "DELETE");
}

/** PATCH /api/admin/bugs/[id] — triage. Returns the updated report. */
export async function bugUpdate(
  id: string,
  body: {
    status?: string;
    severity?: string;
    adminNote?: string;
  }
): Promise<AdminBugDto | null> {
  try {
    const res = await fetch(`/api/admin/bugs/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { report: AdminBugDto };
    return data.report;
  } catch {
    return null;
  }
}

/** PATCH /api/admin/messages/[id] — new | read | done. */
export async function messageUpdate(
  id: string,
  status: "new" | "read" | "done"
): Promise<AdminMessageDto | null> {
  try {
    const res = await fetch(`/api/admin/messages/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message: AdminMessageDto };
    return data.message;
  } catch {
    return null;
  }
}

/** PUT /api/admin/settings — persist all three settings rows. */
export function settingsSave(body: AdminSettingsDto): Promise<UserActionResult> {
  return mutate("/api/admin/settings", "PUT", body);
}
