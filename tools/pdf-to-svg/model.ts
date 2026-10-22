import type { OptionValues } from "@/lib/tools/config-types";

import { expandToRGBA } from "../extract-images/engine";
import { pngEncode } from "../imgconv/png-encode";

/**
 * PDF → SVG model (RB4-a) — the operator-list → SVG translator.
 *
 * 100% pure TypeScript: no DOM, no pdf.js, no pdf-lib. It consumes the
 * pdf.js operator list (fnArray/argsArray — the same shape
 * tools/make-pdf-fillable/detect.ts pioneered) plus a viewport-derived
 * base transform, and emits one standalone SVG per page with the viewBox
 * in PDF points (y-down, exactly how the page renders).
 *
 * Coordinate recipe (all verified against pdfjs-dist 4.10.38 source):
 *  - `baseTransform` = page.getViewport({scale: 1}).transform — maps PDF
 *    user space (y-up) to the SVG viewBox (y-down) and folds /Rotate in.
 *  - The device matrix for a shape is D = baseTransform × CTM; the CTM
 *    starts as identity and is tracked through save/restore/transform
 *    (+ paintFormXObjectBegin/End — the way pdf.js inlines Form XObjects).
 *  - Text: the glyph matrix is CTM × Tm × translate(penX, penY + rise) ×
 *    scale(hScale, -1) × diag(fontSize) — pdf.js's own composition —
 *    premultiplied by D. The SVG font-size is the PDF font size; anything
 *    left over (rotation, squeeze, mirrored text) rides a `transform`.
 *  - Pen advance per glyph (pdf.js semantics): width × fontMatrix0 ×
 *    fontSize (+ wordSpacing on spaces, + charSpacing), × hScale; TJ
 *    numbers move the pen by -n × fontSize/1000.
 *  - Images map the unit square: local box = CTM × [1,0,0,-1,0,1] — the
 *    [0,1]×[0,1] box with row 0 at user y=1 that pdf.js draws
 *    (canvas.js paintInlineImageXObject: scale(1/w, -1/h), draw at -h).
 *  - Colors: the evaluator normalizes every color op to
 *    setFillRGBColor/setStrokeRGBColor with 0-255 int triples.
 *
 * HONEST subset (documented in the tool FAQ): gradients/shadings and
 * patterns are omitted (shadingFill skipped), clipping is approximated
 * away (clipped paths still paint), Type3 glyph procedures are
 * approximated by their font-matrix-scaled advances, stroked-text render
 * modes render filled, image masks are skipped, fonts are substituted by
 * family name — so text stays selectable but the page is not
 * pixel-identical to the PDF.
 */

/* ------------------------------------------------------------------ */
/* Types + constants                                                    */
/* ------------------------------------------------------------------ */

/** 2×3 affine matrix, PDF order [a b c d e f]. */
export type Mat = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY_MATRIX: Mat = [1, 0, 0, 1, 0, 0];

/** The pdf.js operator codes this translator consumes. */
export interface SvgOpsTable {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  rectangle: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  fill: number;
  eoFill: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
  setFillRGBColor: number;
  setStrokeRGBColor: number;
  setLineWidth: number;
  setDash: number;
  setGState: number;
  beginText: number;
  endText: number;
  setCharSpacing: number;
  setWordSpacing: number;
  setHScale: number;
  setLeading: number;
  setFont: number;
  setTextRenderingMode: number;
  setTextRise: number;
  moveText: number;
  setLeadingMoveText: number;
  setTextMatrix: number;
  nextLine: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
  paintImageXObject: number;
  paintImageXObjectRepeat: number;
  paintInlineImageXObject: number;
  paintInlineImageXObjectGroup: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  shadingFill: number;
  clip: number;
  eoClip: number;
}

/**
 * Picks the operator codes this model needs from a pdf.js `OPS` object
 * (extra keys are fine; missing keys become -1 so they never match).
 */
