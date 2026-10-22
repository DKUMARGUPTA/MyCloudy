import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfjsInWorker, workerDocumentShim } from "../pdfjs-common/worker-lib";
import {
  buildReportText,
  MAX_INPUT_BYTES,
  outputBaseName,
  parseRun,
  parseXml,
  runChecks,
  sniffInput,
  takeCii,
  type ReportMeta,
} from "./model";
import type { ValidateDetail } from "./types";

/**
 * Validate e-invoice worker (RB5-e, device mode) — the honest CII checker.
 *
 * The whole pipeline is PURE in model.ts (bun-smoke-tested); this file is
 * the I/O boundary:
 *
 *  1. sniff the input's magic bytes (shared sniffInput — the surface
 *     previews with the SAME code, so preview and run can never disagree):
 *     "%PDF-" → PDF mode, "<…" (<?xml prolog / <rsm / any element) → XML
 *     mode, anything else → the honest vei.errNotXml rejection;
 *  2. PDF mode: pdf.js getDocument + getAttachments — the embedded XML is
 *     picked by name priority (factur-x.xml → zugferd-invoice.xml →
 *     xrechnung.xml → invoice.xml → cii.xml → any *.xml); a PDF with no
 *     XML attachment fails honestly with vei.errNoAttachment (the found
 *     names ride the error detail). The XMP /ConformanceLevel claim, when
 *     parseable, feeds the informational conformance cross-check;
 *  3. parseXml (self-contained, namespace-tolerant — DOMParser is not
 *     worker-safe on every target, so worker and smoke share THIS parser)
 *     → takeCii → runChecks → buildReportText;
 *  4. the result is a deterministic plain-text validation report (.txt —
 *     no JSON fabrication) + the full ValidationReport in the run detail
 *     so the surface can render the checklist without re-parsing.
 *
 * Error mapping:
 *   vei.errNotXml       neither a PDF nor an XML document
 *   vei.errNoAttachment PDF without any embedded XML attachment
 *   vei.errXmlParse     XML that would not parse at all
 *   vei.errTooBig       embedded/raw XML beyond the 20 MB sanity gate
 *   tool.errorEncrypted password-protected PDF (validate is not crack)
 *   tool.errorCorrupt   PDF pdf.js cannot open
 *   tool.errorGeneric   no file / unexpected failure
 *
 * Device-only: the File arrives by structured clone, the report Blob goes
 * back — nothing touches the network.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Attachment name priority (Factur-X first, ZUGFeRD close behind). */
const PREFERRED_XML_NAMES = [
  "factur-x.xml",
  "zugferd-invoice.xml",
  "xrechnung.xml",
  "invoice.xml",
  "cii.xml",
];

interface PickedAttachment {
  name: string;
  content: Uint8Array;
}

/**
 * pickXmlAttachment — deterministic: exact name priority first, then any
 * *.xml attachment (alphabetical, so the pick is stable), else null.
 */
