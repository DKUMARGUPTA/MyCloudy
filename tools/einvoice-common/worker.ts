/**
 * Shared e-invoice embed worker (P9 batch 5) — used by
 * create-electronic-invoice and pdf-to-e-invoice. Loads the source PDF,
 * builds the CII XML from the verified InvoiceState, attaches it the
 * Factur-X way, and returns BOTH the e-invoice PDF and the standalone
 * XML (portals often want the XML itself).
 *
 * The per-tool worker.ts files re-export this (the server-convert
 * sibling pattern turbopack compiles correctly).
 */

import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";
import { calc, parseInvoiceRun } from "../create-invoice/model";
import { buildCiiXml } from "./cii";
import { attachXmlToPdf } from "./embed";

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;

  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorNoFiles" });
    return;
  }

  const profile =
    options.profile === "xrechnung" ? "xrechnung" : "facturx";

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const base = file.name
      .replace(/\.(pdf)$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120);

    try {
      const inv = parseInvoiceRun(String(options.inv ?? "{}"));
      post({ type: "progress", runId, pct: 20, stage: "reading" });

      const c = calc(inv.s);
      const xml = buildCiiXml(inv.s, c, profile);
      post({ type: "progress", runId, pct: 55, stage: "processing" });

      const pdfBytes = new Uint8Array(await file.arrayBuffer());
      const attached = await attachXmlToPdf(pdfBytes, xml, "factur-x.xml", {
        documentType: "INVOICE",
        invoiceId: inv.s.no || "Invoice",
      });
      post({ type: "progress", runId, pct: 90, stage: "saving" });

      post({
        type: "result",
        runId,
        outputs: [
          {
            name: `${base}-e-invoice.pdf`,
            mime: "application/pdf",
            blob: new Blob([attached.bytes as unknown as BlobPart], {
              type: "application/pdf",
            }),
          },
          {
            name: `${base}-factur-x.xml`,
            mime: "application/xml",
            blob: new Blob([xml], { type: "application/xml" }),
          },
        ],
        detail: {
          files: 2,
          pages: attached.pages,
          annotations: inv.s.items.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /password/i.test(message)
        ? "tool.errorEncrypted"
        : /invalid|missing|structure/i.test(message)
          ? "tool.errorCorrupt"
          : "tool.errorGeneric";
      post({ type: "error", runId, code, detail: message });
      return;
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    post({
      type: "error",
      runId: data.runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  });
};
