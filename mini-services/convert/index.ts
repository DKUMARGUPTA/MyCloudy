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
 * Hard rules: job-scoped temp dirs (always cleaned), 30 MB upload cap,
 * URL scheme allow-list (http/https), per-action timeouts, one soffice
 * job at a time (isolated -env:UserInstallation profiles), no shell
 * interpolation of user strings (execFile-style arrays only).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3031;
const MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const CHROME = `${process.env.HOME}/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome`;
const CHROME_HEADLESS = `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.39/chrome-headless-shell-linux64/chrome-headless-shell`;

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
    child.stdout.on("data", (d) => (stdout += d.toString().slice(0, 4000)));
    child.stderr.on("data", (d) => (stderr += d.toString().slice(0, 4000)));
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
        await run(
          CHROME,
          [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--no-pdf-header-footer",
            params.landscape ? "--print-to-pdf" : "--print-to-pdf",
            `--print-to-pdf=${out}`,
            `file://${input}`,
          ].filter((a, i, arr) => a !== "--print-to-pdf" || i === arr.indexOf(a)),
          timeoutMs
        );
        return fileResponse(out, "pdf");
      }
      throw new HttpError(400, "convert.action", `unknown action "${action}" for file input`);
    }

    // No file — the URL-driven actions.
    if (action === "webpage2pdf") {
      let target: URL;
      try {
        target = new URL(urlField);
      } catch {
        throw new HttpError(400, "convert.url", "invalid URL");
      }
      if (target.protocol !== "http:" && target.protocol !== "https:")
        throw new HttpError(400, "convert.url", "only http/https are allowed");
      const out = path.join(jobDir, "out.pdf");
      await run(
        CHROME_HEADLESS,
        [
          "--no-sandbox",
          "--disable-gpu",
          "--no-pdf-header-footer",
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
        const res = await handleConvert(req);
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
      return json(500, { code: "convert.internal", detail: String(err) });
    }
  },
});

console.log(`[convert] listening on :${PORT}`);
export default {};
