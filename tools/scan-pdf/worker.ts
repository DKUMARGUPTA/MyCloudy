import { PDFDocument } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import {
  applyAdjustments,
  applyScanFilter,
  autoDeskew,
  denormalizeQuad,
  parseScanPagesOption,
  quadOutputSize,
  rotateQuarter,
  warpPerspective,
  type ScanBitmap,
} from "./engine";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Scan to PDF worker (PRD §8.4) — full-resolution pipeline at export time:
 * decode photo → perspective warp of the edited quad → filter → rotate →
 * JPEG → pdf-lib assembly. Everything stays on the device: photos arrive
 * by structured clone and the PDF Blob goes straight back.
 *
 * Quality policy (honest, bounded):
 * - warp output long edge is capped by the "quality" option (Standard
 *   1600 px ≈ 190 DPI A4 / High 2400 px ≈ 285 DPI A4) — the same cap real
 *   scanner apps use, keeping memory and file size sane.
 * - JPEG re-encode at 0.90 (B&W pages compress far below that budget).
 */

const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];
const MARGIN_PT: Record<string, number> = { none: 0, small: 18, big: 54 };
const MAX_EDGE: Record<string, number> = { standard: 1600, high: 2400 };

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type ImageKind = "jpeg" | "png" | "webp" | "gif" | "unknown";

function sniffImageKind(head: Uint8Array): ImageKind {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0xff, 0xd8, 0xff])) return "jpeg";
  if (has([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (has([0x47, 0x49, 0x46, 0x38])) return "gif";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  return "unknown";
}

/** Decodes a photo into raw RGBA via OffscreenCanvas. */
async function decodeBitmap(
  file: File,
  onError: (code: string, detail: string) => never
): Promise<ScanBitmap> {
  const raw = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (sniffImageKind(raw) === "unknown") {
    onError("tool.errorUnsupported", file.name);
  }
  let bitmap: ImageBitmap;
  try {
    // Bytes-first (watermark-worker pattern): the structured-cloned File's
    // lazy backing store can defeat createImageBitmap's async decoder in
    // some WebViews — one copy makes the decode bulletproof.
    const bytes = await file.arrayBuffer();
    bitmap = await createImageBitmap(
      new Blob([bytes], { type: file.type || "image/jpeg" })
    );
  } catch {
    onError("tool.errorDecode", file.name);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) onError("tool.errorDecode", file.name);
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    };
  } finally {
    bitmap.close();
  }
}

