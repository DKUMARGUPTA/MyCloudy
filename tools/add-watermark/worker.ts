import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  PDFArray,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { PdfError, StampContext, type StampFontKey, type StampImage } from "@/lib/own/pdf";
import { needsUnicodeFont } from "../stamp-common/layout";
import { loadStampFonts } from "../stamp-common/worker-lib";
import {
  positionCenter,
  rotatedStartPoint,
  targetIndices,
  tileSteps,
  parseHexColor,
  resolveWmOptions,
  type WmFontId,
} from "./wm-options";

/**
 * Add watermark worker (PRD §8.2): stamps text or a logo image onto the
 * chosen pages of a single PDF — on-device, zero network.
 *
 * P6-f: runs on OUR OWN PDF engine (src/lib/own/pdf StampContext). Text
 * stamps use the base-14 standard fonts with pdf-lib-identical metrics
 * (widths + kerning, byte-verified in smoke-pdf-core §16); logos embed via
 * our own JPEG DCT passthrough / PNG→RGB+SMask decoder; "behind content"
 * prepends our stream to /Contents natively.
 *
 * The one remaining pdf-lib branch is the documented DEVANAGARI seam
 * (non-WinAnsi watermark text needs the embedded Noto subset with GSUB
 * shaping — P6-g); that path keeps byte-identical legacy behavior.
 */

const FONT_MAP: Record<WmFontId, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  helveticaBold: StandardFonts.HelveticaBold,
  times: StandardFonts.TimesRoman,
  timesBold: StandardFonts.TimesRomanBold,
  courier: StandardFonts.Courier,
  courierBold: StandardFonts.CourierBold,
};

/** StampFontKey names for the same 6 fonts, in the WmFontId spelling. */
const OWN_FONT: Record<WmFontId, StampFontKey> = {
  helvetica: "helvetica",
  helveticaBold: "helveticaBold",
  times: "times",
  timesBold: "timesBold",
  courier: "courier",
  courierBold: "courierBold",
};

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

/** Strips path separators + unsafe chars from a download display name. */
function safeBaseName(name: string): string {
  const base = name.replace(/\.(pdf)$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
}

/** "#rrggbb" → 0..1 RGB (parseHexColor already scales; legacy default otherwise). */
function hexColor(hex: string): { r: number; g: number; b: number } {
  const parsed = parseHexColor(hex);
  return parsed ?? { r: 0.86, g: 0.15, b: 0.15 };
}

/* ══════════════════ Own-engine logo embedding ══════════════════ */

/** Embeds a logo with OUR engine: PNG/JPEG direct, others re-encoded to PNG. */
async function embedLogoOwn(
  ctx: StampContext,
  file: File
): Promise<StampImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isPng) return ctx.embedPng(bytes);
  if (isJpg) return ctx.embedJpeg(bytes);

  // Other formats (webp/gif/…) — decode + re-encode as PNG on this worker
  // thread (same recipe the legacy path uses).
  const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new PdfError("logo", "logo-canvas");
  c2d.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return ctx.embedPng(new Uint8Array(await png.arrayBuffer()));
}

/* ══════════════════ The legacy pdf-lib run (Deva seam) ══════════════════ */

/** Moves this page's pdf-lib draw stream (appended last) to the front — behind content. */
function moveDrawStreamFirst(page: PDFPage): void {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const size = contents.size();
  if (size < 2) return;
  const mine = contents.get(size - 1);
  contents.remove(size - 1);
  contents.insert(0, mine);
}

async function embedLogo(
  doc: PDFDocument,
  file: File
): Promise<PDFImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isPng) return doc.embedPng(bytes);
  if (isJpg) return doc.embedJpg(bytes);

  // Other formats (webp/gif/…) — decode + re-encode as PNG on this worker
  // thread (same recipe the imagegrid worker uses).
  const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("logo-canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return doc.embedPng(new Uint8Array(await png.arrayBuffer()));
}

