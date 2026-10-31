import { CreateContext } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { decodeHeicToBitmap } from "@/lib/heic/heic-decode";
import { isTiffBytes, TiffFile, TiffError } from "../imgconv/tiff";
import {
  computeSheets,
  mergedTextsFor,
  outputBaseName,
  pagePixelSize,
  pagePtSize,
  parseCardOption,
  parseCsv,
  templateById,
  validatePlaceholders,
  CsvError,
} from "./model";
import {
  drawCardSheet,
  loadTemplateBackdrop,
  type CardCtx,
  type CardSource,
} from "./render";

/**
 * Create card worker (PRD "Card") — device-only. Files arrive by
 * structured clone (the optional photo), every sheet is painted on an
 * OffscreenCanvas by the SAME render.ts the live preview uses, and the
 * result goes straight back as a Blob. Nothing ever leaves the device.
 *
 * Quality policy (honest): the card is a raster composition, so the
 * optional photo is re-encoded once — JPEG quality 0.92, the same
 * single re-compression policy as the collage / imagegrid rotated
 * branch. The PDF is one page per sheet with the JPEG drawn at 2 px/pt
 * (~144 DPI). Folded cards get TWO pages per card (outside then
 * inside — see model.ts for the fold model). JPG/PNG export renders
 * the FIRST sheet only (documented in the UI).
 *
 * Template backgrounds are same-origin static assets fetched with a
 * relative URL; ANY failure falls back to the template gradient
 * (render.ts) — a missing image never kills an export.
 *
 * Photo decode: JPG / PNG / WEBP / GIF natively (createImageBitmap),
 * HEIC via Safari native with the self-hosted libheif WASM fallback,
 * TIFF via the clean-room first-page reader; SVG is honestly
 * unsupported in this tool (v1) — the collage's decode recipe.
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/**
 * Best-effort font registration for the OffscreenCanvas: browsers that
 * expose the CSS Font Loading API inside dedicated workers (Chromium,
 * Firefox) get the self-hosted Noto Sans Devanagari — so Hindi text
 * renders even on fontless systems. Any failure falls back to the
 * system font stacks in render.ts (every mainstream OS ships a
 * Devanagari-capable fallback), so the export never dies here.
 */
let fontsReady: Promise<void> | null = null;
function ensureWorkerFonts(): Promise<void> {
  if (fontsReady) return fontsReady;
  fontsReady = (async () => {
    try {
      const scope = self as unknown as { fonts?: { add: (f: unknown) => void } };
      if (!scope.fonts || typeof FontFace === "undefined") return;
      const face = new FontFace(
        "Noto Sans Devanagari",
        "url(/fonts/NotoSansDevanagari-Regular.ttf)"
      );
      await face.load();
      scope.fonts.add(face);
    } catch {
      // System fonts — honest fallback (render.ts stacks).
    }
  })();
  return fontsReady;
}

type ImageKind = "jpeg" | "png" | "webp" | "gif" | "heic" | "tiff" | "svg" | "unknown";

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
  if (isTiffBytes(head)) return "tiff";
  return "unknown";
}

