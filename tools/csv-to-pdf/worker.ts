import { CreateContext, type StampFontKey } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import type { ConvertFace } from "../convert-common/face";
import {
  drawDataTablesPdf,
  tablesNeedNoto,
  type DataTable,
  type TableOrientation,
  type TablePageSize,
} from "../data-table-common/render";
import {
  csvBaseName,
  csvGrid,
  sniffDelimiter,
  type CsvDelimiter,
} from "./worker-lib";

/**
 * CSV to PDF worker (P3-b — create-resume protocol):
 *
 *  1. every file's bytes → UTF-8 decode (BOM stripped) → full RFC 4180
 *     parse (the "auto" delimiter sniffs from the first 50 lines);
 *  2. honest clamps: 100 columns / 2000 rows per file — the cut is
 *     reported, never silent;
 *  3. one DataTable per file → the shared data-table painter, each
 *     table starting a fresh page titled with the file's base name;
 *  4. font pick — any non-WinAnsi cell (Devanagari, ₹ …) embeds the
 *     self-hosted Noto Sans Devanagari subset; pure-WinAnsi data
 *     stays on the base-14 Helvetica pair (nothing embedded);
 *  5. write with producer "DocoPDF" and the first file's base name.
 *
 * Empty/whitespace-only files are refused honestly (errorCorrupt);
 * a header-only CSV still renders a header-only table.
 */

const DELIMITERS: Record<string, CsvDelimiter> = {
  comma: ",",
  semicolon: ";",
  tab: "\t",
};

function decodeText(bytes: Uint8Array): string {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.startsWith("﻿")) text = text.slice(1);
  return text;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    if (request.files.length === 0) {
      post({ type: "error", runId, code: "tool.errorNoFile" });
      return;
    }

    const delimChoice = String(request.options.delimiter ?? "auto");
    const headerRow = request.options.header !== false;
    const orientation: TableOrientation =
      String(request.options.orientation ?? "portrait") === "landscape"
        ? "landscape"
        : "portrait";
    const pageSize: TablePageSize =
      String(request.options.pageSize ?? "a4") === "letter" ? "letter" : "a4";
    const zebra = request.options.zebra === true;
    const fit = request.options.fit !== false;

    const tables: DataTable[] = [];
    let fileIdx = 0;
    for (const file of request.files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = decodeText(bytes);
      if (text.trim() === "") {
        post({
          type: "error",
          runId,
          code: "tool.errorCorrupt",
          detail: file.name,
        });
        return;
      }
      const delimiter: CsvDelimiter =
        delimChoice === "auto"
          ? sniffDelimiter(text)
          : (DELIMITERS[delimChoice] ?? ",");
      const grid = csvGrid(text, delimiter, headerRow);
      tables.push({
        title: csvBaseName(file.name),
        header: grid.header,
        rows: grid.rows,
      });
      fileIdx++;
      post({
        type: "progress",
        runId,
        pct: 10 + Math.round((fileIdx / request.files.length) * 30),
        stage: "reading",
      });
    }

    post({ type: "progress", runId, pct: 48, stage: "processing" });

    const pdfDoc = CreateContext.create();
    let font: ConvertFace;
    let boldKey: StampFontKey | null = null;
    if (tablesNeedNoto(tables)) {
      // Devanagari / ₹ / any non-WinAnsi content → the embedded Noto
      // subset (Regular only — header hierarchy via faux-bold)
      const notoBytes = await loadDevanagariBytes();
      font = { ttf: pdfDoc.embedTtf(notoBytes) };
    } else {
      font = { std: "helvetica" };
      boldKey = "helveticaBold";
    }

    const report = drawDataTablesPdf(pdfDoc, font, boldKey, tables, {
      pageSize,
      orientation,
      fit,
      zebra,
    });
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    pdfDoc.setTitle(tables[0]?.title ?? "csv-data");
    pdfDoc.setCreationDate(new Date());

    const outBytes = pdfDoc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${tables[0]?.title ?? "csv-data"}.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: tables.length,
        pages: report.pages,
      },
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
