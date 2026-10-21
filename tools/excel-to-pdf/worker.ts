import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  XlsxParseError,
  isWinAnsiText,
  needsNoto,
  parseExcelRun,
  parseXlsx,
  safeOutputBase,
  type ParsedWorkbook,
} from "./model";
import { drawWorkbookPdf } from "./render";

/**
 * Excel to PDF worker (RB1-c — create-resume protocol):
 *
 *  1. files[0] bytes → parseXlsx (honest coded errors: legacy .xls,
 *     non-zip, non-OOXML zips, corrupt parts, no readable sheets);
 *  2. parseExcelRun — the worker-boundary option coercion + clamps;
 *  3. font pick — any non-WinAnsi cell (Devanagari, ₹ …) embeds the
 *     self-hosted Noto Sans Devanagari subset, pure-WinAnsi data
 *     stays on the base-14 Helvetica pair (nothing embedded);
 *  4. drawWorkbookPdf — the exact render.ts the smoke script drives;
 *  5. save with producer "MyCloudy" and the localized output name.
 *
 * All display labels arrive pre-resolved in the options (the surface's
 * t()): the footer template and the fallback file word. When the
 * Helvetica pair is in use, a non-WinAnsi footer (Hindi UI) falls back
 * to the English default — WinAnsi encoding would otherwise throw.
 */

const ERROR_KEYS: Record<string, string> = {
  "xlsx-legacy": "xls.errorLegacy",
  "xlsx-not-zip": "xls.errorNotXlsx",
  "xlsx-not-ooxml": "xls.errorNotXlsx",
  "xlsx-corrupt": "xls.errorCorrupt",
  "xlsx-empty": "xls.errorEmpty",
};

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const file = request.files[0];
    if (!file) {
      post({ type: "error", runId, code: "tool.errorGeneric" });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    post({ type: "progress", runId, pct: 12, stage: "reading" });

    let wb: ParsedWorkbook;
    try {
      wb = parseXlsx(bytes);
    } catch (error) {
      const code =
        error instanceof XlsxParseError ? error.code : "xlsx-corrupt";
      post({
        type: "error",
        runId,
        code: ERROR_KEYS[code] ?? "xls.errorCorrupt",
        detail: file.name,
      });
      return;
    }

    const available = wb.sheets.map((s) => s.name);
    const runOpts = parseExcelRun(request.options, available);
    const byName = new Map(wb.sheets.map((s) => [s.name, s]));
    const selected = runOpts.sheetNames
      .map((name) => byName.get(name))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    if (selected.length === 0) {
      post({ type: "error", runId, code: "xls.errorEmpty", detail: file.name });
      return;
    }
    post({ type: "progress", runId, pct: 24, stage: "processing" });

    const doc = await PDFDocument.create();
    let font: PDFFont;
    let boldFont: PDFFont | null = null;
    if (needsNoto(selected)) {
      // Devanagari / ₹ / any non-WinAnsi content → the embedded Noto
      // subset (Regular only — hierarchy from the faux-bold double-draw)
      const fonts = await loadStampFonts(doc, true);
      font = fonts.fontFor("devanagari");
    } else {
      font = doc.embedStandardFont(StandardFonts.Helvetica);
      boldFont = doc.embedStandardFont(StandardFonts.HelveticaBold);
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    // Helvetica (WinAnsi) cannot encode a localized Hindi footer — the
    // honest fallback keeps the run alive instead of crashing the draw.
    const footerFmt =
      boldFont !== null && !isWinAnsiText(runOpts.footerFmt)
        ? "Sheet {n} of {m}"
        : runOpts.footerFmt;

    const report = drawWorkbookPdf(
      doc,
      font,
      boldFont,
      { ...wb, sheets: selected },
      {
        pageSize: runOpts.pageSize,
        orientation: runOpts.orientation,
        fit: runOpts.fit,
        zebra: runOpts.zebra,
        footerFmt,
      }
    );
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    doc.setProducer("MyCloudy");
    doc.setCreator("MyCloudy");
    doc.setTitle(
      selected.length === 1 ? selected[0].name : safeOutputBase(file.name, "")
    );
    doc.setCreationDate(new Date());

    const bytes2 = await doc.save();
    const base = safeOutputBase(file.name, "");
    const name =
      base !== "spreadsheet"
        ? `${base}.pdf`
        : `${safeOutputBase(selected[0].name, runOpts.fileWord)}.pdf`;
    post({
      type: "result",
      runId,
      outputs: [
        {
          name,
          mime: "application/pdf",
          blob: new Blob([bytes2 as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { pages: report.pages },
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
self.addEventListener("error", (e) => console.log("WORKER-ERR", String(e.message)));
