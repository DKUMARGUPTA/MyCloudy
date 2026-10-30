/**
 * Sidocs convert mini-service (P9-B/C) — LibreOffice + Ghostscript +
 * poppler + headless Chrome wrapper for the Mode S tools.
 *
 *   POST /convert            multipart/form-data
 *     file   — the uploaded document (omitted for webpage2pdf)
 *     action — office2pdf | pdf2office | pdf2svg | pdf2pdfa |
 *              webpage2pdf | html2pdf
 *     format — target for pdf2office (docx|xlsx|pptx|odt|html|png-jpg...)
 *     url    — http(s) URL for webpage2pdf
 *     params — JSON string: {dpi, quality, pdfaLevel, scale, timeoutMs…}
 *   GET /health
 *
 * Success: raw converted bytes, Content-Type + X-Convert-Name headers.
 * Failure: JSON {error, code, detail} with the right status.
 *
 * Hard rules: job-scoped temp dirs (always cleaned), 30 MB upload cap
 * (Content-Length pre-checked BEFORE the body is buffered), URL scheme
 * allow-list (http/https), SSRF guard on webpage2pdf (DNS resolve +
 * refuse loopback/private/link-local — same policy as /api/fetch-page,
 * pinned via --host-resolver-rules so Chrome cannot be DNS-rebound),
 * per-IP rate limit, global concurrency cap, per-action timeouts, one
 * soffice job at a time (isolated -env:UserInstallation profiles), no
 * shell interpolation of user strings (execFile-style arrays only).
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkResolvedIps, validatePageUrl } from "../../tools/webpage-to-pdf/url-guard";

const PORT = 3031;
const MAX_BYTES = 30 * 1024 * 1024;
/** Multipart envelope overhead (boundaries, field names, encoding). */
const MAX_ENVELOPE_BYTES = MAX_BYTES + 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
/** Total stdout/stderr kept per child process — chatty converters must
 * not grow memory without bound (audit S5). */
const MAX_CHILD_OUTPUT = 64 * 1024;
/** Per-IP sliding window for POST /convert (audit S3). */
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 10 * 60_000;
/** Max simultaneously-running conversion jobs (audit S3 — parallel gs /
 * Chrome / pdftocairo jobs could otherwise exhaust CPU/RAM). soffice is
 * separately serialized. */
const MAX_CONCURRENT_JOBS = 4;

/** Locate the newest installed Chrome binary under a puppeteer cache
 * dir — the old hardcoded "linux-155.0.8059.39" path went stale the day
 * the cache updated to 156 and every webpage2pdf/html2pdf run died with
 * ENOENT (found during R19 Phase 2 testing). Picks the lexicographically
 * highest version dir; fails honestly at spawn time when absent. */
function findChromeBinary(cacheDir: string, inner: string): string {
  try {
    const versions = readdirSync(cacheDir)
      .filter((name) => name.startsWith("linux-"))
      .sort();
    const latest = versions[versions.length - 1];
    if (latest) return `${cacheDir}/${latest}/${inner}`;
  } catch {
    /* fall through to the legacy path */
  }
  return `${cacheDir}/linux-155.0.8059.39/${inner}`;
}

const PUPPETEER_CACHE = `${process.env.HOME}/.cache/puppeteer`;
const CHROME = findChromeBinary(
  `${PUPPETEER_CACHE}/chrome`,
  "chrome-linux64/chrome"
);
const CHROME_HEADLESS = findChromeBinary(
  `${PUPPETEER_CACHE}/chrome-headless-shell`,
  "chrome-headless-shell-linux64/chrome-headless-shell"
);

type Params = {
  dpi?: number;
  pdfaLevel?: 1 | 2 | 3;
  scale?: number;
  timeoutMs?: number;
  landscape?: boolean;
};

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

/** Client IP — the gateway (Caddy) overwrites X-Real-IP with the actual
 * remote host, so it cannot be spoofed THROUGH the gateway; direct
 * loopback connections are local by definition. */
function clientIp(req: Request): string {
  const ip = req.headers.get("x-real-ip");
  return ip && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : "direct";
}

const hits = new Map<string, number[]>();

/** Sliding-window per-IP rate limit for expensive endpoints. */
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

let activeJobs = 0;

/** Refuse the body BEFORE buffering it when the declared size is already
 * over the cap (audit S3 — the old check fired only after req.formData()
 * had fully absorbed a multi-GB upload into memory). */
