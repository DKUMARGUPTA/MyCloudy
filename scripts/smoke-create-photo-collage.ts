/**
 * PRE-BUILD smoke test for Create photo collage (62nd tool, PRD
 * "Photo collage").
 *
 * Part 1 (model, pure): every LAYOUT tiles the unit square exactly (area
 * sums, bounds, 400-point overlap sampling), pagination (exact fill,
 * partial last page, single photo, empty), the CollageStyle sanitizer
 * (garbage enums/hex/title/captions), the wire option parser (missing,
 * corrupt JSON, invalid entries, caption alignment, export format),
 * page geometry (A4/Letter/square/4×6 + landscape swaps + 2px/pt), the
 * gap-insetting cell rect math, cover-crop/contain fits, background
 * presets + luminance ink, caption defaults + localized output names.
 *
 * Part 2 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim PLUS a sharp-backed OffscreenCanvas /
 * createImageBitmap shim — bun has no canvas stack, so the raster
 * backend is software-composited (rect/text layers + cover-crop
 * resizes through sharp). The worker's REAL control flow runs end to
 * end: option parse → decode → computePages → drawCollagePage →
 * pdf-lib embedJpg → result Blob. Output is re-opened with pdf-lib:
 * %PDF-/%%EOF magic, page count matches computePages, page dimensions
 * match the format/orientation, embedded JPEG XObjects present, plus
 * a jpg-format run returning real FFD8 bytes and the honest error
 * paths (no photos, SVG rejection).
 *
 * Run: bun scripts/smoke-create-photo-collage.ts
 */
import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