export function pickXmlAttachment(
  attachments: Record<string, { content?: unknown }> | null | undefined
): PickedAttachment | null {
  if (attachments === null || typeof attachments !== "object") return null;
  const entries = Object.entries(attachments);
  if (entries.length === 0) return null;
  const byLower = new Map(
    entries.map(([k, v]) => [k.toLowerCase(), { name: k, value: v }])
  );
  for (const want of PREFERRED_XML_NAMES) {
    const hit = byLower.get(want);
    if (hit !== undefined) {
      const content = hit.value?.content;
      if (content instanceof Uint8Array) {
        return { name: hit.name, content };
      }
    }
  }
  const xmlKeys = entries
    .filter(([k, v]) => k.toLowerCase().endsWith(".xml") && v?.content instanceof Uint8Array)
    .map(([k, v]) => ({ name: k, content: v.content as Uint8Array }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return xmlKeys.length > 0 ? xmlKeys[0] : null;
}

/** The names present (for the honest error detail). */
function attachmentNames(
  attachments: Record<string, unknown> | null | undefined
): string {
  if (attachments === null || typeof attachments !== "object") return "";
  return Object.keys(attachments).join(", ");
}

/** BOM-aware XML decode (UTF-8 default, UTF-16 by BOM — honest scope). */
export function decodeXmlText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** XMP /ConformanceLevel claim ("EN 16931", "BASIC WL" …) or null. */
export function conformanceFromXmp(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  // iOS-safe: no lookbehind; the prefix backreference keeps it symmetric.
  const m = /<([A-Za-z][\w.-]*):ConformanceLevel>\s*([^<]{1,48}?)\s*<\/\1:ConformanceLevel>/.exec(
    raw
  );
  return m === null ? null : m[2];
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const opts = parseRun(String(request.options.run ?? ""));
  post({ type: "progress", runId, pct: 15, stage: "reading" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffInput(bytes);

  let xmlBytes: Uint8Array;
  let meta: ReportMeta = {
    fileName: file.name,
    bytes: bytes.length,
    mode: kind === "pdf" ? "pdf" : "xml",
    attachmentName: null,
    xmpClaim: null,
  };

  if (kind === "unknown") {
    post({
      type: "error",
      runId,
      code: "vei.errNotXml",
      detail: file.name,
    });
    return;
  }

  if (kind === "pdf") {
    /* ---------- Factur-X/ZUGFeRD extraction ---------- */
    const pdfjs = await loadPdfjsInWorker();
    post({ type: "progress", runId, pct: 35, stage: "reading" });

    let pdf: PDFDocumentProxy | null = null;
    try {
      pdf = await pdfjs.getDocument({
        data: bytes.slice(),
        ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
      }).promise;
    } catch (error) {
      const text = `${error instanceof Error ? error.name : ""} ${
        error instanceof Error ? error.message : String(error)
      }`;
      post({
        type: "error",
        runId,
        code: /password|encrypt/i.test(text)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const attachments = await pdf.getAttachments();
    const picked = pickXmlAttachment(
      attachments as Record<string, { content?: unknown }> | null
    );
    if (picked === null) {
      pdf.cleanup();
      post({
        type: "error",
        runId,
        code: "vei.errNoAttachment",
        detail: attachmentNames(attachments as Record<string, unknown> | null),
      });
      return;
    }
    xmlBytes = picked.content.slice(); // copy — pdf.js owns the transport buffer

    let xmpClaim: string | null = null;
    try {
      const md = (await pdf.getMetadata()) as {
        metadata?: { getRaw?: () => string | null } | null;
      };
      xmpClaim = conformanceFromXmp(
        typeof md?.metadata?.getRaw === "function" ? md.metadata.getRaw() : null
      );
    } catch {
      xmpClaim = null; // honest: unreadable XMP just skips the cross-check
    }
    meta = { ...meta, attachmentName: picked.name, xmpClaim };
    pdf.cleanup();
    post({ type: "progress", runId, pct: 55, stage: "processing" });
  } else {
    xmlBytes = bytes;
    post({ type: "progress", runId, pct: 40, stage: "processing" });
  }

  if (xmlBytes.length > MAX_INPUT_BYTES) {
    post({ type: "error", runId, code: "vei.errTooBig", detail: file.name });
    return;
  }

  const xml = decodeXmlText(xmlBytes);
  const tree = parseXml(xml);
  if (tree === null) {
    post({
      type: "error",
      runId,
      code: "vei.errXmlParse",
      detail: file.name,
    });
    return;
  }

  const fields = takeCii(tree);
  const result = runChecks(fields, { xmpClaim: meta.xmpClaim });
  const report = {
    verdict: result.verdict,
    checks: result.checks,
    totals: result.totals,
  };
  post({ type: "progress", runId, pct: 80, stage: "processing" });

  const text = buildReportText(report, meta, opts.labels);
  post({ type: "progress", runId, pct: 92, stage: "saving" });

  const name = `${outputBaseName(file.name, opts.locale, opts.fileWord)}-validation-report.txt`;
  const detail: ValidateDetail = {
    files: 1,
    verdict: result.verdict,
    checksPassed: result.checks.filter((c) => c.status === "pass").length,
    checksWarned: result.checks.filter((c) => c.status === "warn").length,
    checksFailed: result.checks.filter((c) => c.status === "fail").length,
    lineCount: fields.lines.length,
    inputMode: kind === "pdf" ? "pdf" : "xml",
    attachmentName: meta.attachmentName ?? undefined,
    xmpClaim: meta.xmpClaim ?? undefined,
    report,
  };

  post({
    type: "result",
    runId,
    outputs: [
      {
        name,
        mime: "text/plain;charset=utf-8",
        blob: new Blob([text], { type: "text/plain;charset=utf-8" }),
      },
    ],
    detail,
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  });
};
