/**
 * Sidocs request-signature mini-service (P9-F6B, tool #96) — the ONLY
 * Mode S signature tool's envelope holder.
 *
 *   POST   /requests                     multipart: file (PDF ≤ 25 MB, %PDF
 *                                        magic), hours (24|48|168), message
 *                                        (≤ 500, optional), from (≤ 80)
 *                                        → { signUrl, viewUrl, expiresAt }
 *   GET    /requests/:token/meta         (sign OR view token) — never tokens
 *   GET    /requests/:token/pdf          (sign OR view token) original bytes
 *   POST   /requests/:signToken/sign     multipart: file (PDF ≤ 30 MB) —
 *                                        409 already signed, 410 expired
 *   GET    /requests/:viewToken/result   signed.pdf bytes (404 until signed)
 *   DELETE /requests/:viewToken           cancel — bytes wiped immediately,
 *                                        meta stays until the expiry sweep
 *   GET    /health
 *
 * The signer's actual PDF work (drawing/placing the signature) happens 100%
 * CLIENT-SIDE in the recipient's browser — this service only holds the
 * request envelope (PDF bytes + metadata + expiry) so a link can outlive the
 * requester's tab. Nothing is executed, no shell, zero npm deps
 * (node:crypto + node:fs/promises only). A 60 s sweeper deletes every
 * folder whose expiresAt is in the past — max 7 days, then deleted; dirs
 * whose meta.json is unreadable for over 6 h are treated as orphans and
 * removed too. Tokens resolve through an in-memory index (O(1), rebuilt
 * lazily after a restart).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = 3032;
const DATA_DIR = path.join(import.meta.dir, "data");
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_SIGNED_BYTES = 30 * 1024 * 1024;
/** Multipart envelope overhead for the pre-parse Content-Length check. */
const MAX_ORIGINAL_ENVELOPE = MAX_ORIGINAL_BYTES + 1 * 1024 * 1024;
const MAX_SIGNED_ENVELOPE = MAX_SIGNED_BYTES + 1 * 1024 * 1024;
/** Abuse defenses (R19 audit S3): per-IP rate limits + total envelope cap. */
const CREATE_RATE_LIMIT = 10; // envelopes per hour per IP
const CREATE_RATE_WINDOW_MS = 60 * 60_000;
const SIGN_RATE_LIMIT = 30; // signature submissions per hour per IP
const SIGN_RATE_WINDOW_MS = 60 * 60_000;
const MAX_LIVE_ENVELOPES = 500; // pending + signed envelopes on disk
/** A .sign-lock older than this is treated as stale (crashed signer). */
const SIGN_LOCK_STALE_MS = 60_000;
const HOURS_ALLOWED = new Set([24, 48, 168]);
const FROM_MAX = 80;
const MESSAGE_MAX = 500;
const PDF_MAGIC = "%PDF-";
/** 24 random bytes hex — 48 chars, never path-relevant. */
const TOKEN_RE = /^[0-9a-f]{48}$/;
/** token → envelope id — O(1) resolution instead of a full DATA_DIR scan
 * per call (R19 audit P3). Rebuilt lazily on miss after a restart; entries
 * are dropped by the sweeper when an envelope expires. Bounded by
 * MAX_LIVE_ENVELOPES × 2 tokens ≈ 1000 short strings. */
const tokenIndex = new Map<string, string>();
/** Min spacing between full index rebuilds (garbage-token DoS brake). */
const INDEX_TTL_MS = 5_000;
let indexScannedAt = 0;
/** A dir whose meta.json stays unreadable this long is an orphan — a
 * legit create writes meta.json seconds after mkdir (audit P3). */
const ORPHAN_GRACE_MS = 6 * 3_600_000;

interface Meta {
  id: string;
  signToken: string;
  viewToken: string;
  fileName: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  message: string;
  from: string;
  status: "pending" | "signed" | "cancelled";
}

/** What the client may see — the two tokens are NEVER part of this. */
function metaView(meta: Meta): Record<string, unknown> {
  return {
    fileName: meta.fileName,
    bytes: meta.bytes,
    message: meta.message,
    from: meta.from,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    status: statusOf(meta),
  };
}

