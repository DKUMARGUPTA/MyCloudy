import { PDFDocument } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Merge PDF — device-only worker (PRD §8.1; pdf-lib, MIT).
 *
 * Copies the selected page ranges of each file (in the given order) into a
 * new document, optionally inserting a blank page between files and
 * flattening form fields (best effort). Real progress per file and per
 * page; typed error codes for the UI's i18n toasts. Never touches the
 * network.
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

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, fileIds } = request;
  const blankBetween = options.blankBetween === true;
  const flatten = options.flatten === true;
  const outputNameRaw =
    typeof options.outputName === "string" ? options.outputName : "";
  const rangeMap = parseRangeMap(options.fileRanges);

  const total = files.length;
  const merged = await PDFDocument.create();

  for (let index = 0; index < total; index += 1) {
    const file = files[index];
    const fileId = fileIds?.[index];
    const span = 100 / total;

    post({
      type: "progress",
      runId,
      pct: Math.round(index * span),
      stage: "reading",
      detail: { page: index + 1, pages: total },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });

    const spec = (fileId !== undefined ? rangeMap[fileId] : undefined) ?? "";
    const trimmed = spec.trim();
    const indices =
      trimmed === "" || trimmed.toLowerCase() === "all"
        ? Array.from({ length: src.getPageCount() }, (_, i) => i)
        : parsePageSpec(trimmed, src.getPageCount());
    if (indices === null) {
      post({
        type: "error",
        runId,
        code: "tool.errorInvalidPages",
        detail: trimmed,
      });
      return;
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(index * span + span * 0.2),
      stage: "processing",
      detail: { pages: indices.length },
    });

    const copied = await merged.copyPages(src, indices);
    for (let i = 0; i < copied.length; i += 1) {
      merged.addPage(copied[i]);
      post({
        type: "progress",
        runId,
        pct: Math.round(
          index * span + span * (0.2 + 0.65 * ((i + 1) / copied.length))
        ),
        stage: "processing",
        detail: { page: i + 1, pages: copied.length },
      });
    }

    if (blankBetween && index < total - 1) {
      merged.addPage(); // A4-sized blank separator
    }
  }

  if (flatten) {
    try {
      // pdf-lib 1.17.1 API (verified at runtime): PDFForm.flatten().
      const form = merged.getForm();
      form.flatten();
    } catch {
      // Best effort by design — the option hint says complex forms may
      // keep their fields. The merge itself is unaffected.
    }
  }

  post({
    type: "progress",
    runId,
    pct: 95,
    stage: "saving",
  });

  const fallback = `${safeBaseName(files[0].name)}-merged.pdf`;
  const saved = await merged.save({ useObjectStreams: true });
  const outputName = sanitizeOutputName(outputNameRaw, fallback);

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: outputName,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: total, pages: merged.getPageCount() },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
