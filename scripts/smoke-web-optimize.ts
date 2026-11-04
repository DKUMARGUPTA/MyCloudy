/**
 * PRE-BUILD smoke test for the Web Optimize PDF tool (task 2-c).
 *
 * Proves the tool's own core end-to-end with REAL artifacts (the pinned
 * md2pdf/tiff/word lesson — run the worker's own code, not a re-implementation):
 *
 *  1. Pure units: resolveWebOptimizeOptions (defaults, garbage, clamps),
 *     clampedRenderScale (DPI→scale, the 40MP cap math — smoke-rasterize
 *     parity), webOutputName (sanitize/extension vectors).
 *  2. Fixture: a REAL 3-page PDF built with pdf-lib — a few hundred
 *     uniquely-coloured vector rects per page (high-entropy operands that
 *     Flate cannot squeeze) + a title. The colours are quantization-safe
 *     (sub-visible epsilons): every operand string is unique, but the
 *     rendered pixels collapse to ~20 flat colours — so rasterizing at
 *     72 DPI / quality 0.5 MUST shrink the file hard.
 *  3. E2E through the worker's own runWebOptimize with pdf.js (the npm
 *     legacy build, the app's exact 4.10.38) rendering onto a pure-JS
 *     RGBA ShimCanvas (the smoke-pdf-to-tiff recipe: no AA, deterministic
 *     pixels) and JPEG-encoding via sharp (the smoke-passport-photo
 *     convertToBlob/createImageBitmap shims). Verifies: %PDF + %%EOF,
 *     page count + EXACT point sizes (viewport at scale 1), one DCTDecode
 *     XObject per page with the right pixel dims, full-bleed cm, no fonts,
 *     no AcroForm, MyCloudy producer/creator, original metadata dropped,
 *     output bytes < input bytes, savedPct math, progress events, and
 *     pixel truth (decoded JPEG mean == canvas mean, white corner,
 *     rendered title text).
 *  4. DPI/quality trade-offs: 96 default, 150 sharper (bigger), 0.5 vs
 *     0.85 at the same raster (0.5 strictly smaller).
 *  5. Multi-file: two inputs → two independent outputs (core level).
 *  6. Error paths: render failure → webOptimize.errorRender, encrypted
 *     (@cantoo AES-256) → tool.errorEncrypted, garbage → tool.errorCorrupt.
 *  7. Config schema + howKeys + chain target, i18n deep parity (en↔hi),
 *     shared tool.* error keys in BOTH catalogs, registry entry present
 *     (read-only — enabled is the orchestrator's flip).
 *
 * Run: bun scripts/smoke-web-optimize.ts   (fast, exits 0 on green)
 */
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";

import type { OptionValues } from "../src/lib/tools/config-types";
import {
  clampedRenderScale,
  MAX_WEB_PIXELS,
  resolveWebOptimizeOptions,
  runWebOptimize,
  webOutputName,
  WebOptimizeRunError,
  type OpenWebDoc,
  type WebOptDocLike,
} from "../tools/web-optimize-pdf/worker";
import { config } from "../tools/web-optimize-pdf/config";
import i18n from "../tools/web-optimize-pdf/i18n.json";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE_PATH = `${ROOT}download/smoke-web-optimize-fixture.pdf`;
const OUTPUT_PATH = `${ROOT}download/smoke-web-optimize-output.pdf`;

let pass = 0;
let fail = 0;
let checkNo = 0;

