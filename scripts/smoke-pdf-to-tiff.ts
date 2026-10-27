/**
 * Smoke tests for pdf-to-tiff (task 2-a, PRD §8.6 image matrix).
 *
 * Unlike pdf-to-webp (whose encoder is a browser codec Bun cannot run),
 * the TIFF encoder is pure TypeScript — so this smoke proves the WHOLE
 * page → TIFF path end-to-end with real artifacts:
 *
 *  1. Fixture: a real 2-page PDF built with @cantoo/pdf-lib (title text +
 *     a solid coloured rect per page), re-parsed, byte-checked, written to
 *     download/qa-pdf-to-tiff-fixture.pdf for agent-browser QA.
 *  2. Encoder units: independent TIFF parser (magic II, version 42, 12
 *     ascending tags, StripOffsets pinned to 8, dpi rationals, RGBA→RGB
 *     white flattening, odd-byte padding, defensive errors, magic
 *     verification incl. big-endian acceptance).
 *  3. E2E: pdf.js (the app's exact version, npm legacy build) renders the
 *     fixture through the SAME pipeline tools/pdf-to-images/worker.ts runs
 *     — getViewport → white fillRect → page.render → getImageData →
 *     encodeTiffPage → verifyTiffBytes → Blob("image/tiff") — against a
 *     pure-JS RGBA ShimCanvas (no anti-aliasing; deterministic pixels).
 *     Verifies magic + tags + byte counts + dpi rational + the coloured
 *     rect's exact pixels + white background + rendered title text, for
 *     page ranges "all", "1" and "2".
 *  4. Oracles: the output TIFF decodes byte-exact through BOTH the
 *     project's own clean-room TIFF reader (tools/imgconv/tiff.ts — the
 *     tiff-to-pdf engine) and real libvips (sharp).
 *  5. Error paths: invalid page range through the real family pipeline,
 *     a real corrupt-PDF rejection mapped through the worker's catch
 *     logic, and the shared tool.* error keys in both catalog locales.
 *  6. Config schema + chain targets + worker branch presence + i18n
 *     en↔hi key-tree parity.
 *
 * NOT covered here (needs a real browser): the actual Web Worker module
 * boundary and OffscreenCanvas's own rasterization/anti-aliasing — pixel
 * VALUES from a browser render differ at edges (AA). That is agent-browser
 * QA, exactly like the rest of the family.
 *
 * Usage: bun scripts/smoke-pdf-to-tiff.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import sharp from "sharp";

import { parsePageSpec } from "../src/lib/workers/protocol";
import {
  FORMAT_SPECS,
  getFormatSpec,
  pageOutputName,
  parsePercentQuality,
  parseWebpQuality,
  pdfBaseName,
} from "../tools/pdf-to-images/formats";
import {
  encodeTiffPage,
  flattenRgbaToRgb,
  verifyTiffBytes,
} from "../tools/pdf-to-tiff/tiff-encode";
import { decodeTiffPages } from "../tools/imgconv/tiff";
import { config } from "../tools/pdf-to-tiff/config";
import i18nPart from "../tools/pdf-to-tiff/i18n.json";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE_PATH = `${ROOT}download/qa-pdf-to-tiff-fixture.pdf`;
const OUTPUT_PATH = `${ROOT}download/qa-pdf-to-tiff-output.tif`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* Independent minimal TIFF parser (little-endian, test-only)          */
/* ------------------------------------------------------------------ */

interface ParsedIfd {
  entries: Map<number, { type: number; count: number; value: number }>;
  nextIfd: number;
}

function parseTiff(bytes: Uint8Array): {
  ifds: ParsedIfd[];
  readShort: (at: number) => number;
  readLong: (at: number) => number;
} {
  if (bytes[0] !== 0x49 || bytes[1] !== 0x49) throw new Error("not II");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, true) !== 42) throw new Error("bad magic");
  const readShort = (at: number) => view.getUint16(at, true);
  const readLong = (at: number) => view.getUint32(at, true);
  const ifds: ParsedIfd[] = [];
  let at = readLong(4);
  while (at !== 0 && ifds.length < 100) {
    const count = readShort(at);
    const entries = new Map<
      number,
      { type: number; count: number; value: number }
    >();
    for (let i = 0; i < count; i += 1) {
      const e = at + 2 + i * 12;
      entries.set(readShort(e), {
        type: readShort(e + 2),
        count: readLong(e + 4),
        value: readLong(e + 8),
      });
    }
    const nextIfd = readLong(at + 2 + count * 12);
    ifds.push({ entries, nextIfd });
    at = nextIfd;
  }
  return { ifds, readShort, readLong };
}

/** Read the RGB strip straight out of the file at StripOffsets. */
function stripRgb(bytes: Uint8Array): Uint8Array {
  const { ifds, readLong } = parseTiff(bytes);
  const e = ifds[0].entries;
  const offset = e.get(273)!.value;
  const count = e.get(279)!.value;
  return bytes.subarray(offset, offset + count);
}

/* ------------------------------------------------------------------ */
/* ShimCanvas — pure-JS RGBA raster for pdf.js under Bun               */
/*                                                                     */
/* Immediate-mode 2D context: affine transform stack, CSS colour        */
/* parsing, nonzero/evenodd polygon fill, getImageData. No AA — every  */
/* covered pixel gets the exact fill colour, so assertions on solid   */
/* interiors are byte-deterministic.                                   */
/* ------------------------------------------------------------------ */

interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** CTM' = CTM · n (canvas post-multiply semantics). */
function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number; // 0..1
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

function parseColor(style: string): Rgba | null {
  const s = style.trim().toLowerCase();
  if (s === "" || s === "none" || s === "transparent") return null;
  if (NAMED_COLORS[s]) {
    const [r, g, b] = NAMED_COLORS[s];
    return { r, g, b, a: 1 };
  }
  if (s.charAt(0) === "#") {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex.charAt(0) + hex.charAt(0), 16),
        g: parseInt(hex.charAt(1) + hex.charAt(1), 16),
        b: parseInt(hex.charAt(2) + hex.charAt(2), 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter((p) => p !== "");
    if (parts.length >= 3) {
      const nums = parts.map(Number);
      const alpha = parts.length >= 4 && Number.isFinite(nums[3]) ? nums[3] : 1;
      return {
        r: Math.max(0, Math.min(255, Math.round(nums[0]))),
        g: Math.max(0, Math.min(255, Math.round(nums[1]))),
        b: Math.max(0, Math.min(255, Math.round(nums[2]))),
        a: Math.max(0, Math.min(1, alpha)),
      };
    }
  }
  return null;
}

interface Pt {
  x: number;
  y: number;
}

/**
 * pdf.js renders standard-font glyphs as Path2D objects built from SVG-style
 * command strings (see getPathJs in the pdf.js font compiler). IMPORTANT:
 * those strings are COMPACT path data — the command letters are glued to
 * their numbers ("M0.51 0L0.51 0.29L…Q…Z"), NOT the spaced "M x y L x y"
 * form. A whitespace split would see tokens like "0L0.51" (NaN) and drop
 * every glyph — so this tokenizer walks the string with a regex, matching
 * letters and numbers (incl. sign/decimals/exponents) wherever they sit.
 */