/** Renders a processed scan bitmap back to JPEG bytes. */
async function encodeJpeg(bmp: ScanBitmap, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("tool.errorEncode\u0000canvas");
  const imageData = new ImageData(
    new Uint8ClampedArray(bmp.data),
    bmp.width,
    bmp.height
  );
  context.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const pages =
    parseScanPagesOption(options.scan, files.length) ??
    (files.length > 0
      ? parseScanPagesOption(undefined, files.length)
      : []);

  if (pages === null || pages.length === 0) {
    post({ type: "error", runId, code: "tool.errorNoPages" });
    return;
  }

  const fail = (code: string, detail: string): never => {
    throw new Error(`${code}\u0000${detail}`);
  };

  const pageSize = String(options.pageSize ?? "a4");
  const margin = MARGIN_PT[String(options.margin ?? "none")] ?? 0;
  const maxEdge = MAX_EDGE[String(options.quality ?? "standard")] ?? 1600;
  // Round-7: "Auto-straighten text" — deskew each page when the projection
  // profile shows clear text-line structure (strength gate keeps photos
  // and blank pages untouched; angle window 0.3°…5° avoids noise spins).
  const autoStraighten = options.autoStraighten !== false;
  const docName = String(options.docName ?? "").trim();

  const pdf = await PDFDocument.create();

  /** Processes one printable side: decode → warp → filter → adjust →
   * rotate → deskew → JPEG. Shared by single pages and P5 pairs. */
  const processSide = async (
    side: {
      source: number;
      rotation: number;
      filter: string;
      adjust: { brightness: number; contrast: number };
      quad: number[];
    },
    maxEdge: number
  ) => {
    const file = files[side.source];
    const source = await decodeBitmap(file, fail);
    const quad = denormalizeQuad(side.quad as Parameters<typeof denormalizeQuad>[0], source.width, source.height);
    const { width, height } = quadOutputSize(quad, maxEdge);
    let warped = warpPerspective(source, quad, width, height);
    applyScanFilter(warped, side.filter as Parameters<typeof applyScanFilter>[1]);
    applyAdjustments(warped, side.adjust);
    warped = rotateQuarter(warped, side.rotation);
    if (autoStraighten && side.rotation % 180 === 0) {
      // Two-pass estimate+rotate (strength-gated: photos and blank pages
      // pass through untouched; 90°-turned pages skip — their tilt axis is
      // outside the sweep and the corner quad already covers the fix).
      warped = autoDeskew(warped);
    }
    const jpeg = await encodeJpeg(warped, 0.9);
    const image = await pdf.embedJpg(jpeg);
    return image;
  };

  // P5 double-sided ID cards: the visual gap between front and back on
  // the shared page (≈5 mm, like a real photocopy layout).
  const PAIR_GAP_PT = 14;

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const image = await processSide(page, maxEdge);

    if (page.back) {
      // ── Pair: front on top, back below, ONE PDF page, shared scale so
      // both sides of the card print the same size (photocopy layout).
      const backImage = await processSide(page.back, maxEdge);
      let pageW: number;
      let pageH: number;
      let scale: number;
      if (pageSize === "fit") {
        pageW = Math.max(image.width, backImage.width) + margin * 2;
        pageH = image.height + backImage.height + PAIR_GAP_PT + margin * 2;
        scale = 1;
      } else {
        // Stacked sides need a PORTRAIT page even for landscape photos.
        const base = pageSize === "letter" ? LETTER : A4;
        pageW = base[0];
        pageH = base[1];
        scale = Math.min(
          (pageW - margin * 2) / image.width,
          (pageW - margin * 2) / backImage.width,
          (pageH - margin * 2 - PAIR_GAP_PT) / (image.height + backImage.height)
        );
      }
      const pdfPage = pdf.addPage([pageW, pageH]);
      const totalH =
        (image.height + backImage.height) * scale + PAIR_GAP_PT;
      const yFront = (pageH + totalH) / 2 - image.height * scale;
      pdfPage.drawImage(image, {
        x: (pageW - image.width * scale) / 2,
        y: yFront,
        width: image.width * scale,
        height: image.height * scale,
      });
      pdfPage.drawImage(backImage, {
        x: (pageW - backImage.width * scale) / 2,
        y: yFront - PAIR_GAP_PT - backImage.height * scale,
        width: backImage.width * scale,
        height: backImage.height * scale,
      });
    } else {
      // ── Single page: the classic one-scan-per-page geometry.
      let pageW: number;
      let pageH: number;
      if (pageSize === "fit") {
        pageW = image.width + margin * 2;
        pageH = image.height + margin * 2;
      } else {
        const base = pageSize === "letter" ? LETTER : A4;
        const landscape = image.width > image.height;
        pageW = landscape ? base[1] : base[0];
        pageH = landscape ? base[0] : base[1];
      }
      const pdfPage = pdf.addPage([pageW, pageH]);
      const scale = Math.min(
        (pageW - margin * 2) / image.width,
        (pageH - margin * 2) / image.height
      );
      const drawW = image.width * scale;
      const drawH = image.height * scale;
      pdfPage.drawImage(image, {
        x: (pageW - drawW) / 2,
        y: (pageH - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(((i + 1) / pages.length) * 92),
      stage: "processing",
      detail: { page: i + 1, pages: pages.length },
    });
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const saved = await pdf.save({ useObjectStreams: true });

  // Name: the user's document name (Round-7 "Doc name"), else the first
  // source's base name, unless it is one of our own camera captures
  // (scan-…) — then a plain, friendly "scan".
  let base: string;
  if (docName) {
    base = docName.replace(/\.pdf$/i, "");
  } else {
    const firstName = files[pages[0].source].name;
    base = firstName.replace(/\.[^.]+$/, "") || "scan";
    if (/^scan(-|_)|^page(-|_)/i.test(base)) base = "scan";
  }
  const safeBase = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "scan";

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBase}-scan.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: pages.length },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const [code, detail] = message.split("\u0000");
    post({
      type: "error",
      runId: data.runId,
      code: code?.startsWith("tool.") ? code : "tool.errorGeneric",
      detail: detail || undefined,
    });
  });
};
