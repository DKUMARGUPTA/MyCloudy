/**
 * Request-signature client API (P9-F6B, tool #96) — typed fetch wrappers
 * for the request-sign mini-service (:3032).
 *
 * Gateway rule (Caddy XTransformPort): every request uses a RELATIVE path
 * with `?XTransformPort=3032` — never an absolute URL, never localhost.
 * Multipart via FormData; error bodies arrive as {error, code} JSON.
 */

const BASE = "?XTransformPort=3032";

export interface SignRequestMeta {
  fileName: string;
  bytes: number;
  message: string;
  from: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "signed" | "cancelled" | "expired";
}

export interface CreatedRequest {
  signUrl: string;
  viewUrl: string;
  expiresAt: number;
}

export class RequestSignError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`request-sign ${code} (${status})`);
    this.name = "RequestSignError";
  }
}

async function errorFrom(res: Response): Promise<RequestSignError> {
  let code = "rsign.network";
  try {
    const body = (await res.json()) as { code?: string };
    if (typeof body.code === "string" && body.code.length > 0) code = body.code;
  } catch {
    /* non-JSON error body */
  }
  return new RequestSignError(res.status, code);
}

function path(...parts: (string | number)[]): string {
  return `/${parts.join("/")}${BASE}`;
}

/** POST /requests — upload the envelope, get both token URLs back. */
export async function createRequest(
  file: File,
  hours: 24 | 48 | 168,
  from: string,
  message: string
): Promise<CreatedRequest> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("hours", String(hours));
  form.append("from", from);
  form.append("message", message);
  const res = await fetch("/requests" + BASE, { method: "POST", body: form });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as CreatedRequest;
}

/** GET /requests/:token/meta — sign OR view token. */
export async function fetchMeta(token: string): Promise<SignRequestMeta> {
  const res = await fetch(path("requests", token, "meta"));
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as SignRequestMeta;
}

/** GET /requests/:token/pdf — the original PDF bytes (inline). */
export async function fetchPdf(token: string): Promise<Blob> {
  const res = await fetch(path("requests", token, "pdf"));
  if (!res.ok) throw await errorFrom(res);
  return res.blob();
}

/** POST /requests/:signToken/sign — the recipient's signed PDF. */
export async function postSigned(token: string, file: Blob): Promise<void> {
  const form = new FormData();
  form.append("file", file, "signed.pdf");
  const res = await fetch(path("requests", token, "sign"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw await errorFrom(res);
}

/** GET /requests/:viewToken/result — the signed PDF bytes. */
export async function fetchResult(token: string): Promise<Blob> {
  const res = await fetch(path("requests", token, "result"));
  if (!res.ok) throw await errorFrom(res);
  return res.blob();
}

/** DELETE /requests/:viewToken — cancel + wipe. Idempotent. */
export async function cancelRequest(token: string): Promise<void> {
  const res = await fetch(path("requests", token), { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res);
}
