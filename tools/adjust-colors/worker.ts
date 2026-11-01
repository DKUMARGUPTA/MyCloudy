import { CreateContext } from "@/lib/own/pdf";
import {
  parsePageSpec,
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { RenderPixelBudget } from "../pdfjs-common/pixel-budget";

/**
 * Adjust colors worker (PHASE-3 batch 2): renders every selected page with
 * pdf.js, then applies brightness → contrast → saturation per pixel and
 * rebuilds a fresh PDF with each page as a full-bleed PNG (lossless) via
 * OUR OWN CreateContext. Never touches the network.
 *
 * Math (photo-editor order):
 *   brightness  v' = v + b·2.55
 *   contrast    c  = (259·(C+255)) / (255·(259−C)) ; v' = c·(v−128)+128
 *   saturation  l  = 0.2126r + 0.7152g + 0.0722b ; v' = l + (v−l)·s
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

const clamp255 = (v: number): number =>
  v < 0 ? 0 : v > 255 ? 255 : v;

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const dpi = Number(options.dpi ?? 150);
  const scale = Math.max(0.5, Math.min(6, dpi / 72));

  const brightness = Math.max(-100, Math.min(100, Number(options.brightness ?? 0)));
  const contrastRaw = Math.max(-100, Math.min(100, Number(options.contrast ?? 0)));
  const saturation = Math.max(-100, Math.min(100, Number(options.saturation ?? 0)));

  // Contrast in the classic −100..100 UI space → 0..2-ish factor.
  const c = contrastRaw === 0 ? 1 : (259 * (contrastRaw + 255)) / (255 * (259 - contrastRaw));
  const b = brightness * 2.55;
  const s = 1 + saturation / 100;

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const data = new Uint8Array(await file.arrayBuffer());
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;

  const pageNumbers = parsePageSpec(String(options.pages ?? "all"), doc.numPages);
  if (pageNumbers === null || pageNumbers.length === 0) {
    post({ type: "error", runId, code: "tool.errorInvalidPages" });
    return;
  }

  const budget = new RenderPixelBudget();
  const pdf = CreateContext.create();

  for (let i = 0; i < pageNumbers.length; i += 1) {
    const pageNumber = pageNumbers[i]! + 1;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));

    if (!budget.tryConsume(width, height)) {
      page.cleanup();
      doc.cleanup();
      post({ type: "error", runId, code: "tool.errorRenderBudget" });
      return;
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-2d-unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    page.cleanup();

    // The color pass: brightness → contrast → saturation.
    const image = context.getImageData(0, 0, width, height);
    const px = image.data;
    for (let p = 0; p < px.length; p += 4) {
      let r = px[p]! + b;
      let g = px[p + 1]! + b;
      let bl = px[p + 2]! + b;
      if (contrastRaw !== 0) {
        r = c * (r - 128) + 128;
        g = c * (g - 128) + 128;
        bl = c * (bl - 128) + 128;
      }
      if (saturation !== 0) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r = l + (r - l) * s;
        g = l + (g - l) * s;
        bl = l + (bl - l) * s;
      }
      px[p] = clamp255(r);
      px[p + 1] = clamp255(g);
      px[p + 2] = clamp255(bl);
    }
    context.putImageData(image, 0, 0);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const embedded = pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
    // Point-space page (viewport was scaled) — scale back to 72dpi points.
    const ptW = width / scale;
    const ptH = height / scale;
    const out = pdf.addPage(ptW, ptH);
    out.drawImage(embedded, { x: 0, y: 0, width: ptW, height: ptH });

    post({
      type: "progress",
      runId,
      pct: Math.round(6 + (88 * (i + 1)) / pageNumbers.length),
      stage: "processing",
      detail: { page: i + 1, pages: pageNumbers.length },
    });
  }
  doc.cleanup();

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const saved = pdf.write();
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-adjusted.pdf`,
      mime: "application/pdf",
      blob: new Blob([saved as unknown as BlobPart], {
        type: "application/pdf",
      }),
    },
  ];
  post({
    type: "result",
    runId,
    outputs,
    detail: { files: 1, pages: pageNumbers.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /Invalid PDF|structure|corrupt/i.test(message)
      ? "tool.errorCorrupt"
      : /encrypt|password/i.test(message)
        ? "tool.errorEncrypted"
        : "tool.errorGeneric";
    post({ type: "error", runId: data.runId, code });
  });
};