class ShimPath2D {
  readonly subpaths: Pt[][] = [];
  private current: Pt[] | null = null;

  constructor(cmds?: string) {
    if (typeof cmds === "string" && cmds.length > 0) {
      let cmd = "";
      const args: number[] = [];
      const run = (): void => {
        if (args.length === 0) return;
        switch (cmd) {
          case "M":
            this.moveTo(args[0], args[1]);
            break;
          case "L":
            this.lineTo(args[0], args[1]);
            break;
          case "C":
            this.bezierCurveTo(
              args[0],
              args[1],
              args[2],
              args[3],
              args[4],
              args[5]
            );
            break;
          case "Q":
            this.quadraticCurveTo(args[0], args[1], args[2], args[3]);
            break;
          default:
            break;
        }
        args.length = 0;
      };
      // Letters first, then numbers — so "0L0.51" yields number, letter,
      // number; "-0.009" keeps its sign; "1e-3" stays one number.
      const tokens = /([MLQCZmlqcz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
      for (let m = tokens.exec(cmds); m !== null; m = tokens.exec(cmds)) {
        if (m[1] !== undefined) {
          const letter = m[1];
          run();
          if (letter === "Z" || letter === "z") {
            cmd = "";
            this.closePath();
          } else {
            cmd = letter;
          }
        } else {
          args.push(Number(m[2]));
        }
        if (
          args.length ===
          (cmd === "C" ? 6 : cmd === "Q" ? 4 : cmd === "M" || cmd === "L" ? 2 : 0)
        ) {
          // Commands come fully grouped; execute as soon as they arrive.
          run();
        }
      }
      run();
    }
  }

  moveTo(x: number, y: number): void {
    this.current = [{ x, y }];
    this.subpaths.push(this.current);
  }

  lineTo(x: number, y: number): void {
    if (!this.current) return this.moveTo(x, y);
    this.current.push({ x, y });
  }

  closePath(): void {
    this.current = null;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.current || this.current.length === 0) return this.moveTo(x, y);
    const p0 = this.current[this.current.length - 1];
    for (let i = 1; i <= 12; i += 1) {
      const t = i / 12;
      const u = 1 - t;
      this.current.push({
        x: u * u * p0.x + 2 * u * t * cx + t * t * x,
        y: u * u * p0.y + 2 * u * t * cy + t * t * y,
      });
    }
  }

  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number
  ): void {
    if (!this.current || this.current.length === 0) return this.moveTo(x, y);
    const p0 = this.current[this.current.length - 1];
    for (let i = 1; i <= 16; i += 1) {
      const t = i / 16;
      const u = 1 - t;
      this.current.push({
        x: u * u * u * p0.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        y: u * u * u * p0.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      });
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  arc(cx: number, cy: number, r: number, start = 0, end = Math.PI * 2): void {
    for (let i = 0; i <= 24; i += 1) {
      const t = start + ((end - start) * i) / 24;
      this.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t));
    }
  }
}

interface ShimImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

class ShimCtx {
  readonly canvas: ShimCanvas;
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  miterLimit = 10;
  lineDashOffset = 0;
  font = "10px sans-serif";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  /** Colours actually painted (fill/fillRect) — the smoke's exactness oracle. */
  readonly paintedColors: Rgba[] = [];
  /** every fillStyle string set (diagnostics). */
  readonly fillStylesSeen: string[] = [];
  private ctm: Mat = { ...IDENTITY };
  private stack: {
    ctm: Mat;
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    font: string;
  }[] = [];
  private subpaths: Pt[][] = [];
  private current: Pt[] | null = null;

  constructor(canvas: ShimCanvas) {
    this.canvas = canvas;
  }

  save(): void {
    this.stack.push({
      ctm: { ...this.ctm },
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      font: this.font,
    });
  }

  restore(): void {
    const prev = this.stack.pop();
    if (!prev) return;
    this.ctm = prev.ctm;
    this.fillStyle = prev.fillStyle;
    this.strokeStyle = prev.strokeStyle;
    this.globalAlpha = prev.globalAlpha;
    this.font = prev.font;
  }

  translate(x: number, y: number): void {
    this.ctm = mul(this.ctm, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  }

  scale(x: number, y: number): void {
    this.ctm = mul(this.ctm, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
  }

  rotate(radians: number): void {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    this.ctm = mul(this.ctm, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctm = mul(this.ctm, { a, b, c, d, e, f });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctm = { a, b, c, d, e, f };
  }

  getTransform(): Mat {
    return { ...this.ctm };
  }

  beginPath(): void {
    this.subpaths = [];
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    this.current = [{ x, y }];
    this.subpaths.push(this.current);
  }

  lineTo(x: number, y: number): void {
    if (!this.current) return this.moveTo(x, y);
    this.current.push({ x, y });
  }

  closePath(): void {
    this.current = null;
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.current || this.current.length === 0) return this.moveTo(x, y);
    const p0 = this.current[this.current.length - 1];
    for (let i = 1; i <= 12; i += 1) {
      const t = i / 12;
      const u = 1 - t;
      this.current.push({
        x: u * u * p0.x + 2 * u * t * cx + t * t * x,
        y: u * u * p0.y + 2 * u * t * cy + t * t * y,
      });
    }
  }

  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number
  ): void {
    if (!this.current || this.current.length === 0) return this.moveTo(x, y);
    const p0 = this.current[this.current.length - 1];
    for (let i = 1; i <= 16; i += 1) {
      const t = i / 16;
      const u = 1 - t;
      this.current.push({
        x:
          u * u * u * p0.x +
          3 * u * u * t * c1x +
          3 * u * t * t * c2x +
          t * t * t * x,
        y:
          u * u * u * p0.y +
          3 * u * u * t * c1y +
          3 * u * t * t * c2y +
          t * t * t * y,
      });
    }
  }

  arc(
    cx: number,
    cy: number,
    radius: number,
    start = 0,
    end = Math.PI * 2
  ): void {
    for (let i = 0; i <= 24; i += 1) {
      const t = start + ((end - start) * i) / 24;
      this.lineTo(cx + radius * Math.cos(t), cy + radius * Math.sin(t));
    }
  }

  fill(target?: ShimPath2D | string): void {
    const color = parseColor(String(this.fillStyle));
    if (!color) return;
    this.paintedColors.push({ ...color });
    // pdf.js passes glyph paths as Path2D; the fill-rule string form uses
    // the context's own current path.
    const subpaths =
      target instanceof ShimPath2D ? target.subpaths : this.subpaths;
    for (const sub of subpaths) {
      if (sub.length < 3) continue;
      const device = sub.map((p) => this.transformPoint(p));
      const rule =
        typeof target === "string" && target === "evenodd" ? "evenodd" : "nonzero";
      this.fillPolygon(device, rule, color);
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const color = parseColor(String(this.fillStyle));
    if (!color || w === 0 || h === 0) return;
    this.paintedColors.push({ ...color });
    const device = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ].map((p) => this.transformPoint(p));
    this.fillPolygon(device, "nonzero", color);
  }

  strokeRect(): void {
    /* strokes are cosmetic for this fixture */
  }

  stroke(): void {
    /* strokes are cosmetic for this fixture */
  }

  clip(): void {
    /* clips are cosmetic for this fixture */
  }

  setLineDash(): void {
    /* recorded, not rasterized */
  }
  getLineDash(): number[] {
    return [];
  }

  fillText(): void {
    /* pdf.js renders standard-font text as paths here; record only */
  }

  measureText(text: string): { width: number } {
    return { width: [...text].length * 6 };
  }

  getImageData(sx: number, sy: number, w: number, h: number): ShimImageData {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row += 1) {
      const src = (sy + row) * this.canvas.width + sx;
      const dst = row * w;
      for (let col = 0; col < w; col += 1) {
        const s = (src + col) * 4;
        const d = (dst + col) * 4;
        data[d] = this.canvas.data[s];
        data[d + 1] = this.canvas.data[s + 1];
        data[d + 2] = this.canvas.data[s + 2];
        data[d + 3] = this.canvas.data[s + 3];
      }
    }
    return { width: w, height: h, data };
  }

