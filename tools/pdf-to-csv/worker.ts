import type { OptionValues } from "@/lib/tools/config-types";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  axisSegmentsFromOperatorList,
  extractGrid,
  extractRuledGrid,
  gridItemsFromRaw,
  type LatticeOps,
} from "../pdf-to-excel/model";
import {
  buildCsvOutputs,
  csvMimeType,
  type CsvDelimiter,
} from "./worker-lib";

/**
 * PDF to CSV worker (P3-a / R55) — the pdf-to-excel extraction feeding a
 * plain CSV emit instead of a workbook. pdf.js runs INSIDE this worker
 * (fake-worker mode). Pages that draw their table hand their border
 * geometry to extractRuledGrid (exact cells); everything else falls back
 * to the position-clustering grid. Delimiter comma / semicolon / tab,
 * single stacked CSV (with a Page column) or one CSV per page.
 *
 * Pinned lessons honoured: fresh buffer per getDocument, doc.destroy() in
 * a finally, pages cleanup()ped right after reading, scans (zero
 * selectable text) fail honestly with tool.errorNoText.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

interface ResolvedOptions {
  delimiter: CsvDelimiter;
  mode: "single" | "per-page";
  ruled: boolean;
}

function resolveOptions(options: OptionValues): ResolvedOptions {
  const delimiter: CsvDelimiter =
    options.delimiter === "semicolon"
      ? ";"
      : options.delimiter === "tab"
        ? "\t"
        : ",";
  return {
    delimiter,
    mode: options.mode === "per-page" ? "per-page" : "single",
    ruled: options.ruled !== false,
  };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const opts = resolveOptions(request.options);

  const pdfjs = await loadPdfjsInWorker();
  const ops = (pdfjs as unknown as { OPS: LatticeOps }).OPS;
  const outputs: { name: string; mime: string; blob: Blob }[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = safeBaseName(file.name);

    // Fresh copy per run — pdf.js DETACHES the buffer it receives.
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    try {
      const pageNumbers: number[] = [];
      for (let p = 1; p <= doc.numPages; p += 1) pageNumbers.push(p);
      const grids: string[][][] = [];
      let itemCount = 0;
      let done = 0;
      for (const pageNumber of pageNumbers) {
        const pdfPage = await doc.getPage(pageNumber);
        let content;
        let opList: {
          fnArray: ArrayLike<number>;
          argsArray: ArrayLike<unknown>;
        } | null = null;
        try {
          content = await pdfPage.getTextContent();
          opList = (await pdfPage.getOperatorList().catch(() => null)) as {
            fnArray: ArrayLike<number>;
            argsArray: ArrayLike<unknown>;
          } | null;
        } finally {
          pdfPage.cleanup();
        }
        const items = gridItemsFromRaw(content.items as unknown[]);
        itemCount += items.length;
        let grid: string[][] | null = null;
        if (opts.ruled && opList) {
          const segs = axisSegmentsFromOperatorList(
            opList.fnArray,
            opList.argsArray,
            ops
          );
          grid = extractRuledGrid(items, segs);
        }
        grids.push(grid ?? extractGrid(items));
        done += 1;
        totalPages += 1;
        post({
          type: "progress",
          runId,
          pct: Math.round(
            ((fileIndex + done / pageNumbers.length) / files.length) * 95,
          ),
          stage: "processing",
          detail: { page: done, pages: pageNumbers.length },
        });
      }

      // Scans: zero selectable text anywhere — fail honestly.
      if (itemCount === 0) {
        post({
          type: "error",
          runId,
          code: "tool.errorNoText",
          detail: file.name,
        });
        return;
      }

      const csvOutputs = buildCsvOutputs(base, grids, {
        delimiter: opts.delimiter,
        mode: opts.mode,
      });
      const mime = csvMimeType(opts.delimiter);
      for (const out of csvOutputs) {
        outputs.push({
          name: out.name,
          mime,
          blob: new Blob([out.body], { type: mime }),
        });
      }
    } finally {
      doc.destroy();
    }
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: outputs.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /password/i.test(message)
      ? "tool.errorEncrypted"
      : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code });
  });
};
