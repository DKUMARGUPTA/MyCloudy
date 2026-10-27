import { PDFDocument, degrees } from "pdf-lib";

import {
  PdfError,
  organizePages,
  parseForOrganize,
  type OrganizeSource,
  type PlanEntry,
} from "@/lib/own/pdf";
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
 * Batch mode (R2-a — rotate was the pattern-setter, now the whole family):
 * when `options.grids` carries a map of { [workspace file id]:
 * gridWireString }, every input file is rebuilt from ITS OWN grid
 * (iLovePDF/Smallpdf-style batch). `options.selections` carries the same
 * shaped map of per-file extract selections. The maps must cover every
 * file — a malformed or partial map is a hard error, never a silent
 * fall-back to applying one file's state to all files. Without a grids map
 * the legacy single-file path (options.grid / options.selected) runs
 * byte-for-byte as before.
 *
 * Device-only (PRD §2.3): Web Worker, File/Blob in and out, zero network.
 * Real per-page progress is posted while rebuilding.
 *
 * ENGINE (P6-c): tools in OWN_ENGINE_TOOLS run on OUR own PDF micro-engine
 * (src/lib/own/pdf — zero external code, one parse per file, byte-exact
 * content passthrough). Rollout is one tool at a time; everything else
 * still runs the pdf-lib path until its E2E round clears. The two paths
 * share ALL batch/selection/naming logic — only the rebuild differs.
 */

/** P6-c rollout set — a tool joins after its agent-browser E2E round. */
const OWN_ENGINE_TOOLS: ReadonlySet<string> = new Set([
  "extract-pdf-pages",
  "rotate-pdf-pages",
  "rearrange-pdf-pages",
  "remove-pdf-pages",
]);

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

/**
 * Parses the per-file grids map for batch runs:
 * { [workspace file id]: gridWireString } — the same per-file-options shape
 * merge-pdf uses for its range map. Returns null when malformed.
 */
function parseGridsOption(raw: unknown): Map<string, GridPage[]> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const map = new Map<string, GridPage[]>();
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (typeof value !== "string") return null;
    const grid = parseGridOption(value);
    if (grid === null) return null;
    map.set(key, grid);
  }
  return map.size > 0 ? map : null;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * Parses the per-file selections map for batch extract runs:
 * { [workspace file id]: selectionWireString } — the exact same per-file
 * shape as `grids`. Strict per entry: anything that is not a JSON array
 * of non-negative integers makes the WHOLE map malformed (null).
 */
function parseSelectionsOption(raw: unknown): Map<string, number[]> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const map = new Map<string, number[]>();
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (typeof value !== "string") return null;
    let entry: unknown;
    try {
      entry = JSON.parse(value);
    } catch {
      return null;
    }
    if (!Array.isArray(entry)) return null;
    for (const item of entry) {
      if (
        typeof item !== "number" ||
        !Number.isInteger(item) ||
        item < 0
      ) {
        return null;
      }
    }
    map.set(key, entry);
  }
  return map.size > 0 ? map : null;
}

/**
 * Disambiguates output names across the whole run — the SAME "-2" pattern
 * the shared ZIP bundler (zipOutputs) applies before the extension. Two
 * workspace files can share a base name ("scan.pdf" twice); distinct base
 * names keep their clean single-file form ("a-rotated.pdf").
 */
function makeUniqueNamer(): (name: string) => string {
  const used = new Set<string>();
  return (name: string): string => {
    let unique = name;
    let counter = 2;
    while (used.has(unique)) {
      const dot = unique.lastIndexOf(".");
      unique =
        dot > 0
          ? `${unique.slice(0, dot)}-${counter}${unique.slice(dot)}`
          : `${unique}-${counter}`;
      counter += 1;
    }
    used.add(unique);
    return unique;
  };
}