function check(ok: boolean, label: string, detail = ""): void {
  checkNo += 1;
  if (ok) {
    pass += 1;
    console.log(`${checkNo}. PASS ${label}`);
  } else {
    fail += 1;
    console.error(`${checkNo}. FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(
    a === b,
    label,
    a === b ? "" : `expected ${b}, got ${a}`
  );
}

function near(actual: number, expected: number, label: string): void {
  check(
    Math.abs(actual - expected) < 1e-9,
    label,
    `expected ${expected}, got ${actual}`
  );
}

/* ------------------------------------------------------------------ */
/* ShimCanvas — pure-JS RGBA raster for pdf.js under Bun               */
/*                                                                     */
/* Immediate-mode 2D context: affine transform stack, CSS colour       */
/* parsing, nonzero/evenodd polygon fill, getImageData. No AA — every   */
/* covered pixel gets the exact fill colour, so assertions on solid    */
/* interiors are byte-deterministic. (Verbatim recipe from             */
/* scripts/smoke-pdf-to-tiff.ts, the probe-verified pdf.js 4.10 path.) */
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
 * (The concurrent smoke-pdf-to-tiff.ts hit + fixed this exact bug — copied
 * verbatim.)
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

/** Page-sized canvases the core created (1×1 pdf.js temps are skipped). */
const pageCanvases: ShimCanvas[] = [];

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
    if (width >= 100 && height >= 100) pageCanvases.push(this);
  }

  getContext(type: "2d"): ShimCtx | null {
    if (type !== "2d") return null;
    if (!this.ctx) this.ctx = new ShimCtx(this);
    return this.ctx;
  }

  /**
   * The browser's OffscreenCanvas JPEG encode, sharp-backed (the
   * smoke-passport-photo recipe). Deterministic — the same RGBA always
   * encodes to the same bytes, so committedJpegBlob's double-conversion
   * settles immediately.
   */
  async convertToBlob(options: {
    type: string;
    quality?: number;
  }): Promise<Blob> {
    const raw = Buffer.from(
      this.data.buffer,
      this.data.byteOffset,
      this.data.byteLength
    );
    const pipeline = sharp(raw, {
      raw: { width: this.width, height: this.height, channels: 4 },
    });
    const bytes =
      options.type === "image/png"
        ? await pipeline.png().toBuffer()
        : await pipeline
            .jpeg({ quality: Math.round((options.quality ?? 0.92) * 100) })
            .toBuffer();
    return new Blob([new Uint8Array(bytes)], { type: options.type });
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
(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
  async (source: Blob): Promise<{ width: number; height: number; close(): void }> => {
    const bytes = Buffer.from(await source.arrayBuffer());
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    void data;
    return { width: info.width, height: info.height, close() {} };
  };

/* ------------------------------------------------------------------ */
/* pdf.js opener (npm legacy build — the smoke's openDoc injection)     */
/* ------------------------------------------------------------------ */

const STANDARD_FONTS = `${path.join(
  process.cwd(),
  "node_modules/pdfjs-dist/standard_fonts"
)}/`;

const openDocs: Array<{ destroy: () => Promise<void> }> = [];

const openDoc: OpenWebDoc = async (data) => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data: data.slice(),
    ownerDocument: (globalThis as unknown as { document: unknown })
      .document as unknown as HTMLDocument,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: 0,
  }).promise;
  openDocs.push(doc);
  return doc;
};

/* ------------------------------------------------------------------ */
/* Fixture: real 3-page PDF, hundreds of unique-colour vector rects     */
/* ------------------------------------------------------------------ */

const PAGE_W = 420;
const PAGE_H = 297;
const PAGES = 3;
const RECTS_PER_PAGE = 600;

function fixtureRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * The fixture's size-vs-raster design:
 *  - Every rect's colour operands are UNIQUE (sub-visible epsilons), so
 *    the content stream stays high-entropy and Flate cannot squeeze it.
 *  - Base colours depend on the rect's centre cell (5×4 grid): all rects
 *    sharing a cell paint the SAME visible colour, so the raster is ~20
 *    large flat blocks — a JPEG at 72 DPI / quality 0.5 compresses hard.
 *  - Colour components are multiples of 0.05 → ×255 lands on .25/.75
 *    sub-pixel positions, far from rounding boundaries, so the epsilons
 *    (≤ ~1.6e-5, ≈0.004 in 8-bit) never change a rendered byte.
 */
async function buildWebFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Web optimize smoke fixture");
  doc.setAuthor("MyCloudy smoke");
  doc.setSubject("rasterize-heavy vector fixture");
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < PAGES; p += 1) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const rand = fixtureRandom(0x5eed01 + p * 7919);
    for (let i = 0; i < RECTS_PER_PAGE; i += 1) {
      const x = 16 + rand() * 360;
      const y = 16 + rand() * 240;
      const w = Math.min(18 + rand() * 46, 404 - x);
      const h = Math.min(12 + rand() * 34, 281 - y);
      if (w <= 1 || h <= 1) continue;
      const cellX = Math.min(4, Math.floor(((x + w / 2) / PAGE_W) * 5));
      const cellY = Math.min(3, Math.floor(((y + h / 2) / PAGE_H) * 4));
      const rBase = 0.05 + 0.1 * cellX;
      const gBase = 0.45 + 0.1 * cellY;
      const bBase = 0.15 + 0.05 * ((cellX + cellY) % 3);
      page.drawRectangle({
        x,
        y,
        width: w,
        height: h,
        color: rgb(
          rBase + (i % 4) * 3e-6,
          gBase + ((i * 3) % 7) * 2e-6,
          bBase + ((i * 5) % 11) * 1.5e-6
        ),
      });
    }
    // Title LAST → drawn on top of the mosaic, always visible.
    page.drawText(`WEB OPTIMIZE SMOKE PAGE ${p + 1} OF ${PAGES}`, {
      x: 16,
      y: 276,
      size: 12,
      font,
    });
  }
  return doc.save();
}

/** A tiny second fixture (1 page, plain) for the multi-file proof. */
async function buildSmallFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({
    x: 20,
    y: 20,
    width: 380,
    height: 250,
    color: rgb(0.2, 0.4, 0.6),
  });
  return doc.save();
}

/* ------------------------------------------------------------------ */
/* Output PDF inspection helpers (the smoke-rasterize recipe)           */
/* ------------------------------------------------------------------ */

interface PageContent {
  keyCount: number;
  filter: string | null;
  width: number | null;
  height: number | null;
  payload: Uint8Array | null;
  hasFont: boolean;
  annots: number;
  fullBleed: boolean;
}

function contentText(raw: unknown): string {
  // /Contents may be a single stream ref or an array of refs — both
  // concatenate (PDF 32000-1 §7.7.3.3). Streams are Flate-compressed.
  if (raw instanceof PDFArray) {
    let text = "";
    for (let i = 0; i < raw.size(); i += 1) {
      text += contentText(raw.lookup(i));
    }
    return text;
  }
  if (raw instanceof PDFRawStream) {
    return new TextDecoder().decode(decodePDFRawStream(raw).decode());
  }
  return "";
}

function inspectPage(
  doc: PDFDocument,
  pageIndex: number,
  size: { width: number; height: number }
): PageContent {
  const page = doc.getPages()[pageIndex];
  const text = contentText(page.node.Contents());
  const w = Number(size.width.toFixed(2));
  const h = Number(size.height.toFixed(2));
  const fullBleed =
    text.includes("1 0 0 1 0 0 cm") &&
    (text.includes(`${size.width} 0 0 ${size.height} 0 0 cm`) ||
      text.includes(`${w} 0 0 ${h} 0 0 cm`));
  const annots = page.node.Annots();
  const resources = page.node.Resources();
  const fontDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  // pdf-lib writes an EMPTY /Font <<>> in Resources — zero entries means
  // no fonts (the rasterize smoke's empty-/Annots precedent).
  const hasFont = fontDict !== undefined && fontDict.keys().length > 0;
  const xObjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (xObjects === undefined) {
    return {
      keyCount: 0,
      filter: null,
      width: null,
      height: null,
      payload: null,
      hasFont,
      annots: annots?.size() ?? 0,
      fullBleed,
    };
  }
  const keys = xObjects.keys();
  const out: PageContent = {
    keyCount: keys.length,
    filter: null,
    width: null,
    height: null,
    payload: null,
    hasFont,
    annots: annots?.size() ?? 0,
    fullBleed,
  };
  if (keys.length === 1) {
    const image = doc.context.lookup(xObjects.get(keys[0]));
    if (image instanceof PDFRawStream) {
      const wNum = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber);
      const hNum = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber);
      out.width = wNum === undefined ? null : wNum.asNumber();
      out.height = hNum === undefined ? null : hNum.asNumber();
      const filter = image.dict.lookupMaybe(PDFName.of("Filter"), PDFName);
      out.filter = filter === undefined ? null : filter.asString();
      out.payload = image.contents;
    }
  }
  return out;
}

/** Mean RGB (0-255) of an RGBA canvas — the raster's own record. */
function canvasMean(canvas: ShimCanvas): [number, number, number] {
  const { data } = canvas;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = canvas.width * canvas.height;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [r / pixels, g / pixels, b / pixels];
}

/** Mean RGB of a decoded JPEG (3-channel raw) + pixel sampler. */
async function jpegStats(payload: Uint8Array): Promise<{
  mean: [number, number, number];
  width: number;
  height: number;
  format: string;
  darkIn: (rows: [number, number]) => number;
  pixelAt: (x: number, y: number) => [number, number, number];
}> {
  const buf = Buffer.from(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  );
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf)
    .raw()
    .toBuffer({ resolveWithObject: true });
  void info;
  const channels = meta.channels ?? 3;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = meta.width! * meta.height!;
  for (let i = 0; i < data.length; i += channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return {
    mean: [r / pixels, g / pixels, b / pixels],
    width: meta.width!,
    height: meta.height!,
    format: meta.format ?? "",
    darkIn: (rows: [number, number]) => {
      let dark = 0;
      for (let y = rows[0]; y < Math.min(rows[1], meta.height!); y += 1) {
        for (let x = 0; x < meta.width!; x += 1) {
          const at = (y * meta.width! + x) * channels;
          if (data[at] < 90 && data[at + 1] < 90 && data[at + 2] < 90) {
            dark += 1;
          }
        }
      }
      return dark;
    },
    pixelAt: (x: number, y: number): [number, number, number] => {
      const at = (y * meta.width! + x) * channels;
      return [data[at], data[at + 1], data[at + 2]];
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("== 1. Pure units ==");
  eq(resolveWebOptimizeOptions({}), { dpi: 96, quality: 0.7 }, "options: empty → web defaults (96 / 0.7)");
  eq(
    resolveWebOptimizeOptions({ dpi: "150", quality: "0.85" }),
    { dpi: 150, quality: 0.85 },
    "options: select values parse"
  );
  eq(resolveWebOptimizeOptions({ dpi: "banana" }).dpi, 96, "options: garbage dpi → 96");
  eq(resolveWebOptimizeOptions({ quality: "x" }).quality, 0.7, "options: garbage quality → 0.7");
  eq(resolveWebOptimizeOptions({ dpi: 5000 }).dpi, 600, "options: dpi clamped to 600");
  eq(resolveWebOptimizeOptions({ dpi: 10 }).dpi, 36, "options: dpi clamped to 36");
  eq(resolveWebOptimizeOptions({ quality: 0.99 }).quality, 0.95, "options: quality clamped to 0.95");
  eq(resolveWebOptimizeOptions({ quality: 0.05 }).quality, 0.3, "options: quality clamped to 0.3");

  near(clampedRenderScale(595.28, 841.89, 72).scale, 1, "scale: 72 dpi is scale 1");
  near(clampedRenderScale(595.28, 841.89, 96).scale, 4 / 3, "scale: 96 dpi is 4/3");
  near(clampedRenderScale(595.28, 841.89, 300).scale, 25 / 6, "scale: 300 dpi is 25/6");
  near(clampedRenderScale(595.28, 841.89, 1).scale, 0.5, "scale: clamped at 0.5 minimum");
  near(clampedRenderScale(595.28, 841.89, 1200).scale, 8, "scale: clamped at 8 maximum");
  eq(
    [clampedRenderScale(PAGE_W, PAGE_H, 72).pixelW, clampedRenderScale(PAGE_W, PAGE_H, 72).pixelH],
    [420, 297],
    "pixels: 420×297pt @72dpi keeps its point size"
  );
  eq(
    [clampedRenderScale(PAGE_W, PAGE_H, 96).pixelW, clampedRenderScale(PAGE_W, PAGE_H, 96).pixelH],
    [560, 396],
    "pixels: 420×297pt @96dpi is 560×396"
  );
  eq(
    [clampedRenderScale(PAGE_W, PAGE_H, 150).pixelW, clampedRenderScale(PAGE_W, PAGE_H, 150).pixelH],
    [875, 619],
    "pixels: 420×297pt @150dpi is 875×619"
  );
  {
    // A0 landscape @300dpi → ≈139.3MP raw; the clamp must hold the cap.
    const huge = clampedRenderScale(3370, 2384, 300);
    check(
      huge.pixelW * huge.pixelH > 0 && huge.pixelW * huge.pixelH <= MAX_WEB_PIXELS,
      `clamp: A0 @300dpi held under 40MP (got ${huge.pixelW}×${huge.pixelH})`
    );
    check(
      Math.abs(huge.pixelW / huge.pixelH - 3370 / 2384) / (3370 / 2384) < 0.002,
      "clamp: aspect ratio preserved within 0.2%"
    );
    check(huge.scale < 25 / 6, "clamp: effective scale reduced below the requested one");
  }

  eq(webOutputName("report.pdf"), "report-web.pdf", "name: base + -web.pdf");
  eq(webOutputName("Annual Report.PDF"), "Annual Report-web.pdf", "name: extension strip is case-insensitive");
  eq(webOutputName('bad*name?"x".pdf'), "bad_name__x_-web.pdf", "name: filesystem-unsafe characters sanitized");
  eq(webOutputName(""), "document-web.pdf", "name: empty base falls back to document");
  eq(webOutputName("archive.tar"), "archive.tar-web.pdf", "name: non-pdf extension is kept honest");

  console.log("== 2. Fixture (real pdf-lib PDF) ==");
  const fixture = await buildWebFixture();
  check(
    fixture[0] === 0x25 && fixture[1] === 0x50 && fixture[2] === 0x44 && fixture[3] === 0x46,
    "fixture starts with %PDF-"
  );
  check(fixture.length > 20_000, `fixture is genuinely heavy (${fixture.length} bytes)`);
  {
    const reparsed = await PDFDocument.load(fixture.slice(), { updateMetadata: false });
    eq(reparsed.getPageCount(), PAGES, "fixture has 3 pages");
    eq(reparsed.getTitle(), "Web optimize smoke fixture", "fixture title set (proves the output drops it)");
    const size = reparsed.getPage(0).getSize();
    eq([size.width, size.height], [PAGE_W, PAGE_H], "fixture page size 420×297pt");
  }
  fs.mkdirSync(`${ROOT}download`, { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, fixture);
  check(
    fs.statSync(FIXTURE_PATH).size === fixture.length,
    "fixture written to download/smoke-web-optimize-fixture.pdf"
  );

  console.log("== 3. E2E: 72 DPI / quality 0.5 (compress hard) ==");
  const progress: { pct: number; stage: string; page?: number; pages?: number }[] = [];
  const run72 = await runWebOptimize(
    fixture,
    { dpi: "72", quality: "0.5" },
    openDoc,
    (p) => {
      progress.push({ pct: p.pct, stage: p.stage, page: p.detail?.page, pages: p.detail?.pages });
    }
  );

  eq(run72.pages, PAGES, "e2e: all 3 pages converted");
  eq(run72.inputBytes, fixture.length, "e2e: inputBytes = fixture size");
  check(
    progress.length > 0 && progress[0].stage === "reading" && progress[0].pct === 3,
    "progress: first event is reading @3%"
  );
  {
    const processing = progress.filter((p) => p.stage === "processing");
    eq(
      processing.map((p) => p.page),
      [1, 2, 3],
      "progress: one processing event per page, in order"
    );
    check(
      processing.every((p) => p.pages === PAGES),
      "progress: processing detail carries pages=3"
    );
    let monotonic = true;
    for (let i = 1; i < progress.length; i += 1) {
      if (progress[i].pct < progress[i - 1].pct) monotonic = false;
    }
    check(monotonic, "progress: percentages never decrease");
    check(
      progress[progress.length - 1].stage === "saving" && progress[progress.length - 1].pct === 95,
      "progress: last event is saving @95%"
    );
  }

  // Byte-level output sanity.
  const out72 = run72.bytes;
  check(
    out72[0] === 0x25 && out72[1] === 0x50 && out72[2] === 0x44 && out72[3] === 0x46,
    "output starts with %PDF-"
  );
  {
    const tail = new TextDecoder().decode(out72.subarray(Math.max(0, out72.length - 64)));
    check(tail.includes("%%EOF"), "output ends with %%EOF");
  }
  check(out72.length < fixture.length, `output smaller than input (${out72.length} < ${fixture.length})`);
  check(run72.savedPct > 0, `savedPct reported (${run72.savedPct}%)`);
  eq(
    run72.outputBytes,
    out72.length,
    "e2e: outputBytes = saved byte length"
  );
  eq(
    run72.savedPct,
    Math.round((1 - out72.length / fixture.length) * 100),
    "e2e: savedPct matches the result view's own math"
  );

  // Structural verification with pdf-lib.
  const reloaded = await PDFDocument.load(out72.slice(), { updateMetadata: false });
  eq(reloaded.getPageCount(), PAGES, "output page count preserved (3)");
  eq(reloaded.getProducer(), "MyCloudy web optimizer", "output producer is MyCloudy web optimizer");
  eq(reloaded.getCreator(), "MyCloudy web optimizer", "output creator is MyCloudy web optimizer");
  check(
    reloaded.getTitle() === undefined,
    "original title metadata dropped (lean rebuild)"
  );
  check(
    reloaded.catalog.getAcroForm() === undefined,
    "output carries no AcroForm"
  );
  {
    const pages = reloaded.getPages();
    let sizesOk = true;
    for (const page of pages) {
      const size = page.getSize();
      if (size.width !== PAGE_W || size.height !== PAGE_H) sizesOk = false;
    }
    check(sizesOk, "every output page keeps the exact 420×297pt viewport size");

    let oneImage = true;
    let dct = true;
    let dims = true;
    let bleed = true;
    let noFonts = true;
    let noAnnots = true;
    const payloads: Uint8Array[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      const info = inspectPage(reloaded, i, { width: PAGE_W, height: PAGE_H });
      if (info.keyCount !== 1) oneImage = false;
      if (info.filter !== "/DCTDecode") dct = false;
      if (info.width !== 420 || info.height !== 297) dims = false;
      if (!info.fullBleed) bleed = false;
      if (info.hasFont) noFonts = false;
      if (info.annots > 0) noAnnots = false;
      if (info.payload) payloads.push(info.payload);
    }
    check(oneImage, "every page has exactly ONE image XObject (rasterized)");
    check(dct, "image XObjects are JPEG (DCTDecode)");
    check(dims, "image /Width /Height = 420×297 (the 72 DPI render)");
    check(bleed, "images drawn full-bleed at margin 0 (translate+scale cm)");
    check(noFonts, "no fonts left in any page (text was rasterized away)");
    check(noAnnots, "no annotations in any page");
    check(payloads.length === PAGES, "DCT payloads extracted for all pages");

    // Each payload is a real JPEG: SOI/EOI magic + sharp decode + pixel truth.
    let magicOk = true;
    for (const payload of payloads) {
      if (payload[0] !== 0xff || payload[1] !== 0xd8) magicOk = false;
      if (payload[payload.length - 2] !== 0xff || payload[payload.length - 1] !== 0xd9) {
        magicOk = false;
      }
    }
    check(magicOk, "every DCT payload starts with SOI and ends with EOI");

    const canvasBase = pageCanvases.length - PAGES; // this run's canvases
    eq(
      pageCanvases.length,
      PAGES,
      "exactly 3 page canvases created (one per page, no leaks)"
    );
    for (let i = 0; i < PAGES; i += 1) {
      const stats = await jpegStats(payloads[i]);
      check(stats.format === "jpeg", `page ${i + 1}: sharp decodes the payload as jpeg`);
      check(
        stats.width === 420 && stats.height === 297,
        `page ${i + 1}: decoded JPEG is 420×297`
      );
      const canvasMean3 = canvasMean(pageCanvases[canvasBase + i]);
      check(
        Math.abs(stats.mean[0] - canvasMean3[0]) <= 6 &&
          Math.abs(stats.mean[1] - canvasMean3[1]) <= 6 &&
          Math.abs(stats.mean[2] - canvasMean3[2]) <= 6,
        `page ${i + 1}: JPEG mean RGB matches the rendered canvas mean (±6) — got (${stats.mean.map((v) => v.toFixed(1)).join(",")}) vs (${canvasMean3.map((v) => v.toFixed(1)).join(",")})`
      );
    }
    // Page identity: different pages render different mosaics.
    const means = await Promise.all(
      payloads.map(async (payload) => (await jpegStats(payload)).mean)
    );
    check(
      JSON.stringify(means[0]) !== JSON.stringify(means[1]) ||
        JSON.stringify(means[1]) !== JSON.stringify(means[2]),
      "pages render distinct mosaics (no page-mapping mixup)"
    );

    // Pixel truth on page 1: white corner + rendered title text.
    const page1 = await jpegStats(payloads[0]);
    const corner = page1.pixelAt(3, 3);
    check(
      corner[0] >= 235 && corner[1] >= 235 && corner[2] >= 235,
      `page 1: 16pt margin corner is white (got ${corner.join(",")})`
    );
    const darkText = page1.darkIn([8, 24]);
    check(darkText >= 60, `page 1: rendered title text paints dark pixels (${darkText})`);
  }

  console.log("== 4. Defaults + DPI/quality trade-offs ==");
  const runDefault = await runWebOptimize(fixture, {}, openDoc);
  {
    const re = await PDFDocument.load(runDefault.bytes.slice(), { updateMetadata: false });
    const info = inspectPage(re, 0, { width: PAGE_W, height: PAGE_H });
    check(
      info.width === 560 && info.height === 396,
      "default options render at 96 DPI (560×396 XObject)"
    );
  }
  const run150 = await runWebOptimize(fixture, { dpi: "150", quality: "0.5" }, openDoc);
  {
    const re = await PDFDocument.load(run150.bytes.slice(), { updateMetadata: false });
    const info = inspectPage(re, 0, { width: PAGE_W, height: PAGE_H });
    check(
      info.width === 875 && info.height === 619,
      "150 DPI render is 875×619 pixels"
    );
  }
  check(
    run150.outputBytes > run72.outputBytes,
    `150 DPI output is bigger than 72 DPI (${run150.outputBytes} > ${run72.outputBytes}) — the size trade-off is real`
  );

  const runQ85 = await runWebOptimize(fixture, { dpi: "96", quality: "0.85" }, openDoc);
  const runQ50 = await runWebOptimize(fixture, { dpi: "96", quality: "0.5" }, openDoc);
  check(
    runQ50.outputBytes < runQ85.outputBytes,
    `quality 0.5 beats 0.85 at the same raster (${runQ50.outputBytes} < ${runQ85.outputBytes})`
  );
  check(
    runQ50.savedPct > runQ85.savedPct,
    "quality 0.5 reports the bigger saving"
  );

  console.log("== 5. Multi-file (one output per input, core level) ==");
  const small = await buildSmallFixture();
  const smallResult = await runWebOptimize(small, {}, openDoc);
  const smallReload = await PDFDocument.load(smallResult.bytes.slice(), { updateMetadata: false });
  eq(smallResult.pages, 1, "multi: second input converted on its own");
  eq(smallReload.getPageCount(), 1, "multi: second output has its own page count");
  eq(webOutputName("small.pdf"), "small-web.pdf", "multi: per-file output name");
  check(
    smallResult.outputBytes !== runDefault.outputBytes,
    "multi: the two inputs produced two distinct outputs"
  );

  console.log("== 6. Honest error paths ==");
  {
    // Render failure via an injected doc whose page.render rejects.
    const failingDoc: WebOptDocLike = {
      numPages: 2,
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 50 }),
        render: () => ({ promise: Promise.reject(new Error("boom")) }),
        cleanup: () => {},
      }),
      cleanup: () => {},
    };
    let caught: unknown = null;
    try {
      await runWebOptimize(fixture, {}, async () => failingDoc);
    } catch (error) {
      caught = error;
    }
    check(caught instanceof WebOptimizeRunError, "render error: throws WebOptimizeRunError");
    eq(
      caught instanceof WebOptimizeRunError ? caught.code : null,
      "webOptimize.errorRender",
      "render error: maps to webOptimize.errorRender"
    );
    check(
      caught instanceof WebOptimizeRunError && /^page 1/.test(caught.detail ?? ""),
      "render error: failing page number rides along as detail"
    );
  }
  {
    // Real AES-256 encrypted PDF (@cantoo) → pdf.js PasswordException.
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const cantoo = await CantooDoc.create();
    cantoo.addPage([300, 200]);
    cantoo.encrypt({ userPassword: "pw" });
    const encrypted = await cantoo.save({ useObjectStreams: false });
    let caught: unknown = null;
    try {
      await runWebOptimize(new Uint8Array(encrypted), {}, openDoc);
    } catch (error) {
      caught = error;
    }
    check(caught instanceof WebOptimizeRunError, "encrypted: throws WebOptimizeRunError");
    eq(
      caught instanceof WebOptimizeRunError ? caught.code : null,
      "tool.errorEncrypted",
      "encrypted: maps to tool.errorEncrypted"
    );
  }
  {
    let caught: unknown = null;
    try {
      await runWebOptimize(
        new TextEncoder().encode("%PDF-1.7 this is not really a pdf"),
        {},
        openDoc
      );
    } catch (error) {
      caught = error;
    }
    check(caught instanceof WebOptimizeRunError, "corrupt: throws WebOptimizeRunError");
    eq(
      caught instanceof WebOptimizeRunError ? caught.code : null,
      "tool.errorCorrupt",
      "corrupt: garbage input maps to tool.errorCorrupt"
    );
  }

  console.log("== 7. Config schema ==");
  eq(config.toolId, "web-optimize-pdf", "config: toolId matches the registry slug");
  eq(config.outputKind, "pdf", "config: outputKind pdf (rasterize/compress parity)");
  eq(config.minFiles, 1, "config: minFiles 1");
  eq(config.maxFiles, 5, "config: maxFiles 5 (sibling parity)");
  eq(config.chainToolIds ?? [], ["view-pdf"], "config: chain is the honest viewer (output already optimized)");
  eq(config.howKeys ?? [], ["webOptimize.how1", "webOptimize.how2", "webOptimize.how3"], "config: howKeys point at webOptimize.how1-3");
  {
    const byId: Record<string, (typeof config.options)[number]> = {};
    for (const field of config.options) byId[field.id] = field;
    eq(Object.keys(byId).sort().join(","), "dpi,quality", "config: exactly two options (dpi + quality)");
    const dpiField = byId.dpi;
    check(dpiField.kind === "select", "config: dpi is a select");
    if (dpiField.kind === "select") {
      eq(
        dpiField.choices.map((c) => c.value).join(","),
        "72,96,150,200,300",
        "config: dpi choices 72/96/150/200/300"
      );
      eq(dpiField.default, "96", "config: dpi default is the web-focused 96");
      check(
        dpiField.choices.every((c) => c.label.en.length > 0 && /[\u0900-\u097F]/.test(c.label.hi)),
        "config: every dpi choice has Devanagari Hindi"
      );
    }
    const qualityField = byId.quality;
    check(qualityField.kind === "select", "config: quality is a select");
    if (qualityField.kind === "select") {
      eq(
        qualityField.choices.map((c) => c.value).join(","),
        "0.85,0.7,0.5",
        "config: quality choices 0.85/0.7/0.5"
      );
      eq(qualityField.default, "0.7", "config: quality default is balanced (0.7)");
    }
  }
  eq(config.features.length, 5, "config: five features");
  eq(config.faq.length, 3, "config: three FAQ");
  check(
    config.features.every((f) => f.en.length > 0 && f.hi.length > 0) &&
      config.faq.every((f) => f.q.en.length > 0 && f.q.hi.length > 0 && f.a.en.length > 0 && f.a.hi.length > 0),
    "config: every feature + FAQ line has en + hi copy"
  );
  check(
    config.features.concat(config.faq.flatMap((f) => [f.q, f.a])).every((l) => /[\u0900-\u097F]/.test(l.hi)),
    "config: every L10n string carries Devanagari Hindi"
  );
  {
    const faqText = JSON.stringify(config.faq);
    check(
      faqText.includes("can't be selected, searched") && faqText.includes("rasterizes"),
      "config: FAQ states the text-loss honestly (en)"
    );
    check(
      faqText.includes("तस्वीर बन जाता है") && faqText.includes("सिलेक्ट, सर्च"),
      "config: FAQ states the text-loss honestly (hi)"
    );
    check(
      typeof config.createWorker === "function",
      "config: createWorker present"
    );
    const configSource = fs.readFileSync(`${ROOT}tools/web-optimize-pdf/config.ts`, "utf8");
    check(
      configSource.includes('"./worker.ts"') && configSource.includes('type: "module"'),
      "config: createWorker targets ./worker.ts (type module)"
    );
  }

  console.log("== 8. Worker source wiring pins ==");
  {
    const workerSource = fs.readFileSync(`${ROOT}tools/web-optimize-pdf/worker.ts`, "utf8");
    check(workerSource.includes("committedJpegBlob"), "worker: uses committedJpegBlob (the P3.19 blank-snapshot guard)");
    check(workerSource.includes('"MyCloudy web optimizer"'), "worker: sets the MyCloudy producer/creator");
    check(workerSource.includes("../pdfjs-common/worker-lib"), "worker: loads pdf.js via the shared fake-worker loader");
    check(workerSource.includes("webOptimize.errorRender"), "worker: render failures map to webOptimize.errorRender");
    check(workerSource.includes('"/pdfjs/cmaps/"'), "worker: cMaps wired like siblings");
  }

  console.log("== 9. Registry (read-only) + catalogs ==");
  {
    const registrySource = fs.readFileSync(`${ROOT}src/lib/tools/registry.ts`, "utf8");
    check(
      registrySource.includes('id: "web-optimize-pdf"'),
      "registry: web-optimize-pdf entry present (enabled flip is the orchestrator's)"
    );
    check(
      registrySource.includes('id: "view-pdf"'),
      "registry: chain target view-pdf exists"
    );
  }
  {
    const en = JSON.parse(await readFile("src/i18n/en.json", "utf8")) as Record<
      string,
      Record<string, string>
    >;
    const hi = JSON.parse(await readFile("src/i18n/hi.json", "utf8")) as Record<
      string,
      Record<string, string>
    >;
    for (const code of ["errorEncrypted", "errorCorrupt", "errorGeneric"]) {
      check(typeof en.tool?.[code] === "string", `catalog: tool.${code} present in en`);
      check(typeof hi.tool?.[code] === "string", `catalog: tool.${code} present in hi`);
    }
    // Wiring state: webOptimize must land in BOTH catalogs or neither
    // (the orchestrator merges both at once — parity either way).
    check(
      ("webOptimize" in en) === ("webOptimize" in hi),
      "catalog: webOptimize merged into both or neither"
    );
    if ("webOptimize" in en && "webOptimize" in hi) {
      eq(
        Object.keys(en.webOptimize).sort().join(","),
        Object.keys(hi.webOptimize).sort().join(","),
        "catalog: webOptimize en↔hi key parity in en.json/hi.json"
      );
    }
  }

  console.log("== 10. i18n parity (tools/web-optimize-pdf/i18n.json) ==");
  {
    const part = i18n as unknown as {
      en: Record<string, Record<string, string>>;
      hi: Record<string, Record<string, string>>;
    };
    check(
      Object.keys(part.en).join(",") === "webOptimize" && Object.keys(part.hi).join(",") === "webOptimize",
      "i18n: single section webOptimize in both locales"
    );
    eq(
      Object.keys(part.en.webOptimize).sort().join(","),
      Object.keys(part.hi.webOptimize).sort().join(","),
      "i18n: webOptimize en↔hi key parity"
    );
    eq(
      Object.keys(part.en.webOptimize).sort().join(","),
      "description,errorRender,how1,how2,how3,label",
      "i18n: expected key set (label/description/how1-3/errorRender)"
    );
    check(
      Object.values(part.hi.webOptimize).every((v) => /[\u0900-\u097F]/.test(v)),
      "i18n: every Hindi value contains Devanagari"
    );
    check(
      Object.values(part.en.webOptimize).every((v) => v.length > 0) &&
        Object.values(part.hi.webOptimize).every((v) => v.length > 0),
      "i18n: no empty values"
    );
    for (const key of (config.howKeys ?? []).join(",").split(",")) {
      const leaf = key.split(".")[1] ?? "";
      check(
        key.split(".")[0] === "webOptimize" && part.en.webOptimize[leaf] !== undefined,
        `i18n: howKey ${key} resolves in webOptimize`
      );
    }
    check(
      part.en.webOptimize.errorRender.includes("DPI") &&
        part.hi.webOptimize.errorRender.includes("DPI"),
      "i18n: errorRender suggests a lower DPI in both locales"
    );
  }

  console.log("== 11. Artifacts ==");
  await writeFile(OUTPUT_PATH, out72);
  check(
    fs.statSync(OUTPUT_PATH).size === out72.length,
    "72 DPI output written to download/smoke-web-optimize-output.pdf"
  );
  console.log(
    `      (fixture ${fixture.length} B → web PDF ${out72.length} B = ${run72.savedPct}% smaller @72/0.5; 96 default ${runDefault.outputBytes} B; 150 DPI ${run150.outputBytes} B)`
  );

  console.log(
    `\n${pass} passed, ${fail} failed (of ${checkNo})`
  );
  if (fail > 0) process.exit(1);
  // Release every pdf.js worker handle, then exit explicitly — the legacy
  // build keeps the Bun event loop alive otherwise (the pinned B1 lesson).
  void (async () => {
    for (const d of openDocs) {
      try {
        await d.destroy();
      } catch {
        /* best effort */
      }
    }
    process.exit(fail > 0 ? 1 : 0);
  })();
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASH", error);
  process.exit(1);
});
