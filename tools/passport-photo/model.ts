/**
 * Passport photo shared model (PRD "Passport photo maker" — the 94th tool) —
 * PURE data + math used by the surface (live editor + previews), the worker
 * (photo JPEG + print sheet PDF) and the smoke script, so what you frame is
 * exactly what exports.
 *
 * Three layers live here:
 *   1. Geometry — the photo size table (mm), sheet presets (pt), the mm→px
 *      (at 300 DPI) and mm→pt conversions, and the sheet grid packing math
 *      (columns / rows / centred offsets / expected copies).
 *   2. Pixels — the smart-white background wash (edge-seeded flood fill
 *      from the four corners) and the brightness/contrast pass, both pure
 *      functions over raw RGBA arrays so the smoke can prove the real math
 *      on synthetic fixtures.
 *   3. Wire — the PassportStyle sanitizer + the serialized "passport"
 *      option the Run CTA ships, plus localized output names and the
 *      honest ASCII info line drawn in the sheet's bottom margin.
 */

import type { L10n } from "@/lib/tools/registry";

/* ---------------------------- photo sizes ---------------------------- */

export type PhotoSizeId =
  | "india-passport"
  | "india-visa-pan"
  | "us-visa"
  | "china-visa"
  | "custom";

/** One entry of the photo size table — portrait millimetres. */
export interface PhotoSizeDef {
  id: PhotoSizeId;
  label: L10n;
  /** Width in millimetres. */
  wMM: number;
  /** Height in millimetres. */
  hMM: number;
}

/**
 * The size table. Values are the commonly published specs (India passport
 * 35×45mm; the small 25×35mm stamp/visa size also used for PAN-type forms;
 * US visa 51×51mm = 2×2in; China visa 33×48mm). "Custom" takes the mm
 * inputs (clamped 15–100mm per side).
 */
export const PHOTO_SIZES: PhotoSizeDef[] = [
  {
    id: "india-passport",
    label: { en: "India passport — 35×45mm", hi: "भारत पासपोर्ट — 35×45मिमी" },
    wMM: 35,
    hMM: 45,
  },
  {
    id: "india-visa-pan",
    label: { en: "India visa / PAN-size — 25×35mm", hi: "भारत वीज़ा / पैन-साइज़ — 25×35मिमी" },
    wMM: 25,
    hMM: 35,
  },
  {
    id: "us-visa",
    label: { en: "US visa — 51×51mm (2×2in)", hi: "अमेरिकी वीज़ा — 51×51मिमी (2×2इंच)" },
    wMM: 51,
    hMM: 51,
  },
  {
    id: "china-visa",
    label: { en: "China visa — 33×48mm", hi: "चीन वीज़ा — 33×48मिमी" },
    wMM: 33,
    hMM: 48,
  },
  {
    id: "custom",
    label: { en: "Custom", hi: "अपना साइज़" },
    wMM: 35,
    hMM: 45,
  },
];

const SIZE_BY_ID = new Map<string, PhotoSizeDef>(
  PHOTO_SIZES.map((size) => [size.id, size])
);

export function sizeById(id: string): PhotoSizeDef | undefined {
  return SIZE_BY_ID.get(id);
}

export function isPhotoSizeId(id: string): boolean {
  return SIZE_BY_ID.has(id);
}

/** Custom millimetre inputs clamp to this range. */
export const CUSTOM_MM_MIN = 15;
export const CUSTOM_MM_MAX = 100;

/** Clamps one custom millimetre value; junk falls back to `fallback`. */
export function clampCustomMM(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(CUSTOM_MM_MAX, Math.max(CUSTOM_MM_MIN, value));
}

/** The resolved physical size (mm) — custom ids take the clamped inputs. */
export interface ResolvedSize {
  sizeId: PhotoSizeId;
  wMM: number;
  hMM: number;
}

export function resolveSize(
  sizeId: unknown,
  customW: unknown,
  customH: unknown
): ResolvedSize {
  const def = typeof sizeId === "string" ? SIZE_BY_ID.get(sizeId) : undefined;
  if (def === undefined || def.id === "india-passport") {
    // Unknown ids honestly fall back to the India passport size.
    return { sizeId: "india-passport", wMM: 35, hMM: 45 };
  }
  if (def.id !== "custom") {
    return { sizeId: def.id, wMM: def.wMM, hMM: def.hMM };
  }
  return {
    sizeId: "custom",
    wMM: clampCustomMM(customW, 35),
    hMM: clampCustomMM(customH, 45),
  };
}

