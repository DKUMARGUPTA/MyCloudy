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
 * folder whose expiresAt is in the past — max 7 days, then deleted.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = 3032;
const DATA_DIR = path.join(import.meta.dir, "data");
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_SIGNED_BYTES = 30 * 1024 * 1024;
const HOURS_ALLOWED = new Set([24, 48, 168]);
const FROM_MAX = 80;
const MESSAGE_MAX = 500;
const PDF_MAGIC = "%PDF-";
/** 24 random bytes hex — 48 chars, never path-relevant. */
const TOKEN_RE = /^[0-9a-f]{48}$/;

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

/** Linear meta.json scan — fine at this scale (short-lived envelopes only). */
async function findRequest(token: string): Promise<Found | null> {
  if (!TOKEN_RE.test(token)) return null;
  let entries: string[];
  try {
    entries = await readdir(DATA_DIR);
  } catch {
    return null;
  }
  for (const id of entries) {
    const dir = path.join(DATA_DIR, id);
    try {
      const meta = JSON.parse(
        await readFile(path.join(dir, "meta.json"), "utf8")
      ) as Meta;
      if (meta.signToken === token) return { dir, meta, role: "sign" };
      if (meta.viewToken === token) return { dir, meta, role: "view" };
    } catch {
      // Unreadable half-written folder — skip, never crash the scan.
    }
  }
  return null;
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

  const form = await req.formData().catch(() => {
    throw new HttpError(400, "rsign.formData", "expected multipart/form-data");
  });
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "rsign.needFile", "a PDF file is required");
  }
  const bytes = await readValidatedPdf(file, MAX_SIGNED_BYTES, "rsign.signed");

  await writeFile(path.join(found.dir, "signed.pdf"), bytes);
  const meta: Meta = { ...found.meta, status: "signed" };
  await writeFile(path.join(found.dir, "meta.json"), JSON.stringify(meta), "utf8");
  console.log(`[request-sign] signed ${found.meta.id} (${bytes.length} B)`);
  return json(200, { ok: true, status: "signed" });
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
          console.log(`[request-sign] expired → deleted ${id}`);
        }
      } catch {
        // Unreadable folder — not ours to delete blindly.
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
