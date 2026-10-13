import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type { OptionValues } from "@/lib/tools/config-types";
import { parseImageGridOption } from "./model";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";

/**
 * Images → PDF worker (PRD §8.6) — shared by images-to-pdf and its
 * jpg/png/webp/heic-to-pdf presets. Device-only: files arrive by structured
 * clone, pdf-lib embeds them, the PDF Blob goes straight back.
 *
 * Quality policy (honest, no silent re-compression):
 * - unrotated JPG/PNG → the ORIGINAL bytes are embedded (zero quality loss)
 * - rotated images, or WEBP/GIF/HEIC sources → decoded (createImageBitmap,
 *   with the self-hosted libheif WASM as HEIC fallback so Chromium works
 *   too), drawn (rotated) onto an OffscreenCanvas and re-encoded (JPEG 0.92
 *   for photos, PNG when alpha is possible)
 */

const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];
const MARGIN_PT: Record<string, number> = { none: 0, small: 18, big: 54 };
const BG_RGB: Record<string, [number, number, number]> = {
  white: [1, 1, 1],
  soft: [0.96, 0.955, 0.94],
  dark: [0.09, 0.09, 0.11],
};

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

type ImageKind = "jpeg" | "png" | "webp" | "gif" | "heic" | "unknown";

function sniffImageKind(head: Uint8Array): ImageKind {
  const has = (bytes: number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  if (has([0xff, 0xd8, 0xff])) return "jpeg";
  if (has([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (has([0x47, 0x49, 0x46, 0x38])) return "gif";
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  if (has([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(
      head[8] ?? 0,
      head[9] ?? 0,
      head[10] ?? 0,
      head[11] ?? 0
    );
    if (
      ["heic", "heix", "hevc", "hevm", "hevs", "heim", "heis", "mif1", "msf1"].includes(brand)
    ) {
      return "heic";
    }
  }
  return "unknown";
}

/** PNG IHDR dimensions — no decode needed (bytes 16..24, big-endian). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

interface PreparedImage {
  /** pdf-lib embed call to use. */
  kind: "jpeg" | "png";
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Decodes (when needed), rotates and encodes one image. `reuseBitmap`
 * avoids decoding twice for transcode/rotate paths.
 */
async function prepareImage(
  file: File,
  rotation: number,
  onError: (code: string, detail: string) => never
): Promise<PreparedImage> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImageKind(raw.slice(0, 16));
  const rotated = rotation !== 0;

  // Fast path: original bytes, untouched.
  if (!rotated && (kind === "jpeg" || kind === "png")) {
    const size =
      kind === "png"
        ? pngSize(raw)
        : await bitmapSize(file, onError).catch(() => null);
    if (size) {
      return { kind, bytes: raw, width: size.width, height: size.height };
    }
  }

  if (kind === "unknown") {
    onError("tool.images.errorUnsupported", file.name);
  }

  // Decode path (rotation or transcode). HEIC: native decode first
  // (Safari), then the self-hosted libheif WASM so Chromium/Edge/Firefox
  // work too — the honest error only fires when both fail.
  let bitmap: ImageBitmap;
  if (kind === "heic") {
    bitmap = await decodeHeicWithFallback(file, raw, onError);
  } else {
    try {
      bitmap = await createImageBitmap(
        kind === "jpeg" || kind === "png"
          ? new Blob([raw as unknown as BlobPart], { type: `image/${kind}` })
          : file
      );
    } catch {
      onError("tool.images.errorDecode", file.name);
    }
  }

  try {
    const swap = rotation === 90 || rotation === 270;
    const width = swap ? bitmap.height : bitmap.width;
    const height = swap ? bitmap.width : bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) onError("tool.images.errorDecode", file.name);

    if (kind !== "jpeg" && kind !== "heic") {
      // Sources that may carry alpha → PNG keeps it.
      context.fillStyle = "rgba(0,0,0,0)";
    } else {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.translate(width / 2, height / 2);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

    const outKind: "jpeg" | "png" =
      kind === "jpeg" || kind === "heic" ? "jpeg" : "png";
    const blob = await canvas.convertToBlob({
      type: outKind === "jpeg" ? "image/jpeg" : "image/png",
      quality: 0.92,
    });
    return {
      kind: outKind,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width,
      height,
    };
  } finally {
    bitmap.close();
  }
}

async function bitmapSize(
  file: File,
  onError: (code: string, detail: string) => never
): Promise<{ width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    onError("tool.images.errorDecode", file.name);
  }
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/**
 * HEIC decode: try the browser's native decoder first (Safari — fast,
 * zero download), fall back to the self-hosted libheif WASM build that
 * works in every browser (src/lib/heic/heic-decode.ts).
 */
async function decodeHeicWithFallback(
  file: File,
  raw: Uint8Array,
  onError: (code: string, detail: string) => never
): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Chromium/Firefox: native HEIC decode is unavailable — use libheif.
  }
  try {
    return await decodeHeicToBitmap(raw);
  } catch {
    onError("tool.images.errorHeicDecode", file.name);
  }
}

/** Contain-fit `image` into a cell, centered. */
function fitInto(
  image: { width: number; height: number },
  cell: { x: number; y: number; w: number; h: number }
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(cell.w / image.width, cell.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  type WorkerEntry = { source: number; rotation: number };
  const entries: WorkerEntry[] =
    parseImageGridOption(options.images, files.length) ??
    Array.from({ length: files.length }, (_, source) => ({ source, rotation: 0 }));

  if (entries.length === 0) {
    post({ type: "error", runId, code: "tool.images.errorNoImages" });
    return;
  }

  const fail = (code: string, detail: string): never => {
    throw new Error(`${code}\u0000${detail}`);
  };

  const pageSize = String(options.pageSize ?? "a4");
  const orientation = String(options.orientation ?? "auto");
  const margin = MARGIN_PT[String(options.margin ?? "small")] ?? 18;
  const twoUp = String(options.layout ?? "one") === "two";
  const background = BG_RGB[String(options.background ?? "white")] ?? BG_RGB.white;
  const pageNumbers = options.pageNumbers === true;

  const pdf = await PDFDocument.create();
  const font = pageNumbers
    ? await pdf.embedFont(StandardFonts.Helvetica)
    : null;

  const groups: { source: number; rotation: number }[][] = [];
  if (twoUp) {
    for (let i = 0; i < entries.length; i += 2) {
      groups.push(entries.slice(i, i + 2));
    }
  } else {
    groups.push(...entries.map((entry) => [entry]));
  }

  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    const prepared: PreparedImage[] = [];
    for (const entry of group) {
      prepared.push(
        await prepareImage(files[entry.source], entry.rotation, fail)
      );
    }

    // Page size: fixed (A4/Letter, orientation-forced or auto) or fitted.
    let pageW: number;
    let pageH: number;
    if (pageSize === "fit") {
      pageW = Math.max(...prepared.map((p) => p.width)) + margin * 2;
      pageH = Math.max(...prepared.map((p) => p.height)) + margin * 2;
    } else {
      const base = pageSize === "letter" ? LETTER : A4;
      const widest = Math.max(...prepared.map((p) => p.width));
      const tallest = Math.max(...prepared.map((p) => p.height));
      const landscape =
        orientation === "landscape" ||
        (orientation === "auto" && widest > tallest);
      pageW = landscape ? base[1] : base[0];
      pageH = landscape ? base[0] : base[1];
    }

    const page = pdf.addPage([pageW, pageH]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageW,
      height: pageH,
      color: rgb(background[0], background[1], background[2]),
    });

    const embed = async (image: PreparedImage) => {
      return image.kind === "jpeg"
        ? await pdf.embedJpg(image.bytes)
        : await pdf.embedPng(image.bytes);
    };

    if (twoUp && prepared.length === 2) {
      const cellW = (pageW - margin * 3) / 2;
      const cellH = pageH - margin * 2;
      for (let i = 0; i < prepared.length; i += 1) {
        const cell = {
          x: margin + i * (cellW + margin),
          y: margin,
          w: cellW,
          h: cellH,
        };
        const box = fitInto(prepared[i], cell);
        const img = await embed(prepared[i]);
        page.drawImage(img, { ...box });
      }
    } else {
      const cell = { x: margin, y: margin, w: pageW - margin * 2, h: pageH - margin * 2 };
      const box = fitInto(prepared[0], cell);
      const img = await embed(prepared[0]);
      page.drawImage(img, { ...box });
    }

    post({
      type: "progress",
      runId,
      pct: Math.round(((g + 1) / groups.length) * 92),
      stage: "processing",
      detail: { page: g + 1, pages: groups.length },
    });
  }

  if (font) {
    const total = pdf.getPageCount();
    const pages = pdf.getPages();
    for (let i = 0; i < pages.length; i += 1) {
      const label = `${i + 1} / ${total}`;
      const size = font.widthOfTextAtSize(label, 9);
      pages[i].drawText(label, {
        x: (pages[i].getWidth() - size) / 2,
        y: 14,
        size: 9,
        font,
        color: rgb(0.45, 0.45, 0.5),
      });
    }
  }

  post({ type: "progress", runId, pct: 95, stage: "saving" });
  const saved = await pdf.save({ useObjectStreams: true });
  const base = files[entries[0].source].name.replace(/\.[^.]+$/, "") || "images";
  const safeBase = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "images";

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: `${safeBase}.pdf`,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: { files: 1, pages: groups.length },
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
      code: code?.startsWith("tool.") ? code : "tool.errorCorrupt",
      detail: detail || undefined,
    });
  });
};