/* ------------------------------- units ------------------------------- */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
/** The photo JPEG is exported at 300 DPI (print quality). */
export const PHOTO_DPI = 300;
/** Single re-compression policy — the house photo standard. */
export const JPEG_QUALITY = 0.92;

/** Millimetres → pixels at a DPI, rounded (the exact export size). */
export function mmToPx(mm: number, dpi = PHOTO_DPI): number {
  if (!Number.isFinite(mm) || mm <= 0 || dpi <= 0) return 0;
  return Math.round((mm / MM_PER_INCH) * dpi);
}

/** Millimetres → PDF points (1pt = 1/72in), exact float. */
export function mmToPt(mm: number): number {
  if (!Number.isFinite(mm) || mm <= 0) return 0;
  return (mm / MM_PER_INCH) * PT_PER_INCH;
}

export interface PhotoPixels {
  w: number;
  h: number;
}

/** Exact export pixel size of the single photo. */
export function photoPixelSize(size: ResolvedSize): PhotoPixels {
  return { w: mmToPx(size.wMM), h: mmToPx(size.hMM) };
}

/** The photo's true aspect (mm ratio — the crop guide's shape). */
export function sizeAspect(size: ResolvedSize): number {
  return size.wMM / size.hMM;
}

/* ------------------------------- sheets ------------------------------ */

export type SheetId = "photo4x6" | "a4";

export interface SheetDef {
  id: SheetId;
  label: L10n;
  wPt: number;
  hPt: number;
}

/** Sheet presets — classic 4×6 photo paper (10×15cm) and A4. */
export const SHEETS: SheetDef[] = [
  {
    id: "photo4x6",
    label: { en: "4×6 photo paper (10×15cm)", hi: "4×6 फ़ोटो पेपर (10×15सेमी)" },
    wPt: 288,
    hPt: 432,
  },
  {
    id: "a4",
    label: { en: "A4 sheet", hi: "A4 शीट" },
    wPt: 595.28,
    hPt: 841.89,
  },
];

const SHEET_BY_ID = new Map<string, SheetDef>(SHEETS.map((s) => [s.id, s]));

export function sheetById(id: string): SheetDef {
  return SHEET_BY_ID.get(id) ?? (SHEET_BY_ID.get("photo4x6") as SheetDef);
}

/** Safe margin around the grid, in PDF points. */
export const SHEET_PAD_PT = 9;
/** Gutter between neighbouring photos, in PDF points. */
export const CELL_GAP_PT = 4;
/** Extra bottom strip reserved for the info line, in PDF points. */
export const INFO_STRIP_PT = 20;

/** The packed grid of photos on one sheet — pure math. */
export interface SheetPlan {
  sheetId: SheetId;
  pageW: number;
  pageH: number;
  /** Photo cell size in points. */
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  /** cols × rows. */
  copies: number;
  gap: number;
  padX: number;
  padTop: number;
  padBottom: number;
  /** Top-left of the grid block, measured from the page's top-left. */
  offsetX: number;
  offsetY: number;
  /** Whether a bottom info strip is reserved. */
  infoLine: boolean;
}

/**
 * Packs the photo (in pt) onto the sheet, centred, with a safe margin and
 * a gutter between copies. The count formula is the honest one:
 *   cols = floor((pageW − 2·padX + gap) / (cellW + gap))
 *   rows = floor((pageH − padTop − padBottom + gap) / (cellH + gap))
 * A photo that does not fit yields cols/rows 0 (copies 0) — the worker
 * raises the honest "too large for this sheet" error instead of shrinking
 * the photo (never print a 34mm photo labelled 35mm).
 */
export function computeSheetPlan(
  size: ResolvedSize,
  sheetId: string,
  opts?: { infoLine?: boolean }
): SheetPlan {
  const sheet = sheetById(sheetId);
  const infoLine = opts?.infoLine === true;
  const cellW = mmToPt(size.wMM);
  const cellH = mmToPt(size.hMM);
  const padX = SHEET_PAD_PT;
  const padTop = SHEET_PAD_PT;
  const padBottom = infoLine ? SHEET_PAD_PT + INFO_STRIP_PT : SHEET_PAD_PT;
  const gap = CELL_GAP_PT;
  const usableW = sheet.wPt - padX * 2 + gap;
  const usableH = sheet.hPt - padTop - padBottom + gap;
  const cols = cellW + gap > 0 ? Math.floor(usableW / (cellW + gap)) : 0;
  const rows = cellH + gap > 0 ? Math.floor(usableH / (cellH + gap)) : 0;
  const copies = cols * rows;
  const blockW = cols > 0 ? cols * cellW + (cols - 1) * gap : 0;
  const blockH = rows > 0 ? rows * cellH + (rows - 1) * gap : 0;
  const contentH = sheet.hPt - padTop - padBottom;
  return {
    sheetId: sheet.id,
    pageW: sheet.wPt,
    pageH: sheet.hPt,
    cellW,
    cellH,
    cols,
    rows,
    copies,
    gap,
    padX,
    padTop,
    padBottom,
    offsetX: (sheet.wPt - blockW) / 2,
    offsetY: padTop + Math.max(0, (contentH - blockH) / 2),
    infoLine,
  };
}

