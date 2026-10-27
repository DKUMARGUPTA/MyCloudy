import {
  PdfError,
  organizeMerge,
  parseForOrganize,
  type MergePlanEntry,
  type OrganizeSource,
} from "@/lib/own/pdf";
import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Merge PDF — device-only worker (PRD §8.1).
 *
 * P6-d: runs 100% on OUR OWN PDF micro-engine (src/lib/own/pdf — zero
 * external code). Each input file is parsed ONCE (typed refusal for
 * encrypted inputs — the R6-b structural probe, never a raw-bytes sniff —
 * and typed corrupt errors naming the exact file); every selected page is
 * then rebuilt through the shared multi-document reachable-set union with
 * byte-exact content passthrough. Real progress per file and per page;
 * typed error codes for the UI's i18n toasts. Never touches the network.
 *
 * Options and outputs are IDENTICAL to the pdf-lib era:
 *   - per-file page ranges ("1-3, 5" per workspace file id)
 *   - optional blank A4 page between files (595.28 × 841.89 — the exact
 *     pdf-lib addPage() default, so old and new outputs size alike)
 *   - outputName override + unsafe-char sanitisation
 *
 * `flatten` is a documented STRUCTURAL NO-OP on this engine: the writer
 * never carries the document-level AcroForm catalog entry, so the merged
 * output is always non-interactive (fields render from their widget /Annots
 * appearance streams, which ARE copied) — the flatten switch asks for
 * exactly that end state and needs no extra work. Same behavior class as
 * the old "best effort" promise; complex forms no longer "keep" live
 * fields because none are carried.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function sanitizeOutputName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return fallback;
  const withExt = cleaned.toLowerCase().endsWith(".pdf")
    ? cleaned
    : `${cleaned}.pdf`;
  return withExt.slice(0, 150);
}

interface FileRangeMap {
  [fileId: string]: string;
}

function parseRangeMap(raw: unknown): FileRangeMap {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: FileRangeMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Maps an own-engine failure to the worker's i18n error code. */
function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, fileIds } = request;
  const blankBetween = options.blankBetween === true;
  const outputNameRaw =
    typeof options.outputName === "string" ? options.outputName : "";
  const rangeMap = parseRangeMap(options.fileRanges);

  const total = files.length;
  const sources: OrganizeSource[] = [];
  /** Per-file resolved 0-based page indices, aligned with `sources`. */
  const perFileIndices: number[][] = [];

  // ── Parse phase: ONE typed parse per file (R6-b honesty — the
  // encrypted/corrupt toast names the file that stopped the run). ──
  for (let index = 0; index < total; index += 1) {
    const file = files[index];
    post({
      type: "progress",
      runId,
      pct: Math.round((index / total) * 80),
      stage: "reading",
      detail: { page: index + 1, pages: total },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    let source: OrganizeSource;
    try {
      source = parseForOrganize(bytes);
    } catch (error: unknown) {
      post({
        type: "error",
        runId,
        code: engineErrorCode(error),
        detail: file.name,
      });
      return;
    }
    sources.push(source);

    const fileId = fileIds?.[index];
    const spec = (fileId !== undefined ? rangeMap[fileId] : undefined) ?? "";
    const trimmed = spec.trim();
    const indices =
      trimmed === "" || trimmed.toLowerCase() === "all"
        ? Array.from({ length: source.pages.length }, (_, i) => i)
        : parsePageSpec(trimmed, source.pages.length);
    if (indices === null) {
      post({
        type: "error",
        runId,
        code: "tool.errorInvalidPages",
        detail: `${file.name}: ${trimmed}`,
      });
      return;
    }
    perFileIndices.push(indices);
  }

  // ── Plan phase: every selected page in order, optional A4 blank
  // between files (the exact pdf-lib addPage() default size). ──
  const plan: MergePlanEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    for (const pageIndex of perFileIndices[index]!) {
      plan.push({ kind: "page", doc: index, src: pageIndex });
    }
    if (blankBetween && index < total - 1) {
      plan.push({ kind: "blank", width: 595.28, height: 841.89 });
    }
  }

  if (plan.length === 0) {
    // Every range resolved to zero pages (e.g. two 0-page inputs) — the
    // honest "nothing to merge" refusal, not an empty PDF.
    post({
      type: "error",
      runId,
      code: "tool.errorInvalidPages",
      detail: undefined,
    });
    return;
  }

  // ── Write phase: one multi-document rebuild, real per-page progress. ──
  const totalPages = plan.length;
  const merged = organizeMerge(sources, plan, (fraction, page) => {
    post({
      type: "progress",
      runId,
      pct: Math.round(80 + 15 * fraction),
      stage: "processing",
      detail: { page, pages: totalPages },
    });
  });

  post({
    type: "progress",
    runId,
    pct: 95,
    stage: "saving",
  });

  const fallback = `${safeBaseName(files[0].name)}-merged.pdf`;
  const outputName = sanitizeOutputName(outputNameRaw, fallback);

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outputName,
        mime: "application/pdf",
        blob: new Blob([merged as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: total, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: engineErrorCode(error),
      detail: undefined,
    });
  });
};
