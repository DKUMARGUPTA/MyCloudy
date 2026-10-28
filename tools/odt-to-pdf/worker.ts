import { CreateContext, type StampFontKey } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import {
  needsNoto,
  OdfParseError,
  outputBaseName,
  parseOdt,
} from "./model";
import { drawOdfPdf } from "./render";
import type { ConvertFace } from "../convert-common/face";

/**
 * OpenDocument to PDF worker (RB2-b — the 72nd tool) — device-only,
 * zero network beyond the same-origin font. Mirrors the word-to-pdf
 * worker protocol:
 *
 *  1. read the .odt/.ods bytes from request.files[0] and parseOdt them
 *     (fflate unzip + the tokenizer); a rejected file (non-ZIP, .odp,
 *     .odg, missing content.xml, empty body) posts its honest code;
 *  2. font pick — pure-WinAnsi content embeds NO font at all
 *     (base-14 Helvetica + HelveticaBold), while ANY Devanagari char
 *     switches to the self-hosted Noto Sans Devanagari (OUR
 *     Type0/CIDFontType2 subsetter + Indic shaper) — the
 *     create-resume/stamp-common recipe;
 *  3. drawOdfPdf — the exact render.ts the smoke script drives;
 *  4. write with producer/creator "DocoPDF" and the localized name.
 *
 * Options: pageSize ("a4"|"letter"), margin ("normal"|"narrow") and
 * lang ("en"|"hi" — the localized fallback word for a nameless file).
 * The document kind (text vs sheets) is auto-detected from the file.
 */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const file = request.files[0];
    if (!file) {
      post({ type: "error", runId, code: "odt.errNoFile" });
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    let doc;
    try {
      doc = parseOdt(bytes);
    } catch (error) {
      if (error instanceof OdfParseError) {
        post({ type: "error", runId, code: `odt.${error.code}`, detail: file.name });
        return;
      }
      throw error;
    }

    const opts = {
      pageSize: (String(request.options.pageSize) === "letter"
        ? "letter"
        : "a4") as "a4" | "letter",
      margin: (String(request.options.margin) === "narrow"
        ? "narrow"
        : "normal") as "normal" | "narrow",
    };
    const lang = String(request.options.lang) === "hi" ? "hi" : "en";

    const pdfDoc = CreateContext.create();
    let font: ConvertFace;
    let boldKey: StampFontKey | null = null;
    if (needsNoto(doc)) {
      // Devanagari (or any non-WinAnsi) content → the embedded Noto
      // subset. OFL ships Regular only: hierarchy comes from size, and
      // bold text falls back to the regular face.
      const notoBytes = await loadDevanagariBytes();
      font = { ttf: pdfDoc.embedTtf(notoBytes) };
    } else {
      font = { std: "helvetica" };
      boldKey = "helveticaBold";
    }
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const report = drawOdfPdf(pdfDoc, font, boldKey, doc, opts);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const baseName = outputBaseName(file.name, lang);
    pdfDoc.setProducer("DocoPDF");
    pdfDoc.setCreator("DocoPDF");
    pdfDoc.setTitle(baseName);
    pdfDoc.setCreationDate(new Date());

    const bytes2 = pdfDoc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${baseName}.pdf`,
          mime: "application/pdf",
          blob: new Blob([bytes2 as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        pages: report.pages,
        words:
          doc.kind === "text"
            ? doc.blocks.reduce(
                (sum, b) =>
                  b.kind === "table"
                    ? sum +
                      b.rows.reduce(
                        (s, r) =>
                          s + r.join(" ").split(/\s+/).filter(Boolean).length,
                        0
                      )
                    : sum +
                      b.runs.reduce(
                        (s, r) => s + r.text.split(/\s+/).filter(Boolean).length,
                        0
                      ),
                0
              )
            : doc.sheets.reduce(
                (sum, sh) =>
                  sum +
                  sh.grid.reduce(
                    (s, r) =>
                      s + r.join(" ").split(/\s+/).filter(Boolean).length,
                    0
                  ),
                0
              ),
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