import {
  BACKGROUND_COLORS,
  DEFAULT_STYLE,
  GAP_PT,
  LAYOUTS,
  MARGIN_PT,
  MAX_CAPTION_CHARS,
  PHOTO_LONG_EDGE_CAP,
  backgroundHex,
  cellRectInArea,
  cellRectPx,
  computePages,
  containFit,
  coverCrop,
  defaultCaptionFor,
  hexLuminance,
  inkHex,
  isLayoutId,
  layoutById,
  outputBaseName,
  pagePixelSize,
  pagePtSize,
  parseCollageOption,
  photoDecodeCap,
  photosPerPage,
  sanitizeHexColor,
  sanitizeStyle,
  serializeCollage,
  titleFontPt,
  type CollageStyle,
} from "../tools/create-photo-collage/model";
import { truncateText } from "../tools/create-photo-collage/render";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string, detail?: unknown): void {
  failed += 1;
  console.log(`FAIL ${message}`);
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

function assert(condition: boolean, message: string, detail?: unknown): void {
  if (condition) pass(message);
  else fail(message, detail);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(message);
  else fail(message, { actual, expected });
}

/* ================================================================== */
/* Part 1 — the pure model                                             */
/* ================================================================== */

function part1(): void {
  /* ---- layouts tile the unit square exactly ---- */
  assert(LAYOUTS.length === 10, "10 layouts shipped", LAYOUTS.length);
  for (const layout of LAYOUTS) {
    let area = 0;
    for (const cell of layout.cells) {
      area += cell.w * cell.h;
      assert(
        cell.x >= 0 && cell.y >= 0 && cell.x + cell.w <= 1.000001 && cell.y + cell.h <= 1.000001,
        `layout ${layout.id}: cell in bounds`
      );
    }
    assert(Math.abs(area - 1) < 1e-9, `layout ${layout.id}: area sums to 1`, area);

    // Overlap sampling: 20×20 grid points, each covered exactly once.
    let overlaps = 0;
    for (let gx = 0; gx < 20; gx += 1) {
      for (let gy = 0; gy < 20; gy += 1) {
        const px = (gx + 0.5) / 20;
        const py = (gy + 0.5) / 20;
        let covered = 0;
        for (const cell of layout.cells) {
          if (
            px >= cell.x && px < cell.x + cell.w &&
            py >= cell.y && py < cell.y + cell.h
          ) {
            covered += 1;
          }
        }
        if (covered !== 1) overlaps += 1;
      }
    }
    assert(overlaps === 0, `layout ${layout.id}: no overlap (400 samples)`, overlaps);
  }

  // Lookup + fallback
  assert(layoutById("nope").id === "quad", "layoutById: unknown falls back to quad");
  assert(isLayoutId("filmstrip") && !isLayoutId("nope"), "isLayoutId");
  assertEqual(photosPerPage("nine"), 9, "photosPerPage(nine) = 9");
  assertEqual(photosPerPage("duo"), 2, "photosPerPage(duo) = 2");

  /* ---- pagination ---- */
  const quad8 = computePages(8, "quad");
  assertEqual(quad8.length, 2, "computePages: 8 photos quad = 2 pages");
  assert(
    quad8.every((page) => page.cells.every((cell) => cell.photo !== null)),
    "computePages: exact fill has no empty cells"
  );
  assertEqual(quad8[0].cells.map((c) => c.photo), [0, 1, 2, 3], "computePages: page 1 order");
  assertEqual(quad8[1].cells.map((c) => c.photo), [4, 5, 6, 7], "computePages: page 2 order");

  const quad5 = computePages(5, "quad");
  assertEqual(quad5.length, 2, "computePages: 5 photos quad = 2 pages");
  assertEqual(
    quad5[1].cells.map((c) => c.photo),
    [4, null, null, null],
    "computePages: partial last page keeps template with nulls"
  );

  assertEqual(computePages(1, "duo").length, 1, "computePages: 1 photo = 1 page");
  assertEqual(computePages(0, "quad").length, 0, "computePages: 0 photos = no pages");
  assertEqual(computePages(10, "trio-left").length, 4, "computePages: 10 photos trio = 4 pages");

  /* ---- sanitizeStyle ---- */
  assertEqual(sanitizeStyle(null), { ...DEFAULT_STYLE, captions: [] }, "sanitizeStyle: null → defaults");
  assertEqual(sanitizeStyle("garbage"), { ...DEFAULT_STYLE, captions: [] }, "sanitizeStyle: string → defaults");
  const garbage = sanitizeStyle({
    format: "a5",
    orientation: "diagonal",
    layout: "round",
    background: "blue",
    customColor: "#GGGGGG",
    radius: "sharp",
    gap: "huge",
    margin: 5,
    fit: "stretch",
    polaroid: "yes",
    title: 123,
    captions: [42, null, "ok"],
  });
  assert(
    garbage.format === "a4" &&
      garbage.orientation === "portrait" &&
      garbage.layout === "quad" &&
      garbage.background === "white" &&
      garbage.customColor === "#f5f1ea" &&
      garbage.radius === DEFAULT_STYLE.radius &&
      garbage.gap === DEFAULT_STYLE.gap &&
      garbage.margin === DEFAULT_STYLE.margin &&
      garbage.fit === DEFAULT_STYLE.fit &&
      garbage.polaroid === false &&
      garbage.title === "" &&
      JSON.stringify(garbage.captions) === JSON.stringify(["", "", "ok"]),
    "sanitizeStyle: every garbage field falls back",
    garbage
  );
  const clamped = sanitizeStyle({
    title: "x".repeat(400),
    captions: ["y".repeat(400)],
  });
  assert(clamped.title.length === 120, "sanitizeStyle: title clamped to 120", clamped.title.length);
  assert(
    clamped.captions[0].length === MAX_CAPTION_CHARS,
    "sanitizeStyle: caption clamped to 60",
    clamped.captions[0].length
  );
  assertEqual(sanitizeHexColor("#AAbbCC"), "#aabbcc", "sanitizeHexColor: lowercased");
  assertEqual(sanitizeHexColor("nope"), "#f5f1ea", "sanitizeHexColor: invalid → fallback");
  assertEqual(sanitizeHexColor("#12345", "#ffffff"), "#ffffff", "sanitizeHexColor: custom fallback");

  /* ---- wire option parse ---- */
  const missing = parseCollageOption(undefined, 3);
  assertEqual(
    missing.photos,
    [[0, 0], [1, 0], [2, 0]],
    "parseCollageOption: missing → natural order"
  );
  assert(missing.style.layout === "quad" && missing.exportFormat === "pdf", "parseCollageOption: defaults");

  const corrupt = parseCollageOption("{not json", 2);
  assertEqual(corrupt.photos, [[0, 0], [1, 0]], "parseCollageOption: corrupt JSON → natural order");

  const valid = parseCollageOption(
    serializeCollage({
      photos: [[2, 90], [0, 180]],
      style: { ...DEFAULT_STYLE, layout: "six", captions: ["a", "b"] },
      exportFormat: "png",
      locale: "hi",
    }),
    3
  );
  assertEqual(valid.photos, [[2, 90], [0, 180]], "parseCollageOption: valid photos kept");
  assert(valid.style.layout === "six", "parseCollageOption: style layout kept");
  assertEqual(valid.style.captions, ["a", "b"], "parseCollageOption: captions aligned");
  assert(valid.exportFormat === "png" && valid.locale === "hi", "parseCollageOption: format + locale kept");

  const invalid = parseCollageOption(
    JSON.stringify({ photos: [[9, 0], ["x", 90], [1, 45], [0, 90]], exportFormat: "tif", locale: "de" }),
    2
  );
  assertEqual(invalid.photos, [[0, 90]], "parseCollageOption: out-of-range + bad rotation dropped");
  assert(invalid.exportFormat === "pdf" && invalid.locale === "en", "parseCollageOption: bad format/locale → defaults");

  /* ---- page geometry ---- */
  const a4p = pagePtSize({ ...DEFAULT_STYLE });
  assert(Math.abs(a4p.w - 595.28) < 0.01 && Math.abs(a4p.h - 841.89) < 0.01, "A4 portrait pt", a4p);
  const a4l = pagePtSize({ ...DEFAULT_STYLE, orientation: "landscape" });
  assert(Math.abs(a4l.w - 841.89) < 0.01 && Math.abs(a4l.h - 595.28) < 0.01, "A4 landscape swap", a4l);
  const letter = pagePtSize({ ...DEFAULT_STYLE, format: "letter" });
  assert(letter.w === 612 && letter.h === 792, "Letter portrait pt", letter);
  const sq = pagePtSize({ ...DEFAULT_STYLE, format: "square", orientation: "landscape" });
  assert(Math.abs(sq.w - sq.h) < 0.01, "square ignores orientation", sq);
  const photo = pagePtSize({ ...DEFAULT_STYLE, format: "photo4x6" });
  assert(photo.w === 288 && photo.h === 432, "4×6 photo portrait pt", photo);
  const photoL = pagePtSize({ ...DEFAULT_STYLE, format: "photo4x6", orientation: "landscape" });
  assert(photoL.w === 432 && photoL.h === 288, "4×6 photo landscape swap", photoL);
  const px = pagePixelSize({ ...DEFAULT_STYLE });
  assert(px.w === 1191 && px.h === 1684, "pagePixelSize = pt × 2 (rounded)", px);
  assertEqual(GAP_PT, { none: 0, thin: 8, cozy: 18 }, "gap presets");
  assertEqual(MARGIN_PT, { none: 0, thin: 16, cozy: 34 }, "margin presets");
  assert(titleFontPt({ ...DEFAULT_STYLE }) === 25, "titleFontPt A4 = 25pt", titleFontPt({ ...DEFAULT_STYLE }));

  /* ---- cell rect math (gap insetting) ---- */
  const duo = layoutById("duo");
  const c0 = cellRectPx(duo.cells[0], 100, 100, 10, 4);
  const c1 = cellRectPx(duo.cells[1], 100, 100, 10, 4);
  assert(
    c0.x === 10 && c0.y === 10 && c0.w === 38 && c0.h === 80,
    "cellRectPx: first cell flush with margin, inset on interior edge",
    c0
  );
  assert(c1.x === 52 && c1.w === 38, "cellRectPx: gutter = gap (10+38+4+38+10)", c1);
  const flush = cellRectPx(duo.cells[0], 100, 100, 0, 0);
  assert(flush.w === 50 && flush.h === 100, "cellRectPx: zero gap tiles exactly", flush);
  const band = cellRectInArea(duo.cells[0], { x: 10, y: 30, w: 80, h: 60 }, 4);
  assert(band.x === 10 && band.y === 30 && band.w === 38 && band.h === 60, "cellRectInArea: custom area", band);

  /* ---- crop math ---- */
  const landscapeIntoPortrait = coverCrop(200, 100, 50, 100);
  assert(
    landscapeIntoPortrait.sx === 75 &&
      landscapeIntoPortrait.sy === 0 &&
      landscapeIntoPortrait.sw === 50 &&
      landscapeIntoPortrait.sh === 100,
    "coverCrop: landscape → portrait cell crops horizontally-centered",
    landscapeIntoPortrait
  );
  const portraitIntoLandscape = coverCrop(100, 200, 100, 50);
  assert(
    portraitIntoLandscape.sx === 0 &&
      portraitIntoLandscape.sy === 75 &&
      portraitIntoLandscape.sw === 100 &&
      portraitIntoLandscape.sh === 50,
    "coverCrop: portrait → landscape cell crops vertically-centered",
    portraitIntoLandscape
  );
  const sameAspect = coverCrop(300, 150, 600, 300);
  assert(
    sameAspect.sx === 0 && sameAspect.sy === 0 && sameAspect.sw === 300 && sameAspect.sh === 150,
    "coverCrop: matching aspect = full source",
    sameAspect
  );
  assertEqual(coverCrop(0, 100, 50, 50), { sx: 0, sy: 0, sw: 0, sh: 0 }, "coverCrop: degenerate = zero rect");
  const contained = containFit(100, 100, 200, 100);
  assert(contained.x === 50 && contained.y === 0 && contained.w === 100 && contained.h === 100, "containFit: centred", contained);

  /* ---- backgrounds + ink ---- */
  assertEqual(BACKGROUND_COLORS.soft, "#f5f1ea", "soft warm background value");
  assert(backgroundHex({ ...DEFAULT_STYLE, background: "dark" }) === "#1c1917", "backgroundHex dark");
  assert(
    backgroundHex({ ...DEFAULT_STYLE, background: "custom", customColor: "#E8D5C4" }) === "#e8d5c4",
    "backgroundHex custom valid"
  );
  assert(
    backgroundHex({ ...DEFAULT_STYLE, background: "custom", customColor: "junk" }) === "#f5f1ea",
    "backgroundHex custom invalid → sanitized fallback"
  );
  assert(hexLuminance("#ffffff") > hexLuminance("#1c1917"), "hexLuminance ordering");
  assert(inkHex("#ffffff") === "#1c1917" && inkHex("#1c1917") === "#faf9f7", "inkHex flips with background");

  /* ---- decode cap (RAM guard, ENH-1) ---- */
  for (const layout of LAYOUTS) {
    for (const format of ["a4", "letter", "square", "photo4x6"] as const) {
      for (const orientation of ["portrait", "landscape"] as const) {
        const style: CollageStyle = {
          ...DEFAULT_STYLE,
          layout: layout.id,
          format,
          orientation,
        };
        const px = pagePixelSize(style);
        const cap = photoDecodeCap(style);
        let maxCell = 0;
        for (const cell of layoutById(layout.id).cells) {
          maxCell = Math.max(maxCell, cell.w * px.w, cell.h * px.h);
        }
        assert(
          cap >= Math.ceil(maxCell) && cap >= PHOTO_LONG_EDGE_CAP,
          `photoDecodeCap: ${format}/${orientation}/${layout.id} covers the largest cell`,
          { cap, maxCell }
        );
      }
    }
  }
  // The largest built-in cell (A4 portrait duo full-height ≈ 1684 px)
  // sits below the generous 2048 floor → normal photos stay zero-copy.
  assert(
    photoDecodeCap({ ...DEFAULT_STYLE, layout: "duo", format: "a4" }) === 2048,
    "photoDecodeCap: A4 duo full-height cell < 2048 → floor applies"
  );

  /* ---- captions + names ---- */
  assertEqual(defaultCaptionFor("IMG_2048 (1).JPG"), "IMG_2048 (1)", "defaultCaptionFor strips extension");
  assert(
    defaultCaptionFor(`${"a".repeat(100)}.png`).length === MAX_CAPTION_CHARS,
    "defaultCaptionFor clamps to 60"
  );
  assertEqual(outputBaseName("en", "pdf"), "photo-collage.pdf", "outputBaseName en");
  assertEqual(outputBaseName("hi", "jpg"), "फ़ोटो-कोलाज.jpg", "outputBaseName hi");

  /* ---- truncateText with a deterministic fake ctx ---- */
  const fakeCtx = {
    measureText: (text: string) => ({
      width: [...text].length * 10,
    }),
  } as unknown as CanvasRenderingContext2D;
  assertEqual(truncateText(fakeCtx, "hello", 60), "hello", "truncateText: fits → unchanged");
  assertEqual(truncateText(fakeCtx, "hello", 40), "hel…", "truncateText: cuts + ellipsis");
  assertEqual(truncateText(fakeCtx, "hello", 25), "h…", "truncateText: tiny budget");
  assertEqual(truncateText(fakeCtx, "", 50), "", "truncateText: empty stays empty");
}

/* ================================================================== */
/* Canvas shims — sharp-backed software rasterizer for bun             */
/* ================================================================== */

interface DrawImageOp {
  kind: "image";
  source: ShimBitmap | ShimCanvas;
  /** Source dims snapshotted at record time — browsers snapshot pixels at
   *  drawImage call time, and the worker may release (0×0-resize) a
   *  consumed canvas right after drawing from it. */
  srcW: number;
  srcH: number;
  args: number[];
  tx: number;
  ty: number;
  rotDeg: number;
}
interface RectOp {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  tx: number;
  ty: number;
  rotDeg: number;
}
interface TextOp {
  kind: "text";
  text: string;
  x: number;
  y: number;
  font: string;
  fill: string;
  align: string;
  baseline: string;
  tx: number;
  ty: number;
  rotDeg: number;
}
type ShimOp = DrawImageOp | RectOp | TextOp;

interface ShimBitmap {
  width: number;
  height: number;
  _raw: Buffer;
  /** Set by the worker's memory-guard close() — the regression signal. */
  closed: boolean;
  close(): void;
}

function isShimBitmap(source: ShimBitmap | ShimCanvas): source is ShimBitmap {
  return "_raw" in source;
}

interface ShimState {
  tx: number;
  ty: number;
  rotDeg: number;
}

function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 16;
}