/** Derived status: an unswept pending request past its expiry reads "expired". */
function statusOf(meta: Meta): Meta["status"] | "expired" {
  if (meta.status === "pending" && Date.now() > meta.expiresAt) return "expired";
  return meta.status;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/* ---------------- abuse defenses (R19 audit S3) ---------------- */

/** Client IP — the gateway overwrites X-Real-IP with the actual remote
 * host, so it cannot be spoofed through the gateway; direct loopback
 * connections are local by definition. */
function clientIp(req: Request): string {
  const ip = req.headers.get("x-real-ip");
  return ip && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : "direct";
}

const buckets = new Map<string, { times: number[] }>();

/** Sliding-window per-IP rate limit. */
function rateLimited(
  ip: string,
  kind: "create" | "sign",
  limit: number,
  windowMs: number
): boolean {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const recent = (buckets.get(key)?.times ?? []).filter(
    (time) => now - time < windowMs
  );
  if (recent.length >= limit) {
    buckets.set(key, { times: recent });
    return true;
  }
  recent.push(now);
  buckets.set(key, { times: recent });
  if (buckets.size > 2000) {
    for (const [k, v] of buckets) {
      if (v.times.every((time) => now - time >= CREATE_RATE_WINDOW_MS)) {
        buckets.delete(k);
      }
    }
  }
  return false;
}

/** Refuse the body BEFORE buffering when the declared size is over the
 * cap — the old check fired only after formData() had absorbed it. */
function assertEnvelopeSize(req: Request, maxEnvelope: number, code: string): void {
  const declared = req.headers.get("content-length");
  if (declared === null) return; // chunked — post-parse checks still apply
  const n = Number(declared);
  if (Number.isFinite(n) && n > maxEnvelope) {
    throw new HttpError(
      413,
      `${code}.tooLarge`,
      `request body over ${Math.round(maxEnvelope / (1024 * 1024))} MB`
    );
  }
}

/** Count live (pending|signed) envelopes — the sweeper removes expired
 * ones, but an attacker must not be able to fill the disk faster. */
async function liveEnvelopeCount(): Promise<number> {
  try {
    const entries = await readdir(DATA_DIR);
    return entries.length;
  } catch {
    return 0;
  }
}

/** Strip path separators / control chars — names are display-only here. */
function sanitizeName(raw: string): string {
  const base = path
    .basename(raw)
    .replace(/[\u0000-\u001f\u007f"/\\:]+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const cleaned = base.slice(0, 120);
  return cleaned.length > 0 ? cleaned : "document.pdf";
}

/** ASCII-safe fallback + RFC 5987 form for the Content-Disposition name. */
function contentDisposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "'");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

interface Found {
  dir: string;
  meta: Meta;
  /** Which of the two tokens the caller presented. */
  role: "sign" | "view";
}

/** One linear pass over DATA_DIR filling tokenIndex (cold start after a
 * service restart). The clear+refill is synchronous, so concurrent
 * requests never observe a half-built index. */
async function scanIndex(): Promise<void> {
  indexScannedAt = Date.now();
  let entries: string[];
  try {
    entries = await readdir(DATA_DIR);
  } catch {
    return;
  }
  const fresh = new Map<string, string>();
  for (const id of entries) {
    try {
      const meta = JSON.parse(
        await readFile(path.join(DATA_DIR, id, "meta.json"), "utf8")
      ) as Meta;
      if (typeof meta.signToken === "string" && typeof meta.viewToken === "string") {
        fresh.set(meta.signToken, id);
        fresh.set(meta.viewToken, id);
      }
    } catch {
      // Unreadable half-written folder — the sweeper owns those.
    }
  }
  tokenIndex.clear();
  for (const [token, id] of fresh) tokenIndex.set(token, id);
}

/** Resolve a token to its dir + FRESH meta (status may have changed since
 * the last call). O(1) via tokenIndex; a miss triggers at most one index
 * rebuild per INDEX_TTL_MS. */
async function findRequest(token: string): Promise<Found | null> {
  if (!TOKEN_RE.test(token)) return null;
  let id = tokenIndex.get(token);
  if (id === undefined) {
    if (Date.now() - indexScannedAt > INDEX_TTL_MS) await scanIndex();
    id = tokenIndex.get(token);
    if (id === undefined) return null;
  }
  const dir = path.join(DATA_DIR, id);
  try {
    const meta = JSON.parse(
      await readFile(path.join(dir, "meta.json"), "utf8")
    ) as Meta;
    if (meta.signToken !== token && meta.viewToken !== token) {
      tokenIndex.delete(token); // stale entry — dir contents changed
      return null;
    }
    return { dir, meta, role: meta.signToken === token ? "sign" : "view" };
  } catch {
    // Unreadable half-written folder — same honest answer as before.
    return null;
  }
}

/** Cap + %PDF magic BEFORE anything is written to disk. */
async function readValidatedPdf(
  file: File,
  maxBytes: number,
  code: string
): Promise<Buffer> {
  if (!(file instanceof File)) {
    throw new HttpError(400, code, "expected a file field");
  }
  if (file.size > maxBytes) {
    throw new HttpError(
      413,
      `${code}.tooLarge`,
      `over ${Math.round(maxBytes / (1024 * 1024))} MB (${file.size})`
    );
  }
  const head = Buffer.from(await file.slice(0, 5).arrayBuffer()).toString(
    "latin1"
  );
  if (head !== PDF_MAGIC) {
    throw new HttpError(415, `${code}.notPdf`, "file is not a PDF");
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.subarray(0, 5).toString("latin1") !== PDF_MAGIC) {
    throw new HttpError(415, `${code}.notPdf`, "file is not a PDF");
  }
  return buf;
}

/* ------------------------------- handlers ------------------------------- */

async function handleCreate(req: Request): Promise<Response> {
  assertEnvelopeSize(req, MAX_ORIGINAL_ENVELOPE, "rsign.file");
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "rsign.formData", "expected multipart/form-data");
  });

  const hoursRaw = String(form.get("hours") ?? "");
  const hours = Number(hoursRaw);
  if (!HOURS_ALLOWED.has(hours)) {
    throw new HttpError(400, "rsign.hours", "hours must be 24, 48 or 168");
  }
  const from = String(form.get("from") ?? "").trim();
  if (from.length === 0 || from.length > FROM_MAX) {
    throw new HttpError(400, "rsign.from", `from must be 1-${FROM_MAX} chars`);
  }
  const message = String(form.get("message") ?? "").trim();
  if (message.length > MESSAGE_MAX) {
    throw new HttpError(400, "rsign.message", `message over ${MESSAGE_MAX} chars`);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "rsign.needFile", "a PDF file is required");
  }
  const bytes = await readValidatedPdf(file, MAX_ORIGINAL_BYTES, "rsign.file");

  const now = Date.now();
  const id = randomUUID();
  const dir = path.join(DATA_DIR, id);
  await mkdir(dir, { recursive: true });
  const meta: Meta = {
    id,
    signToken: randomBytes(24).toString("hex"),
    viewToken: randomBytes(24).toString("hex"),
    fileName: sanitizeName(file.name),
    bytes: bytes.length,
    createdAt: now,
    expiresAt: now + hours * 3_600_000,
    message,
    from,
    status: "pending",
  };
  await writeFile(path.join(dir, "original.pdf"), bytes);
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");
  tokenIndex.set(meta.signToken, id);
  tokenIndex.set(meta.viewToken, id);
  console.log(`[request-sign] created ${id} (${bytes.length} B, ${hours}h)`);
  return json(200, {
    signUrl: `#/sign/${meta.signToken}`,
    viewUrl: `#/req/${meta.viewToken}`,
    expiresAt: meta.expiresAt,
  });
}

