import { CreateContext } from "@/lib/own/pdf";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";
import { RenderPixelBudget } from "../pdfjs-common/pixel-budget";

/**
 * Scanner effect worker (PHASE-3 batch 2): renders every page with pdf.js,
 * then builds the flatbed illusion — palette pass (greyscale / threshold
 * / faint colour), sensor noise, and a slight tilt drawn onto a fresh
 * white canvas — and rebuilds a PDF with each page as a full-bleed JPEG
 * (scanners are JPEG machines; quality 0.82) via OUR OWN CreateContext.
 * Never touches the network.
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

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  if (files.length === 0) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const dpi = Number(options.dpi ?? 200);
  const scale = Math.max(0.5, Math.min(6, dpi / 72));
  const mode =
    options.color === "bw" || options.color === "faint-color"
      ? (options.color as "bw" | "faint-color")
      : "grayscale";

  const tiltRaw = Number(options.tilt ?? 0.5);
  const tilt =
    Number.isFinite(tiltRaw) && tiltRaw >= 0 && tiltRaw <= 3 ? tiltRaw : 0.5;
  const noiseRaw = Number(options.noise ?? 25);
  const noise =
    Number.isFinite(noiseRaw) && noiseRaw >= 0 && noiseRaw <= 100 ? noiseRaw : 25;
  const noiseAmp = noise * 0.55; // ±luminance jitter
  const saltChance = noise / 2000; // bright speck probability per pixel

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const pdfjs: PdfjsModule = await loadPdfjsInWorker();
  const pdf = CreateContext.create();

  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex]!;
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;

    const budget = new RenderPixelBudget();

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
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

      // Pass 1 — palette (luminance → mode).
      const image = context.getImageData(0, 0, width, height);
      const px = image.data;
      for (let p = 0; p < px.length; p += 4) {
        const r = px[p]!;
        const g = px[p + 1]!;
        const b = px[p + 2]!;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let nr: number;
        let ng: number;
        let nb: number;
        if (mode === "bw") {
          const v = lum > 160 ? 255 : 0;
          nr = v;
          ng = v;
          nb = v;
        } else if (mode === "faint-color") {
          // 75% greyscale + 25% original, plus a warm paper tint.
          nr = clamp255(lum * 0.75 + r * 0.25) * 1.02 + 5;
          ng = clamp255(lum * 0.75 + g * 0.25) * 0.99 + 2;
          nb = clamp255(lum * 0.75 + b * 0.25) * 0.92;
          nr = clamp255(nr);
          ng = clamp255(ng);
          nb = clamp255(nb);
        } else {
          nr = lum;
          ng = lum;
          nb = lum;
        }
        // Pass 2 — sensor noise (skipped for pure white paper background).
        if (noise > 0 && !(nr > 249 && ng > 249 && nb > 249)) {
          const jitter = (Math.random() - 0.5) * 2 * noiseAmp;
          const salt = Math.random() < saltChance ? 60 : 0;
          nr = clamp255(nr + jitter + salt);
          ng = clamp255(ng + jitter + salt);
          nb = clamp255(nb + jitter + salt);
        }
        px[p] = nr;
        px[p + 1] = ng;
        px[p + 2] = nb;
      }
      context.putImageData(image, 0, 0);

      // Pass 3 — the tilt: rotate the treated page onto a white sheet,
      // upscaled a hair so the rotated corners stay covered.
      let sheet = canvas;
      if (tilt > 0) {
        const rad = (tilt * Math.PI) / 180;
        const cover = 1 + rad * rad * 0.75;
        const outW = Math.ceil(width * cover);
        const outH = Math.ceil(height * cover);
        const rotated = new OffscreenCanvas(outW, outH);
        const rctx = rotated.getContext("2d");
        if (!rctx) throw new Error("canvas-2d-unavailable");
        rctx.fillStyle = "#ffffff";
        rctx.fillRect(0, 0, outW, outH);
        rctx.translate(outW / 2, outH / 2);
        rctx.rotate(rad);
        rctx.drawImage(canvas, -width / 2, -height / 2, width, height);
        sheet = rotated;
      }

      const blob = await sheet.convertToBlob({
        type: "image/jpeg",
        quality: 0.82,
      });
      const embedded = pdf.embedJpeg(new Uint8Array(await blob.arrayBuffer()));
      // Point-space page — scale back to 72dpi points.
      const ptW = sheet.width / scale;
      const ptH = sheet.height / scale;
      const out = pdf.addPage(ptW, ptH);
      out.drawImage(embedded, { x: 0, y: 0, width: ptW, height: ptH });

      totalPages += 1;
      post({
        type: "progress",
        runId,
        pct: Math.round(
          6 +
            (88 * (fileIndex + pageNumber / doc.numPages)) / files.length
        ),
        stage: "processing",
        detail: { page: totalPages },
      });
    }
    doc.cleanup();
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const saved = pdf.write();
  const base = safeBaseName(files[0]!.name);
  const outputs = [
    {
      name:
        files.length > 1
          ? `${base}-scanned-batch.pdf`
          : `${base}-scanned.pdf`,
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
    detail: { files: files.length, pages: totalPages },
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