function assertEnvelopeSize(req: Request): void {
  const declared = req.headers.get("content-length");
  if (declared === null) return; // chunked — post-parse checks still apply
  const n = Number(declared);
  if (Number.isFinite(n) && n > MAX_ENVELOPE_BYTES) {
    throw new HttpError(
      413,
      "convert.tooLarge",
      `request body over ${Math.round(MAX_ENVELOPE_BYTES / (1024 * 1024))} MB`
    );
  }
}

/** execFile-style: no shell, argv array only. */
function run(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HttpError(504, "convert.timeout", `${path.basename(cmd)} timed out`));
    }, timeoutMs);
    // Total cap per stream (audit S5) — chatty soffice/gs jobs used to
    // grow stdout without bound (the per-chunk slice capped chunks, not
    // the accumulation).
    child.stdout.on("data", (d) => {
      if (stdout.length >= MAX_CHILD_OUTPUT) return;
      stdout += d.toString().slice(0, MAX_CHILD_OUTPUT - stdout.length);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length >= MAX_CHILD_OUTPUT) return;
      stderr += d.toString().slice(0, MAX_CHILD_OUTPUT - stderr.length);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HttpError(500, "convert.spawn", String(err)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new HttpError(422, "convert.failed", `${path.basename(cmd)} exit ${code}: ${stderr.slice(0, 500)}`)
        );
    });
  });
}

