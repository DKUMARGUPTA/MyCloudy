/**
 * Passport photo drawing engine — ONE implementation shared by the surface
 * (live editor canvas, single-photo preview, sheet preview) so every
 * consumer paints the same framing the worker exports. The worker's own
 * raster route (photo canvas) uses drawPhotoCrop too; the print sheet PDF
 * is drawn by pdf-lib in the worker from the SAME SheetPlan math.
 *
 * Everything is expressed in caller pixels: the surface scales the sheet
 * plan (pt) into its preview canvas, so a 300 px preview and a 4×6 print
 * line up exactly. Works with both HTMLCanvasElement 2D and
 * OffscreenCanvas 2D contexts.
 */

import {
  HEAD_GUIDE,
  sheetCellRect,
  type CropRect,
  type SheetPlan,
} from "./model";

/** Anything drawImage accepts as a raster source. */
export type PassportSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/** 2D context of either canvas flavour (drawImage-compatible with both). */
export type PassportCtx =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

export const TEXT_FONT_STACK =
  "'Noto Sans Devanagari', 'Noto Sans', system-ui, sans-serif";

export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Draws the cropped photo into a destination rect: flattened over pure
 * white (passport photos print on white) then the 9-arg drawImage crop.
 */
export function drawPhotoCrop(
  ctx: PassportCtx,
  source: PassportSource,
  crop: CropRect,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  if (dw <= 0 || dh <= 0 || crop.sw <= 0 || crop.sh <= 0) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(dx, dy, dw, dh);
  ctx.drawImage(
    source,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    dx,
    dy,
    dw,
    dh
  );
}

/** Dims everything outside `rect` — the editor's "this is cropped away" veil. */
export function dimOutside(
  ctx: PassportCtx,
  rect: RectPx,
  W: number,
  H: number
): void {
  const veil = "rgba(28, 25, 23, 0.52)";
  ctx.fillStyle = veil;
  if (rect.y > 0) ctx.fillRect(0, 0, W, rect.y);
  if (rect.y + rect.h < H) {
    ctx.fillRect(0, rect.y + rect.h, W, H - rect.y - rect.h);
  }
  if (rect.x > 0) ctx.fillRect(0, rect.y, rect.x, rect.h);
  if (rect.x + rect.w < W) {
    ctx.fillRect(rect.x + rect.w, rect.y, W - rect.x - rect.w, rect.h);
  }
}

/** Dashed accent frame around the crop — the exact photo outline. */
export function drawCropFrame(ctx: PassportCtx, rect: RectPx): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  ctx.save();
  if (typeof ctx.setLineDash === "function") ctx.setLineDash([7, 5]);
  ctx.strokeStyle = "#e11d48";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(rect.x + 0.5, rect.y + 0.5);
  ctx.lineTo(rect.x + rect.w - 0.5, rect.y + 0.5);
  ctx.lineTo(rect.x + rect.w - 0.5, rect.y + rect.h - 0.5);
  ctx.lineTo(rect.x + 0.5, rect.y + rect.h - 0.5);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * The honest head guide: a tinted band inside the frame where the head
 * should roughly sit (≈70% of the frame height, HEAD_GUIDE fractions) —
 * a hint, never an official spec claim. Draws the band, its dashed
 * edges, and a small "≈70%" label chip at the band's right edge.
 */
export function drawHeadGuide(ctx: PassportCtx, rect: RectPx): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  const top = rect.y + rect.h * HEAD_GUIDE.top;
  const bottom = rect.y + rect.h * HEAD_GUIDE.bottom;

  ctx.save();
  // Tinted band.
  ctx.fillStyle = "rgba(225, 29, 72, 0.07)";
  ctx.fillRect(rect.x, top, rect.w, bottom - top);
  // Dashed edges.
  if (typeof ctx.setLineDash === "function") ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "rgba(225, 29, 72, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(rect.x + 1, top);
  ctx.lineTo(rect.x + rect.w - 1, top);
  ctx.moveTo(rect.x + 1, bottom);
  ctx.lineTo(rect.x + rect.w - 1, bottom);
  ctx.stroke();
  ctx.restore();

  // Label chip ("≈70%") at the band's top-right, inside the frame.
  const label = "~70%";
  const fontPx = Math.max(10, Math.min(15, Math.round(rect.w * 0.055)));
  ctx.save();
  ctx.font = `600 ${fontPx}px ${TEXT_FONT_STACK}`;
  const textW = ctx.measureText(label).width;
  const chipW = textW + fontPx;
  const chipH = fontPx + 4;
  const chipX = Math.max(rect.x + 2, rect.x + rect.w - chipW - 2);
  const chipY = top + 3;
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.fillRect(chipX, chipY, chipW, chipH);
  ctx.strokeStyle = "rgba(225, 29, 72, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chipX + 0.5, chipY + 0.5);
  ctx.lineTo(chipX + chipW - 0.5, chipY + 0.5);
  ctx.lineTo(chipX + chipW - 0.5, chipY + chipH - 0.5);
  ctx.lineTo(chipX + 0.5, chipY + chipH - 0.5);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = "#9f1239";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, chipX + chipW / 2, chipY + chipH / 2 + 0.5);
  ctx.restore();
}

export interface SheetPreviewOptions {
  /** Dashed gray cut rectangles around every photo (default true). */
  cutGuides?: boolean;
  /** The info line text — empty string skips it. */
  infoText?: string;
}

/**
 * Paints the print sheet preview: white page, the photo drawn once per
 * grid cell, dashed cut guides and the optional info line in the bottom
 * margin — the exact layout the worker's PDF will carry, scaled to the
 * caller's canvas (which must already be sized pageW:pageH).
 */
export function drawSheetPreview(
  ctx: PassportCtx,
  plan: SheetPlan,
  photo: PassportSource,
  opts?: SheetPreviewOptions
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  if (W <= 0 || H <= 0) return;
  const scale = W / plan.pageW;

  // Page.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Photos.
  for (let row = 0; row < plan.rows; row += 1) {
    for (let col = 0; col < plan.cols; col += 1) {
      const cell = sheetCellRect(plan, row, col);
      ctx.drawImage(photo, cell.x * scale, cell.y * scale, cell.w * scale, cell.h * scale);
    }
  }

  // Cut guides.
  if (opts?.cutGuides !== false && plan.copies > 0) {
    ctx.save();
    if (typeof ctx.setLineDash === "function") ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(120, 113, 108, 0.85)";
    ctx.lineWidth = Math.max(1, 0.6 * scale);
    for (let row = 0; row < plan.rows; row += 1) {
      for (let col = 0; col < plan.cols; col += 1) {
        const cell = sheetCellRect(plan, row, col);
        const x = cell.x * scale;
        const y = cell.y * scale;
        const w = cell.w * scale;
        const h = cell.h * scale;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y + 0.5);
        ctx.lineTo(x + w - 0.5, y + 0.5);
        ctx.lineTo(x + w - 0.5, y + h - 0.5);
        ctx.lineTo(x + 0.5, y + h - 0.5);
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Info line, in the reserved bottom strip.
  const infoText = opts?.infoText ?? "";
  if (plan.infoLine && infoText !== "") {
    const fontPx = Math.max(9, 7 * scale);
    ctx.save();
    ctx.font = `500 ${fontPx}px ${TEXT_FONT_STACK}`;
    ctx.fillStyle = "#78716c";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const stripY = (plan.pageH - plan.padBottom / 2) * scale;
    ctx.fillText(infoText, W / 2, stripY);
    ctx.restore();
  }
}