async function runLegacy(
  runId: number,
  file: File,
  bytes: Uint8Array,
  wm: ReturnType<typeof resolveWmOptions>,
  assets: File[] | undefined
): Promise<void> {
  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = doc.getPageCount();
  const targets = targetIndices(wm, pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "tool.errorWatermarkNoPages" });
    return;
  }

  // Stamp data: text (with the WinAnsi check upfront) or logo image.
  let font: PDFFont | null = null;
  let textW = 0;
  let logo: PDFImage | null = null;
  const textColor = (() => {
    const parsed = parseHexColor(wm.color);
    return parsed ? rgb(parsed.r, parsed.g, parsed.b) : rgb(0.86, 0.15, 0.15);
  })();

  if (wm.type === "text") {
    const text = wm.text.trim();
    if (text.length === 0) {
      post({ type: "error", runId, code: "tool.errorWatermarkMissing" });
      return;
    }
    // (This branch is only reached when needsUnicodeFont(text) is true.)
    const stampFonts = await loadStampFonts(doc, true);
    font = stampFonts.fontFor("devanagari");
    try {
      font.encodeText(text); // throws for glyphs the embedded font lacks
    } catch {
      post({ type: "error", runId, code: "tool.errorWatermarkChars" });
      return;
    }
    textW = font.widthOfTextAtSize(text, wm.size);
  } else {
    const logoFile = assets && assets.length > 0 ? assets[0] : undefined;
    if (!logoFile) {
      post({ type: "error", runId, code: "tool.errorWatermarkLogoMissing" });
      return;
    }
    try {
      logo = await embedLogo(doc, logoFile);
    } catch {
      post({ type: "error", runId, code: "tool.errorWatermarkLogo" });
      return;
    }
  }

  const total = targets.length;
  let done = 0;
  for (const pageIndex of targets) {
    const page = doc.getPage(pageIndex);
    const pageW = page.getWidth();
    const pageH = page.getHeight();

    if (wm.type === "text" && font) {
      const text = wm.text.trim();
      const boxH = wm.size;
      const baseline = boxH * 0.25;
      if (wm.tile) {
        const { stepX, stepY } = tileSteps(textW, wm.size, wm.tileGap);
        for (let y = -stepY; y < pageH + stepY; y += stepY) {
          for (let x = -stepX; x < pageW + stepX; x += stepX) {
            const { sx, sy } = rotatedStartPoint(
              x + textW / 2,
              y + boxH / 2,
              textW,
              boxH,
              wm.rotation
            );
            page.drawText(text, {
              x: sx,
              y: sy + baseline,
              size: wm.size,
              font,
              color: textColor,
              opacity: wm.opacity,
              rotate: degrees(wm.rotation),
            });
          }
        }
      } else {
        const { cx, cy } = positionCenter(
          wm.position,
          pageW,
          pageH,
          textW,
          boxH,
          wm.margin
        );
        const { sx, sy } = rotatedStartPoint(cx, cy, textW, boxH, wm.rotation);
        page.drawText(text, {
          x: sx,
          y: sy + baseline,
          size: wm.size,
          font,
          color: textColor,
          opacity: wm.opacity,
          rotate: degrees(wm.rotation),
        });
      }
    } else if (logo) {
      const boxW = (pageW * wm.logoScale) / 100;
      const boxH = boxW * (logo.height / logo.width);
      if (wm.tile) {
        const { stepX, stepY } = tileSteps(boxW, boxH, wm.tileGap);
        for (let y = -stepY; y < pageH + stepY; y += stepY) {
          for (let x = -stepX; x < pageW + stepX; x += stepX) {
            page.drawImage(logo, {
              x,
              y,
              width: boxW,
              height: boxH,
              opacity: wm.opacity,
              rotate: degrees(wm.rotation),
            });
          }
        }
      } else {
        const { cx, cy } = positionCenter(
          wm.position,
          pageW,
          pageH,
          boxW,
          boxH,
          wm.margin
        );
        const { sx, sy } = rotatedStartPoint(cx, cy, boxW, boxH, wm.rotation);
        page.drawImage(logo, {
          x: sx,
          y: sy,
          width: boxW,
          height: boxH,
          opacity: wm.opacity,
          rotate: degrees(wm.rotation),
        });
      }
    }

    if (wm.behind) moveDrawStreamFirst(page);

    done += 1;
    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (done / total) * 87),
      stage: "processing",
      detail: { page: done, pages: total },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = await doc.save({ useObjectStreams: true });
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-watermarked.pdf`,
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
    detail: { files: 1, pages: total },
  });
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, assets } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const wm = resolveWmOptions(options);

  post({ type: "progress", runId, pct: 4, stage: "reading" });
  const bytes = new Uint8Array(await file.arrayBuffer());

  // The Devanagari seam: non-WinAnsi watermark text keeps the pdf-lib path.
  if (wm.type === "text" && needsUnicodeFont(wm.text.trim())) {
    await runLegacy(runId, file, bytes, wm, assets);
    return;
  }

  await runOwnEngine(runId, file, bytes, wm, assets);
}

/** The P6-f own-engine watermark run. */
async function runOwnEngine(
  runId: number,
  file: File,
  bytes: Uint8Array,
  wm: ReturnType<typeof resolveWmOptions>,
  assets: File[] | undefined
): Promise<void> {
  const ctx = StampContext.load(bytes);
  const targets = targetIndices(wm, ctx.pageCount);
  if (targets === null || targets.length === 0) {
    post({ type: "error", runId, code: "tool.errorWatermarkNoPages" });
    return;
  }

  const color = hexColor(wm.color);
  let textW = 0;
  let font: StampFontKey | null = null;
  let logo: StampImage | null = null;

  if (wm.type === "text") {
    const text = wm.text.trim();
    if (text.length === 0) {
      post({ type: "error", runId, code: "tool.errorWatermarkMissing" });
      return;
    }
    font = OWN_FONT[wm.font];
    try {
      // Throws typed "chars" when the font cannot encode — the parity of
      // pdf-lib's font.encodeText try/catch.
      textW = ctx.measure(text, font, wm.size);
    } catch (error) {
      if (error instanceof PdfError && error.code === "chars") {
        post({ type: "error", runId, code: "tool.errorWatermarkChars" });
        return;
      }
      throw error;
    }
  } else {
    const logoFile = assets && assets.length > 0 ? assets[0] : undefined;
    if (!logoFile) {
      post({ type: "error", runId, code: "tool.errorWatermarkLogoMissing" });
      return;
    }
    try {
      logo = await embedLogoOwn(ctx, logoFile);
    } catch {
      post({ type: "error", runId, code: "tool.errorWatermarkLogo" });
      return;
    }
  }

  const total = targets.length;
  let done = 0;
  for (const pageIndex of targets) {
    const page = ctx.pages[pageIndex]!;
    const pageW = page.mediaBox[2] - page.mediaBox[0];
    const pageH = page.mediaBox[3] - page.mediaBox[1];

    if (wm.type === "text" && font) {
      const text = wm.text.trim();
      const boxH = wm.size;
      // Baseline sits ~0.25em above the box bottom (descent allowance),
      // so the em-box middle matches the canvas preview's "middle".
      const baseline = boxH * 0.25;
      if (wm.tile) {
        const { stepX, stepY } = tileSteps(textW, wm.size, wm.tileGap);
        for (let y = -stepY; y < pageH + stepY; y += stepY) {
          for (let x = -stepX; x < pageW + stepX; x += stepX) {
            const { sx, sy } = rotatedStartPoint(
              x + textW / 2,
              y + boxH / 2,
              textW,
              boxH,
              wm.rotation
            );
            ctx.stampText(pageIndex, {
              x: sx,
              y: sy + baseline,
              text,
              size: wm.size,
              font,
              color,
              opacity: wm.opacity,
              rotate: wm.rotation,
              behind: wm.behind,
            });
          }
        }
      } else {
        const { cx, cy } = positionCenter(
          wm.position,
          pageW,
          pageH,
          textW,
          boxH,
          wm.margin
        );
        const { sx, sy } = rotatedStartPoint(cx, cy, textW, boxH, wm.rotation);
        ctx.stampText(pageIndex, {
          x: sx,
          y: sy + baseline,
          text,
          size: wm.size,
          font,
          color,
          opacity: wm.opacity,
          rotate: wm.rotation,
          behind: wm.behind,
        });
      }
    } else if (logo) {
      const boxW = (pageW * wm.logoScale) / 100;
      const boxH = boxW * (logo.height / logo.width);
      if (wm.tile) {
        const { stepX, stepY } = tileSteps(boxW, boxH, wm.tileGap);
        for (let y = -stepY; y < pageH + stepY; y += stepY) {
          for (let x = -stepX; x < pageW + stepX; x += stepX) {
            ctx.stampImage(pageIndex, logo, {
              x,
              y,
              width: boxW,
              height: boxH,
              opacity: wm.opacity,
              rotate: wm.rotation,
              behind: wm.behind,
            });
          }
        }
      } else {
        const { cx, cy } = positionCenter(
          wm.position,
          pageW,
          pageH,
          boxW,
          boxH,
          wm.margin
        );
        const { sx, sy } = rotatedStartPoint(cx, cy, boxW, boxH, wm.rotation);
        ctx.stampImage(pageIndex, logo, {
          x: sx,
          y: sy,
          width: boxW,
          height: boxH,
          opacity: wm.opacity,
          rotate: wm.rotation,
          behind: wm.behind,
        });
      }
    }

    done += 1;
    post({
      type: "progress",
      runId,
      pct: Math.round(8 + (done / total) * 87),
      stage: "processing",
      detail: { page: done, pages: total },
    });
  }

  post({ type: "progress", runId, pct: 96, stage: "saving" });
  const saved = ctx.write();
  const outputs = [
    {
      name: `${safeBaseName(file.name)}-watermarked.pdf`,
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
    detail: { files: 1, pages: total },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    // Own-engine typed errors first (PdfError carries a code); then the
    // legacy message-regex net for the pdf-lib Deva seam.
    if (error instanceof PdfError) {
      const code =
        error.code === "encrypted"
          ? "tool.errorEncrypted"
          : error.code === "logo"
            ? "tool.errorWatermarkLogo"
            : error.code === "chars"
              ? "tool.errorWatermarkChars"
              : "tool.errorCorrupt";
      post({ type: "error", runId: data.runId, code, detail: undefined });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /encrypt/i.test(message)
      ? "tool.errorEncrypted"
      : /logo/i.test(message)
        ? "tool.errorWatermarkLogo"
        : "tool.errorCorrupt";
    post({ type: "error", runId: data.runId, code, detail: undefined });
  });
};
