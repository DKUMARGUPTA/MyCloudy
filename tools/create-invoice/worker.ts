import { PDFDocument } from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadStampFonts } from "../stamp-common/worker-lib";
import { calc, outputBaseName, parseInvoiceRun } from "./model";
import { drawInvoice } from "./render";

/**
 * Create invoice worker (P3-INVOICE) — device-only, zero network beyond
 * the same-origin font. The standalone app exported the sheet through
 * html2pdf.js FROM A CDN (a raster JPEG screenshot of the DOM, ~300 KB,
 * text not selectable, and a privacy break). This worker instead draws
 * the SAME sheet as a true vector PDF with pdf-lib (render.ts):
 *
 *  - one embedded font — the self-hosted Noto Sans Devanagari — covers
 *    ₹ $ € £ + Latin + हिंदी in every label, so EN and HI invoices both
 *    print perfectly (verified: U+20B9 is glyph 790);
 *  - the UPI QR is drawn as VECTOR rectangles from the qrcode matrix
 *    (same npm engine as the Generate QR code tool) — crisp at any zoom;
 *  - totals are RE-COMPUTED here from the state with the same pure model
 *    the live preview uses — the PDF can never disagree with the screen;
 *  - items flow onto continuation pages with the header row repeated.
 *
 * All display labels arrive pre-resolved in `labels` (the surface's t()),
 * so the PDF text matches the UI language exactly. Drawing math lives in
 * render.ts, which the smoke script drives directly.
 */

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    const inv = parseInvoiceRun(String(request.options.inv ?? ""));
    post({ type: "progress", runId, pct: 20, stage: "processing" });

    const doc = await PDFDocument.create();
    // needDevanagari = always: ₹ and Hindi can appear in any label,
    // and the body font IS the Devanagari face by design.
    const fonts = await loadStampFonts(doc, true);
    const font = fonts.fontFor("devanagari");
    post({ type: "progress", runId, pct: 45, stage: "processing" });

    await drawInvoice(doc, font, inv);
    post({ type: "progress", runId, pct: 85, stage: "saving" });

    const bytes = await doc.save();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: outputBaseName(inv.s) + ".pdf",
          mime: "application/pdf",
          blob: new Blob([bytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: { pages: doc.getPageCount() },
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