async function handleMeta(token: string): Promise<Response> {
  const found = await findRequest(token);
  if (!found) throw new HttpError(404, "rsign.notFound", "unknown request");
  return json(200, metaView(found.meta));
}

async function handlePdf(token: string): Promise<Response> {
  const found = await findRequest(token);
  if (!found) throw new HttpError(404, "rsign.notFound", "unknown request");
  if (statusOf(found.meta) === "expired") {
    throw new HttpError(410, "rsign.expired", "this request has expired");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(found.dir, "original.pdf"));
  } catch {
    // Cancelled (bytes wiped) — same honest answer as gone.
    throw new HttpError(404, "rsign.notFound", "no PDF held for this request");
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition("inline", found.meta.fileName),
      "content-length": String(bytes.length),
    },
  });
}

async function handleSign(token: string, req: Request): Promise<Response> {
  const found = await findRequest(token);
  if (!found || found.role !== "sign") {
    throw new HttpError(404, "rsign.notFound", "unknown request");
  }
  const status = statusOf(found.meta);
  if (status === "signed") {
    throw new HttpError(409, "rsign.alreadySigned", "already signed");
  }
  if (status === "expired") {
    throw new HttpError(410, "rsign.expired", "this request has expired");
  }
  if (status === "cancelled") {
    throw new HttpError(410, "rsign.cancelled", "this request was cancelled");
  }

  assertEnvelopeSize(req, MAX_SIGNED_ENVELOPE, "rsign.signed");

  // Double-sign race lock (audit P2-5): the old flow did an unlocked
  // read-check-write on meta.json — two concurrent signers BOTH passed
  // the "signed?" check, both wrote signed.pdf, and the loser's bytes
  // were silently overwritten (last-write-wins, both got success). An
  // O_EXCL ("wx") lock file closes the window; a stale lock (crashed
  // signer) auto-expires so a crash cannot wedge the request forever.
  const lockPath = path.join(found.dir, ".sign-lock");
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > SIGN_LOCK_STALE_MS) {
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  } catch {
    /* no lock yet — normal path */
  }
  try {
    await writeFile(lockPath, String(Date.now()), { flag: "wx" });
  } catch {
    throw new HttpError(
      409,
      "rsign.signingInProgress",
      "another signature is being submitted for this request"
    );
  }
  try {
    // Re-check status UNDER the lock — the pre-lock check raced.
    const fresh = JSON.parse(
      await readFile(path.join(found.dir, "meta.json"), "utf8")
    ) as Meta;
    const freshStatus = statusOf(fresh);
    if (freshStatus === "signed") {
      throw new HttpError(409, "rsign.alreadySigned", "already signed");
    }
    if (freshStatus !== "pending") {
      throw new HttpError(
        410,
        `rsign.${freshStatus}`,
        `this request is ${freshStatus}`
      );
    }

    const form = await req.formData().catch(() => {
      throw new HttpError(400, "rsign.formData", "expected multipart/form-data");
    });
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new HttpError(400, "rsign.needFile", "a PDF file is required");
    }
    const bytes = await readValidatedPdf(file, MAX_SIGNED_BYTES, "rsign.signed");

    // Write-then-rename: a reader never sees a half-written signed.pdf.
    const tmpPath = path.join(found.dir, ".signed.tmp");
    await writeFile(tmpPath, bytes);
    await rm(path.join(found.dir, "signed.pdf"), { force: true }).catch(
      () => undefined
    );
    await rename(tmpPath, path.join(found.dir, "signed.pdf"));
    const meta: Meta = { ...fresh, status: "signed" };
    await writeFile(path.join(found.dir, "meta.json"), JSON.stringify(meta), "utf8");
    console.log(`[request-sign] signed ${found.meta.id} (${bytes.length} B)`);
    return json(200, { ok: true, status: "signed" });
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function handleResult(token: string): Promise<Response> {
  const found = await findRequest(token);
  if (!found || found.role !== "view") {
    throw new HttpError(404, "rsign.notFound", "unknown request");
  }
  if (found.meta.status !== "signed") {
    throw new HttpError(404, "rsign.notSigned", "not signed yet");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(found.dir, "signed.pdf"));
  } catch {
    throw new HttpError(404, "rsign.notSigned", "signed bytes unavailable");
  }
  const name = found.meta.fileName.replace(/\.pdf$/i, "") + "-signed.pdf";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition("attachment", name),
      "content-length": String(bytes.length),
    },
  });
}