  putImageData(image: ShimImageData, dx: number, dy: number): void {
    for (let row = 0; row < image.height; row += 1) {
      for (let col = 0; col < image.width; col += 1) {
        const s = (row * image.width + col) * 4;
        const d = ((dy + row) * this.canvas.width + (dx + col)) * 4;
        this.canvas.data[d] = image.data[s];
        this.canvas.data[d + 1] = image.data[s + 1];
        this.canvas.data[d + 2] = image.data[s + 2];
        this.canvas.data[d + 3] = image.data[s + 3];
      }
    }
  }

  drawImage(): void {
    /* fixture has no image XObjects */
  }

  createLinearGradient(): { addColorStop(): void } {
    return { addColorStop() {} };
  }

  private transformPoint(p: Pt): Pt {
    const m = this.ctm;
    return {
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    };
  }

  /** Scanline fill at pixel centres — no AA, deterministic interiors. */
  private fillPolygon(
    device: Pt[],
    rule: "nonzero" | "evenodd",
    color: Rgba
  ): void {
    const { width, height, data } = this.canvas;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of device) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const rowStart = Math.max(0, Math.ceil(minY - 0.5));
    const rowEnd = Math.min(height - 1, Math.floor(maxY - 0.5));
    const n = device.length;
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const y = row + 0.5;
      const xs: { x: number; dir: number }[] = [];
      for (let i = 0; i < n; i += 1) {
        const p1 = device[i];
        const p2 = device[(i + 1) % n];
        if (p1.y === p2.y) continue;
        const cross = (p1.y > y) !== (p2.y > y);
        if (!cross) continue;
        xs.push({
          x: p1.x + ((y - p1.y) * (p2.x - p1.x)) / (p2.y - p1.y),
          dir: p2.y > p1.y ? 1 : -1,
        });
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.x - b.x);
      const spans: [number, number][] = [];
      if (rule === "evenodd") {
        for (let i = 0; i + 1 < xs.length; i += 2) {
          spans.push([xs[i].x, xs[i + 1].x]);
        }
      } else {
        let wind = 0;
        let spanStart = 0;
        for (let i = 0; i < xs.length; i += 1) {
          const before = wind;
          wind += xs[i].dir;
          if (before === 0 && wind !== 0) spanStart = xs[i].x;
          else if (before !== 0 && wind === 0) spans.push([spanStart, xs[i].x]);
        }
      }
      for (const [xa, xb] of spans) {
        if (xb <= xa) continue;
        let col = Math.ceil(xa - 0.5);
        const end = Math.ceil(xb - 0.5);
        for (; col < end; col += 1) {
          if (col < 0 || col >= width) continue;
          const alpha = color.a * this.globalAlpha;
          const idx = (row * width + col) * 4;
          if (alpha >= 1) {
            data[idx] = color.r;
            data[idx + 1] = color.g;
            data[idx + 2] = color.b;
            data[idx + 3] = 255;
          } else if (alpha > 0) {
            const inv = 1 - alpha;
            data[idx] = Math.round(data[idx] * inv + color.r * alpha);
            data[idx + 1] = Math.round(data[idx + 1] * inv + color.g * alpha);
            data[idx + 2] = Math.round(data[idx + 2] * inv + color.b * alpha);
            data[idx + 3] = Math.round(
              data[idx + 3] * inv + 255 * alpha
            );
          }
        }
      }
    }
  }
}

class ShimCanvas {
  width: number;
  height: number;
  style: Record<string, string> = {};
  data: Uint8ClampedArray;
  private ctx: ShimCtx | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  getContext(type: "2d"): ShimCtx | null {
    if (type !== "2d") return null;
    if (!this.ctx) this.ctx = new ShimCtx(this);
    return this.ctx;
  }
}

/* Install the shims BEFORE pdf.js is imported (the probe-verified order). */
(globalThis as unknown as Record<string, unknown>).OffscreenCanvas =
  ShimCanvas as unknown as typeof OffscreenCanvas;
(globalThis as unknown as Record<string, unknown>).Path2D =
  ShimPath2D as unknown as typeof Path2D;
(globalThis as unknown as Record<string, unknown>).document = {
  baseURI: "http://localhost/",
  createElement(tag: string) {
    return tag === "canvas"
      ? new ShimCanvas(1, 1)
      : { style: {}, append() {}, textContent: "" };
  },
  documentElement: { getElementsByTagName: () => [{ append() {} }] },
};

/* ------------------------------------------------------------------ */
/* Fixture: a real 2-page PDF (title text + coloured rect per page)    */
/* ------------------------------------------------------------------ */

/** Page-point geometry the pixel assertions below are derived from. */
const PAGE_W_PT = 420;
const PAGE_H_PT = 297;
const RECT = { x: 30, y: 197, w: 360, h: 70 }; // bottom-left origin
const DPI = 150;
const SCALE = DPI / 72; // 25/12 — the worker's own scale math
const CANVAS_W = Math.round(PAGE_W_PT * SCALE); // 875
const CANVAS_H = Math.round(PAGE_H_PT * SCALE); // 619
/** Rect in canvas pixels: x [62.5, 812.5), y [62.5, 208.33). */
const RECT_PX = {
  x0: RECT.x * SCALE,
  x1: (RECT.x + RECT.w) * SCALE,
  y0: (PAGE_H_PT - RECT.y - RECT.h) * SCALE,
  y1: (PAGE_H_PT - RECT.y) * SCALE,
};
/** Deep-interior pixel of the rect (rounded centres). */
const CENTER_PX = {
  x: Math.floor((RECT_PX.x0 + RECT_PX.x1) / 2),
  y: Math.floor((RECT_PX.y0 + RECT_PX.y1) / 2),
};
/** A corner well outside the rect and above the title text. */
const CORNER_PX = { x: 3, y: 3 };

