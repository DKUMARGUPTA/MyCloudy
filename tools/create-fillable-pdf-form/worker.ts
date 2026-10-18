import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { parseFormDoc, outputBaseName } from "./model";
import { drawFormPdf } from "./render";

/**
 * Create fillable PDF form worker (P3-FORM) — device-only, zero network
 * beyond the same-origin font. The surface ships the serialized FormDoc
 * in the `form` option; this worker:
 *
 *  1. parseFormDoc — full defensive coercion at the boundary (unknown
 *     kinds dropped, geometry clamped, names deduped);
 *  2. draws statics + labels with the ONE embedded font (self-hosted
 *     Noto Sans Devanagari — ₹ + हिंदी + Latin all print) via render.ts;
 *  3. adds REAL AcroForm widgets (text/multiline/number/date/checkbox/
 *     radio/dropdown), required flags, maxLength, Adobe AF* format and
 *     keystroke actions, calculation /AA /C scripts and the AcroForm /CO
 *     calculation order — ISO 32000-1 §12.6.4;
 *  4. saves ONE PDF blob named from the form title.
 */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const form = parseFormDoc(request.options.form ?? "");
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    const doc = await PDFDocument.create();
    // needDevanagari = always: printed labels can be हिंदी/₹ in any form.
    const fonts = await loadStampFonts(doc, true);
    const font = fonts.fontFor("devanagari");
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    const report = drawFormPdf(doc, font, form);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const bytes = await doc.save();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outputBaseName(form) + ".pdf",
          mime: "application/pdf",
          blob: new Blob([bytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        pages: report.pages,
        fields: report.fields,
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
