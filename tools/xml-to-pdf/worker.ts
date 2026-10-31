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
import { parseXml } from "../xml-invoice-to-pdf/xml";
import { xmlBaseName, xmlToTable } from "./worker-lib";

/**
 * XML to PDF worker (P3-b — create-resume protocol):
 *
 *  1. every file's bytes → our own namespace-aware parser (prolog,
 *     CDATA, DOCTYPE skip, entity decoding — the UBL/CII-grade
 *     well-formedness from the e-invoice tool);
 *  2. auto-detection: repeated like-named elements become records
 *     (RSS items, sitemap urls, product feeds) with child-element
 *     columns + @attribute columns; no repetition → the flattened
 *     Path/Value leaf view;
 *  3. the shared data-table painter, each file its own titled table;
 *  4. font pick — any non-WinAnsi cell embeds the self-hosted Noto
 *     Sans Devanagari subset; pure-WinAnsi data stays base-14;
 *  5. write with producer "DocoPDF".
 *
 * Malformed XML is refused honestly (errorCorrupt) — never a
 * guessed-at rendering.
 */

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

    const showAttributes = request.options.attributes !== false;
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
      let root;
      try {
        root = parseXml(bytes);
      } catch {
        post({
          type: "error",
          runId,
          code: "tool.errorCorrupt",
          detail: file.name,
        });
        return;
      }
      tables.push(xmlToTable(root, xmlBaseName(file.name), showAttributes).table);
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
    pdfDoc.setTitle(tables[0]?.title ?? "xml-data");
    pdfDoc.setCreationDate(new Date());

    const outBytes = pdfDoc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${tables[0]?.title ?? "xml-data"}.pdf`,
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