/** Find the single output LibreOffice produced in `dir` (extension filtered). */
async function pickOutput(dir: string, wantExt?: string): Promise<string> {
  const entries = await readdir(dir);
  const filtered = wantExt
    ? entries.filter((f) => f.toLowerCase().endsWith(wantExt.toLowerCase()))
    : entries.filter((f) => !f.startsWith("."));
  if (filtered.length === 0)
    throw new HttpError(422, "convert.noOutput", "converter produced no output");
  if (filtered.length > 1)
    throw new HttpError(422, "convert.ambiguous", `multiple outputs: ${filtered.join(", ")}`);
  return path.join(dir, filtered[0]);
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** ONE soffice conversion at a time (profile contention otherwise). */
let sofficeChain: Promise<unknown> = Promise.resolve();
function queueSoffice(job: () => Promise<string>): Promise<string> {
  const next = sofficeChain.then(job, job);
  sofficeChain = next.catch(() => undefined);
  return next;
}

async function soffice(
  input: string,
  outDir: string,
  convertTo: string,
  timeoutMs: number,
  importFilter?: string
): Promise<string> {
  const profile = await mkdtemp(path.join(tmpdir(), "lo-"));
  const outExt = convertTo.split(":")[0];
  try {
    return await queueSoffice(() =>
      run(
        "soffice",
        [
          "--headless",
          "--norestore",
          `-env:UserInstallation=file://${profile}`,
          ...(importFilter ? [`--infilter=${importFilter}`] : []),
          "--convert-to",
          convertTo,
          "--outdir",
          outDir,
          input,
        ],
        timeoutMs
      ).then(() => pickOutput(outDir, `.${outExt}`))
    );
  } finally {
    void rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

const OFFICE_IN = new Set([
  ".doc", ".docx", ".rtf", ".odt", ".txt", ".xls", ".xlsx", ".ods", ".csv",
  ".ppt", ".pptx", ".odp", ".epub", ".htm", ".html", ".pub", ".wpd", ".xml",
]);

async function handleConvert(req: Request): Promise<Response> {
  assertEnvelopeSize(req);
  const form = await req.formData().catch(
    () => {
      throw new HttpError(400, "convert.formData", "expected multipart/form-data");
    }
  );
  const action = String(form.get("action") ?? "");
  const format = String(form.get("format") ?? "");
  const urlField = String(form.get("url") ?? "");
  let params: Params = {};
  const rawParams = form.get("params");
  if (typeof rawParams === "string" && rawParams !== "") {
    try {
      params = JSON.parse(rawParams) as Params;
    } catch {
      throw new HttpError(400, "convert.params", "params must be JSON");
    }
  }
  const timeoutMs = Math.min(180_000, Math.max(10_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  const file = form.get("file");
  const jobDir = await mkdtemp(path.join(tmpdir(), "sidocs-"));
  try {
    let input = "";
    if (file instanceof File) {
      if (file.size > MAX_BYTES)
        throw new HttpError(413, "convert.tooLarge", `over 30 MB (${file.size})`);
      const ext = path.extname(file.name).toLowerCase();
      if (!/^[a-z0-9]{1,9}$/i.test(ext.replace(".", "")))
        throw new HttpError(400, "convert.badExt", `bad extension "${ext}"`);
      // Keep the ORIGINAL file name (sanitized) so the converted output
      // is named after the user's file, not the temp name.
      const safeBase = path
        .basename(file.name, ext)
        .replace(/[^a-zA-Z0-9._ -]/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 80) || "document";
      input = path.join(jobDir, `${safeBase}${ext || ".bin"}`);
      await writeFile(input, Buffer.from(await file.arrayBuffer()));

      if (action === "office2pdf") {
        if (!OFFICE_IN.has(ext))
          throw new HttpError(415, "convert.unsupported", `unsupported input ${ext}`);
        const out = await soffice(input, jobDir, "pdf", timeoutMs);
        return fileResponse(out, "pdf");
      }
      if (action === "pdf2office") {
        if (ext !== ".pdf") throw new HttpError(415, "convert.needPdf", "input must be a PDF");
        const fmt = ["docx", "xlsx", "pptx", "odt", "html"].includes(format) ? format : "docx";
        // The PDF import filters MUST ride --infilter (convert-to filter
        // syntax alone silently re-emits the input PDF unchanged).
        // calc_pdf_import is broken in LibreOffice 25.2 ("no export
        // filter") — pdf→xlsx goes pdftotext -layout → CSV → Calc instead.
        if (fmt === "xlsx") {
          // calc_pdf_import is broken in LibreOffice 25.2 — pdf→xlsx goes
          // pdftotext -layout → CSV cells (2+ space columns) → Calc.
          const txt = path.join(jobDir, "table.txt");
          await run("pdftotext", ["-layout", "-enc", "UTF-8", input, txt], timeoutMs);
          const lines = (await readFile(txt, "utf8")).split("\n");
          const csv = path.join(jobDir, "table.csv");
          const cell = (v: string) => `"${v.trim().replace(/"/g, '""')}"`;
          const rows = lines
            .filter((l) => l.trim() !== "")
            .map((l) => l.split(/\s{2,}/).filter((c) => c.trim() !== "").map(cell).join(","));
          await writeFile(csv, rows.join("\n") + "\n", "utf8");
          const out = await soffice(csv, jobDir, "xlsx:Calc MS Excel 2007 XML", timeoutMs);
          return fileResponse(out, "xlsx");
        }
        const importFilter =
          fmt === "pptx" ? "impress_pdf_import" : "writer_pdf_import";
        const out = await soffice(input, jobDir, fmt, timeoutMs, importFilter);
        return fileResponse(out, fmt);
      }
      if (action === "pdf2svg") {
        if (ext !== ".pdf") throw new HttpError(415, "convert.needPdf", "input must be a PDF");
        const out = path.join(jobDir, "out.svg");
        await run("pdftocairo", ["-svg", "-f", "1", "-l", "1", input, out], timeoutMs);
        return fileResponse(out, "svg");
      }
      if (action === "pdf2pdfa") {
        if (ext !== ".pdf") throw new HttpError(415, "convert.needPdf", "input must be a PDF");
        const level = params.pdfaLevel === 1 || params.pdfaLevel === 3 ? params.pdfaLevel : 2;
        const out = path.join(jobDir, "out.pdf");
        // RGB strategy (NOT UseDeviceIndependentColor — gs refuses it:
        // "cannot guarantee creating a conformant PDF/A file … reverting
        // to normal output"). OutputIntent is optional at -2B without
        // device-dependent colour; pdfaid XMP + RGB conversion is what
        // gs produces for a conformant PDF/A-2B document.
        await run(
          "gs",
          [
            `-dPDFA=${level}`,
            "-dBATCH", "-dNOPAUSE",
            "-sColorConversionStrategy=RGB",
            "-sDEVICE=pdfwrite",
            "-dPDFACompatibilityPolicy=1",
            `-sOutputFile=${out}`,
            input,
          ],
          timeoutMs
        );
        return fileResponse(out, "pdf");
      }
      if (action === "html2pdf") {
        const out = path.join(jobDir, "out.pdf");
        // Landscape comes from the HTML itself (@page { size: A4
        // landscape }) — the CLI has no landscape switch. The old
        // `landscape ? "--print-to-pdf" : "--print-to-pdf"` ternary was
        // a silent no-op (audit P3, removed).
        await run(
          CHROME,
          [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--no-pdf-header-footer",
            `--print-to-pdf=${out}`,
            `file://${input}`,
          ],
          timeoutMs
        );
        return fileResponse(out, "pdf");
      }
      throw new HttpError(400, "convert.action", `unknown action "${action}" for file input`);
    }

    // No file — the URL-driven actions.
    if (action === "webpage2pdf") {
      // SSRF guard (audit S2) — same policy as /api/fetch-page:
      //   1. strict http(s) URL parse (validatePageUrl),
      //   2. DNS-resolve EVERY address and require them all public
      //      (loopback / private / link-local / ULA / v4-mapped refused,
      //      fail-closed on unparseable),
      //   3. pin Chrome to the validated IP via --host-resolver-rules so
      //      a rebinding attack between check and fetch cannot retarget
      //      the browser at a private address for THIS hostname.
      // Residual (documented): Chrome follows redirects itself; a
      // redirect to a DIFFERENT hostname resolves fresh. Acceptable here
      // — the only inward services are these two mini-services.
      const check = validatePageUrl(urlField);
      if (!check.ok) throw new HttpError(400, "convert.url", "invalid URL");
      const target = check.url;
      let addresses: string[];
      try {
        const resolved = await lookup(
          target.hostname.replace(/^\[|\]$/g, ""),
          { all: true }
        );
        addresses = resolved.map((entry) => entry.address);
      } catch {
        throw new HttpError(400, "convert.url", "hostname could not be resolved");
      }
      const guard = checkResolvedIps(addresses);
      if (!guard.ok) {
        throw new HttpError(
          403,
          "convert.urlPrivate",
          "target host is not publicly reachable"
        );
      }
      const out = path.join(jobDir, "out.pdf");
      await run(
        CHROME_HEADLESS,
        [
          "--no-sandbox",
          "--disable-gpu",
          "--no-pdf-header-footer",
          `--host-resolver-rules=MAP ${target.hostname} ${addresses[0]}`,
          `--print-to-pdf=${out}`,
          target.href,
        ],
        timeoutMs
      );
      return fileResponse(out, "pdf");
    }
    throw new HttpError(400, "convert.input", "action needs a file or a url");
  } finally {
    void rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fileResponse(outPath: string, kind: string): Promise<Response> {
  // A tiny retry: some filesystems surface readdir entries before the
  // converter's final rename fully lands (observed with soffice on /tmp).
  let bytes: Buffer | null = null;
  let lastErr: unknown = null;
  for (let i = 0; i < 4 && bytes === null; i += 1) {
    try {
      bytes = await readFile(outPath);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (bytes === null) {
    console.error(`[convert] unreadable output ${outPath}`, lastErr);
    try {
      console.error(`[convert] dir now:`, await readdir(path.dirname(outPath)));
    } catch {
      /* best effort */
    }
    throw new HttpError(422, "convert.vanished", "output vanished before read");
  }
  if (bytes.length === 0) throw new HttpError(422, "convert.empty", "empty output");
  const name = path.basename(outPath);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": MIME[path.extname(outPath)] ?? "application/octet-stream",
      "x-convert-name": encodeURIComponent(name),
      "x-convert-kind": kind,
      "content-length": String(bytes.length),
    },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    try {
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, service: "convert" }), {
          headers: { "content-type": "application/json", ...cors },
        });
      }
      if (url.pathname === "/convert" && req.method === "POST") {
        const ip = clientIp(req);
        if (rateLimited(ip)) {
          console.error(`[convert] 429 rate-limited ${ip}`);
          return json(429, {
            code: "convert.rateLimited",
            detail: `over ${RATE_LIMIT} conversions per 10 minutes`,
          });
        }
        if (activeJobs >= MAX_CONCURRENT_JOBS) {
          console.error(`[convert] 503 busy (${activeJobs} jobs running)`);
          return new Response(
            JSON.stringify({
              code: "convert.busy",
              detail: "too many conversions are running — retry shortly",
            }),
            {
              status: 503,
              headers: {
                "content-type": "application/json",
                "retry-after": "5",
                ...cors,
              },
            }
          );
        }
        activeJobs += 1;
        let res: Response;
        try {
          res = await handleConvert(req);
        } finally {
          activeJobs -= 1;
        }
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return res;
      }
      return json(404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) {
        console.error(`[convert] ${req.method} ${url.pathname} → ${err.status} ${err.code}: ${err.message}`);
        return json(err.status, { code: err.code, detail: err.message });
      }
      console.error(`[convert] internal:`, err);
      // Generic message only (audit P3) — String(err) can leak absolute
      // paths and stack snippets to a public endpoint. The full error
      // stays in the service log above.
      return json(500, { code: "convert.internal", detail: "internal error" });
    }
  },
});

console.log(`[convert] listening on :${PORT}`);
export default {};