/**
 * Cell rectangle on the sheet, top-left origin (canvas convention) —
 * the PDF caller flips the y axis (PDF origin is bottom-left).
 */
export function sheetCellRect(
  plan: SheetPlan,
  row: number,
  col: number
): { x: number; y: number; w: number; h: number } {
  return {
    x: plan.offsetX + col * (plan.cellW + plan.gap),
    y: plan.offsetY + row * (plan.cellH + plan.gap),
    w: plan.cellW,
    h: plan.cellH,
  };
}

/* ----------------------------- crop math ----------------------------- */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

/** Source rect to draw for a zoom/pan setting, target aspect included. */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function clampZoom(zoom: unknown): number {
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function clampPan(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

/**
 * The crop rect: the largest centred rect of `aspect` inside the source,
 * shrunk by `zoom` (1 = widest) and slid by pan −1..1 (the fraction of the
 * remaining slack per axis; 0 = centred, ±1 = flush to that edge).
 */
export function computeCropRect(
  sw: number,
  sh: number,
  aspect: number,
  zoom: number,
  panX: number,
  panY: number
): CropRect {
  if (!(sw > 0) || !(sh > 0) || !(aspect > 0)) {
    return { sx: 0, sy: 0, sw: 0, sh: 0 };
  }
  const z = clampZoom(zoom);
  let baseW: number;
  let baseH: number;
  if (sw / sh > aspect) {
    baseH = sh;
    baseW = sh * aspect;
  } else {
    baseW = sw;
    baseH = sw / aspect;
  }
  const w = baseW / z;
  const h = baseH / z;
  const sx = ((sw - w) / 2) * (1 + clampPan(panX));
  const sy = ((sh - h) / 2) * (1 + clampPan(panY));
  return { sx, sy, sw: w, sh: h };
}

/**
 * Honest head guide: the band (fractions of the frame height) where the
 * head should roughly sit — a visual hint, NOT an official spec claim.
 * Band height 0.78 − 0.08 = 70% of the frame.
 */
export const HEAD_GUIDE = { top: 0.08, bottom: 0.78 };

/* ------------------------- smart white pixels ------------------------ */

export const WHITE_TOLERANCE_MAX = 100;
/** Max slider steps for brightness / contrast. */
export const ADJUST_MAX = 60;

function clampRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Tolerance 0–100 → the squared RGB distance a pixel may sit from the
 * corner seed and still wash. 100 = √3·255 (any colour).
 */
export function toleranceDistanceSq(tolerance: number): number {
  const t = clampRange(tolerance, 0, WHITE_TOLERANCE_MAX, 0);
  const dist = (t / 100) * Math.sqrt(3) * 255;
  return dist * dist;
}

/** Mean colour of up to 3×3 patches at the four corners. */
function cornerSeed(
  data: Uint8ClampedArray,
  w: number,
  h: number
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const patch = (cx: number, cy: number): void => {
    for (let y = Math.max(0, cy - 1); y <= Math.min(h - 1, cy + 1); y += 1) {
      for (let x = Math.max(0, cx - 1); x <= Math.min(w - 1, cx + 1); x += 1) {
        const o = (y * w + x) * 4;
        r += data[o];
        g += data[o + 1];
        b += data[o + 2];
        n += 1;
      }
    }
  };
  patch(0, 0);
  patch(w - 1, 0);
  patch(0, h - 1);
  patch(w - 1, h - 1);
  if (n === 0) return [255, 255, 255];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Smart white background — an edge-seeded flood fill: the four corner
 * patches decide the background colour; every border pixel within the
 * tolerance of that seed starts the fill, which then walks 4-connected
 * neighbours (matched against the SAME seed — gradients cannot run away
 * into the face) and washes them to pure white. Returns the washed pixel
 * count (0 = nothing matched; the surface shows its honest hint).
 *
 * Honest limits: this works on plain, evenly-lit backgrounds. Busy
 * backgrounds keep the original — no AI matting, no promises.
 */
export function applyWhiteBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number
): number {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return 0;
  const [sr, sg, sb] = cornerSeed(data, width, height);
  const maxDistSq = toleranceDistanceSq(tolerance);
  const washed = new Uint8Array(width * height);
  const queue: number[] = [];

  const matches = (idx: number): boolean => {
    const o = idx * 4;
    const dr = data[o] - sr;
    const dg = data[o + 1] - sg;
    const db = data[o + 2] - sb;
    return dr * dr + dg * dg + db * db <= maxDistSq;
  };

  // Seed from every border pixel that already matches the seed colour.
  for (let x = 0; x < width; x += 1) {
    const top = x;
    const bottom = (height - 1) * width + x;
    if (!washed[top] && matches(top)) queue.push(top);
    if (!washed[bottom] && matches(bottom)) queue.push(bottom);
  }
  for (let y = 1; y < height - 1; y += 1) {
    const left = y * width;
    const right = y * width + width - 1;
    if (!washed[left] && matches(left)) queue.push(left);
    if (!washed[right] && matches(right)) queue.push(right);
  }

  let count = 0;
  while (queue.length > 0) {
    const idx = queue.pop() as number;
    if (washed[idx]) continue;
    washed[idx] = 1;
    const o = idx * 4;
    data[o] = 255;
    data[o + 1] = 255;
    data[o + 2] = 255;
    count += 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0 && !washed[idx - 1] && matches(idx - 1)) queue.push(idx - 1);
    if (x < width - 1 && !washed[idx + 1] && matches(idx + 1)) queue.push(idx + 1);
    if (y > 0 && !washed[idx - width] && matches(idx - width)) queue.push(idx - width);
    if (y < height - 1 && !washed[idx + width] && matches(idx + width)) {
      queue.push(idx + width);
    }
  }
  return count;
}

/**
 * Brightness/contrast pass — plain per-pixel math, fast at photo sizes.
 * Brightness ±60 adds directly; contrast ±60 uses the classic
 * f = 259·(c+255) / (255·(259−c)) pivot around mid-grey 128. Both clamp.
 * (0, 0) is an exact identity (early return — the smoke pins this).
 */
export function applyBrightnessContrast(
  data: Uint8ClampedArray,
  brightness: number,
  contrast: number
): void {
  // Junk inputs clamp to 0 (identity) — a missing adjustment must never
  // become a destructive −60 edit.
  const b = clampRange(brightness, -ADJUST_MAX, ADJUST_MAX, 0);
  const c = clampRange(contrast, -ADJUST_MAX, ADJUST_MAX, 0);
  if (b === 0 && c === 0) return;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0; i < data.length; i += 4) {
    for (let ch = 0; ch < 3; ch += 1) {
      const v = (data[i + ch] - 128) * factor + 128 + b;
      data[i + ch] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
}

/* ------------------------------ wire format --------------------------- */

export type BackgroundMode = "original" | "white";
export type PassportLocale = "en" | "hi";

/** Full framing recipe — the wire format lives in PassportOption below. */
export interface PassportStyle {
  sizeId: PhotoSizeId;
  customW: number;
  customH: number;
  sheet: SheetId;
  zoom: number;
  panX: number;
  panY: number;
  background: BackgroundMode;
  whiteTolerance: number;
  brightness: number;
  contrast: number;
  cutGuides: boolean;
  infoLine: boolean;
}

export const DEFAULT_STYLE: PassportStyle = {
  sizeId: "india-passport",
  customW: 35,
  customH: 45,
  sheet: "photo4x6",
  zoom: 1,
  panX: 0,
  panY: 0,
  background: "white",
  whiteTolerance: 30,
  brightness: 0,
  contrast: 0,
  cutGuides: true,
  infoLine: true,
};

function pickString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Garbage in → defaults out. Every field is validated independently. */
export function sanitizeStyle(value: unknown): PassportStyle {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    sizeId: pickString(
      raw.sizeId,
      ["india-passport", "india-visa-pan", "us-visa", "china-visa", "custom"] as const,
      DEFAULT_STYLE.sizeId
    ),
    customW: clampCustomMM(raw.customW, DEFAULT_STYLE.customW),
    customH: clampCustomMM(raw.customH, DEFAULT_STYLE.customH),
    sheet: pickString(raw.sheet, ["photo4x6", "a4"] as const, DEFAULT_STYLE.sheet),
    zoom: clampZoom(raw.zoom),
    panX: clampPan(raw.panX),
    panY: clampPan(raw.panY),
    background: pickString(raw.background, ["original", "white"] as const, "white"),
    whiteTolerance: clampRange(
      raw.whiteTolerance,
      0,
      WHITE_TOLERANCE_MAX,
      DEFAULT_STYLE.whiteTolerance
    ),
    brightness: clampRange(
      raw.brightness,
      -ADJUST_MAX,
      ADJUST_MAX,
      DEFAULT_STYLE.brightness
    ),
    contrast: clampRange(
      raw.contrast,
      -ADJUST_MAX,
      ADJUST_MAX,
      DEFAULT_STYLE.contrast
    ),
    cutGuides: raw.cutGuides === false ? false : true,
    infoLine: raw.infoLine === false ? false : true,
  };
}

/** The "passport" option — the worker needs nothing else. */
export interface PassportOption {
  style: PassportStyle;
  locale: PassportLocale;
}

export function serializePassport(option: PassportOption): string {
  return JSON.stringify(option);
}

/**
 * Parses the "passport" option. Missing / corrupt data falls back to the
 * defaults — a fresh mount must still produce an honest 35×45 sheet.
 */
export function parsePassportOption(value: unknown): PassportOption {
  let parsed: unknown = null;
  if (typeof value === "string" && value !== "") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  } else if (typeof value === "object" && value !== null) {
    parsed = value;
  }
  const raw = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    style: sanitizeStyle(raw.style),
    locale: pickString(raw.locale, ["en", "hi"] as const, "en"),
  };
}