export function opsTable(ops: Record<string, unknown>): SvgOpsTable {
  const get = (key: keyof SvgOpsTable): number => {
    const value = ops[key];
    return typeof value === "number" && Number.isInteger(value) ? value : -1;
  };
  return {
    save: get("save"),
    restore: get("restore"),
    transform: get("transform"),
    constructPath: get("constructPath"),
    rectangle: get("rectangle"),
    moveTo: get("moveTo"),
    lineTo: get("lineTo"),
    curveTo: get("curveTo"),
    curveTo2: get("curveTo2"),
    curveTo3: get("curveTo3"),
    closePath: get("closePath"),
    fill: get("fill"),
    eoFill: get("eoFill"),
    stroke: get("stroke"),
    closeStroke: get("closeStroke"),
    fillStroke: get("fillStroke"),
    eoFillStroke: get("eoFillStroke"),
    closeFillStroke: get("closeFillStroke"),
    closeEOFillStroke: get("closeEOFillStroke"),
    endPath: get("endPath"),
    setFillRGBColor: get("setFillRGBColor"),
    setStrokeRGBColor: get("setStrokeRGBColor"),
    setLineWidth: get("setLineWidth"),
    setDash: get("setDash"),
    setGState: get("setGState"),
    beginText: get("beginText"),
    endText: get("endText"),
    setCharSpacing: get("setCharSpacing"),
    setWordSpacing: get("setWordSpacing"),
    setHScale: get("setHScale"),
    setLeading: get("setLeading"),
    setFont: get("setFont"),
    setTextRenderingMode: get("setTextRenderingMode"),
    setTextRise: get("setTextRise"),
    moveText: get("moveText"),
    setLeadingMoveText: get("setLeadingMoveText"),
    setTextMatrix: get("setTextMatrix"),
    nextLine: get("nextLine"),
    showText: get("showText"),
    showSpacedText: get("showSpacedText"),
    nextLineShowText: get("nextLineShowText"),
    nextLineSetSpacingShowText: get("nextLineSetSpacingShowText"),
    paintImageXObject: get("paintImageXObject"),
    paintImageXObjectRepeat: get("paintImageXObjectRepeat"),
    paintInlineImageXObject: get("paintInlineImageXObject"),
    paintInlineImageXObjectGroup: get("paintInlineImageXObjectGroup"),
    paintFormXObjectBegin: get("paintFormXObjectBegin"),
    paintFormXObjectEnd: get("paintFormXObjectEnd"),
    shadingFill: get("shadingFill"),
    clip: get("clip"),
    eoClip: get("eoClip"),
  };
}

/** One pdf.js operator list (getOperatorList shape). */
export interface SvgOperatorList {
  fnArray: readonly number[];
  argsArray: readonly unknown[][];
}

/** Glyph entries pdf.js showText emits (numbers = TJ adjustments). */
export type SvgGlyph = number | GlyphObject | null | undefined;

export interface GlyphObject {
  unicode?: unknown;
  width?: unknown;
  isSpace?: unknown;
  fontChar?: unknown;
  accent?: unknown;
  isInFont?: unknown;
}

/** Font metadata resolved from page.commonObjs (worker + smoke provide it). */
export interface SvgFontInfo {
  /** Display family, e.g. "Helvetica-Bold" / "NotoSansDevanagari-Regular-8". */
  family: string;
  /** Generic CSS fallback: "sans-serif" | "serif" | "monospace". */
  generic: string;
  bold: boolean;
  italic: boolean;
  /** fontMatrix[0] — glyph width scale (0.001 for normal fonts). */
  fontMatrix0: number;
}