/** "<svg" within the first KB (after xml decl / doctype / comments). */
function isSvgBytes(head: Uint8Array): boolean {
  const window = head.subarray(0, 1024);
  let text = "";
  for (let i = 0; i < window.length; i += 1) {
    text += String.fromCharCode(window[i]);
  }
  return /<svg[\s>]/i.test(text);
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}\u0000${detail}`);
}

function tiffErrorCode(error: TiffError): string {
  if (error.kind === "tiff-corrupt") return "tool.images.errorTiffCorrupt";
  if (error.kind === "tiff-too-large") return "tool.images.errorTiffTooLarge";
  return "tool.images.errorTiffUnsupported";
}

/**
 * Decodes the card photo to a bitmap (collage's decodePhoto — magic
 * sniff, HEIC native → libheif, TIFF first page, SVG honest reject).
 */
async function decodePhoto(file: File): Promise<ImageBitmap> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name) || isSvgBytes(head)) {
    fail("tool.images.errorUnsupported", file.name);
  }
  const kind = sniffImageKind(head);
  if (kind === "unknown") {
    fail("tool.images.errorUnsupported", file.name);
  }
  if (kind === "heic") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Chromium/Firefox: native HEIC decode is unavailable — libheif.
      try {
        return await decodeHeicToBitmap(
          new Uint8Array(await file.arrayBuffer())
        );
      } catch {
        fail("tool.images.errorHeicDecode", file.name);
      }
    }
  }
  if (kind === "tiff") {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const tiff = TiffFile.parse(bytes);
      if (tiff.pageCount === 0) fail("tool.images.errorTiffCorrupt", file.name);
      const page = tiff.decodePage(0);
      const canvas = new OffscreenCanvas(page.width, page.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) fail("tool.images.errorDecode", file.name);
      ctx.putImageData(
        new ImageData(page.rgba, page.width, page.height) as unknown as ImageData,
        0,
        0
      );
      return await createImageBitmap(canvas);
    } catch (error) {
      if (error instanceof TiffError) fail(tiffErrorCode(error), file.name);
      throw error;
    }
  }
  try {
    return await createImageBitmap(file);
  } catch {
    fail("tool.images.errorDecode", file.name);
  }
}

/**
 * Encodes one card sheet to a JPEG blob (quality 0.92). convertToBlob
 * IS the canvas commit — nothing reads pixels back.
 */
async function renderSheetBlob(
  sheet: ReturnType<typeof computeSheets>[number],
  texts: ReturnType<typeof mergedTextsFor>,
  option: ReturnType<typeof parseCardOption>,
  photo: CardSource | null,
  backdrop: CardSource | null,
  pixelW: number,
  pixelH: number
): Promise<Blob> {
  const canvas = new OffscreenCanvas(pixelW, pixelH);
  const ctx = canvas.getContext("2d") as CardCtx | null;
  if (!ctx) fail("tool.errorGeneric", "canvas");
  drawCardSheet(
    ctx,
    sheet,
    {
      template: option.template,
      format: option.format,
      orientation: option.orientation,
      texts,
      background: option.background,
    },
    { photo, backdrop },
    option.photoIndex !== null
  );
  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const option = parseCardOption(options.card, files.length);
  const { exportFormat, locale } = option;

  // Self-hosted Devanagari font for the worker canvas (best-effort —
  // see ensureWorkerFonts; failures fall back to system stacks).
  await ensureWorkerFonts();

  /* ---------------- optional photo ---------------- */
  let photo: CardSource | null = null;
  if (option.photoIndex !== null) {
    post({ type: "progress", runId, pct: 4, stage: "reading" });
    photo = await decodePhoto(files[option.photoIndex]);
  }

  /* ---------------- CSV mail merge ---------------- */
  let columns: string[] = [];
  let rows: string[][] | null = null;
  if (option.csvText.trim() !== "") {
    try {
      const parsed = parseCsv(option.csvText);
      if (parsed.rows.length > 0) {
        columns = parsed.columns;
        rows = parsed.rows;
      }
    } catch (error) {
      if (error instanceof CsvError) {
        post({ type: "error", runId, code: error.code });
        return;
      }
      throw error;
    }
    if (rows !== null) {
      // Unknown {{column}} names → one honest error listing them all.
      const unknown = validatePlaceholders(option.texts, columns);
      if (unknown.length > 0) {
        fail("card.errorCsvColumn", unknown.join(", "));
      }
    }
  }
  const mergeRows = rows !== null ? rows.length : 1;

  /* ---------------- template backdrop (gradient fallback) ---------------- */
  post({ type: "progress", runId, pct: 8, stage: "reading" });
  const backdrop = await loadTemplateBackdrop(templateById(option.template).bg);

  const sheets = computeSheets(option.format, mergeRows);
  const pt = pagePtSize(option.format, option.orientation);
  const px = pagePixelSize(option.format, option.orientation);
  const baseName = outputBaseName(locale, exportFormat, mergeRows);

  /* ---------------- JPG / PNG: first sheet only (honest) ---------------- */
  if (exportFormat !== "pdf") {
    post({ type: "progress", runId, pct: 55, stage: "processing" });
    const texts = mergedTextsFor(option.texts, rows?.[0] ?? null, columns);
    const canvas = new OffscreenCanvas(px.w, px.h);
    const ctx = canvas.getContext("2d") as CardCtx | null;
    if (!ctx) fail("tool.errorGeneric", "canvas");
    drawCardSheet(
      ctx,
      sheets[0],
      {
        template: option.template,
        format: option.format,
        orientation: option.orientation,
        texts,
        background: option.background,
      },
      { photo, backdrop },
      option.photoIndex !== null
    );
    const blob = await canvas.convertToBlob({
      type: exportFormat === "png" ? "image/png" : "image/jpeg",
      quality: 0.92,
    });
    post({ type: "progress", runId, pct: 96, stage: "saving" });
    post({
      type: "result",
      runId,
      outputs: [{ name: baseName, mime: blob.type, blob }],
      detail: { files: photo !== null ? 1 : 0, pages: 1 },
    });
    return;
  }

  /* ---------------- PDF: one page per sheet ---------------- */
  const pdf = CreateContext.create();
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    const texts = mergedTextsFor(option.texts, rows?.[sheet.rowIndex] ?? null, columns);
    const jpeg = await renderSheetBlob(
      sheet,
      texts,
      option,
      photo,
      backdrop,
      px.w,
      px.h
    );
    const embedded = pdf.embedJpeg(new Uint8Array(await jpeg.arrayBuffer()));
    const page = pdf.addPage(pt.w, pt.h);
    // Explicit width/height — pdf-lib ignores w/h spreads (P4.4 lesson).
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pt.w,
      height: pt.h,
    });
    post({
      type: "progress",
      runId,
      pct: 10 + Math.round(((i + 1) / sheets.length) * 82),
      stage: "processing",
      detail: { page: i + 1, pages: sheets.length },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  // R44 branding — metadata only; the document stays clean.
  pdf.setProducer("DocoPDF");
  pdf.setCreator("DocoPDF");
  pdf.setTitle(baseName.replace(/\.[^.]+$/, ""));
  pdf.setCreationDate(new Date());
  const saved = pdf.write();
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: baseName,
        mime: "application/pdf",
        blob: new Blob([saved as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: photo !== null ? 1 : 0,
      pages: sheets.length,
    },
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
      // Card tool error codes live under "card.*" (CSV limits) next to
      // the shared "tool.*" family.
      code:
        code?.startsWith("tool.") || code?.startsWith("card.")
          ? code
          : "tool.errorGeneric",
      detail: detail || undefined,
    });
  });
};
