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
import { jsonBaseName, jsonToTable, parseJsonDocument } from "./worker-lib";

/**
 * JSON to PDF worker (P3-b — create-resume protocol):
 *
 *  1. every file's bytes → UTF-8 decode (BOM stripped) → strict
 *     JSON.parse, with the honest NDJSON / JSON-Lines fallback;
 *  2. shape auto-detection (records / matrix / values / object /
 *     scalar) → one DataTable per file via the PURE engine;
 *  3. the shared data-table painter, each table starting a fresh page
 *     titled with the file's base name;
 *  4. font pick — any non-WinAnsi cell embeds the self-hosted Noto
 *     Sans Devanagari subset; pure-WinAnsi data stays base-14;
 *  5. write with producer "DocoPDF".
 *
 * Unparseable files are refused honestly (errorCorrupt) — never a
 * guessed-at rendering.
 */

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
      const parsed = parseJsonDocument(text);
      if (parsed === null) {
        post({
          type: "error",
          runId,
          code: "tool.errorCorrupt",
          detail: file.name,
        });
        return;
      }
      tables.push(jsonToTable(parsed.value, jsonBaseName(file.name)).table);
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
    pdfDoc.setTitle(tables[0]?.title ?? "json-data");
    pdfDoc.setCreationDate(new Date());

    const outBytes = pdfDoc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${tables[0]?.title ?? "json-data"}.pdf`,
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