class ShimCtx {
  canvas: ShimCanvas;
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  font = "16px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  imageSmoothingEnabled = true;
  imageSmoothingQuality: "high" | "low" | "medium" = "high";
  private stack: ShimState[] = [];
  private state: ShimState = { tx: 0, ty: 0, rotDeg: 0 };

  constructor(canvas: ShimCanvas) {
    this.canvas = canvas;
  }

  save(): void {
    this.stack.push({ ...this.state });
  }

  restore(): void {
    const prev = this.stack.pop();
    if (prev) this.state = prev;
  }

  translate(x: number, y: number): void {
    this.state.tx += x;
    this.state.ty += y;
  }

  rotate(radians: number): void {
    this.state.rotDeg = (this.state.rotDeg + Math.round((radians * 180) / Math.PI)) % 360;
  }

  beginPath(): void { /* recorded via ops; clips are approximated away */ }
  moveTo(): void { /* path node */ }
  lineTo(): void { /* path node */ }
  arcTo(): void { /* path node */ }
  closePath(): void { /* path node */ }
  clip(): void { /* rounded clips are cosmetic — pixel fidelity is QA'd in-browser */ }
  stroke(): void { /* hairlines are cosmetic */ }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.canvas.ops.push({
      kind: "rect",
      x,
      y,
      w,
      h,
      fill: this.fillStyle,
      ...this.state,
    });
  }

  fillText(text: string, x: number, y: number): void {
    this.canvas.ops.push({
      kind: "text",
      text,
      x,
      y,
      font: this.font,
      fill: this.fillStyle,
      align: this.textAlign,
      baseline: this.textBaseline,
      ...this.state,
    });
  }

  measureText(text: string): { width: number } {
    return { width: [...text].length * fontSizeOf(this.font) * 0.55 };
  }

  drawImage(source: ShimBitmap | ShimCanvas, ...args: number[]): void {
    this.canvas.ops.push({
      kind: "image",
      source,
      srcW: source.width,
      srcH: source.height,
      args,
      ...this.state,
    });
  }
}