/** Cancel: wipe the bytes NOW, keep the (status: cancelled) meta for the
 *  expiry sweeper — both sides see an honest "cancelled" until expiry. */
async function handleCancel(token: string): Promise<Response> {
  const found = await findRequest(token);
  if (!found || found.role !== "view") {
    // Idempotent: unknown/already-gone requests report success.
    return json(200, { ok: true, status: "cancelled" });
  }
  await rm(path.join(found.dir, "original.pdf"), { force: true }).catch(
    () => undefined
  );
  await rm(path.join(found.dir, "signed.pdf"), { force: true }).catch(
    () => undefined
  );
  if (found.meta.status !== "cancelled") {
    const meta: Meta = { ...found.meta, status: "cancelled" };
    await writeFile(
      path.join(found.dir, "meta.json"),
      JSON.stringify(meta),
      "utf8"
    );
    console.log(`[request-sign] cancelled ${found.meta.id} (bytes wiped)`);
  }
  return json(200, { ok: true, status: "cancelled" });
}

/* -------------------------------- sweeper ------------------------------- */

let sweeping = false;
async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    let entries: string[] = [];
    try {
      entries = await readdir(DATA_DIR);
    } catch {
      return;
    }
    for (const id of entries) {
      const dir = path.join(DATA_DIR, id);
      try {
        const meta = JSON.parse(
          await readFile(path.join(dir, "meta.json"), "utf8")
        ) as Meta;
        if (Date.now() > meta.expiresAt) {
          await rm(dir, { recursive: true, force: true });
          tokenIndex.delete(meta.signToken);
          tokenIndex.delete(meta.viewToken);
          console.log(`[request-sign] expired → deleted ${id}`);
        }
      } catch {
        // Orphan (meta.json unreadable): leave brand-new dirs alone — a
        // legit create writes meta.json seconds after mkdir — but remove
        // anything stuck this way beyond the grace window. These used to
        // accumulate forever AND count against MAX_LIVE_ENVELOPES
        // (R19 audit P3).
        try {
          const st = await stat(dir);
          if (Date.now() - st.mtimeMs > ORPHAN_GRACE_MS) {
            await rm(dir, { recursive: true, force: true });
            console.log(`[request-sign] orphan → deleted ${id}`);
          }
        } catch {
          /* dir vanished mid-sweep — fine */
        }
      }
    }
  } finally {
    sweeping = false;
  }
}