/** A resolved image payload, ready for data-URI embedding. */
export interface SvgImagePayload {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface SvgPageContext {
  /** viewBox width (pt) — viewport.width at scale 1. */
  width: number;
  /** viewBox height (pt) — viewport.height at scale 1. */
  height: number;
  /** viewport.transform at scale 1 (y-flip + /Rotate baked in). */
  baseTransform: Mat;
  /** Font ref (setFont arg) → metadata; null skips the run honestly. */
  resolveFont: (ref: unknown) => Promise<SvgFontInfo | null>;
  /** Image objId → payload; null skips the image honestly. */
  resolveImage: (objId: unknown) => Promise<SvgImagePayload | null>;
  /** Embed images as base64 PNG (off = vector + text only). */
  includeImages: boolean;
}

export interface SvgBuildStats {
  texts: number;
  rects: number;
  paths: number;
  images: number;
  /** Element cap hit — the rest of the page was skipped (honest guard). */
  truncated: boolean;
}

export interface SvgBuildResult {
  svg: string;
  stats: SvgBuildStats;
}

/** Honest guards (docstring promises): never explode on hostile files. */
export const MAX_ELEMENTS = 20000;
/** Skip images with absurd pixel sides (same rule as extract-images). */
export const MAX_IMAGE_SIDE = 16384;

export const SVG_MIME = "image/svg+xml";

const BOLD_NAME_RE = /(bold|black|heavy|demi|semib|ultra)/i;
const ITALIC_NAME_RE = /(italic|oblique)/i;

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/** XML-escape for text and attribute content: & < > " '. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Strips characters that are illegal inside XML 1.0 text nodes. */
export function sanitizeSvgText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
    } else if (code < 32 || (code >= 127 && code <= 159)) {
      continue;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Number → short SVG attribute form (≤ 2 decimals, no trailing zeros). */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/** Matrix product (PDF composition order: mul(m, n) = m × n). */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Apply a matrix to a point. */
function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** True when the matrix is axis-aligned (no rotation/skew). */
function isAxisAligned(m: Mat): boolean {
  return Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
}

/** True when the matrix is identity within tolerance. */
function isIdentityish(m: Mat): boolean {
  return (
    Math.abs(m[0] - 1) < 1e-3 &&
    Math.abs(m[1]) < 1e-3 &&
    Math.abs(m[2]) < 1e-3 &&
    Math.abs(m[3] - 1) < 1e-3
  );
}

function finiteMat(m: Mat): boolean {
  return m.every((v) => Number.isFinite(v));
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * pdf.js color op args (setFillRGBColor/setStrokeRGBColor) arrive as a
 * 3-element Uint8ClampedArray of 0-255 ints (evaluator getRgb output —
 * verified against 4.10.38). Clamp + hex them; null when unusable.
 */
export function colorToHex(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const parts = args as { length?: unknown } & Record<number, unknown>;
  if (parts.length !== 3) return null;
  const rgb: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const n = num(parts[i], -1);
    if (n < 0) return null;
    rgb.push(Math.min(255, Math.round(n)));
  }
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Font-object → SvgFontInfo coercion (worker + smoke share it). */
export function toFontInfo(raw: unknown): SvgFontInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const fallback =
    typeof obj.fallbackName === "string" ? obj.fallbackName.trim() : "";
  const useName = name.length > 0 ? name : fallback || "sans-serif";
  const fontMatrix = obj.fontMatrix;
  const fontMatrix0 =
    Array.isArray(fontMatrix) &&
    typeof fontMatrix[0] === "number" &&
    fontMatrix[0] > 0
      ? fontMatrix[0]
      : 0.001;
  const generic = ["serif", "sans-serif", "monospace"].includes(fallback)
    ? fallback
    : /courier|mono/i.test(useName)
      ? "monospace"
      : /times|serif|georgia|garamond|roman/i.test(useName)
        ? "serif"
        : "sans-serif";
  return {
    family: useName,
    generic,
    bold: obj.bold === true || BOLD_NAME_RE.test(useName),
    italic: obj.italic === true || ITALIC_NAME_RE.test(useName),
    fontMatrix0,
  };
}

/* ------------------------------------------------------------------ */
/* Data URI embedding (worker + smoke share the same encoder path)     */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

/**
 * Raw image payload (pdf.js ImageKind data) → PNG data URI. Reuses the
 * extract-images RGB expansion + the imgconv clean-room PNG encoder, so
 * the worker and the bun smoke produce byte-identical embeds.
 */
export async function imageToDataUri(
  payload: SvgImagePayload
): Promise<string | null> {
  const { width, height, kind, data } = payload;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE
  ) {
    return null;
  }
  const rgba = expandToRGBA(data, kind, width, height);
  if (rgba === null) return null;
  const blob = pngEncode({ width, height, data: rgba });
  const png = new Uint8Array(await blob.arrayBuffer());
  if (png[0] !== 0x89 || png[1] !== 0x50) return null;
  return `data:image/png;base64,${bytesToBase64(png)}`;
}

/* ------------------------------------------------------------------ */
/* Graphics state                                                      */
/* ------------------------------------------------------------------ */

interface GState {
  ctm: Mat;
  fill: string;
  stroke: string;
  lineWidth: number;
  dash: number[];
  fontRef: unknown;
  fontSize: number;
  leading: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  rise: number;
  renderMode: number;
  tm: Mat;
  penX: number;
  penY: number;
  lineX: number;
  lineY: number;
}