/* ------------------------------ outputs ------------------------------ */

/** Localized output names (workers have no locale — it rides the option). */
export function photoOutputName(locale: PassportLocale): string {
  return locale === "hi" ? "पासपोर्ट-फ़ोटो.jpg" : "passport-photo.jpg";
}

export function sheetOutputName(locale: PassportLocale): string {
  return locale === "hi" ? "पासपोर्ट-फ़ोटो-शीट.pdf" : "passport-photo-sheet.pdf";
}

/**
 * The sheet's bottom-margin info line — ASCII only (Helvetica, print
 * shops), capped tight. Example: "35x45mm - 300 DPI - 6 copies - DocoPDF".
 */
export function infoLineText(size: ResolvedSize, plan: SheetPlan): string {
  const w = Math.round(size.wMM);
  const h = Math.round(size.hMM);
  const text = `${w}x${h}mm - ${PHOTO_DPI} DPI - ${plan.copies} ${
    plan.copies === 1 ? "copy" : "copies"
  } - DocoPDF`;
  return text.slice(0, 80);
}

/* ---------------------------- JPEG DPI tag ---------------------------- */

/**
 * Writes a JFIF APP0 density so print shops see the true 300 DPI (canvas
 * encoders write no density). If a JFIF APP0 already leads the file its
 * fields are patched; otherwise a fresh APP0 is inserted right after SOI
 * (JFIF spec position). Pure byte surgery — no re-encode, no recompress.
 */