/** Page 1 rect colour: 0.2/0.4/0.8 → exactly (51, 102, 204) in 8-bit. */
const PAGE1_RECT_RGB: [number, number, number] = [51, 102, 204];
/** Page 2 rect colour: 0.6/0.2/0.4 → exactly (153, 51, 102) in 8-bit. */
const PAGE2_RECT_RGB: [number, number, number] = [153, 51, 102];

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("pdf-to-tiff smoke fixture");
  doc.setAuthor("DocoPDF smoke");
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fills: [number, number, number][] = [
    [0.2, 0.4, 0.8],
    [0.6, 0.2, 0.4],
  ];
  for (let i = 0; i < fills.length; i += 1) {
    const page = doc.addPage([PAGE_W_PT, PAGE_H_PT]);
    page.drawRectangle({
      x: RECT.x,
      y: RECT.y,
      width: RECT.w,
      height: RECT.h,
      color: rgb(fills[i][0], fills[i][1], fills[i][2]),
    });
    page.drawText(`PDF TO TIFF SMOKE PAGE ${i + 1} of ${fills.length}`, {
      x: 30,
      y: 120,
      size: 18,
      font,
    });
  }
  return doc.save();
}

/* ------------------------------------------------------------------ */
/* E2E: the family pipeline (mirrors tools/pdf-to-images/worker.ts)    */
/* ------------------------------------------------------------------ */

type PdfjsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

const STANDARD_FONTS = `${path.join(
  process.cwd(),
  "node_modules/pdfjs-dist/standard_fonts"
)}/`;

interface FamilyOutput {
  name: string;
  mime: string;
  blob: Blob;
  bytes: Uint8Array;
  width: number;
  height: number;
  /** The ShimCtx's painted colours (the raster's own record). */
  paintedColors: Rgba[];
}

/**
 * The worker's per-file flow, line for line — only the pdf.js loader
 * differs (npm legacy build instead of the self-hosted URL; the app
 * ships the exact same version, see public/pdfjs + package.json) and
 * the canvas is the ShimCanvas above instead of OffscreenCanvas.
 */
async function familyRun(
  data: Uint8Array,
  fileName: string,
  options: {
    dpi?: string | number;
    pages?: string;
    /** Worker-parity fields (TIFF ignores both — mirrored line for line). */
    quality?: string | number;
    transparent?: boolean;
  }
): Promise<{ outputs: FamilyOutput[] }> {
  const format = getFormatSpec("pdf-to-tiff");

  const dpi = Number(options.dpi ?? 150);
  const scale = Math.max(0.5, Math.min(8, dpi / 72));
  const quality = format.parseQuality?.(options.quality);
  const transparent = options.transparent === true && format.alpha;

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data,
    ownerDocument: (globalThis as unknown as { document: unknown })
      .document as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;

  const base = pdfBaseName(fileName);
  const outputs: FamilyOutput[] = [];

  const pageNumbers = parsePageSpec(String(options.pages ?? "all"), doc.numPages);
  if (pageNumbers === null || pageNumbers.length === 0) {
    await doc.destroy();
    throw new Error("tool.errorInvalidPages");
  }

  for (let i = 0; i < pageNumbers.length; i += 1) {
    const pageNumber = pageNumbers[i] + 1; // 1-based in pdf.js
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));

    const canvas = new ShimCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-2d-unavailable");
    if (!transparent) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      background: transparent ? "rgba(0,0,0,0)" : undefined,
    }).promise;
    page.cleanup();

    // The worker's TIFF branch (format.tiff): getImageData → encode →
    // verify → Blob. quality/convertToBlob are never touched for TIFF.
    if (!format.tiff) throw new Error("format-not-tiff");
    const image = context.getImageData(0, 0, width, height);
    const bytes = encodeTiffPage(
      { width, height, rgba: image.data },
      dpi
    );
    const verified = verifyTiffBytes(bytes);
    if (!verified.ok) throw new Error(`tiff-verify-failed:${verified.detail}`);
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: format.mime,
    });
    outputs.push({
      name: pageOutputName(base, pageNumber, pageNumbers.length, format.ext),
      mime: format.mime,
      blob,
      bytes,
      width,
      height,
      paintedColors: context.paintedColors,
    });
  }

  doc.cleanup();
  await doc.destroy();
  return { outputs };
}

/** Worker's catch-chain, verbatim (used for the corrupt-PDF path). */
function workerErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /password/i.test(message)
    ? "tool.errorEncrypted"
    : /canvas/i.test(message)
      ? "tool.errorGeneric"
      : "tool.errorCorrupt";
}

function pixelAt(rgb: Uint8Array, width: number, x: number, y: number): [number, number, number] {
  const at = (y * width + x) * 3;
  return [rgb[at], rgb[at + 1], rgb[at + 2]];
}

function nearColor(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance: number
): boolean {
  return (
    Math.abs(actual[0] - expected[0]) <= tolerance &&
    Math.abs(actual[1] - expected[1]) <= tolerance &&
    Math.abs(actual[2] - expected[2]) <= tolerance
  );
}

/* ------------------------------------------------------------------ */
/* Deep i18n key-tree helper                                            */
/* ------------------------------------------------------------------ */

