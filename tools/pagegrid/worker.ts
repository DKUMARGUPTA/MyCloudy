import { PDFDocument, degrees } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  parseGridOption,
  parseNumberListOption,
  type GridPage,
} from "./model";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Shared PageGrid worker (PRD §8.1 family): rebuilds a PDF from an edited
 * page list — [source index, rotation delta] entries, blanks included.
 * All four family tools (rotate / rearrange / remove / extract) run THIS
 * worker; only the naming and the extract filter differ.
 *
 * Device-only (PRD §2.3): pdf-lib in a Web Worker, File/Blob in and out,
 * zero network. Real per-page progress is posted while rebuilding.
 */

/** A4 portrait — the fallback size for leading blank pages. */
const A4: [number, number] = [595.28, 841.89];

const OUTPUT_SUFFIX: Record<string, string> = {
  "rotate-pdf-pages": "-rotated",
  "rearrange-pdf-pages": "-rearranged",
  "remove-pdf-pages": "-pages-removed",
  "extract-pdf-pages": "-extracted",
};

/** Strips path separators + unsafe chars from a download display name. */
function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Entries this run should emit: the whole grid, or the extract selection. */
function resolveEntries(
  toolId: string,
  options: OptionValues,
  grid: GridPage[]
): { entries: GridPage[]; onePerPage: boolean } | null {
  const onePerPage = options.onePerPage === true;
  if (toolId !== "extract-pdf-pages") {
    return { entries: grid, onePerPage: false };
  }
  const selected = parseNumberListOption(options.selected);
  const unique = [...new Set(selected)].sort((a, b) => a - b);
  const entries: GridPage[] = [];
  for (const index of unique) {
    const entry = grid[index];
    if (entry) entries.push(entry);
  }
  return { entries, onePerPage };
}

/**
 * Builds one output PDF from the given entries. Blank entries become real
 * blank pages sized like the first real page (A4 when the grid has none).
 */
async function buildOutput(
  source: PDFDocument,
  entries: GridPage[],
  runId: number,
  progress: (fraction: number, page: number) => void
): Promise<Uint8Array> {
  const out = await PDFDocument.create();

  // Copy every real page up front (duplicate indices are supported —
  // verified: pdf-lib returns independent copies).
  const realIndices = entries
    .map((entry) => entry.source)
    .filter((source) => source >= 0);
  const copied =
    realIndices.length > 0 ? await out.copyPages(source, realIndices) : [];

  // Reference size for blanks: first real page, else A4.
  let blankSize: [number, number] = A4;
  if (copied.length > 0) {
    blankSize = [copied[0].getWidth(), copied[0].getHeight()];
  }

  let realCursor = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.source === -1) {
      out.addPage(blankSize);
    } else {
      const page = copied[realCursor];
      realCursor += 1;
      const angle = (page.getRotation().angle + entry.rotation + 360) % 360;
      page.setRotation(degrees(angle));
      out.addPage(page);
    }
    progress((index + 1) / entries.length, index + 1);
  }

  return out.save({ useObjectStreams: true });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, toolId, options, files } = request;
  const grid = parseGridOption(options.grid);
  if (grid === null) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  const resolved = resolveEntries(toolId, options, grid);
  if (resolved === null || resolved.entries.length === 0) {
    // Safety net — the CTA is disabled before this can happen (PRD §8.1).
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  const { entries, onePerPage } = resolved;
  const suffix = OUTPUT_SUFFIX[toolId] ?? "-pages";
  const outputs: { name: string; mime: string; blob: Blob }[] = [];

  const totalFiles = files.length;
  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
    const file = files[fileIndex];
    const base = safeBaseName(file.name);
    const fileSpan = totalFiles > 1 ? `-${fileIndex + 1}` : "";

    post({
      type: "progress",
      runId,
      pct: Math.round((fileIndex / totalFiles) * 100),
      stage: "reading",
      detail: { page: fileIndex + 1, pages: totalFiles },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });

    const emit = (fraction: number, page: number): void => {
      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + fraction) / totalFiles) * 92
        ),
        stage: "processing",
        detail: { page, pages: entries.length },
      });
    };

    if (onePerPage) {
      for (let index = 0; index < entries.length; index += 1) {
        const saved = await buildOutput(source, [entries[index]], runId, emit);
        outputs.push({
          name: `${base}_page${index + 1}${fileSpan}.pdf`,
          mime: "application/pdf",
          blob: new Blob([saved as unknown as BlobPart], {
            type: "application/pdf",
          }),
        });
      }
    } else {
      const saved = await buildOutput(source, entries, runId, emit);
      post({
        type: "progress",
        runId,
        pct: Math.round(((fileIndex + 1) / totalFiles) * 95),
        stage: "saving",
      });
      outputs.push({
        name: `${base}${suffix}${fileSpan}.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      });
    }
  }

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: entries.length },
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