/* --------------------------------- boot --------------------------------- */

await mkdir(DATA_DIR, { recursive: true });
setInterval(() => void sweep(), 60_000);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") {
        return json(200, { ok: true, service: "request-sign" });
      }

      // /requests (create) and /requests/<token>[/<action>]
      const parts = url.pathname.split("/").filter((p) => p !== "");
      if (parts[0] === "requests") {
        if (req.method === "POST" && parts.length === 1) {
          const ip = clientIp(req);
          if (rateLimited(ip, "create", CREATE_RATE_LIMIT, CREATE_RATE_WINDOW_MS)) {
            console.error(`[request-sign] 429 create rate-limited ${ip}`);
            return json(429, {
              error: "too many requests — try again later",
              code: "rsign.rateLimited",
            });
          }
          if ((await liveEnvelopeCount()) >= MAX_LIVE_ENVELOPES) {
            console.error(`[request-sign] 503 at envelope capacity`);
            return json(503, {
              error: "service at capacity — try again later",
              code: "rsign.capacity",
            });
          }
          return await handleCreate(req);
        }
        if (parts.length >= 2) {
          const token = parts[1];
          const action = parts[2] ?? "";

          if (req.method === "GET" && action === "meta") {
            return await handleMeta(token);
          }
          if (req.method === "GET" && action === "pdf") {
            return await handlePdf(token);
          }
          if (req.method === "POST" && action === "sign") {
            const ip = clientIp(req);
            if (rateLimited(ip, "sign", SIGN_RATE_LIMIT, SIGN_RATE_WINDOW_MS)) {
              console.error(`[request-sign] 429 sign rate-limited ${ip}`);
              return json(429, {
                error: "too many requests — try again later",
                code: "rsign.rateLimited",
              });
            }
            return await handleSign(token, req);
          }
          if (req.method === "GET" && action === "result") {
            return await handleResult(token);
          }
          if (req.method === "DELETE" && action === "") {
            return await handleCancel(token);
          }
        }
      }

      return json(404, { error: "not found", code: "rsign.route" });
    } catch (err) {
      if (err instanceof HttpError) {
        console.error(
          `[request-sign] ${req.method} ${url.pathname} → ${err.status} ${err.code}: ${err.message}`
        );
        return json(err.status, { error: err.message, code: err.code });
      }
      console.error("[request-sign] internal:", err);
      return json(500, { error: "internal error", code: "rsign.internal" });
    }
  },
});

console.log(`[request-sign] listening on :${PORT} (data: ${DATA_DIR})`);
export default {};
