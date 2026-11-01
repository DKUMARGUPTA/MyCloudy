import type { OptionValues } from "@/lib/tools/config-types";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { gridItemsFromRaw, type GridTextItem } from "../pdf-to-excel/model";
import { ET_MAX_PIECES, extractTables, type TableBlock } from "./engine";
import {
  combineCsvs,
  resolveDelimiter,
  rowsToCsv,
  tableFileName,
} from "./csv-emit";
import { zipSync } from "@/lib/own/zip";

/**
 * Extract tables worker (PHASE-7): pdf.js reads each page's text with
 * positions (fake-worker mode, the pdf-to-excel recipe), the pure
 * engine SEGMENTS the page into distinct tables, and each table leaves
 * as RFC-4180 CSV — one .csv per table inside a .zip, or every table
 * in one combined .csv. Own zip engine, own CSV writer, never the
 * network.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "tables";
}

export interface EtProgress {
  pct: number;
  stage: "reading" | "processing" | "saving";
  detail?: { page: number; pages: number };
}

export interface EtRunResult {
  bytes: Uint8Array;
  name: string;
  mime: string;
  pages: number;
  tables: number;
}

/** The whole pipeline, smoke-safe headless (pdf.js read + segment + emit). */
export async function runExtractTables(
  bytes: Uint8Array,
  options: OptionValues,
  onProgress?: (progress: EtProgress) => void
): Promise<EtRunResult> {
  const pagesSpec = String(options.pages ?? "all").trim() || "all";
  const delimiter = resolveDelimiter(options.delimiter);
  const single = options.output === "single";

  // pdf.js DETACHES the buffer it receives — probe a fresh copy (R32).
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  try {
    const pageNumbers = parsePageSpec(pagesSpec, doc.numPages);
    if (pageNumbers === null || pageNumbers.length === 0) {
      throw new Error("tool.errorInvalidPages");
    }

    /** (1-based page number, tables) in page order. */
    const found: Array<{ page: number; blocks: TableBlock[] }> = [];
    let itemCount = 0;

    for (let i = 0; i < pageNumbers.length; i += 1) {
      const pageNumber = pageNumbers[i]! + 1;
      const page = await doc.getPage(pageNumber);
      let content: { items?: unknown[] };
      try {
        content = await page.getTextContent();
      } finally {
        page.cleanup();
      }
      const items = gridItemsFromRaw(
        (content.items ?? []) as unknown[]
      ) as GridTextItem[];
      itemCount += items.length;
      if (items.length > ET_MAX_PIECES) {
        throw new Error("tool.errorTooManyItems");
      }
      const blocks = extractTables(items);
      if (blocks.length > 0) {
        found.push({ page: pageNumber, blocks });
      }
      onProgress?.({
        pct: Math.round(8 + (72 * (i + 1)) / pageNumbers.length),
        stage: "processing",
        detail: { page: i + 1, pages: pageNumbers.length },
      });
    }

    if (itemCount === 0) {
      throw new Error("tool.errorNoText");
    }
    const totalTables = found.reduce((sum, f) => sum + f.blocks.length, 0);
    if (totalTables === 0) {
      throw new Error("tool.errorNoTables");
    }

    onProgress?.({ pct: 88, stage: "saving" });
    const rawName = options.__fileName;
    const base = safeBaseName(
      typeof rawName === "string" && rawName.length > 0 ? rawName : "tables"
    );
    const encoder = new TextEncoder();

    if (single) {
      const bytes = encoder.encode(
        combineCsvs(
          found.flatMap((f) => f.blocks.map((b) => b.grid)),
          delimiter
        )
      );
      return {
        bytes,
        name: `${base}-tables.csv`,
        mime: "text/csv",
        pages: pageNumbers.length,
        tables: totalTables,
      };
    }

    // ZIP: one RFC-4180 .csv per table.
    const entries: Record<string, Uint8Array> = {};
    for (const { page, blocks } of found) {
      blocks.forEach((block, index) => {
        entries[tableFileName("", page, index + 1)] = encoder.encode(
          rowsToCsv(block.grid, delimiter)
        );
      });
    }
    const zipped = zipSync(entries, { level: 6 });
    return {
      bytes: zipped,
      name: `${base}-tables.zip`,
      mime: "application/zip",
      pages: pageNumbers.length,
      tables: totalTables,
    };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  let result: EtRunResult;
  try {
    const optionValues: OptionValues = { ...options, __fileName: file.name };
    result = await runExtractTables(bytes, optionValues, (progress) => {
      post({ type: "progress", runId, ...progress });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^tool\./.test(message)
      ? message
      : /password|encrypt/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorCorrupt";
    post({ type: "error", runId, code });
    return;
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const outputs = [
    {
      name: result.name,
      mime: result.mime,
      blob: new Blob([result.bytes as unknown as BlobPart], {
        type: result.mime,
      }),
    },
  ];

  post({
    type: "result",
    runId,
    outputs,
    detail: {
      files: 1,
      pages: result.pages,
      tablesExtracted: result.tables,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch(() => {
    post({ type: "error", runId: data.runId, code: "tool.errorGeneric" });
  });
};
