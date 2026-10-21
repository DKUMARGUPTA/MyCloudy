import type { OptionValues } from "@/lib/tools/config-types";

/**
 * Worker protocol for device-only tools (PRD §2.3/§6.3).
 *
 * Main thread -> worker:
 *   { type: "run", runId, toolId, options, files }
 *
 * Worker -> main thread:
 *   { type: "progress", runId, pct, stage, detail? }   real progress per page
 *   { type: "result",  runId, outputs }               Blob outputs
 *   { type: "error",   runId, code, detail? }          i18n key, no user text
 *
 * Cancel is NOT a message: the pool terminates the worker immediately
 * (PRD §6.3: "Cancel immediately worker terminate karta hai") and cleans
 * the OPFS temp copies. Workers therefore never need cancel-draining logic.
 *
 * Workers carry no file data over the network — they receive File objects
 * by structured clone (same-origin blobs) and post Blob results back.
 */

export type RunStage = "reading" | "processing" | "saving";

export interface StageDetail {
  page?: number;
  pages?: number;
  /** Live OCR confidence (%) for the page just processed (ocr-pdf). */
  conf?: number;
}

export interface RunDetail {
  files?: number;
  pages?: number;
  /** Mean OCR confidence (%) across OCRed pages (ocr-pdf). */
  confidence?: number;
  /** Whether the output fit the byte budget (compress-pdf-to-size). */
  targetHit?: boolean;
  /** Form fields added to the output (make-pdf-fillable). */
  fields?: number;
  /** Editor objects drawn into the output (edit-pdf). */
  objects?: number;
  /** Embedded image assets in the output (edit-pdf). */
  images?: number;
  /** Real PDF annotations written (annotate-pdf). */
  annotations?: number;
  /** Sticky notes among the annotations (annotate-pdf). */
  notes?: number;
  /** Words of text written into the output (write-pdf). */
  words?: number;
  /** Paragraphs extracted into the output (pdf-to-word). */
  paragraphs?: number;
  /** Headings detected in the output (pdf-to-word). */
  headings?: number;
}

export interface ToolOutput {
  /** Download display name (worker sanitizes; UI re-validates on rename). */
  name: string;
  mime: string;
  blob: Blob;
}

export interface WorkerRunRequest {
  type: "run";
  runId: number;
  toolId: string;
  options: OptionValues;
  files: File[];
  /** Workspace file ids aligned with `files` (per-file options, e.g. merge ranges). */
  fileIds?: string[];
  /** Extra run assets beside the main files (e.g. the watermark logo). */
  assets?: File[];
}

export type WorkerResponse =
  | {
      type: "progress";
      runId: number;
      pct: number; // 0-100 overall
      stage: RunStage;
      detail?: StageDetail;
    }
  | {
      type: "result";
      runId: number;
      outputs: ToolOutput[];
      /** Run summary for the result view (PRD §8.1: "5 files, 42 pages"). */
      detail?: RunDetail;
    }
  | { type: "error"; runId: number; code: string; detail?: string };

export function isWorkerResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== "object" || data === null) return false;
  const type = (data as { type?: unknown }).type;
  return type === "progress" || type === "result" || type === "error";
}

/**
 * Page-range parsing shared by tools that operate on page selections
 * ("all" | "1-3, 5, 8-" -> 0-based indices, clamped, deduped, ascending).
 * Returns null when the spec cannot be parsed.
 */
export function parsePageSpec(
  spec: string,
  pageCount: number
): number[] | null {
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all" || trimmed === "*") {
    return Array.from({ length: pageCount }, (_, i) => i);
  }
  const picked = new Set<number>();
  for (const partRaw of trimmed.split(/[,\s]+/)) {
    const part = partRaw.trim();
    if (part === "") continue;
    const match = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
    if (!match) return null;
    const start = Number.parseInt(match[1], 10);
    // "8-" (dash, no end) is an OPEN range: 8 through the last page —
    // exactly what the docstring promises. A bare "8" is one page.
    const openEnd = match[2] === undefined && part.includes("-");
    const end = openEnd
      ? pageCount
      : match[2] === undefined
        ? start
        : Number.parseInt(match[2], 10);
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const lo = Math.max(1, from);
    const hi = Math.min(pageCount, to);
    for (let page = lo; page <= hi; page += 1) {
      picked.add(page - 1); // to 0-based
    }
  }
  if (picked.size === 0) return null;
  return [...picked].sort((a, b) => a - b);
}