class ShimCanvas {
  #width: number;
  #height: number;
  ops: ShimOp[] = [];
  private raw: Promise<Buffer> | null = null;

  constructor(width: number, height: number) {
    this.#width = width;
    this.#height = height;
  }

  /*
   * The worker's releaseSource() drops a consumed canvas by resizing it
   * to 0×0. In a real browser drawImage is synchronous, so that is safe;
   * in this shim the recorded ops rasterize lazily — so a resize to zero
   * must FIRST flush the pending raster (which captures its size up
   * front), exactly like the browser already had the pixels.
   */
  get width(): number {
    return this.#width;
  }
  get height(): number {
    return this.#height;
  }
  set width(value: number) {
    if (value <= 0 && this.ops.length > 0 && !this.raw) void this._ensureRaw();
    this.#width = value;
  }
  set height(value: number) {
    if (value <= 0 && this.ops.length > 0 && !this.raw) void this._ensureRaw();
    this.#height = value;
  }

  getContext(kind: string): ShimCtx | null {
    return kind === "2d" ? new ShimCtx(this) : null;
  }

  /** Raw RGBA pixels of every recorded op, composited in order. */
  _ensureRaw(): Promise<Buffer> {
    if (!this.raw) this.raw = this._rasterize();
    return this.raw;
  }

