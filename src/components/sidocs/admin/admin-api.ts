/**
 * P12 admin console — typed API client (task 12-c).
 *
 * Thin wrappers over the /api/admin/* routes that task 12-a implements.
 * Contract notes:
 *   - every route returns JSON;
 *   - non-admin callers get 403 {error: "forbidden"};
 *   - error bodies are {error: <code>} (codes shared with auth-client).
 *
 * All failures throw AdminApiError; adminErrorCode() maps unknown/network
 * failures to "server_error" so the UI can render auth.err.* strings.
 */

export type AdminBugStatus =
  | "new"
  | "confirmed"
  | "in_progress"
  | "fixed"
  | "wontfix";
export type AdminBugSeverity = "low" | "medium" | "high" | "critical";
export type AdminMessageStatus = "new" | "read" | "done";
export type AdminAnnouncementVariant = "info" | "success" | "warning";
export type AdminUserRole = "user" | "admin";

export interface AdminStats {
  users: number;
  bugsNew: number;
  bugsOpen: number;
  messagesNew: number;
  feedbackCount: number;
  usageToday: number;
  topTools: { toolId: string; count: number }[];
  recentSignups: { email: string; name: string | null; createdAt: string }[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: AdminUserRole;
  plan: string;
  bannedAt: string | null;
  createdAt: string;
}

export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminBugReport {
  id: string;
  title: string;
  message: string;
  category: string;
  severity: AdminBugSeverity;
  status: AdminBugStatus;
  toolId: string | null;
  adminNote: string | null;
  browserInfo: string | null;
  createdAt: string;
  updatedAt: string;
  email: string | null;
}

export interface AdminMessage {
  id: string;
  name: string;
  email: string;
  category: string;
  message: string;
  status: AdminMessageStatus;
  createdAt: string;
}

export interface AdminFeedbackItem {
  id: string;
  toolId: string;
  rating: number;
  reason: string | null;
  message: string | null;
  createdAt: string;
}

export interface AdminFeedback {
  items: AdminFeedbackItem[];
  upCount: number;
  downCount: number;
}

export interface AdminAnnouncement {
  id: string;
  textEn: string;
  textHi: string;
  variant: AdminAnnouncementVariant;
  until?: string | null;
}

export interface AdminToolOverride {
  enabled: boolean;
  note?: string;
}

export interface AdminSettings {
  toolOverrides: Record<string, AdminToolOverride>;
  announcements: AdminAnnouncement[];
  siteFlags: { registrationOpen: boolean };
}

export interface AdminAuditEntry {
  id: string;
  actor: string;
  action: string;
  metaJson: string | null;
  createdAt: string;
}

export class AdminApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AdminApiError";
    this.code = code;
  }
}

/** Map any thrown value to a displayable error code (unknown → server_error). */
export function adminErrorCode(error: unknown): string {
  return error instanceof AdminApiError ? error.code : "server_error";
}

async function adminRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const { signal, ...rest } = init ?? {};
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...rest,
      signal,
    });
  } catch {
    // fetch() rejects on network failure and on abort; aborting callers
    // ignore errors via their `active` flag, so one code is enough.
    throw new AdminApiError("network");
  }

  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    let code = response.status === 403 ? "forbidden" : "server_error";
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ) {
      code = (body as { error: string }).error;
    }
    throw new AdminApiError(code);
  }
  return body as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* ---------------------------------------------------------------- */
/* GET /api/admin/stats                                              */
/* ---------------------------------------------------------------- */
export function fetchAdminStats(signal?: AbortSignal): Promise<AdminStats> {
  return adminRequest<AdminStats>("/api/admin/stats", { signal });
}

/* ---------------------------------------------------------------- */
/* /api/admin/users — list, patch, delete                            */
/* ---------------------------------------------------------------- */
export function fetchAdminUsers(
  params: { q: string; page: number; pageSize: number },
  signal?: AbortSignal
): Promise<AdminUsersPage> {
  const search = new URLSearchParams();
  if (params.q.trim()) search.set("q", params.q.trim());
  search.set("page", String(params.page));
  search.set("pageSize", String(params.pageSize));
  return adminRequest<AdminUsersPage>(
    `/api/admin/users?${search.toString()}`,
    { signal }
  );
}

export function patchAdminUser(
  id: string,
  body: { action: "ban" | "unban" | "role"; role?: AdminUserRole }
): Promise<{ ok: true }> {
  return adminRequest(
    `/api/admin/users/${encodeURIComponent(id)}`,
    jsonInit("PATCH", body)
  );
}

export function deleteAdminUser(id: string): Promise<{ ok: true }> {
  return adminRequest(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* ---------------------------------------------------------------- */
/* /api/admin/bugs — list, patch                                     */
/* ---------------------------------------------------------------- */
export function fetchAdminBugs(
  status: string,
  signal?: AbortSignal
): Promise<{ reports: AdminBugReport[] }> {
  const search = status ? `?status=${encodeURIComponent(status)}` : "";
  return adminRequest<{ reports: AdminBugReport[] }>(
    `/api/admin/bugs${search}`,
    { signal }
  );
}

export function patchAdminBug(
  id: string,
  body: { status?: AdminBugStatus; severity?: AdminBugSeverity; adminNote?: string }
): Promise<{ report: AdminBugReport }> {
  return adminRequest(
    `/api/admin/bugs/${encodeURIComponent(id)}`,
    jsonInit("PATCH", body)
  );
}

/* ---------------------------------------------------------------- */
/* /api/admin/messages — list, patch                                 */
/* ---------------------------------------------------------------- */
export function fetchAdminMessages(
  signal?: AbortSignal
): Promise<{ messages: AdminMessage[] }> {
  return adminRequest<{ messages: AdminMessage[] }>("/api/admin/messages", {
    signal,
  });
}

export function patchAdminMessage(
  id: string,
  status: AdminMessageStatus
): Promise<{ message: AdminMessage }> {
  return adminRequest(
    `/api/admin/messages/${encodeURIComponent(id)}`,
    jsonInit("PATCH", { status })
  );
}

/* ---------------------------------------------------------------- */
/* GET /api/admin/feedback                                           */
/* ---------------------------------------------------------------- */
export function fetchAdminFeedback(
  signal?: AbortSignal
): Promise<AdminFeedback> {
  return adminRequest<AdminFeedback>("/api/admin/feedback", { signal });
}

/* ---------------------------------------------------------------- */
/* /api/admin/settings — get, put                                    */
/* ---------------------------------------------------------------- */
export function fetchAdminSettings(
  signal?: AbortSignal
): Promise<AdminSettings> {
  return adminRequest<AdminSettings>("/api/admin/settings", { signal });
}

export function putAdminSettings(
  body: Partial<
    Pick<AdminSettings, "toolOverrides" | "announcements" | "siteFlags">
  >
): Promise<{ ok: true }> {
  return adminRequest("/api/admin/settings", jsonInit("PUT", body));
}

/* ---------------------------------------------------------------- */
/* GET /api/admin/audit                                              */
/* ---------------------------------------------------------------- */
export function fetchAdminAudit(
  signal?: AbortSignal
): Promise<{ entries: AdminAuditEntry[] }> {
  return adminRequest<{ entries: AdminAuditEntry[] }>("/api/admin/audit", {
    signal,
  });
}