function freshState(): GState {
  return {
    ctm: IDENTITY_MATRIX,
    fill: "#000000",
    stroke: "#000000",
    lineWidth: 1,
    dash: [],
    fontRef: null,
    fontSize: 0,
    leading: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    rise: 0,
    renderMode: 0,
    tm: IDENTITY_MATRIX,
    penX: 0,
    penY: 0,
    lineX: 0,
    lineY: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Pending path (between constructPath and its paint op)                */
/* ------------------------------------------------------------------ */

interface PathCmd {
  cmd: "M" | "L" | "C" | "Z";
  pts: number[];
}

interface PendingPath {
  /** Path commands in PDF user space (pre-CTM). */
  cmds: PathCmd[];
  /** Set when the path is exactly one rectangle (the common case). */
  rect: { x: number; y: number; w: number; h: number } | null;
}

/** Parses constructPath args [ops, coords, minMax] into a pending path. */
export function parseConstructPath(
  ops: SvgOpsTable,
  args: readonly unknown[]
): PendingPath | null {
  const pathOps = args[0];
  const coords = args[1];
  if (!Array.isArray(pathOps) || !Array.isArray(coords)) return null;
  let ci = 0;
  let cx = 0;
  let cy = 0;
  let started = false;
  const cmds: PathCmd[] = [];
  const pureRects: { x: number; y: number; w: number; h: number }[] = [];
  let onlyRects = true;

  for (const op of pathOps) {
    if (op === ops.moveTo) {
      cx = num(coords[ci]);
      cy = num(coords[ci + 1]);
      ci += 2;
      started = true;
      onlyRects = false;
      cmds.push({ cmd: "M", pts: [cx, cy] });
    } else if (op === ops.lineTo) {
      cx = num(coords[ci]);
      cy = num(coords[ci + 1]);
      ci += 2;
      started = true;
      onlyRects = false;
      cmds.push({ cmd: "L", pts: [cx, cy] });
    } else if (op === ops.curveTo) {
      const pts = [
        num(coords[ci]),
        num(coords[ci + 1]),
        num(coords[ci + 2]),
        num(coords[ci + 3]),
        num(coords[ci + 4]),
        num(coords[ci + 5]),
      ];
      ci += 6;
      cx = pts[4];
      cy = pts[5];
      started = true;
      onlyRects = false;
      cmds.push({ cmd: "C", pts });
    } else if (op === ops.curveTo2) {
      // x2 y2 x3 y3 — the current point doubles as the first control.
      const x2 = num(coords[ci]);
      const y2 = num(coords[ci + 1]);
      const x3 = num(coords[ci + 2]);
      const y3 = num(coords[ci + 3]);
      ci += 4;
      cmds.push({ cmd: "C", pts: [cx, cy, x2, y2, x3, y3] });
      cx = x3;
      cy = y3;
      started = true;
      onlyRects = false;
    } else if (op === ops.curveTo3) {
      // x1 y1 x2 y2 — the endpoint doubles as the second control.
      const x1 = num(coords[ci]);
      const y1 = num(coords[ci + 1]);
      const x2 = num(coords[ci + 2]);
      const y2 = num(coords[ci + 3]);
      ci += 4;
      cmds.push({ cmd: "C", pts: [x1, y1, x2, y2, x2, y2] });
      cx = x2;
      cy = y2;
      started = true;
      onlyRects = false;
    } else if (op === ops.closePath) {
      cmds.push({ cmd: "Z", pts: [] });
      onlyRects = false;
    } else if (op === ops.rectangle) {
      const x = num(coords[ci]);
      const y = num(coords[ci + 1]);
      const w = num(coords[ci + 2]);
      const h = num(coords[ci + 3]);
      ci += 4;
      pureRects.push({
        x: Math.min(x, x + w),
        y: Math.min(y, y + h),
        w: Math.abs(w),
        h: Math.abs(h),
      });
      // A rectangle subpath (counterclockwise, per the PDF `re` operator).
      cmds.push({ cmd: "M", pts: [x, y] });
      cmds.push({ cmd: "L", pts: [x + w, y] });
      cmds.push({ cmd: "L", pts: [x + w, y + h] });
      cmds.push({ cmd: "L", pts: [x, y + h] });
      cmds.push({ cmd: "Z", pts: [] });
      cx = x;
      cy = y;
      started = true;
    } else {
      return null; // unknown path op — drop the whole path honestly
    }
  }

  if (!started && pureRects.length === 0) return null;
  return {
    cmds,
    rect: pureRects.length === 1 && onlyRects ? pureRects[0] : null,
  };
}

/** Serializes path commands; each point optionally transformed by `m`. */
function pathData(cmds: readonly PathCmd[], m: Mat | null): string {
  const pt = (x: number, y: number): string => {
    const p = m === null ? ([x, y] as [number, number]) : apply(m, x, y);
    return `${fmt(p[0])} ${fmt(p[1])}`;
  };
  let d = "";
  for (const c of cmds) {
    if (c.cmd === "Z") {
      d += "Z";
      continue;
    }
    const step = c.cmd === "C" ? 6 : 2;
    const parts: string[] = [];
    for (let i = 0; i + 1 < c.pts.length; i += step) {
      if (c.cmd === "C") {
        parts.push(
          `${pt(c.pts[i], c.pts[i + 1])} ${pt(c.pts[i + 2], c.pts[i + 3])} ${pt(
            c.pts[i + 4],
            c.pts[i + 5]
          )}`
        );
      } else {
        parts.push(pt(c.pts[i], c.pts[i + 1]));
      }
    }
    if (parts.length > 0) d += `${c.cmd}${parts.join(" ")}`;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Text runs                                                           */
/* ------------------------------------------------------------------ */

interface TextPiece {
  x: number;
  y: number;
  text: string;
}

interface TextElement {
  family: string;
  generic: string;
  bold: boolean;
  italic: boolean;
  size: number;
  fill: string;
  pieces: TextPiece[];
  /** Residual transform when the glyph matrix is not a plain scale. */
  transform: Mat | null;
}

/** glyph.unicode → display string ("" for skipped glyphs). */
function glyphUnicode(glyph: GlyphObject): string {
  if (typeof glyph.unicode !== "string") return "";
  return sanitizeSvgText(glyph.unicode);
}

/**
 * Serializes one <text> element — one per showText run ("group runs into
 * <text> elements"). Kerning numbers inside the glyph array split
 * tspans so explicit x positions stay faithful.
 */
function textToSvg(el: TextElement): string {
  const attrs: string[] = [
    `font-family="${xmlEscape(`${el.family}, ${el.generic}`)}"`,
    `font-size="${fmt(el.size)}"`,
  ];
  if (el.bold) attrs.push('font-weight="bold"');
  if (el.italic) attrs.push('font-style="italic"');
  attrs.push(`fill="${el.fill}"`);
  attrs.push('xml:space="preserve"');
  if (el.transform !== null) {
    attrs.unshift(`transform="matrix(${el.transform.map((v) => fmt(v)).join(" ")})"`);
  }
  const live = el.pieces.filter((p) => p.text.length > 0);
  if (live.length === 0) return "";
  if (live.length === 1 && el.transform === null) {
    return `<text x="${fmt(live[0].x)}" y="${fmt(live[0].y)}" ${attrs.join(" ")}>${xmlEscape(live[0].text)}</text>`;
  }
  const tspans = live
    .map(
      (p) =>
        `<tspan x="${fmt(p.x)}" y="${fmt(p.y)}">${xmlEscape(p.text)}</tspan>`
    )
    .join("");
  return `<text ${attrs.join(" ")}>${tspans}</text>`;
}

/* ------------------------------------------------------------------ */
/* Stroke width helper                                                 */
/* ------------------------------------------------------------------ */

/**
 * Stroke width in viewBox units for baked coordinates — lineWidth scaled
 * by the average axis scale (exact when |a| = |d|; an approximation that
 * matches how the canvas pen distorts under non-uniform scales).
 */
function strokeWidthFor(state: GState, device: Mat): number {
  if (state.lineWidth <= 0) return 0;
  return (state.lineWidth * (Math.abs(device[0]) + Math.abs(device[3]))) / 2;
}

/* ------------------------------------------------------------------ */
/* The walker                                                          */
/* ------------------------------------------------------------------ */

/** The unit-square image matrix: local image box → PDF user space, with
 *  row 0 at user y=1 (pdf.js draws scale(1/w, -1/h) + draw at -h). */
const IMAGE_FLIP: Mat = [1, 0, 0, -1, 0, 1];

/** Guards + runs the async font resolution for one showText op. */
async function showTextRun(
  state: GState,
  ctx: SvgPageContext,
  glyphs: unknown,
  stats: SvgBuildStats,
  out: string[]
): Promise<void> {
  if (!Array.isArray(glyphs)) return;
  if (state.fontSize <= 0) return;
  // Invisible (3) and clip-only (7) text render nothing.
  if (state.renderMode === 3 || state.renderMode === 7) return;

  const font = await ctx.resolveFont(state.fontRef);
  if (font === null) return; // unknown font — skip the run honestly

  // Glyph origin matrix (pdf.js composition):
  // CTM × Tm × translate(penX, penY + rise) × scale(h, -1) × diag(fs).
  const base = mul(
    mul(state.ctm, state.tm),
    [1, 0, 0, 1, state.penX, state.penY + state.rise]
  );
  const device = mul(
    mul(ctx.baseTransform, base),
    [state.fontSize * state.hScale, 0, 0, -state.fontSize, 0, 0]
  );
  if (!finiteMat(device)) return;

  const size = state.fontSize;
  // Residual transform: what is left after the SVG font-size carries the
  // em scale (identity for ordinary horizontal text).
  const residual: Mat = [
    device[0] / size,
    device[1] / size,
    device[2] / size,
    device[3] / size,
    device[4],
    device[5],
  ];
  const plain =
    isAxisAligned(residual) &&
    residual[0] > 0 &&
    residual[3] > 0 &&
    isIdentityish(residual);

  const el: TextElement = {
    family: font.family,
    generic: font.generic,
    bold: font.bold,
    italic: font.italic,
    size,
    fill: state.fill,
    pieces: [],
    transform: plain ? null : residual,
  };

  const advance = (width: number, isSpace: boolean): number =>
    (width * size * font.fontMatrix0 +
      (isSpace ? state.wordSpacing : 0) +
      state.charSpacing) *
    state.hScale;

  let piece: TextPiece | null = null;
  for (const entry of glyphs as SvgGlyph[]) {
    if (typeof entry === "number") {
      // TJ adjustment: the pen moves by -n/1000 × fontSize (pdf.js keeps
      // spacingDir at -1 for horizontal fonts). Breaks the piece.
      piece = null;
      state.penX += (-entry * size) / 1000;
      continue;
    }
    if (entry === null || entry === undefined) continue;
    const glyph = entry as GlyphObject;
    const text = glyphUnicode(glyph);
    const width = num(glyph.width, 0);

    if (piece === null) {
      const originDevice = mul(ctx.baseTransform, base);
      piece = { x: originDevice[4], y: originDevice[5], text: "" };
      el.pieces.push(piece);
    }
    piece.text += text;

    state.penX += advance(width, glyph.isSpace === true);
  }

  const svg = textToSvg(el);
  if (svg.length === 0) return;
  if (stats.texts + stats.rects + stats.paths + stats.images >= MAX_ELEMENTS) {
    stats.truncated = true;
    return;
  }
  out.push(svg);
  stats.texts += 1;
}

/** One embedded image at its device matrix. */
function emitImage(dataUri: string, device: Mat): string {
  return (
    `<image x="0" y="0" width="1" height="1" preserveAspectRatio="none" ` +
    `transform="matrix(${device.map((v) => fmt(v)).join(" ")})" ` +
    `xlink:href="${dataUri}" href="${dataUri}"/>`
  );
}

/** Emits a rect or path for the pending path + paint op combination. */
function paintPath(
  state: GState,
  ctx: SvgPageContext,
  pending: PendingPath | null,
  mode: "fill" | "stroke" | "fillStroke",
  evenOdd: boolean,
  stats: SvgBuildStats,
  out: string[]
): void {
  if (pending === null || pending.cmds.length === 0) return;
  if (stats.texts + stats.rects + stats.paths + stats.images >= MAX_ELEMENTS) {
    stats.truncated = true;
    return;
  }
  const device = mul(ctx.baseTransform, state.ctm);
  if (!finiteMat(device)) return;

  const attrs: string[] = [];
  if (mode !== "stroke") attrs.push(`fill="${state.fill}"`);
  else attrs.push('fill="none"');
  if (mode !== "fill") {
    attrs.push(`stroke="${state.stroke}"`);
    attrs.push(`stroke-width="${fmt(strokeWidthFor(state, device))}"`);
    if (state.dash.length > 0) {
      attrs.push(
        `stroke-dasharray="${state.dash.map((v) => fmt(v)).join(" ")}"`
      );
    }
  }
  if (evenOdd && mode !== "stroke") attrs.push('fill-rule="evenodd"');

  // Pure rectangle fast path — an exact baked <rect> when axis-aligned.
  if (
    pending.rect !== null &&
    isAxisAligned(device) &&
    device[0] !== 0 &&
    device[3] !== 0
  ) {
    const r = pending.rect;
    const corners: [number, number][] = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of corners) {
      const [dx, dy] = apply(device, x, y);
      if (dx < minX) minX = dx;
      if (dy < minY) minY = dy;
      if (dx > maxX) maxX = dx;
      if (dy > maxY) maxY = dy;
    }
    if (![minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) return;
    out.push(
      `<rect x="${fmt(minX)}" y="${fmt(minY)}" width="${fmt(
        maxX - minX
      )}" height="${fmt(maxY - minY)}" ${attrs.join(" ")}/>`
    );
    stats.rects += 1;
    return;
  }

  // General path: bake coordinates when axis-aligned (the readable,
  // smoke-checkable form), else carry the matrix and keep PDF-space data
  // (stroke geometry then distorts exactly like the pdf.js canvas pen).
  if (isAxisAligned(device) && device[0] > 0 && device[3] < 0) {
    out.push(`<path d="${pathData(pending.cmds, device)}" ${attrs.join(" ")}/>`);
    stats.paths += 1;
    return;
  }
  out.push(
    `<path transform="matrix(${device
      .map((v) => fmt(v))
      .join(" ")})" d="${pathData(pending.cmds, null)}" ${attrs.join(" ")}/>`
  );
  stats.paths += 1;
}

/** Inline image payloads live directly in the operator args. */
function rawToPayload(raw: unknown): SvgImagePayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const width = obj.width;
  const height = obj.height;
  if (typeof width !== "number" || typeof height !== "number") return null;
  const data = obj.data;
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    return null;
  }
  return {
    width,
    height,
    kind: typeof obj.kind === "number" ? obj.kind : 0,
    data,
  };
}

/** setGState entries: LW / D / Font (the rest is approximated or ignored). */
function applyGState(state: GState, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const key = entry[0];
    const value = entry[1];
    if (key === "LW") {
      state.lineWidth = Math.max(0, num(value, 1));
    } else if (key === "D" && Array.isArray(value)) {
      const rawDash = Array.isArray(value[0]) ? value[0] : [];
      state.dash = rawDash
        .map((v) => num(v))
        .filter((v) => Number.isFinite(v) && v >= 0);
    } else if (key === "Font" && Array.isArray(value)) {
      state.fontRef = value[0];
      state.fontSize = num(value[1]);
    }
  }
}

/** Builds the full SVG for one page from its operator list. */
export async function buildPageSvg(
  ops: SvgOpsTable,
  list: SvgOperatorList,
  ctx: SvgPageContext
): Promise<SvgBuildResult> {
  const stats: SvgBuildStats = {
    texts: 0,
    rects: 0,
    paths: 0,
    images: 0,
    truncated: false,
  };
  const out: string[] = [];

  let state = freshState();
  const stack: GState[] = [];
  const formStack: Mat[] = [];
  let pending: PendingPath | null = null;

  const fnArray = list.fnArray;
  const argsArray = list.argsArray;

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];

    if (fn === ops.save) {
      stack.push(state);
      state = {
        ...state,
        ctm: [...state.ctm] as Mat,
        tm: [...state.tm] as Mat,
        dash: [...state.dash],
      };
    } else if (fn === ops.restore) {
      const restored = stack.pop();
      if (restored !== undefined) state = restored;
    } else if (fn === ops.transform) {
      const t: Mat = [
        num(args[0], 1),
        num(args[1]),
        num(args[2]),
        num(args[3], 1),
        num(args[4]),
        num(args[5]),
      ];
      state.ctm = mul(state.ctm, t);
    } else if (fn === ops.constructPath) {
      pending = parseConstructPath(ops, args);
    } else if (fn === ops.setFillRGBColor) {
      const hex = colorToHex(args);
      if (hex !== null) state.fill = hex;
    } else if (fn === ops.setStrokeRGBColor) {
      const hex = colorToHex(args);
      if (hex !== null) state.stroke = hex;
    } else if (fn === ops.setLineWidth) {
      state.lineWidth = Math.max(0, num(args[0], 1));
    } else if (fn === ops.setDash) {
      const rawDash = Array.isArray(args[0]) ? args[0] : [];
      state.dash = rawDash
        .map((v) => num(v))
        .filter((v) => Number.isFinite(v) && v >= 0);
    } else if (fn === ops.setGState) {
      applyGState(state, args[0]);
    } else if (fn === ops.beginText) {
      state.tm = IDENTITY_MATRIX;
      state.penX = state.penY = state.lineX = state.lineY = 0;
    } else if (fn === ops.endText) {
      // Text state survives ET (matches pdf.js).
    } else if (fn === ops.setCharSpacing) {
      state.charSpacing = num(args[0]);
    } else if (fn === ops.setWordSpacing) {
      state.wordSpacing = num(args[0]);
    } else if (fn === ops.setHScale) {
      const scale = num(args[0], 100) / 100;
      state.hScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
    } else if (fn === ops.setLeading) {
      state.leading = -num(args[0]);
    } else if (fn === ops.setFont) {
      state.fontRef = args[0];
      state.fontSize = num(args[1]);
    } else if (fn === ops.setTextRenderingMode) {
      state.renderMode = num(args[0]);
    } else if (fn === ops.setTextRise) {
      state.rise = num(args[0]);
    } else if (fn === ops.setTextMatrix) {
      state.tm = [
        num(args[0], 1),
        num(args[1]),
        num(args[2]),
        num(args[3], 1),
        num(args[4]),
        num(args[5]),
      ];
      state.penX = state.penY = state.lineX = state.lineY = 0;
    } else if (fn === ops.moveText) {
      state.penX = state.lineX += num(args[0]);
      state.penY = state.lineY += num(args[1]);
    } else if (fn === ops.setLeadingMoveText) {
      state.leading = -num(args[1]);
      state.penX = state.lineX += num(args[0]);
      state.penY = state.lineY += num(args[1]);
    } else if (fn === ops.nextLine) {
      state.penX = state.lineX;
      state.penY = state.lineY += state.leading;
    } else if (
      fn === ops.showText ||
      fn === ops.showSpacedText ||
      fn === ops.nextLineShowText
    ) {
      if (fn === ops.nextLineShowText) {
        state.penX = state.lineX;
        state.penY = state.lineY += state.leading;
      }
      await showTextRun(state, ctx, args[0], stats, out);
    } else if (fn === ops.nextLineSetSpacingShowText) {
      state.wordSpacing = num(args[0]);
      state.charSpacing = num(args[1]);
      state.penX = state.lineX;
      state.penY = state.lineY += state.leading;
      await showTextRun(state, ctx, args[2], stats, out);
    } else if (
      fn === ops.fill ||
      fn === ops.eoFill ||
      fn === ops.stroke ||
      fn === ops.closeStroke ||
      fn === ops.fillStroke ||
      fn === ops.eoFillStroke ||
      fn === ops.closeFillStroke ||
      fn === ops.closeEOFillStroke
    ) {
      const isStroke =
        fn === ops.stroke ||
        fn === ops.closeStroke ||
        fn === ops.fillStroke ||
        fn === ops.eoFillStroke ||
        fn === ops.closeFillStroke ||
        fn === ops.closeEOFillStroke;
      const isFill =
        fn === ops.fill ||
        fn === ops.eoFill ||
        fn === ops.fillStroke ||
        fn === ops.eoFillStroke ||
        fn === ops.closeFillStroke ||
        fn === ops.closeEOFillStroke;
      paintPath(
        state,
        ctx,
        pending,
        isFill && isStroke ? "fillStroke" : isStroke ? "stroke" : "fill",
        fn === ops.eoFill ||
          fn === ops.eoFillStroke ||
          fn === ops.closeEOFillStroke,
        stats,
        out
      );
      pending = null;
    } else if (fn === ops.endPath || fn === ops.clip || fn === ops.eoClip) {
      // endPath: clip-only or discarded — nothing paints (clipping is
      // approximated away). clip/eoClip keep the path for a FOLLOWING
      // paint op (PDF `W f` semantics), so only endPath consumes it.
      if (fn === ops.endPath) pending = null;
    } else if (fn === ops.paintFormXObjectBegin) {
      formStack.push(state.ctm);
      const matrix = args[0];
      if (Array.isArray(matrix) && matrix.length === 6) {
        state.ctm = mul(
          state.ctm,
          [
            num(matrix[0], 1),
            num(matrix[1]),
            num(matrix[2]),
            num(matrix[3], 1),
            num(matrix[4]),
            num(matrix[5]),
          ] as Mat
        );
      }
    } else if (fn === ops.paintFormXObjectEnd) {
      const restored = formStack.pop();
      if (restored !== undefined) state.ctm = restored;
    } else if (fn === ops.shadingFill) {
      // Gradient fills — honestly omitted (the FAQ documents this).
    } else if (fn === ops.paintImageXObject) {
      if (ctx.includeImages) {
        const payload = await ctx.resolveImage(args[0]);
        const dataUri =
          payload === null ? null : await imageToDataUri(payload);
        if (dataUri !== null) {
          if (stats.texts + stats.rects + stats.paths + stats.images < MAX_ELEMENTS) {
            out.push(
              emitImage(dataUri, mul(mul(ctx.baseTransform, state.ctm), IMAGE_FLIP))
            );
            stats.images += 1;
          } else {
            stats.truncated = true;
          }
        }
      }
    } else if (fn === ops.paintImageXObjectRepeat) {
      if (ctx.includeImages) {
        const payload = await ctx.resolveImage(args[0]);
        const dataUri =
          payload === null ? null : await imageToDataUri(payload);
        if (dataUri !== null) {
          const sx = num(args[1], 1);
          const sy = num(args[2], 1);
          const positions = Array.isArray(args[3]) ? args[3] : [];
          for (let p = 0; p + 1 < positions.length; p += 2) {
            if (
              stats.texts + stats.rects + stats.paths + stats.images >=
              MAX_ELEMENTS
            ) {
              stats.truncated = true;
              break;
            }
            const m = mul(
              mul(ctx.baseTransform, state.ctm),
              mul(
                [sx, 0, 0, sy, num(positions[p]), num(positions[p + 1])],
                IMAGE_FLIP
              )
            );
            out.push(emitImage(dataUri, m));
            stats.images += 1;
          }
        }
      }
    } else if (
      fn === ops.paintInlineImageXObject ||
      fn === ops.paintInlineImageXObjectGroup
    ) {
      if (ctx.includeImages) {
        const payload = rawToPayload(args[0]);
        const dataUri =
          payload === null ? null : await imageToDataUri(payload);
        if (dataUri !== null) {
          if (stats.texts + stats.rects + stats.paths + stats.images < MAX_ELEMENTS) {
            out.push(
              emitImage(
                dataUri,
                mul(mul(ctx.baseTransform, state.ctm), IMAGE_FLIP)
              )
            );
            stats.images += 1;
          } else {
            stats.truncated = true;
          }
        }
      }
    }
    // Everything else (dependency, marked content, masks, …) is skipped.
  }

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${fmt(ctx.width)}pt" height="${fmt(ctx.height)}pt" ` +
    `viewBox="0 0 ${fmt(ctx.width)} ${fmt(ctx.height)}" version="1.1">\n` +
    `<rect x="0" y="0" width="${fmt(ctx.width)}" height="${fmt(
      ctx.height
    )}" fill="#ffffff"/>\n` +
    `${out.join("\n")}\n` +
    `</svg>\n`;
  return { svg, stats };
}