  private async _rasterize(): Promise<Buffer> {
    // Capture the size up front: a zero-size release may already have
    // flushed this rasterization (see the width setter) — everything
    // below must use the dims the canvas had when its ops were recorded.
    const W = this.width;
    const H = this.height;
    // Background: the first full-canvas rect (if any), else transparent.
    let background = { r: 0, g: 0, b: 0, alpha: 0 };
    for (const op of this.ops) {
      if (
        op.kind === "rect" &&
        op.x === 0 && op.y === 0 &&
        Math.round(op.w) === W && Math.round(op.h) === H
      ) {
        background = parseColor(op.fill);
        break;
      }
    }
    const base = await sharp({
      create: {
        width: W,
        height: H,
        channels: 4,
        background,
      },
    })
      .raw()
      .toBuffer();

    const layers: sharp.OverlayOptions[] = [];
    const place = async (op: RectOp | TextOp): Promise<void> => {
      if (op.kind === "rect") {
        const svg = Buffer.from(
          `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="${roundSafe(op.x + op.tx)}" y="${roundSafe(op.y + op.ty)}" width="${Math.max(1, Math.round(op.w))}" height="${Math.max(1, Math.round(op.h))}" fill="${op.fill}"/></svg>`
        );
        layers.push({ input: await sharp(svg).png().toBuffer() });
      } else {
        const size = fontSizeOf(op.font);
        const anchor =
          op.align === "center" ? "middle" : op.align === "right" || op.align === "end" ? "end" : "start";
        const dominant = op.baseline === "middle" ? "central" : "auto";
        const escaped = op.text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const family = "sans-serif";
        const svg = Buffer.from(
          `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><text x="${roundSafe(op.x + op.tx)}" y="${roundSafe(op.y + op.ty)}" font-family="${family}" font-size="${size}" fill="${op.fill}" text-anchor="${anchor}" dominant-baseline="${dominant}">${escaped}</text></svg>`
        );
        layers.push({ input: await sharp(svg).png().toBuffer() });
      }
    };

    for (const op of this.ops) {
      if (op.kind === "rect" || op.kind === "text") {
        if (op.rotDeg !== 0) continue; // rotated text is not used by the engine
        await place(op);
        continue;
      }
      // Image op
      const sourceRaw = await sourcePixels(op.source);
      const srcW = op.srcW;
      const srcH = op.srcH;
      let layer: Buffer;
      let left: number;
      let top: number;
      if (op.args.length >= 5) {
        // 9-arg cover-crop form
        const [sx, sy, sw, sh, dx, dy, dw, dh] = op.args;
        const region = await sharp(sourceRaw, {
          raw: { width: srcW, height: srcH, channels: 4 },
        })
          .extract({
            left: Math.max(0, Math.round(sx)),
            top: Math.max(0, Math.round(sy)),
            width: Math.max(1, Math.min(Math.round(sw), srcW - Math.max(0, Math.round(sx)))),
            height: Math.max(1, Math.min(Math.round(sh), srcH - Math.max(0, Math.round(sy)))),
          })
          .resize(Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)), { fit: "fill" })
          .png()
          .toBuffer();
        layer = region;
        left = Math.round(dx + op.tx);
        top = Math.round(dy + op.ty);
      } else if (op.args.length === 2) {
        // 3-arg natural size (the rotation canvas path)
        const [dx, dy] = op.args;
        if (op.rotDeg !== 0) {
          const rotated = await sharp(sourceRaw, {
            raw: { width: srcW, height: srcH, channels: 4 },
          })
            .rotate(op.rotDeg)
            .png()
            .toBuffer();
          layer = rotated;
          // Rotated around the canvas centre → covers [0..W,0..H] exactly.
          left = Math.round(dx + op.tx + srcW / 2 - (op.rotDeg % 180 === 90 ? srcH : srcW) / 2);
          top = Math.round(dy + op.ty + srcH / 2 - (op.rotDeg % 180 === 90 ? srcW : srcH) / 2);
        } else {
          layer = await sharp(sourceRaw, {
            raw: { width: srcW, height: srcH, channels: 4 },
          })
            .png()
            .toBuffer();
          left = Math.round(dx + op.tx);
          top = Math.round(dy + op.ty);
        }
      } else {
        continue;
      }
      layers.push({ input: layer, left, top });
    }

    if (layers.length === 0) return base;
    return await sharp(base, {
      raw: { width: W, height: H, channels: 4 },
    })
      .composite(layers)
      .raw()
      .toBuffer();
  }

  async convertToBlob(options: { type: string; quality?: number }): Promise<Blob> {
    const raw = await this._ensureRaw();
    const pipeline = sharp(raw, {
      raw: { width: this.width, height: this.height, channels: 4 },
    });
    const bytes =
      options.type === "image/png"
        ? await pipeline.png().toBuffer()
        : await pipeline.jpeg({ quality: Math.round((options.quality ?? 0.92) * 100) }).toBuffer();
    return new Blob([new Uint8Array(bytes)], { type: options.type });
  }
}

