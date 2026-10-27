/**
 * Shared server-convert proxy worker (P9-B/C) — the thin bridge every
 * Mode S conversion tool uses. The heavy lifting happens in the
 * LibreOffice + Ghostscript + poppler mini-service (mini-services/
 * convert, port 3031); this worker only:
 *
 *   1. maps the run's toolId to a service action (+format/params),
 *   2. forwards the file as multipart form-data through the gateway
 *      (`/convert?XTransformPort=3031` — the ONLY cross-port pattern
 *      the sandbox Caddy gateway accepts),
 *   3. surfaces progress and maps service errors honestly.
 *
 * Privacy note (kept honest in every tool's FAQ): these tools are
 * Server-assisted (Mode S) — the file does travel to Sidocs's own
 * converter process; nothing else, no third party, no storage.
 */
import type {
  WorkerRunRequest,
  WorkerResponse,
  RunStage,
} from "@/lib/workers/protocol";

/**
 * Workers cannot fetch RELATIVE URLs — their location is the chunk URL,
 * not the app origin, and "…/…?XTransformPort=3031" fails to parse. We
 * absolutize against the worker's own origin (same-origin chunk).
 */
const SERVICE_URL = new URL("/convert?XTransformPort=3031", self.location.origin).href;

interface ToolSpecEntry {
  action: "office2pdf" | "pdf2office" | "pdf2svg" | "pdf2pdfa" | "html2pdf";
  format?: string;
  outputExt: string;
  mime: string;
  /** Options keys forwarded into the service params JSON. */
  paramKeys?: string[];
}

const TOOL_SPECS: Record<string, ToolSpecEntry> = {
  "word-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "excel-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "powerpoint-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "odt-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "rtf-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "epub-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "publisher-to-pdf": { action: "office2pdf", outputExt: "pdf", mime: "application/pdf" },
  "html-to-pdf": { action: "html2pdf", outputExt: "pdf", mime: "application/pdf", paramKeys: ["landscape"] },
  "pdf-to-word": { action: "pdf2office", format: "docx", outputExt: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "pdf-to-excel": { action: "pdf2office", format: "xlsx", outputExt: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  "pdf-to-powerpoint": { action: "pdf2office", format: "pptx", outputExt: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  "pdf-to-odt": { action: "pdf2office", format: "odt", outputExt: "odt", mime: "application/vnd.oasis.opendocument.text" },
  "pdf-to-svg": { action: "pdf2svg", outputExt: "svg", mime: "image/svg+xml" },
  "pdf-to-pdfa": { action: "pdf2pdfa", outputExt: "pdf", mime: "application/pdf", paramKeys: ["pdfaLevel"] },
};

type ProxyResponse =
  | { type: "progress"; runId: number; pct: number; stage: RunStage }
  | {
      type: "result";
      runId: number;
      outputs: { name: string; mime: string; blob: Blob }[];
      detail: { files: number };
    }
  | { type: "error"; runId: number; code: string; detail?: string };

function post(response: ProxyResponse): void {
  self.postMessage(response as unknown as WorkerResponse);
}

/** "my-file.docx" + "pdf" → "my-file.pdf" (keeps the base, honest rename). */
function swapExtension(name: string, ext: string): string {
  const base = name.replace(/\.[a-z0-9]{1,9}$/i, "");
  return `${base || "document"}.${ext}`;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const spec = TOOL_SPECS[request.toolId];
  if (!spec) {
    post({ type: "error", runId, code: "tool.errorGeneric", detail: `unknown server tool ${request.toolId}` });
    return;
  }
  try {
    if (request.files.length === 0) {
      post({ type: "error", runId, code: "tool.errorNoFiles", detail: "no files" });
      return;
    }
    post({ type: "progress", runId, pct: 15, stage: "reading" });

    // Sequential, one file at a time — the service itself queues
    // LibreOffice anyway; this keeps progress meaningful.
    const outputs: { name: string; mime: string; blob: Blob }[] = [];
    for (let i = 0; i < request.files.length; i += 1) {
      const file = request.files[i];
      const params: Record<string, unknown> = {};
      for (const key of spec.paramKeys ?? []) {
        const v = request.options[key];
        if (v !== undefined && v !== null && v !== "") params[key] = v;
      }
      const form = new FormData();
      form.append("action", spec.action);
      if (spec.format) form.append("format", spec.format);
      if (Object.keys(params).length > 0) form.append("params", JSON.stringify(params));
      form.append("file", file, file.name);

      const res = await fetch(SERVICE_URL, { method: "POST", body: form });
      if (!res.ok) {
        let code = "tool.errorGeneric";
        let detail = `service HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { code?: string; detail?: string };
          if (body.code) code = body.code;
          if (body.detail) detail = body.detail;
        } catch {
          /* non-JSON error body */
        }
        post({ type: "error", runId, code, detail: `${file.name}: ${detail}` });
        return;
      }
      const blob = await res.blob();
      const headerName = res.headers.get("x-convert-name");
      const outName =
        headerName !== null && decodeURIComponent(headerName).includes(".")
          ? decodeURIComponent(headerName)
          : swapExtension(file.name, spec.outputExt);
      outputs.push({ name: outName, mime: spec.mime, blob });
      post({
        type: "progress",
        runId,
        pct: 20 + Math.round(((i + 1) / request.files.length) * 65),
        stage: "processing",
      });
    }

    post({ type: "progress", runId, pct: 90, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs,
      detail: { files: outputs.length },
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