/** Extract entries: the grid restricted to the (unique, sorted) selection. */
function filterBySelection(
  grid: GridPage[],
  selected: number[]
): GridPage[] {
  const unique = [...new Set(selected)].sort((a, b) => a - b);
  const entries: GridPage[] = [];
  for (const index of unique) {
    const entry = grid[index];
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Legacy single-file resolution: the whole grid, or the extract selection. */
function resolveEntries(
  toolId: string,
  options: OptionValues,
  grid: GridPage[]
): { entries: GridPage[]; onePerPage: boolean } | null {
  const onePerPage = options.onePerPage === true;
  if (toolId !== "extract-pdf-pages") {
    return { entries: grid, onePerPage: false };
  }
  return {
    entries: filterBySelection(grid, parseNumberListOption(options.selected)),
    onePerPage,
  };
}

/** Maps an own-engine failure to the worker's i18n error code. */
function engineErrorCode(error: unknown): string {
  if (error instanceof PdfError && error.code === "encrypted") {
    return "tool.errorEncrypted";
  }
  return "tool.errorCorrupt";
}

/**
 * Builds one output PDF from the given entries on OUR OWN engine (P6-c).
 * Blank entries become real blank pages sized like the first real page of
 * the OUTPUT (A4 when the grid has none) — byte-exact parity with the
 * pdf-lib path's `copied[0]` sizing. `source` is the ONE parse for the
 * file; every write reuses it (never re-parses the bytes).
 */
function buildOutputOwn(
  source: OrganizeSource,
  entries: GridPage[],
  progress: (fraction: number, page: number) => void
): Uint8Array {
  const firstReal = entries.find((entry) => entry.source >= 0)?.source ?? -1;
  const plan: PlanEntry[] = entries.map((entry) => {
    if (entry.source !== -1) {
      return { kind: "page", src: entry.source, rotateDelta: entry.rotation };
    }
    return firstReal >= 0
      ? { kind: "blank-from", src: firstReal }
      : { kind: "blank", width: A4[0], height: A4[1] };
  });
  return organizePages(source, plan, progress);
}

/**
 * Builds one output PDF from the given entries (legacy pdf-lib path —
 * kept until each tool's own-engine E2E round clears, then P6-e removes it).
 */
async function buildOutputPdfLib(
  source: PDFDocument,
  entries: GridPage[],
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
  const { runId, toolId, options, files, fileIds } = request;
  const grid = parseGridOption(options.grid);
  if (grid === null) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  const isExtract = toolId === "extract-pdf-pages";
  const onePerPage = isExtract && options.onePerPage === true;
  const useOwnEngine = OWN_ENGINE_TOOLS.has(toolId);

  // Batch mode: per-file grids keyed by workspace file id (all four family
  // tools). A malformed map is refused rather than guessed (never apply
  // one file's grid to every file silently).
  const gridsRaw = options.grids;
  let gridMap: Map<string, GridPage[]> | null = null;
  if (typeof gridsRaw === "string" && gridsRaw.length > 0) {
    gridMap = parseGridsOption(gridsRaw);
    if (gridMap === null) {
      post({ type: "error", runId, code: "tool.errorCorrupt" });
      return;
    }
  }

  // Extract batch: per-file selections in the same map shape.
  let selectionMap: Map<string, number[]> | null = null;
  if (isExtract) {
    const selectionsRaw = options.selections;
    if (typeof selectionsRaw === "string" && selectionsRaw.length > 0) {
      selectionMap = parseSelectionsOption(selectionsRaw);
      if (selectionMap === null) {
        post({ type: "error", runId, code: "tool.errorCorrupt" });
        return;
      }
    }
  }

  // Legacy single-file path (no grids map): resolve once from the shared
  // options — the exact pre-batch flow.
  let legacyEntries: GridPage[] | null = null;
  if (gridMap === null) {
    const resolved = resolveEntries(toolId, options, grid);
    if (resolved === null || resolved.entries.length === 0) {
      // Safety net — the CTA is disabled before this can happen (PRD §8.1).
      post({ type: "error", runId, code: "tool.errorInvalidPages" });
      return;
    }
    legacyEntries = resolved.entries;
  }

  const suffix = OUTPUT_SUFFIX[toolId] ?? "-pages";
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  const uniqueName = makeUniqueNamer();
  let pagesTotal = 0;

  const totalFiles = files.length;
  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
    const file = files[fileIndex];
    const base = safeBaseName(file.name);

    // Batch: each file rebuilds from ITS OWN grid (+ its own extract
    // selection). Legacy runs share the single resolved entry list.
    let fileEntries: GridPage[];
    if (gridMap !== null) {
      const fileId = fileIds?.[fileIndex];
      const fileGrid =
        fileId !== undefined ? gridMap.get(fileId) ?? null : null;
      if (fileGrid === null || fileGrid.length === 0) {
        // Missing/empty grid for this file — refuse the whole run (the
        // surface gates this before the CTA; worker stays defense-in-depth).
        post({ type: "error", runId, code: "tool.errorInvalidPages" });
        return;
      }
      if (isExtract) {
        const fileSelected =
          fileId !== undefined && selectionMap !== null
            ? selectionMap.get(fileId)
            : undefined;
        if (fileSelected === undefined || fileSelected.length === 0) {
          // Every batch file needs its own non-empty selection.
          post({ type: "error", runId, code: "tool.errorInvalidPages" });
          return;
        }
        fileEntries = filterBySelection(fileGrid, fileSelected);
        if (fileEntries.length === 0) {
          post({ type: "error", runId, code: "tool.errorInvalidPages" });
          return;
        }
      } else {
        fileEntries = fileGrid;
      }
    } else {
      fileEntries = legacyEntries as GridPage[];
    }
    pagesTotal += fileEntries.length;

    post({
      type: "progress",
      runId,
      pct: Math.round((fileIndex / totalFiles) * 100),
      stage: "reading",
      detail: { page: fileIndex + 1, pages: totalFiles },
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    // R6-b honesty (merge-pdf standard): the batch can hold up to 20 files,
    // so the encrypted/corrupt toast must NAME the file that stopped the run.

    // Per-file progress for the rebuild stage (same shape both engines).
    const emit = (fraction: number, page: number): void => {
      post({
        type: "progress",
        runId,
        pct: Math.round(
          ((fileIndex + fraction) / totalFiles) * 92
        ),
        stage: "processing",
        detail: { page, pages: fileEntries.length },
      });
    };

    const pushOutput = (saved: Uint8Array, name: string): void => {
      outputs.push({
        name,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      });
    };

    if (useOwnEngine) {
      // ── OUR engine: ONE typed parse per file, every write reuses it ──
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
      if (onePerPage) {
        for (let index = 0; index < fileEntries.length; index += 1) {
          const saved = buildOutputOwn(source, [fileEntries[index]!], emit);
          pushOutput(
            saved,
            uniqueName(`${base}_page${index + 1}.pdf`)
          );
        }
      } else {
        const saved = buildOutputOwn(source, fileEntries, emit);
        post({
          type: "progress",
          runId,
          pct: Math.round(((fileIndex + 1) / totalFiles) * 95),
          stage: "saving",
        });
        pushOutput(saved, uniqueName(`${base}${suffix}.pdf`));
      }
      continue;
    }

    // ── Legacy pdf-lib path (until each tool's E2E round clears) ──
    // Structural probe first (pdf-lib ignoreEncryption load + isEncrypted —
    // never a raw-bytes "/Encrypt" sniff), then the plain load for corrupts.
    let probe: PDFDocument | null = null;
    try {
      probe = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
    } catch {
      // Not parseable at all — the plain load below keeps producing the
      // honest corrupt error for this file.
    }
    if (probe?.isEncrypted) {
      post({
        type: "error",
        runId,
        code: "tool.errorEncrypted",
        detail: file.name,
      });
      return;
    }
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      post({
        type: "error",
        runId,
        code: /encrypt/i.test(message)
          ? "tool.errorEncrypted"
          : "tool.errorCorrupt",
        detail: file.name,
      });
      return;
    }

    if (onePerPage) {
      for (let index = 0; index < fileEntries.length; index += 1) {
        const saved = await buildOutputPdfLib(
          source,
          [fileEntries[index]!],
          emit
        );
        pushOutput(saved, uniqueName(`${base}_page${index + 1}.pdf`));
      }
    } else {
      const saved = await buildOutputPdfLib(source, fileEntries, emit);
      post({
        type: "progress",
        runId,
        pct: Math.round(((fileIndex + 1) / totalFiles) * 95),
        stage: "saving",
      });
      pushOutput(saved, uniqueName(`${base}${suffix}.pdf`));
    }
  }

  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: pagesTotal },
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