async function sourcePixels(source: ShimBitmap | ShimCanvas): Promise<Buffer> {
  if (isShimBitmap(source)) return source._raw;
  return await source._ensureRaw();
}

function parseColor(fill: string): { r: number; g: number; b: number; alpha: number } {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(fill.trim());
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      alpha: 1,
    };
  }
  const rgba = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\)/.exec(fill);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return { r: 0, g: 0, b: 0, alpha: 1 };
}

function roundSafe(value: number): number {
  return Math.max(0, Math.round(value));
}

/* ---- global shims ---- */

type Posted = Record<string, unknown> & { type: string; runId: string };
const inbox: Posted[] = [];
/** Every bitmap the worker decoded this run — close() flags are the
 *  memory-guard regression signal (full-res sources must be released). */
const createdBitmaps: ShimBitmap[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
  OffscreenCanvas: typeof OffscreenCanvas;
  createImageBitmap: typeof createImageBitmap;
};

function installShims(): void {
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Posted);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
    ShimCanvas as unknown as typeof OffscreenCanvas;
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (
    source: FakeFile | Blob | ShimCanvas
  ): Promise<ShimBitmap> => {
    const bytes = Buffer.from(await (source as FakeFile).arrayBuffer());
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bitmap: ShimBitmap = {
      width: info.width,
      height: info.height,
      _raw: data,
      closed: false,
      close(): void {
        this.closed = true;
      },
    };
    createdBitmaps.push(bitmap);
    return bitmap;
  };
}

/* ---- fixtures + harness ---- */