/* ------------------------------------------------------------------ */
/* Worker-boundary helpers (shared with the smoke)                     */
/* ------------------------------------------------------------------ */

export interface PdfToSvgRunOptions {
  pages: string;
  includeImages: boolean;
}

/** Coerces the raw options payload (pages spec + images switch). */
export function parseSvgOptions(
  options: OptionValues | Record<string, unknown>
): PdfToSvgRunOptions {
  const pages =
    typeof options.pages === "string" && options.pages.trim().length > 0
      ? options.pages
      : "all";
  return {
    pages,
    includeImages: options.includeImages !== false,
  };
}

/** Shared download-name sanitizer (pdf-to-images rule). */
export function sanitizeSvgBase(fileName: string): string {
  return (
    fileName
      .replace(/\.pdf$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 120) || "document"
  );
}

/**
 * One output name: `base.svg` when a single page is exported, else
 * `base_page<N>.svg` (the pdf-to-images multi-page convention).
 */
export function svgOutputName(
  base: string,
  pageNumber: number,
  single: boolean
): string {
  return single ? `${base}.svg` : `${base}_page${pageNumber}.svg`;
}

/**
 * Map a thrown pdf.js error message to the i18n key the shell toast
 * shows (same families as extract-images / pdf-to-images).
 */
export function classifySvgError(message: string): string {
  if (/password/i.test(message)) return "tool.errorEncrypted";
  if (/canvas/i.test(message)) return "tool.errorGeneric";
  return "tool.errorCorrupt";
}