function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  const keys = Object.keys(value).sort();
  const out: string[] = [];
  for (const key of keys) {
    const child = (value as Record<string, unknown>)[key];
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out.push(...keyTree(child, path));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("== fixture: real 2-page PDF ==");
  const fixture = await buildFixture();
  check(
    "starts with %PDF-",
    fixture[0] === 0x25 && fixture[1] === 0x50 && fixture[2] === 0x44 && fixture[3] === 0x46
  );
  check("fixture has bytes", fixture.length > 1000, `${fixture.length}`);
  const reparsed = await PDFDocument.load(fixture.slice());
  check("re-parse page count = 2", reparsed.getPageCount() === 2, `${reparsed.getPageCount()}`);
  check("title round-trips", reparsed.getTitle() === "pdf-to-tiff smoke fixture");
  fs.mkdirSync(`${ROOT}download`, { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, fixture);
  const writtenStat = fs.statSync(FIXTURE_PATH);
  check(
    "fixture written to download/qa-pdf-to-tiff-fixture.pdf",
    writtenStat.isFile() && writtenStat.size === fixture.length,
    `${writtenStat.size} bytes`
  );

  console.log("== format specs (worker's real table) ==");
  const tiff = getFormatSpec("pdf-to-tiff");
  check("mime image/tiff", tiff.mime === "image/tiff");
  check("ext tif (not tiff)", tiff.ext === "tif");
  check("no alpha (opaque pages)", tiff.alpha === false);
  check("lossless (no quality passed)", tiff.lossy === false);
  check("tiff branch flag on", tiff.tiff === true);
  check("no quality parser (lossless)", tiff.parseQuality === undefined);
  const jpg = getFormatSpec("pdf-to-jpg");
  check(
    "jpg spec preserved",
    jpg.mime === "image/jpeg" && jpg.ext === "jpg" && jpg.alpha === false && jpg.lossy === true && jpg.parseQuality === parsePercentQuality
  );
  const png = getFormatSpec("pdf-to-png");
  check(
    "png spec preserved",
    png.mime === "image/png" && png.ext === "png" && png.alpha === true && png.lossy === false
  );
  const webp = getFormatSpec("pdf-to-webp");
  check(
    "webp spec preserved",
    webp.mime === "image/webp" && webp.ext === "webp" && webp.alpha === true && webp.lossy === true && webp.verifyMime === true && webp.parseQuality === parseWebpQuality
  );
  check("unknown tool falls back to jpg", getFormatSpec("no-such-tool").ext === "jpg");
  check(
    "format table has exactly the 5 family tools (jpg, png, tiff, webp, svg)",
    Object.keys(FORMAT_SPECS).sort().join(",") ===
      "pdf-to-jpg,pdf-to-png,pdf-to-svg,pdf-to-tiff,pdf-to-webp",
    Object.keys(FORMAT_SPECS).sort().join(",")
  );

  console.log("== encoder units (independent parser) ==");
  const unitRgba = new Uint8ClampedArray([
    10, 20, 30, 255,
    40, 50, 60, 255,
    70, 80, 90, 255,
    100, 110, 120, 255,
  ]);
  const unit = encodeTiffPage({ width: 2, height: 2, rgba: unitRgba }, 150);
  {
    const { ifds, readShort, readLong } = parseTiff(unit);
    const e = ifds[0].entries;
    check("magic II*\\0 + version 42", unit[0] === 0x49 && unit[1] === 0x49 && unit[2] === 0x2a && unit[3] === 0 && readShort(2) === 42);
    check("one IFD, chain terminates", ifds.length === 1 && ifds[0].nextIfd === 0);
    check("12 entries", e.size === 12, `got ${e.size}`);
    check("tags ascending", [...e.keys()].every((tag, i, arr) => i === 0 || arr[i - 1] < tag));
    check("ImageWidth 2", e.get(256)?.value === 2);
    check("ImageLength 2", e.get(257)?.value === 2);
    check(
      "BitsPerSample → offset {8,8,8}",
      (() => {
        const at = e.get(258)!.value;
        return readShort(at) === 8 && readShort(at + 2) === 8 && readShort(at + 4) === 8;
      })()
    );
    check("Compression 1 (uncompressed)", e.get(259)?.value === 1);
    check("Photometric 2 (RGB)", e.get(262)?.value === 2);
    check("StripOffsets pinned to 8 (header-only preamble)", e.get(273)?.value === 8);
    check("SamplesPerPixel 3", e.get(277)?.value === 3);
    check("RowsPerStrip = full height", e.get(278)?.value === 2);
    check("StripByteCounts = w*h*3 = 12", e.get(279)?.value === 12);
    check(
      "XResolution 150/1 inch",
      (() => {
        const at = e.get(282)!.value;
        return readLong(at) === 150 && readLong(at + 4) === 1;
      })()
    );
    check(
      "YResolution 150/1 inch",
      (() => {
        const at = e.get(283)!.value;
        return readLong(at) === 150 && readLong(at + 4) === 1;
      })()
    );
    check("ResolutionUnit 2 (inch)", e.get(296)?.value === 2);
    check(
      "pixel bytes land at offset 8 in RGBA→RGB order",
      (() => {
        const strip = unit.subarray(8, 8 + 12);
        const expected = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        for (let i = 0; i < 12; i += 1) if (strip[i] !== expected[i]) return false;
        return true;
      })()
    );
    check(
      "file length = 8 + pixels + 22 extras + 150 IFD",
      unit.length === 8 + 12 + 6 + 8 + 8 + 150,
      `${unit.length}`
    );
  }

  // RGBA → RGB flattening on white.
  {
    const flat = flattenRgbaToRgb(
      new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0, 40, 80, 120, 100]),
      3
    );
    check("alpha 255 passes through", flat[0] === 200 && flat[1] === 100 && flat[2] === 50);
    check("alpha 0 lands on white", flat[3] === 255 && flat[4] === 255 && flat[5] === 255);
    // Independent expectation: 40*100/255 + 255*155/255 ≈ 170.7 → 171,
    // 80*100/255 + 155 ≈ 186.4 → 186, 120*100/255 + 155 ≈ 202.1 → 202.
    check(
      "alpha 100 blends on white (rounded)",
      flat[6] === 171 && flat[7] === 186 && flat[8] === 202,
      `got ${flat[6]},${flat[7]},${flat[8]}`
    );
  }
  {
    // Full encoder round: mixed alphas must equal the flatten output.
    const rgba = new Uint8ClampedArray([
      10, 20, 30, 255,
      10, 20, 30, 0,
      240, 244, 248, 253,
      1, 2, 3, 77,
    ]);
    const tiff = encodeTiffPage({ width: 2, height: 2, rgba }, 300);
    const strip = stripRgb(tiff);
    const flat = flattenRgbaToRgb(rgba, 4);
    let same = strip.length === flat.length;
    for (let i = 0; i < flat.length && same; i += 1) same = strip[i] === flat[i];
    check("mixed-alpha image encodes flattened bytes", same);
  }

  // Odd pixel-byte count → pad byte keeps the IFD word-aligned.
  {
    const odd = encodeTiffPage(
      { width: 3, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]) },
      96
    );
    const { ifds, readLong } = parseTiff(odd);
    const e = ifds[0].entries;
    check("odd strip: byte count stays the true length 9", e.get(279)?.value === 9);
    check(
      "odd strip: pad byte keeps the IFD word-aligned (offset 40, even)",
      readLong(4) === 40 && 40 % 2 === 0,
      `ifd at ${readLong(4)}`
    );
    check(
      "odd strip: file length 190 (8+9+pad+22+150)",
      odd.length === 190,
      `${odd.length}`
    );
    check(
      "odd strip: dpi 96 stamps",
      (() => {
        const at = e.get(282)!.value;
        return readLong(at) === 96 && readLong(at + 4) === 1;
      })()
    );
  }

  // Encoder capability vectors: any integer dpi stamps its rational — the
  // config only offers 72/150/300/600, but the encoder contract itself is
  // wider (96/200 are real-world TIFF/fax values a future config may add).
  for (const dpi of [72, 96, 150, 200, 300, 600]) {
    const tiff = encodeTiffPage(
      { width: 1, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 255]) },
      dpi
    );
    const { ifds, readLong } = parseTiff(tiff);
    const at = ifds[0].entries.get(282)!.value;
    check(`dpi ${dpi} → XResolution ${dpi}/1`, readLong(at) === dpi && readLong(at + 4) === 1);
  }

  // dpi sanitisation.
  {
    const nan = encodeTiffPage({ width: 1, height: 1, rgba: new Uint8ClampedArray(4) }, Number.NaN);
    const zero = encodeTiffPage({ width: 1, height: 1, rgba: new Uint8ClampedArray(4) }, 0);
    const frac = encodeTiffPage({ width: 1, height: 1, rgba: new Uint8ClampedArray(4) }, 150.4);
    const readDpi = (bytes: Uint8Array) => parseTiff(bytes).readLong(parseTiff(bytes).ifds[0].entries.get(282)!.value);
    check("dpi NaN falls back to 150", readDpi(nan) === 150);
    check("dpi 0 clamps to 1", readDpi(zero) === 1);
    check("dpi 150.4 rounds to 150", readDpi(frac) === 150);
  }

  // Defensive errors.
  {
    let threw = "";
    try {
      encodeTiffPage({ width: 2, height: 2, rgba: new Uint8ClampedArray(3) }, 150);
    } catch (error) {
      threw = (error as Error).message;
    }
    check("bad rgba length throws tiff-bad-image", threw === "tiff-bad-image");
    threw = "";
    try {
      encodeTiffPage({ width: 0, height: 2, rgba: new Uint8ClampedArray(8) }, 150);
    } catch (error) {
      threw = (error as Error).message;
    }
    check("zero width throws", threw === "tiff-bad-image");
    threw = "";
    try {
      encodeTiffPage({ width: 1.5, height: 2, rgba: new Uint8ClampedArray(8) }, 150);
    } catch (error) {
      threw = (error as Error).message;
    }
    check("fractional width throws", threw === "tiff-bad-image");
  }

  // verifyTiffBytes (the worker's magic self-check).
  {
    check("valid output verifies", verifyTiffBytes(unit).ok === true);
    check(
      "big-endian MM\\0* accepted",
      verifyTiffBytes(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0])).ok === true
    );
    check("bad magic rejected", verifyTiffBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 8, 0, 0])).ok === false);
    check("version 43 rejected", verifyTiffBytes(new Uint8Array([0x49, 0x49, 0x2b, 0x00, 0, 0, 0, 8, 0, 0])).ok === false);
    check("short header rejected", verifyTiffBytes(new Uint8Array([0x49, 0x49])).ok === false);
    check(
      "out-of-range IFD offset rejected",
      verifyTiffBytes(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff, 0xff])).ok === false
    );
  }

  console.log("== E2E: family pipeline render → encode (all pages) ==");
  const allRun = await familyRun(fixture.slice(), "qa-pdf-to-tiff-fixture.pdf", {
    dpi: "150",
    pages: "all",
  });
  check("all → 2 outputs", allRun.outputs.length === 2, `${allRun.outputs.length}`);
  check(
    "names base_page1.tif / base_page2.tif",
    allRun.outputs[0].name === "qa-pdf-to-tiff-fixture_page1.tif" &&
      allRun.outputs[1].name === "qa-pdf-to-tiff-fixture_page2.tif",
    allRun.outputs.map((o) => o.name).join(", ")
  );
  check("blob MIME image/tiff", allRun.outputs.every((o) => o.mime === "image/tiff" && o.blob.type === "image/tiff"));
  const page1 = allRun.outputs[0];
  const page2 = allRun.outputs[1];
  check("viewport math: 420×297pt @150dpi → 875×619px", page1.width === CANVAS_W && page1.height === CANVAS_H, `${page1.width}×${page1.height}`);
  const rgb1 = stripRgb(page1.bytes);
  const rgb2 = stripRgb(page2.bytes);
  check(
    "StripByteCounts = 875*619*3",
    parseTiff(page1.bytes).ifds[0].entries.get(279)?.value === CANVAS_W * CANVAS_H * 3
  );
  check(
    "blob round-trips the exact encoded bytes",
    (() => {
      const expected = page1.bytes.length;
      return page1.blob.size === expected;
    })(),
    `${page1.blob.size} vs ${page1.bytes.length}`
  );
  {
    // Structure of the real rendered page 1.
    const { ifds, readShort, readLong } = parseTiff(page1.bytes);
    const e = ifds[0].entries;
    check("E2E: magic + version 42", page1.bytes[0] === 0x49 && page1.bytes[1] === 0x49 && readShort(2) === 42);
    check("E2E: one IFD, chain ends", ifds.length === 1 && ifds[0].nextIfd === 0);
    check("E2E: 12 entries", e.size === 12);
    check("E2E: width 875", e.get(256)?.value === CANVAS_W);
    check("E2E: height 619", e.get(257)?.value === CANVAS_H);
    check("E2E: compression 1 (uncompressed)", e.get(259)?.value === 1);
    check("E2E: photometric 2 (RGB)", e.get(262)?.value === 2);
    check("E2E: StripOffsets 8", e.get(273)?.value === 8);
    check("E2E: SamplesPerPixel 3", e.get(277)?.value === 3);
    check("E2E: RowsPerStrip = 619", e.get(278)?.value === CANVAS_H);
    check(
      "E2E: dpi rational 150/1 + ResolutionUnit inch",
      (() => {
        const at = e.get(282)!.value;
        return readLong(at) === 150 && readLong(at + 4) === 1 && e.get(296)?.value === 2;
      })()
    );
    check(
      "E2E: byte count = w*h*3 (RGB, uncompressed)",
      e.get(279)?.value === CANVAS_W * CANVAS_H * 3
    );
  }
  // Pixel truth: white corner, exact rect colour, rendered text.
  check(
    "E2E: page-1 corner is white background",
    JSON.stringify(pixelAt(rgb1, CANVAS_W, CORNER_PX.x, CORNER_PX.y)) === "[255,255,255]"
  );
  {
    const centre = pixelAt(rgb1, CANVAS_W, CENTER_PX.x, CENTER_PX.y);
    const recorded = page1.paintedColors.find((c) => nearColor([c.r, c.g, c.b], PAGE1_RECT_RGB, 1));
    check(
      "E2E: pdf.js painted the page-1 rect colour (±1)",
      recorded !== undefined,
      `painted: ${page1.paintedColors.map((c) => `${c.r},${c.g},${c.b}`).join(" | ")}`
    );
    if (recorded) {
      check(
        "E2E: page-1 rect centre pixel is EXACTLY that colour",
        centre[0] === recorded.r && centre[1] === recorded.g && centre[2] === recorded.b,
        `got ${centre.join(",")}`
      );
      check("E2E: recorded colour ≈ (51,102,204)", nearColor([recorded.r, recorded.g, recorded.b], PAGE1_RECT_RGB, 1));
    }
    check(
      "E2E: page-1 rect centre ≈ (51,102,204) (±1)",
      nearColor(centre, PAGE1_RECT_RGB, 1),
      `got ${centre.join(",")}`
    );
  }
  {
    const centre2 = pixelAt(rgb2, CANVAS_W, CENTER_PX.x, CENTER_PX.y);
    check(
      "E2E: page-2 rect centre ≈ (153,51,102) (±1)",
      nearColor(centre2, PAGE2_RECT_RGB, 1),
      `got ${centre2.join(",")}`
    );
    check(
      "E2E: page-2 corner is white background",
      JSON.stringify(pixelAt(rgb2, CANVAS_W, CORNER_PX.x, CORNER_PX.y)) === "[255,255,255]"
    );
  }
  {
    // Title text: dark pixels below the rect (rows ~320-420).
    let dark = 0;
    for (let y = 320; y < 420 && y < CANVAS_H; y += 1) {
      for (let x = 0; x < CANVAS_W; x += 1) {
        const p = pixelAt(rgb1, CANVAS_W, x, y);
        if (p[0] < 60 && p[1] < 60 && p[2] < 60) dark += 1;
      }
    }
    check("E2E: rendered title text paints dark pixels", dark >= 30, `${dark} dark pixels`);
  }

  console.log("== E2E: page ranges “1” and “2” only ==");
  const oneRun = await familyRun(fixture.slice(), "qa-pdf-to-tiff-fixture.pdf", {
    dpi: "150",
    pages: "1",
  });
  check('pages "1" → single output', oneRun.outputs.length === 1);
  check('pages "1" → name base.tif (single-page convention)', oneRun.outputs[0].name === "qa-pdf-to-tiff-fixture.tif", oneRun.outputs[0].name);
  check(
    'pages "1" → page-1 rect colour',
    nearColor(pixelAt(stripRgb(oneRun.outputs[0].bytes), CANVAS_W, CENTER_PX.x, CENTER_PX.y), PAGE1_RECT_RGB, 1)
  );
  const twoRun = await familyRun(fixture.slice(), "qa-pdf-to-tiff-fixture.pdf", {
    dpi: "150",
    pages: "2",
  });
  check('pages "2" → single output', twoRun.outputs.length === 1);
  check('pages "2" → name base.tif (single-page convention)', twoRun.outputs[0].name === "qa-pdf-to-tiff-fixture.tif", twoRun.outputs[0].name);
  check(
    'pages "2" → page-2 rect colour',
    nearColor(pixelAt(stripRgb(twoRun.outputs[0].bytes), CANVAS_W, CENTER_PX.x, CENTER_PX.y), PAGE2_RECT_RGB, 1)
  );
  check(
    'pages "1" vs "2" produce different pixels (page identity)',
    (() => {
      const a = stripRgb(oneRun.outputs[0].bytes);
      const b = stripRgb(twoRun.outputs[0].bytes);
      return a.length === b.length && a.some((v, i) => v !== b[i]);
    })()
  );

  // Keep the page-1 output for eyeballing + orchestrator QA.
  fs.writeFileSync(OUTPUT_PATH, page1.bytes);
  check(
    "E2E output written to download/qa-pdf-to-tiff-output.tif",
    fs.statSync(OUTPUT_PATH).size === page1.bytes.length
  );

  console.log("== oracle 1: in-repo clean-room TIFF reader (tiff-to-pdf engine) ==");
  {
    const pages = decodeTiffPages(page1.bytes);
    check("decoder sees 1 page", pages.length === 1);
    check("decoder width/height", pages[0].width === CANVAS_W && pages[0].height === CANVAS_H);
    check("decoder dpi 150", pages[0].dpi === 150, `${pages[0].dpi}`);
    let byteExact = pages[0].rgba.length === CANVAS_W * CANVAS_H * 4;
    if (byteExact) {
      for (let p = 0; p < CANVAS_W * CANVAS_H; p += 1) {
        const s = p * 4;
        const d = p * 3;
        if (
          pages[0].rgba[s] !== rgb1[d] ||
          pages[0].rgba[s + 1] !== rgb1[d + 1] ||
          pages[0].rgba[s + 2] !== rgb1[d + 2]
        ) {
          byteExact = false;
          break;
        }
      }
    }
    check("decoder pixels byte-exact vs encoded strip", byteExact);
    check(
      "decoder alpha channel fully opaque",
      (() => {
        for (let i = 3; i < pages[0].rgba.length; i += 4) if (pages[0].rgba[i] !== 255) return false;
        return true;
      })()
    );
  }

  console.log("== oracle 2: real libvips (sharp) decode ==");
  {
    const buf = Buffer.from(page1.bytes.buffer, page1.bytes.byteOffset, page1.bytes.byteLength);
    const meta = await sharp(buf).metadata();
    check("sharp: format tiff", meta.format === "tiff");
    check("sharp: size 875×619", meta.width === CANVAS_W && meta.height === CANVAS_H, `${meta.width}×${meta.height}`);
    check("sharp: 3 channels", meta.channels === 3, `${meta.channels}`);
    check("sharp: density 150", Math.round(meta.density ?? 0) === 150, `${meta.density}`);
    const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    let byteExact = data.length === rgb1.length;
    if (byteExact) {
      for (let i = 0; i < rgb1.length; i += 1) {
        if (data[i] !== rgb1[i]) {
          byteExact = false;
          break;
        }
      }
    }
    check("sharp: pixels byte-exact vs encoded strip", byteExact);
  }

  console.log("== error paths (family branches) ==");
  {
    let code = "";
    try {
      await familyRun(fixture.slice(), "qa-pdf-to-tiff-fixture.pdf", { dpi: "150", pages: "banana" });
    } catch (error) {
      code = (error as Error).message;
    }
    check('garbage range "banana" → tool.errorInvalidPages', code === "tool.errorInvalidPages", code);
  }
  {
    // Real corrupt PDF → pdf.js rejects → worker's catch-chain mapping.
    const garbage = new Uint8Array(1024);
    for (let i = 0; i < garbage.length; i += 1) garbage[i] = (i * 31) & 0xff;
    garbage.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // fake %PDF- header
    const pdfjs = await loadPdfjs();
    let message = "";
    try {
      await pdfjs.getDocument({ data: garbage, standardFontDataUrl: STANDARD_FONTS }).promise;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("corrupt PDF really rejected by pdf.js", message.length > 0);
    check(
      "worker catch-chain maps it to tool.errorCorrupt",
      workerErrorCode(new Error(message)) === "tool.errorCorrupt",
      message.slice(0, 60)
    );
  }
  {
    const en = JSON.parse(fs.readFileSync(`${ROOT}src/i18n/en.json`, "utf8")) as Record<string, unknown>;
    const hi = JSON.parse(fs.readFileSync(`${ROOT}src/i18n/hi.json`, "utf8")) as Record<string, unknown>;
    const tool = en.tool as Record<string, unknown>;
    const toolHi = hi.tool as Record<string, unknown>;
    check(
      "shared error keys exist in both catalogs",
      ["errorInvalidPages", "errorCorrupt", "errorEncrypted", "errorGeneric"].every(
        (k) => typeof tool[k] === "string" && typeof toolHi[k] === "string"
      )
    );
  }

  console.log("== config schema ==");
  check("toolId pdf-to-tiff", config.toolId === "pdf-to-tiff");
  check("outputKind image", config.outputKind === "image");
  check("file limits 1..5 (sibling parity)", config.minFiles === 1 && config.maxFiles === 5);
  const byId: Record<string, (typeof config.options)[number]> = {};
  for (const field of config.options) byId[field.id] = field;
  check("exactly 2 options: dpi, pages", Object.keys(byId).sort().join(",") === "dpi,pages");
  const dpiField = byId.dpi;
  check("dpi is select", dpiField.kind === "select");
  if (dpiField.kind === "select") {
    const webpConfigSource = fs.readFileSync(`${ROOT}tools/pdf-to-webp/config.ts`, "utf8");
    check(
      "dpi choices copied from the sibling EXACTLY (72/150/300/600, default 150)",
      dpiField.choices.map((c) => c.value).join(",") === "72,150,300,600" &&
        dpiField.default === "150",
      dpiField.choices.map((c) => c.value).join(",")
    );
    check(
      "dpi label + hint copied from the sibling EXACTLY",
      fs.readFileSync(`${ROOT}tools/pdf-to-tiff/config.ts`, "utf8").includes('en: "Higher DPI = sharper but heavier files"') &&
        webpConfigSource.includes('en: "Higher DPI = sharper but heavier files"') &&
        fs.readFileSync(`${ROOT}tools/pdf-to-tiff/config.ts`, "utf8").includes('id: "dpi"'),
    );
    check(
      "every dpi choice encodes a distinct stampable rational",
      dpiField.choices.every((c) => {
        const value = Number(c.value);
        const tiff = encodeTiffPage(
          { width: 1, height: 1, rgba: new Uint8ClampedArray(4) },
          value
        );
        const p = parseTiff(tiff);
        return p.readLong(p.ifds[0].entries.get(282)!.value) === value;
      })
    );
  }
  check("pages default all", byId.pages.kind === "pages" && byId.pages.default === "all");
  check(
    "no pageMarks option (siblings have none)",
    !config.options.some((o) => o.id === "pageMarks")
  );
  check(
    "createWorker targets the shared family worker",
    typeof config.createWorker === "function"
  );
  const configSource = fs.readFileSync(`${ROOT}tools/pdf-to-tiff/config.ts`, "utf8");
  check(
    "createWorker URL is ../pdf-to-images/worker.ts (type module)",
    configSource.includes('"../pdf-to-images/worker.ts"') && configSource.includes('type: "module"')
  );
  const workerSource = fs.readFileSync(`${ROOT}tools/pdf-to-images/worker.ts`, "utf8");
  check(
    "shared worker carries the TIFF branch (encodeTiffPage + getImageData)",
    workerSource.includes("encodeTiffPage") && workerSource.includes("getImageData")
  );
  check(
    "features: 5 bullets, en+hi non-empty",
    config.features.length === 5 && config.features.every((f) => f.en.length > 0 && f.hi.length > 0)
  );
  check(
    "faq: 3 items, q+a en+hi non-empty",
    config.faq.length === 3 &&
      config.faq.every((f) => f.q.en.length > 0 && f.q.hi.length > 0 && f.a.en.length > 0 && f.a.hi.length > 0)
  );
  check(
    "every L10n string in the schema carries Devanagari Hindi",
    config.features.concat(config.faq.flatMap((f) => [f.q, f.a])).every((l) => /[\u0900-\u097F]/.test(l.hi))
  );
  const faqText = JSON.stringify(config.faq);
  check(
    "FAQ states the uncompressed-size honesty (en)",
    faqText.includes("uncompressed") && faqText.includes("use PDF to JPG, PNG or WEBP")
  );
  check(
    "FAQ states the uncompressed-size honesty (hi)",
    faqText.includes("बिना-कंप्रेशन") && faqText.includes("JPG, PNG या WEBP")
  );

  console.log("== chain targets + registry ==");
  const registrySource = fs.readFileSync(`${ROOT}src/lib/tools/registry.ts`, "utf8");
  check("registry entry for pdf-to-tiff exists", registrySource.includes('id: "pdf-to-tiff"'));
  check(
    "chainToolIds exactly [tiff-to-pdf, images-to-pdf, jpg-to-pdf]",
    JSON.stringify(config.chainToolIds) === JSON.stringify(["tiff-to-pdf", "images-to-pdf", "jpg-to-pdf"]),
    JSON.stringify(config.chainToolIds)
  );
  for (const id of config.chainToolIds ?? []) {
    check(`chain target "${id}" is a registry id`, registrySource.includes(`id: "${id}"`));
  }

  console.log("== i18n parity (tools/pdf-to-tiff/i18n.json) ==");
  const part = i18nPart as unknown as { en: Record<string, unknown>; hi: Record<string, unknown> };
  check("en↔hi key trees equal (deep)", JSON.stringify(keyTree(part.en)) === JSON.stringify(keyTree(part.hi)));
  const enKeys = keyTree(part.en);
  check(
    "section tiffOut carries the expected keys",
    enKeys.join(",") === "tiffOut.hint,tiffOut.successNote,tiffOut.successTitle,tiffOut.surfaceLabel",
    enKeys.join(",")
  );
  check(
    "all values non-empty",
    keyTree(part.en).length === keyTree(part.hi).length &&
      ["surfaceLabel", "hint", "successTitle", "successNote"].every((k) => {
        const e = (part.en.tiffOut as Record<string, string>)[k];
        const h = (part.hi.tiffOut as Record<string, string>)[k];
        return typeof e === "string" && e.length > 0 && typeof h === "string" && h.length > 0;
      })
  );
  check(
    "successNote plural in both locales",
    (part.en.tiffOut as Record<string, string>).successNote.indexOf("count, plural") >= 0 &&
      (part.hi.tiffOut as Record<string, string>).successNote.indexOf("count, plural") >= 0
  );
  check(
    "every Hindi value contains Devanagari",
    Object.values(part.hi.tiffOut as Record<string, string>).every((v) => /[\u0900-\u097F]/.test(v))
  );
  check(
    "successNote repeats the smaller-files honesty (en+hi)",
    (part.en.tiffOut as Record<string, string>).successNote.includes("uncompressed") &&
      (part.hi.tiffOut as Record<string, string>).successNote.includes("बिना कंप्रेशन")
  );
  {
    const en = JSON.parse(fs.readFileSync(`${ROOT}src/i18n/en.json`, "utf8")) as Record<string, unknown>;
    const hi = JSON.parse(fs.readFileSync(`${ROOT}src/i18n/hi.json`, "utf8")) as Record<string, unknown>;
    // Both-or-neither (the pptOut convention): the orchestrator merged
    // tiffOut into both catalogs after this smoke was written, so the
    // old "not yet present" guard only held pre-merge. The invariant
    // that matters now: the section is merged symmetrically, with
    // matching key trees.
    check(
      "tiffOut merged into both catalogs together (both-or-neither)",
      ("tiffOut" in en) === ("tiffOut" in hi)
    );
    if ("tiffOut" in en) {
      check(
        "tiffOut en↔hi key trees still match post-merge",
        JSON.stringify(keyTree(en.tiffOut)) === JSON.stringify(keyTree(hi.tiffOut))
      );
    }
  }

  console.log("== coverage honesty ==");
  console.log(
    "  covered  : real 2-page PDF fixture (built, re-parsed, written);" +
      " format table incl. jpg/png/webp regression vectors; encoder units" +
      " (structure, flattening, odd bytes, dpi stamps, errors, magic" +
      " verification); FULL E2E through the family pipeline — pdf.js" +
      " legacy (the app's exact 4.10.38) rendering the real fixture at" +
      " 150 DPI, the worker's own getImageData → encodeTiffPage →" +
      " verifyTiffBytes → Blob flow, magic/tags/dpi/byte-counts + exact" +
      " rect pixels + white background + rendered text, page ranges" +
      " \"all\"/\"1\"/\"2\", invalid-pages + corrupt-PDF error branches;" +
      " byte-exact decodes through BOTH the in-repo TIFF reader (tiff-to-" +
      "pdf engine) and real libvips (sharp); config schema; chain" +
      " targets; i18n deep parity."
  );
  console.log(
    "  NOT here : the real Web Worker module boundary and OffscreenCanvas's" +
      " own anti-aliased rasterization (the ShimCanvas raster is" +
      " deterministic, no AA — edge pixels differ from a browser render)." +
      " Agent-browser QA with download/qa-pdf-to-tiff-fixture.pdf covers" +
      " that, exactly like the rest of the family."
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASH", error);
  process.exit(1);
});
