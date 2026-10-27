import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import {
  axisSegmentsFromOperatorList,
  buildOutputName,
  buildXlsx,
  excelBaseName,
  extractGrid,
  extractRuledGrid,
  gridItemsFromRaw,
  parseRun,
  type LatticeOps,
  XLSX_MIME,
  type XlsxSheet,
} from "./model";

/**
 * PDF → Excel worker (RB1-d — the 70th tool): pdf.js runs INSIDE this
 * worker (fake-worker mode, the pdf-to-txt recipe). Every page's text
 * content AND operator list are read; pages that draw their table hand
 * their border geometry to extractRuledGrid (exact cells), everything
 * else falls back to extractGrid. Sheets become a real .xlsx via our
 * own ZIP engine. Device-only: the file arrives by structured clone and
 * the Blob leaves the same way.
 *
 * Pinned lessons honoured here:
 *  - the buffer handed to getDocument is a FRESH copy (pdf.js detaches
 *    whatever it receives);
 *  - doc.destroy() in a finally, pages cleanup()ped right after their
 *    content is read;
 *  - scans (zero selectable text on every page) fail honestly with
 *    tool.errorNoText instead of shipping an empty workbook.
 *
 * Progress checkpoints: 20 (document open) → interpolated per page →
 * 45 (grids extracted) → 85 (workbook zipped) → result.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, files } = request;
  const opts = parseRun(String(request.options.excel ?? ""));

  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }

  const pdfjs = await loadPdfjsInWorker();
  const ops = (pdfjs as unknown as { OPS: LatticeOps }).OPS;
  // Fresh copy per run — pdf.js DETACHES the buffer it receives.
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    // Worker-safe canvas factory — image pages need createElement
    // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  post({ type: "progress", runId, pct: 20, stage: "processing" });

  try {
    const grids: string[][][] = [];
    let itemCount = 0;
    for (let page = 1; page <= doc.numPages; page += 1) {
      const pdfPage = await doc.getPage(page);
      let content;
      let opList: {
        fnArray: ArrayLike<number>;
        argsArray: ArrayLike<unknown>;
      } | null = null;
      try {
        content = await pdfPage.getTextContent();
        // Border geometry for the ruled-table reader; pages whose
        // operator list cannot be read just fall back to clustering.
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
      post({
        type: "progress",
        runId,
        pct: 20 + Math.round((25 * page) / doc.numPages),
        stage: "processing",
        detail: { page, pages: doc.numPages },
      });
    }

    // Scans: zero selectable text anywhere — fail honestly (the FAQ
    // points at the OCR tool instead).
    if (itemCount === 0) {
      post({
        type: "error",
        runId,
        code: "tool.errorNoText",
        detail: file.name,
      });
      return;
    }

    const base = excelBaseName(file.name);
    const sheets: XlsxSheet[] = [];
    if (opts.sheetMode === "perPage") {
      for (let i = 0; i < grids.length; i += 1) {
        sheets.push({ name: `${opts.labels.pageWord} ${i + 1}`, rows: grids[i] });
      }
    } else {
      sheets.push({
        name: base || opts.labels.sheetWord,
        rows: grids.flat(),
      });
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const bytes = buildXlsx(sheets, {
      numericCells: opts.numericCells,
      boldHeader: opts.boldHeader,
    });
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    post({
      type: "result",
      runId,
      outputs: [
        {
          name: buildOutputName(base, opts.labels.fileWord),
          mime: XLSX_MIME,
          blob: new Blob([bytes as unknown as BlobPart], { type: XLSX_MIME }),
        },
      ],
      detail: { files: 1, pages: grids.length },
    });
  } finally {
    await doc.destroy().catch(() => undefined);
  }
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