class FakeFile {
  name: string;
  type: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array, type = "image/png") {
    this.name = name;
    this.type = type;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
  slice(start: number, end: number): FakeFile {
    return new FakeFile(this.name, this.#bytes.slice(start, end), this.type);
  }
}

async function makePng(
  width: number,
  height: number,
  rgb: [number, number, number],
  label: string
): Promise<Uint8Array> {
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="rgb(${rgb[0]},${rgb[1]},${rgb[2]})"/><text x="${width / 2}" y="${height / 2}" font-family="sans-serif" font-size="${Math.round(Math.min(width, height) / 6)}" fill="white" text-anchor="middle">${label}</text></svg>`
  );
  const bytes = await sharp(svg).png().toBuffer();
  return new Uint8Array(bytes);
}

interface RunOutcome {
  result:
    | (Posted & { type: "result"; detail?: Record<string, unknown> })
    | null;
  error: (Posted & { type: "error"; code?: string }) | null;
  outputs: { name: string; mime: string; blob: Blob }[];
  progress: number;
}

async function runWorker(
  files: FakeFile[],
  options: Record<string, string | number | boolean>
): Promise<RunOutcome> {
  inbox.length = 0;
  createdBitmaps.length = 0;
  workerGlobal.onmessage!({
    data: { type: "run", runId: "smoke", files, options, assets: [] },
  });
  for (let i = 0; i < 600; i += 1) {
    const terminal = inbox.find((m) => m.type === "result" || m.type === "error");
    if (terminal) {
      await new Promise((r) => setTimeout(r, 0));
      const result =
        (inbox.find((m) => m.type === "result") as RunOutcome["result"]) ?? null;
      const error =
        (inbox.find((m) => m.type === "error") as RunOutcome["error"]) ?? null;
      const outputs = (result?.outputs as RunOutcome["outputs"]) ?? [];
      return {
        result,
        error,
        outputs,
        progress: inbox.filter((m) => m.type === "progress").length,
      };
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("worker never posted a terminal message");
}

async function bytesOf(outcome: RunOutcome): Promise<Uint8Array> {
  if (!outcome.result) throw new Error("no result message");
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

/* ================================================================== */
/* Part 2 — the real worker (shimmed raster backend)                   */
/* ================================================================== */

async function part2(): Promise<void> {
  installShims();
  await import("../tools/create-photo-collage/worker");
  if (typeof workerGlobal.onmessage !== "function") {
    throw new Error("worker did not register onmessage");
  }

  const fixtures: FakeFile[] = [
    new FakeFile("beach.png", await makePng(320, 200, [210, 120, 60], "BEACH")),
    new FakeFile("sunset.png", await makePng(200, 320, [180, 60, 40], "SUNSET")),
    new FakeFile("garden.png", await makePng(256, 256, [70, 130, 60], "GARDEN")),
    new FakeFile("temple.png", await makePng(300, 240, [150, 100, 160], "TEMPLE")),
    new FakeFile("market.png", await makePng(240, 300, [40, 120, 150], "MARKET")),
  ];

  /* ---- 1. quad, 5 photos → 2-page A4 portrait PDF ---- */
  const style: CollageStyle = {
    ...DEFAULT_STYLE,
    layout: "quad",
    title: "Our Trip",
    polaroid: true,
    captions: ["beach", "sunset", "garden", "temple", "market"],
  };
  const run1 = await runWorker(fixtures, {
    collage: serializeCollage({
      photos: fixtures.map((_, index): [number, number] => [index, 0]),
      style,
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assert(run1.error === null, "run 1: no error", run1.error);
  assert(run1.result !== null, "run 1: result posted");
  assert(run1.progress >= 2, "run 1: per-page progress posted", run1.progress);
  assertEqual(run1.result?.detail?.pages, 2, "run 1: detail pages = 2");
  assertEqual(run1.result?.detail?.files, 5, "run 1: detail files = 5");
  assertEqual(run1.outputs[0]?.name, "photo-collage.pdf", "run 1: output name");

  const pdf1 = await bytesOf(run1);
  const head = Buffer.from(pdf1.slice(0, 5)).toString("latin1");
  const tail = Buffer.from(pdf1.slice(-32)).toString("latin1");
  assert(head.startsWith("%PDF-"), "run 1: PDF magic", head);
  assert(tail.trimEnd().endsWith("%%EOF"), "run 1: %%EOF", tail);

  const reopened = await PDFDocument.load(pdf1);
  assertEqual(reopened.getPageCount(), 2, "run 1: page count matches computePages(5, quad)");
  const page0 = reopened.getPage(0);
  assert(
    Math.abs(page0.getWidth() - 595.28) < 0.05 && Math.abs(page0.getHeight() - 841.89) < 0.05,
    "run 1: A4 portrait page dims",
    { w: page0.getWidth(), h: page0.getHeight() }
  );
  let jpegXObjects = 0;
  for (const [, obj] of reopened.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const dict = obj.dict;
      const subtype = dict.get(PDFName.of("Subtype"));
      const filter = dict.get(PDFName.of("Filter"));
      if (
        String(subtype) === "/Image" &&
        String(filter).includes("DCTDecode")
      ) {
        assert(
          obj.contents[0] === 0xff && obj.contents[1] === 0xd8,
          "run 1: embedded image bytes are real JPEG (FFD8)",
          [obj.contents[0], obj.contents[1]]
        );
        jpegXObjects += 1;
      }
    }
  }
  assert(jpegXObjects === 2, "run 1: one embedded JPEG XObject per page", jpegXObjects);

  /* ---- 2. duo + landscape letter + 2 photos → 1 page 792×612 ---- */
  const run2 = await runWorker(fixtures.slice(0, 2), {
    collage: serializeCollage({
      photos: [[0, 0], [1, 0]],
      style: { ...DEFAULT_STYLE, layout: "duo", format: "letter", orientation: "landscape", radius: "round", margin: "thin", gap: "cozy" },
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assert(run2.error === null, "run 2: no error", run2.error);
  const pdf2 = await bytesOf(run2);
  const reopened2 = await PDFDocument.load(pdf2);
  assertEqual(reopened2.getPageCount(), 1, "run 2: single page");
  const page2 = reopened2.getPage(0);
  assert(
    Math.abs(page2.getWidth() - 792) < 0.05 && Math.abs(page2.getHeight() - 612) < 0.05,
    "run 2: Letter landscape dims",
    { w: page2.getWidth(), h: page2.getHeight() }
  );

  /* ---- 3. rotated photo (90°) through the orientedSource canvas ---- */
  const run3 = await runWorker(fixtures.slice(0, 3), {
    collage: serializeCollage({
      photos: [[0, 90], [1, 180], [2, 270]],
      style: { ...DEFAULT_STYLE, layout: "trio-left" },
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assert(run3.error === null, "run 3: rotation run no error", run3.error);
  const pdf3 = await bytesOf(run3);
  assert(Buffer.from(pdf3.slice(0, 5)).toString("latin1").startsWith("%PDF-"), "run 3: valid PDF with quarter-turns");

  /* ---- 4. jpg export → FFD8 page-1 image ---- */
  const run4 = await runWorker(fixtures.slice(0, 2), {
    collage: serializeCollage({
      photos: [[0, 0], [1, 0]],
      style: { ...DEFAULT_STYLE, layout: "duo-stack" },
      exportFormat: "jpg",
      locale: "en",
    }),
  });
  assert(run4.error === null, "run 4: jpg run no error", run4.error);
  assertEqual(run4.outputs[0]?.mime, "image/jpeg", "run 4: jpeg mime");
  assertEqual(run4.outputs[0]?.name, "photo-collage.jpg", "run 4: jpg output name");
  const jpg = await bytesOf(run4);
  assert(jpg[0] === 0xff && jpg[1] === 0xd8, "run 4: JPEG magic FFD8", [jpg[0], jpg[1]]);
  assert(jpg.length > 1000, "run 4: non-trivial bytes", jpg.length);

  /* ---- 5. png export → 8950 magic + hi locale name ---- */
  const run5 = await runWorker(fixtures.slice(0, 1), {
    collage: serializeCollage({
      photos: [[0, 0]],
      style: { ...DEFAULT_STYLE, layout: "quad", format: "square" },
      exportFormat: "png",
      locale: "hi",
    }),
  });
  assert(run5.error === null, "run 5: png run no error", run5.error);
  const png = await bytesOf(run5);
  assert(png[0] === 0x89 && png[1] === 0x50, "run 5: PNG magic 8950", [png[0], png[1]]);
  assertEqual(run5.outputs[0]?.name, "फ़ोटो-कोलाज.png", "run 5: localized output name");
  // Square page ratio: 595.28pt → 1191px wide/high.
  const meta = await sharp(Buffer.from(png)).metadata();
  assert(
    Math.abs((meta.width ?? 0) - (meta.height ?? 0)) < 4,
    "run 5: square page = square pixels",
    { w: meta.width, h: meta.height }
  );

  /* ---- 6. honest errors ---- */
  const run6 = await runWorker([], { collage: "" });
  assertEqual(run6.error?.code, "tool.images.errorNoImages", "run 6: no photos → honest error");

  const svgFile = new FakeFile(
    "logo.svg",
    new Uint8Array(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`)),
    "image/svg+xml"
  );
  const run7 = await runWorker([svgFile], {
    collage: serializeCollage({
      photos: [[0, 0]],
      style: { ...DEFAULT_STYLE },
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assertEqual(run7.error?.code, "tool.images.errorUnsupported", "run 7: SVG → honest unsupported error");

  /* ---- 7. garbage option JSON → natural order + defaults ---- */
  const run8 = await runWorker(fixtures.slice(0, 3), { collage: "nonsense{{{" });
  assert(run8.error === null, "run 8: garbage option still runs", run8.error);
  const pdf8 = await bytesOf(run8);
  const reopened8 = await PDFDocument.load(pdf8);
  assertEqual(reopened8.getPageCount(), 1, "run 8: 3 photos default quad = 1 page");

  /* ---- 8. memory guard: oversized photo downscaled + released (ENH-1) ---- */
  const bigBytes = await makePng(3000, 2000, [12, 92, 160], "BIG");
  const bigFile = new FakeFile("big.png", bigBytes);
  const smallFile = fixtures[2]; // 256×256 garden — under the cap
  const run9 = await runWorker([bigFile, smallFile], {
    collage: serializeCollage({
      photos: [[0, 90], [1, 0]],
      style: { ...DEFAULT_STYLE, layout: "duo" },
      exportFormat: "pdf",
      locale: "en",
    }),
  });
  assert(run9.error === null, "run 9: oversized-photo run no error", run9.error);
  assertEqual(createdBitmaps.length, 2, "run 9: two photos decoded");
  assert(
    createdBitmaps[0].width === 3000 && createdBitmaps[0].height === 2000,
    "run 9: oversized photo decoded at full resolution",
    { w: createdBitmaps[0].width, h: createdBitmaps[0].height }
  );
  assert(
    createdBitmaps[0].closed,
    "run 9: full-res bitmap released after the cap downscale (mobile OOM guard)"
  );
  assert(
    !createdBitmaps[1].closed,
    "run 9: under-cap bitmap stays open (zero-copy, visually identical path)"
  );
  const pdf9 = await bytesOf(run9);
  assert(
    Buffer.from(pdf9.slice(0, 5)).toString("latin1").startsWith("%PDF-"),
    "run 9: valid PDF after downscale + rotate"
  );
  const reopened9 = await PDFDocument.load(pdf9);
  assertEqual(reopened9.getPageCount(), 1, "run 9: duo 2 photos = 1 page");
  let jpeg9 = 0;
  for (const [, obj] of reopened9.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFRawStream &&
      String(obj.dict.get(PDFName.of("Subtype"))) === "/Image" &&
      String(obj.dict.get(PDFName.of("Filter"))).includes("DCTDecode")
    ) {
      jpeg9 += 1;
    }
  }
  assertEqual(jpeg9, 1, "run 9: one embedded JPEG page image");

  /* ---- 9. downscaled pixels still composite (visual sanity) ---- */
  const run10 = await runWorker([bigFile], {
    collage: serializeCollage({
      photos: [[0, 0]],
      style: { ...DEFAULT_STYLE, layout: "duo-stack", background: "white" },
      exportFormat: "jpg",
      locale: "en",
    }),
  });
  assert(run10.error === null, "run 10: jpg run no error", run10.error);
  assert(createdBitmaps[0].closed, "run 10: oversized bitmap released");
  const jpg10 = await bytesOf(run10);
  const stats = await sharp(Buffer.from(jpg10)).stats();
  assert(
    stats.channels.length >= 3 &&
      stats.channels[2].mean > stats.channels[0].mean + 40,
    "run 10: downscaled photo keeps its colour (blue-dominant fixture)",
    stats.channels.map((c) => Math.round(c.mean))
  );
}

async function main(): Promise<void> {
  part1();
  await part2();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