export function setJpegDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  // The JFIF density fields are unsigned 16-bit — clamp to 65535, not
  // 99999 (a larger clamp silently wraps: 99999 & 0xffff = 34463).
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  // JFIF APP0 (JFIF 1.02) at the head: SOI | FF E0 | len | "JFIF\0" |
  // version | units | Xdensity | Ydensity | thumb dims — the length field
  // is 16 (0x0010) without a thumbnail and "JFIF\0" sits at bytes 6–10.
  const segLen = bytes.length > 5 ? (bytes[4] << 8) | bytes[5] : 0;
  const isJfifApp0 =
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    bytes.length > 17 &&
    segLen >= 16 &&
    bytes[6] === 0x4a &&
    bytes[7] === 0x46 &&
    bytes[8] === 0x49 &&
    bytes[9] === 0x46 &&
    bytes[10] === 0x00;
  if (isJfifApp0) {
    const out = new Uint8Array(bytes);
    out[13] = 0x01; // units: dots per inch
    out[14] = (d >> 8) & 0xff;
    out[15] = d & 0xff;
    out[16] = out[14];
    out[17] = out[15];
    return out;
  }
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, // APP0 "JFIF\0"
    0x01, 0x01, // version 1.1
    0x01, // units: dots per inch
    (d >> 8) & 0xff, d & 0xff, // X density
    (d >> 8) & 0xff, d & 0xff, // Y density
    0x00, 0x00, // no thumbnail
  ]);
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}
