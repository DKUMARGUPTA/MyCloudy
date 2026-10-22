import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  checkResolvedIps,
  validatePageUrl,
} from "../../../../tools/webpage-to-pdf/url-guard";
import {
  decodeHtmlBytes,
  FETCH_PAGE_LIMITS,
  type FetchErrorCode,
} from "../../../../tools/webpage-to-pdf/model";

/**
 * POST /api/fetch-page — the honest pipe behind "Webpage to PDF" (RB4-f).
 *
 * Browsers cannot fetch arbitrary cross-origin URLs (CORS), so THIS
 * route is the one piece that runs server-side — a DUMB PIPE:
 *
 *  - it validates the URL (http/https only, explicit parse),
 *  - resolves the hostname and refuses loopback / private / link-local /
 *    unique-local targets (SSRF guard — checked on EVERY redirect hop,
 *    not just the first),
 *  - follows at most 3 redirects manually (each target re-validated),
 *  - enforces one 15 s budget for the whole walk, caps the body at
 *    5 MB, requires an HTML content-type,
 *  - decodes the bytes with the SAME charset-aware reader the on-device
 *    html-to-pdf engine uses (BOM + <meta charset>), and
 *  - returns the HTML STRING to the caller — where ALL rendering to PDF
 *    happens on the user's device, in a Web Worker.
 *
 * The body is NEVER logged, NEVER stored, NEVER forwarded anywhere: it
 * exists in this function's memory for the duration of one request and
 * then it is gone. There is no database, no cache, no analytics on the
 * fetched content. The URL itself is not logged either.
 *
 * Known honest limits (documented in the tool's FAQ): JavaScript never
 * runs, so SPA shells and paywalled pages render whatever their server
 * sent as HTML; CSS layout is not applied by the on-device renderer.
 * DNS-rebinding TOCTOU (a hostname that resolves public at check time
 * and private at fetch time) is out of scope for this guard — the walk
 * never sends credentials or cookies, which keeps the blast radius at
 * "a public page was read".
 */

const bodySchema = z.object({
  url: z.string().min(1).max(2048),
});

/** honest crawler-style UA: identifies the tool, no fake browser claim */
const USER_AGENT = "Mozilla/5.0 (compatible; MyCloudyBot/1.0; webpage-to-pdf)";

const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** machine code → HTTP status (the worker maps codes to i18n keys) */
const HTTP_BY_CODE: Record<string, number> = {
  "invalid-json": 400,
  "invalid-body": 400,
  "invalid-url": 400,
  "private-address": 403,
  "rate-limited": 429,
  "dns-failed": 502,
  "fetch-failed": 502,
  "http-status": 502,
  "too-many-redirects": 502,
  "timeout": 504,
  "too-large": 413,
  "not-html": 415,
};

class PipeError extends Error {
  readonly code: FetchErrorCode;
  readonly detail: string | undefined;
  constructor(code: FetchErrorCode, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function errorResponse(code: string, detail?: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: code, ...(detail !== undefined ? { detail } : {}) },
    { status: HTTP_BY_CODE[code] ?? 502 }
  );
}

/* ------------------------------------------------------------------ */
/* Rate limit (the feedback-route precedent, in-memory only)            */
/* ------------------------------------------------------------------ */

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(
    (time) => now - time < RATE_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1000) {
    for (const [key, times] of hits) {
      if (times.every((time) => now - time >= RATE_WINDOW_MS)) {
        hits.delete(key);
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* SSRF guard: every resolved IP must be public                          */
/* ------------------------------------------------------------------ */

async function assertPublicHost(hostname: string): Promise<void> {
  // WHATWG hostnames arrive unbracketed for IPv4 / names, bracketed
  // for IPv6 literals — normalize before resolving.
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    const resolved = await lookup(host, { all: true });
    addresses = resolved.map((entry) => entry.address);
  } catch {
    throw new PipeError("dns-failed");
  }
  if (addresses.length === 0) throw new PipeError("dns-failed");
  const guard = checkResolvedIps(addresses);
  if (!guard.ok) {
    // the address itself never leaves the process — only the refusal
    throw new PipeError("private-address");
  }
}

/* ------------------------------------------------------------------ */
/* Capped body read (declared AND streamed lengths checked)              */
/* ------------------------------------------------------------------ */

async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > FETCH_PAGE_LIMITS.maxBytes) {
    throw new PipeError("too-large", `${declared}`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > FETCH_PAGE_LIMITS.maxBytes) {
      throw new PipeError("too-large", `${buffer.byteLength}`);
    }
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > FETCH_PAGE_LIMITS.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PipeError("too-large", `${total}`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The pipe                                                              */
/* ------------------------------------------------------------------ */

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return errorResponse("rate-limited");
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse("invalid-json");
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid-body");
  }

  const entry = validatePageUrl(parsed.data.url);
  if (!entry.ok) {
    return errorResponse(entry.code);
  }

  // ONE budget for DNS + every hop + the body read of the whole walk.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    FETCH_PAGE_LIMITS.timeoutMs
  );

  try {
    let current = entry.url;
    // for (hop = 0; hop <= maxRedirects; …) — the guard below fires when
    // a (maxRedirects+1)-th redirect is seen, so 3 hops are followed.
    for (let hop = 0; ; hop++) {
      // per-hop SSRF re-validation: a redirect may not retarget us inward
      await assertPublicHost(current.hostname);

      let res: Response;
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: ACCEPT, "user-agent": USER_AGENT },
        });
      } catch (cause) {
        if (
          controller.signal.aborted ||
          (cause instanceof Error && cause.name === "AbortError")
        ) {
          throw new PipeError("timeout");
        }
        throw new PipeError("fetch-failed");
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new PipeError("fetch-failed", `${res.status}`);
        if (hop >= FETCH_PAGE_LIMITS.maxRedirects) {
          throw new PipeError("too-many-redirects");
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new PipeError("fetch-failed", "bad-redirect-location");
        }
        const revalidated = validatePageUrl(next.toString());
        if (!revalidated.ok) {
          throw new PipeError("invalid-url", "redirect-target");
        }
        current = revalidated.url;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new PipeError("http-status", `${res.status}`);
      }

      const contentType = (res.headers.get("content-type") ?? "")
        .toLowerCase()
        .split(";")[0]
        ?.trim();
      if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
        await res.body?.cancel().catch(() => undefined);
        throw new PipeError("not-html", contentType === "" ? "none" : contentType);
      }

      const bytes = await readCapped(res);
      // the SAME charset-aware decode the on-device engine uses (BOM +
      // <meta charset> aware, UTF-8 default) — then the string leaves and
      // the bytes are garbage-collected. Never logged, never stored.
      return NextResponse.json({
        ok: true,
        html: decodeHtmlBytes(bytes),
        finalUrl: current.toString(),
        status: res.status,
      });
    }
  } catch (cause) {
    if (cause instanceof PipeError) {
      return errorResponse(cause.code, cause.detail);
    }
    if (
      controller.signal.aborted ||
      (cause instanceof Error && cause.name === "AbortError")
    ) {
      return errorResponse("timeout");
    }
    return errorResponse("fetch-failed");
  } finally {
    clearTimeout(timer);
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "method-not-allowed" },
    { status: 405 }
  );
}
