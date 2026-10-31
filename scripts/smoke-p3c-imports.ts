/**
 * Smoke: P3-c import pack 2 (R57) — bmp/psd/cbz/email-to-pdf.
 *
 *   0. Wiring: registry counts 134 total / 133 live / 1 deferred AI
 *      (translate only); the four new defs are enabled convert-to with
 *      the right accepts (image/image/any/text); configs + seo entries
 *      present; the 3 NEW i18n error keys exist in BOTH catalogs.
 *   1. BMP engine (PURE, tools/raster-decode-common/bmp): 24-bit BI_RGB
 *      bottom-up + top-down, 4-bit packed, 1-bit OS/2 CORE palette,
 *      16-bit RGB555, 32-bit BI_BITFIELDS V4 with alpha, RLE8 + RLE4
 *      (repeat / absolute / EOL), honest refusals (BI_JPEG, truncated
 *      rows, >40 MP, bad signature).
 *   2. PSD engine (PURE, tools/raster-decode-common/psd): raw + PackBits
 *      RLE composites, alpha channel, grayscale, PSB v2 section length,
 *      honest refusals (16-bit depth, CMYK mode, truncation).
 *   3. CBZ helpers (PURE, tools/cbz-to-pdf/worker-lib): natural page
 *      order (page-2 < page-10, folder grouping, case folding), junk
 *      filtering; zip roundtrip through the OWN zip engine.
 *   4. EML engine (PURE, tools/email-to-pdf/worker-lib): header folding,
 *      RFC 2047 B/Q words (Hindi subject), quoted-printable + base64
 *      bodies, charset labels, multipart alternative (plain preferred)
 *      / mixed with attachments, RFC 2231 filename*, HTML fallback,
 *      honest not-an-email refusal.
 *   5. Render integration: computeImagePlacement geometry (fit / A4
 *      portrait + landscape auto), BMP raster → hand-built PNG → OWN
 *      engine → pdf-lib reload oracle, email painter page-count oracle
 *      on a long body (pagination) + multi-file sections.
 *
 * Run: bun scripts/smoke-p3c-imports.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { ALL_TOOLS } from "../src/lib/tools/registry";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { getToolSeo } from "../src/lib/seo/tool-seo";
import { CreateContext } from "../src/lib/own/pdf";
import { zipSync, unzipSync, zlibSync, crc32 } from "../src/lib/own/zip";
import {
  BmpDecodeError,
  decodeBmp,
  isBmpBytes,
  MAX_RASTER_PIXELS,
  type RasterImage,
} from "../tools/raster-decode-common/bmp";
import { decodePsd, isPsdBytes, PsdDecodeError } from "../tools/raster-decode-common/psd";
import {
  computeImagePlacement,
} from "../tools/raster-decode-common/render";
import {
  filterAndSortImageEntries,
  hasImageExtension,
  isJunkEntry,
  naturalCompare,
} from "../tools/cbz-to-pdf/worker-lib";
import {
  decodeQuotedPrintable,
  decodeRfc2047,
  EmlParseError,
  htmlToPlainText,
  parseEml,
} from "../tools/email-to-pdf/worker-lib";
import { renderEmail } from "../tools/email-to-pdf/render";
import type { ConvertFace } from "../tools/convert-common/face";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const enc = new TextEncoder();

/* ─── fixture builders ───────────────────────────────────────────────────── */

function dv(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 24-bit BI_RGB BMP from top-down RGB triplets. */
function buildBmp24(
  width: number,
  height: number,
  rgb: number[],
  opts: { topDown?: boolean } = {},
): Uint8Array {
  const stride = (width * 3 + 3) & ~3;
  const pixelStart = 14 + 40;
  const out = new Uint8Array(pixelStart + stride * height);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, opts.topDown ? -height : height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(30, 0, true);
  for (let y = 0; y < height; y += 1) {
    const srcY = height - 1 - y; // file rows are bottom-up
    for (let x = 0; x < width; x += 1) {
      const p = (srcY * width + x) * 3;
      const o = pixelStart + y * stride + x * 3;
      out[o] = rgb[p + 2]!;
      out[o + 1] = rgb[p + 1]!;
      out[o + 2] = rgb[p]!;
    }
  }
  return out;
}

function buildBmp32V4(
  width: number,
  height: number,
  rgba: number[],
): Uint8Array {
  const pixelStart = 14 + 108;
  const out = new Uint8Array(pixelStart + width * 4 * height);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 108, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 3, true); // BI_BITFIELDS
  view.setUint32(14 + 40, 0x00ff0000, true); // R (V4 masks live after the INFOHEADER fields)
  view.setUint32(14 + 44, 0x0000ff00, true); // G
  view.setUint32(14 + 48, 0x000000ff, true); // B
  view.setUint32(14 + 52, 0xff000000, true); // A
  for (let y = 0; y < height; y += 1) {
    const srcY = height - 1 - y; // file rows are bottom-up
    for (let x = 0; x < width; x += 1) {
      const p = (srcY * width + x) * 4;
      const o = pixelStart + y * width * 4 + x * 4;
      out[o] = rgba[p + 2]!;
      out[o + 1] = rgba[p + 1]!;
      out[o + 2] = rgba[p]!;
      out[o + 3] = rgba[p + 3]!;
    }
  }
  return out;
}

/** 16-bit RGB555 BMP from top-down 15-bit values. */
function buildBmp16(width: number, height: number, values: number[]): Uint8Array {
  const stride = (width * 2 + 3) & ~3;
  const pixelStart = 14 + 40;
  const out = new Uint8Array(pixelStart + stride * height);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 16, true);
  view.setUint32(30, 0, true);
  for (let i = 0; i < width * height; i += 1) {
    view.setUint16(pixelStart + i * 2, values[i]!, true);
  }
  return out;
}

/** OS/2 BITMAPCOREHEADER 1-bit palette BMP. */
function buildBmpCore1(width: number, height: number, bits: number[]): Uint8Array {
  const stride = (Math.ceil(width / 8) + 3) & ~3;
  const paletteStart = 14 + 12;
  const pixelStart = paletteStart + 2 * 3;
  const out = new Uint8Array(pixelStart + stride * height);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 12, true);
  view.setUint16(18, width, true);
  view.setUint16(20, height, true);
  view.setUint16(22, 1, true);
  view.setUint16(24, 1, true);
  // palette: black, white (BGR)
  out[paletteStart] = 0;
  out[paletteStart + 3] = 255;
  out[paletteStart + 4] = 255;
  out[paletteStart + 5] = 255;
  for (let y = 0; y < height; y += 1) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      if (bits[srcY * width + x] === 1) {
        out[pixelStart + y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/** 8-bit palette BMP with an RLE8 stream. */
function buildBmpRle8(
  width: number,
  height: number,
  palette: number[][],
  stream: number[],
): Uint8Array {
  const paletteStart = 14 + 40;
  const pixelStart = paletteStart + palette.length * 4;
  const out = new Uint8Array(pixelStart + stream.length);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 8, true);
  view.setUint32(30, 1, true); // BI_RLE8
  view.setUint32(46, palette.length, true);
  palette.forEach((rgb, i) => {
    const o = paletteStart + i * 4;
    out[o] = rgb[2]!;
    out[o + 1] = rgb[1]!;
    out[o + 2] = rgb[0]!;
    out[o + 3] = 0;
  });
  out.set(Uint8Array.from(stream), pixelStart);
  return out;
}

/** 4-bit palette BMP with an RLE4 stream. */
function buildBmpRle4(
  width: number,
  height: number,
  palette: number[][],
  stream: number[],
): Uint8Array {
  const paletteStart = 14 + 40;
  const pixelStart = paletteStart + palette.length * 4;
  const out = new Uint8Array(pixelStart + stream.length);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 4, true);
  view.setUint32(30, 2, true); // BI_RLE4
  view.setUint32(46, palette.length, true);
  palette.forEach((rgb, i) => {
    const o = paletteStart + i * 4;
    out[o] = rgb[2]!;
    out[o + 1] = rgb[1]!;
    out[o + 2] = rgb[0]!;
    out[o + 3] = 0;
  });
  out.set(Uint8Array.from(stream), pixelStart);
  return out;
}

/** 4-bit uncompressed palette BMP (packed nibbles). */
function buildBmp4(
  width: number,
  height: number,
  palette: number[][],
  indices: number[],
): Uint8Array {
  const stride = (Math.ceil((width * 4) / 8) + 3) & ~3;
  const paletteStart = 14 + 40;
  const pixelStart = paletteStart + palette.length * 4;
  const out = new Uint8Array(pixelStart + stride * height);
  const view = dv(out);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(10, pixelStart, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 4, true);
  view.setUint32(30, 0, true);
  view.setUint32(46, palette.length, true);
  palette.forEach((rgb, i) => {
    const o = paletteStart + i * 4;
    out[o] = rgb[2]!;
    out[o + 1] = rgb[1]!;
    out[o + 2] = rgb[0]!;
    out[o + 3] = 0;
  });
  for (let y = 0; y < height; y += 1) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const idx = indices[srcY * width + x]! & 0x0f;
      const o = pixelStart + y * stride + (x >> 1);
      if (x % 2 === 0) out[o] |= idx << 4;
      else out[o] |= idx;
    }
  }
  return out;
}

/** PackBits-encode one row (literal + repeat runs). */
function packBitsRow(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < 128) run += 1;
    if (run >= 3) {
      out.push(257 - run, row[i]!);
      i += run;
    } else {
      let j = i;
      while (
        j < row.length &&
        j - i < 128 &&
        !(j + 2 < row.length && row[j] === row[j + 1] && row[j + 1] === row[j + 2])
      ) {
        j += 1;
      }
      const lit = j - i;
      if (lit === 0) {
        out.push(0, row[i]!);
        i += 1;
      } else {
        out.push(lit - 1);
        for (let k = i; k < j; k += 1) out.push(row[k]!);
        i = j;
      }
    }
  }
  return Uint8Array.from(out);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PSD with channel-planar composite data (raw or PackBits RLE). */
function buildPsd(opts: {
  width: number;
  height: number;
  mode: 1 | 3;
  compression: 0 | 1;
  planes: Uint8Array[];
  version?: 1 | 2;
}): Uint8Array {
  const { width, height, mode, compression, planes } = opts;
  const version = opts.version ?? 1;
  const channels = planes.length;
  let body: Uint8Array;
  if (compression === 0) {
    body = concatBytes(planes);
  } else {
    const counts = new Uint8Array(2 * channels * height);
    const countsView = dv(counts);
    const packed: Uint8Array[] = [];
    for (let c = 0; c < channels; c += 1) {
      for (let y = 0; y < height; y += 1) {
        const row = planes[c]!.subarray(y * width, (y + 1) * width);
        const encRow = packBitsRow(row);
        countsView.setUint16(2 * (c * height + y), encRow.length, false);
        packed.push(encRow);
      }
    }
    body = concatBytes([counts, ...packed]);
  }
  const layerFieldLen = version === 2 ? 8 : 4;
  const total = 26 + 4 + 4 + layerFieldLen + 2 + body.length;
  const out = new Uint8Array(total);
  const view = dv(out);
  out[0] = 0x38;
  out[1] = 0x42;
  out[2] = 0x50;
  out[3] = 0x53;
  view.setUint16(4, version, false);
  view.setUint16(12, channels, false);
  view.setUint32(14, height, false);
  view.setUint32(18, width, false);
  view.setUint16(22, 8, false);
  view.setUint16(24, mode, false);
  let o = 26;
  view.setUint32(o, 0, false); // colour mode data
  o += 4;
  view.setUint32(o, 0, false); // image resources
  o += 4;
  if (version === 2) {
    view.setUint32(o, 0, false); // layer/mask u64 (high)
    view.setUint32(o + 4, 0, false); // (low)
    o += 8;
  } else {
    view.setUint32(o, 0, false);
    o += 4;
  }
  view.setUint16(o, compression, false);
  o += 2;
  out.set(body, o);
  return out;
}

/** Minimal PNG from an RGBA raster (smoke-only; the worker uses canvas). */
function buildPng(raster: RasterImage): Uint8Array {
  const { width, height, rgba } = raster;
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const idat = zlibSync(raw, 6);
  const ihdr = new Uint8Array(13);
  const iv = dv(ihdr);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const head = new Uint8Array(4 + data.length + 4 + 4);
    const hv = dv(head);
    hv.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i);
    head.set(data, 8);
    const crcTarget = head.subarray(4, 8 + data.length);
    hv.setUint32(4 + data.length + 4, crc32(crcTarget), false);
    return head;
  };
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concatBytes([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function px(raster: RasterImage, x: number, y: number): number[] {
  const o = (y * raster.width + x) * 4;
  return [raster.rgba[o]!, raster.rgba[o + 1]!, raster.rgba[o + 2]!, raster.rgba[o + 3]!];
}

/* ─── 0. wiring ──────────────────────────────────────────────────────────── */

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

console.log("── 0. Wiring ────────────────────────────────────────────");
{
  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    "tool counts: 134 total / 133 live / 1 deferred AI (translate)",
    ALL_TOOLS.length === 134 && live === 133 && deferred.join(",") === "translate-pdf",
    { total: ALL_TOOLS.length, live, deferred },
  );

  const expects: Record<string, string> = {
    "bmp-to-pdf": "image",
    "psd-to-pdf": "image",
    "cbz-to-pdf": "any",
    "email-to-pdf": "text",
  };
  for (const [id, accepts] of Object.entries(expects)) {
    const def = ALL_TOOLS.find((t) => t.id === id);
    check(
      `${id}: registry def enabled convert-to accepts ${accepts}`,
      def !== undefined &&
        def.enabled &&
        def.category === "convert-to" &&
        def.accepts === accepts,
    );
    check(`${id}: config wired`, (TOOL_CONFIGS as Record<string, unknown>)[id] !== undefined);
    check(`${id}: seo entry`, getToolSeo(id) !== undefined);
    check(
      `${id}: worker file exists`,
      readFileSync(join(root, "tools", id, "worker.ts"), "utf8").length > 0,
    );
  }

  const en = JSON.parse(read("src/i18n/en.json")) as { tool?: Record<string, unknown> };
  const hi = JSON.parse(read("src/i18n/hi.json")) as { tool?: Record<string, unknown> };
  for (const key of ["errorInputTooLarge", "errorNotArchive", "errorNotEmail"]) {
    check(
      `i18n tool.${key} en+hi`,
      en.tool?.[key] !== undefined && hi.tool?.[key] !== undefined,
    );
  }
  // every tool.* leaf count parity (en == hi)
  const leafCount = (obj: unknown): number => {
    if (typeof obj !== "object" || obj === null) return 1;
    return Object.values(obj).reduce((sum: number, v) => sum + leafCount(v), 0);
  };
  check(
    "i18n en/hi flat-leaf parity after +3 keys",
    leafCount(en) === leafCount(hi),
    { en: leafCount(en), hi: leafCount(hi) },
  );
}

/* ─── 1. BMP engine ──────────────────────────────────────────────────────── */

console.log("── 1. BMP engine ────────────────────────────────────────");
{
  check("isBmpBytes positive", isBmpBytes(Uint8Array.from([0x42, 0x4d, 0, 0])));
  check("isBmpBytes negative (PSD)", !isPsdBytesAsBmp());

  // 24-bit bottom-up: file row 0 = image bottom row
  const rgb = [
    255, 0, 0, 0, 255, 0, 0, 0, 255,
    255, 255, 0, 128, 64, 32, 16, 16, 16,
  ];
  const r1 = decodeBmp(buildBmp24(3, 2, rgb));
  check("24-bit geometry", r1.width === 3 && r1.height === 2);
  check("24-bit top-left is red (bottom-up flip)", px(r1, 0, 0).join() === "255,0,0,255");
  check("24-bit (1,0) green", px(r1, 1, 0).join() === "0,255,0,255");
  check("24-bit (2,0) blue", px(r1, 2, 0).join() === "0,0,255,255");
  check("24-bit bottom-left yellow", px(r1, 0, 1).join() === "255,255,0,255");
  check("24-bit (1,1) mixed", px(r1, 1, 1).join() === "128,64,32,255");
  check("24-bit opaque", r1.hasAlpha === false && r1.depth === 24);

  // top-down: negative height
  const r2 = decodeBmp(buildBmp24(3, 2, rgb, { topDown: true }));
  check("top-down: first file row IS the top row", px(r2, 0, 0).join() === "255,255,0,255");
  check("top-down: bottom row red", px(r2, 0, 1).join() === "255,0,0,255");

  // 32-bit BI_BITFIELDS V4 with alpha
  const rgba = [
    255, 0, 0, 255, 0, 255, 0, 128,
    0, 0, 255, 0, 10, 20, 30, 200,
  ];
  const r3 = decodeBmp(buildBmp32V4(2, 2, rgba));
  check("32-bit bitfields (0,0)", px(r3, 0, 0).join() === "255,0,0,255");
  check("32-bit bitfields (1,0) alpha 128", px(r3, 1, 0).join() === "0,255,0,128");
  check("32-bit bitfields (1,1)", px(r3, 1, 1).join() === "10,20,30,200");
  check("32-bit hasAlpha true (alpha < 255 present)", r3.hasAlpha === true);

  // 16-bit RGB555: 0x7C00 = pure red, 0x03FF = green+blue full
  const r4 = decodeBmp(buildBmp16(2, 1, [0x7c00, 0x03ff]));
  check("16-bit RGB555 red", px(r4, 0, 0).join() === "255,0,0,255");
  check("16-bit RGB555 green+blue", px(r4, 1, 0).join() === "0,255,255,255");

  // OS/2 CORE 1-bit
  const r5 = decodeBmp(buildBmpCore1(2, 2, [1, 0, 0, 1]));
  check("CORE 1-bit white pixel", px(r5, 0, 0).join() === "255,255,255,255");
  check("CORE 1-bit black pixel", px(r5, 1, 0).join() === "0,0,0,255");

  // 4-bit packed palette
  const pal4 = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ];
  const r6 = decodeBmp(buildBmp4(4, 1, pal4, [0, 1, 2, 3]));
  check("4-bit packed nibbles", [0, 1, 2, 3].every((i) => px(r6, i, 0).slice(0, 3).join() === pal4[i]!.join()));

  // RLE8: 4×2 — stream rows encode BOTTOM-FIRST (positive height):
  //   stream row 0 (= image bottom row y=1): 3×black, delta skip, EOL
  //   stream row 1 (= image top row y=0):   2×red, absolute 4 bytes, EOL, EOB
  const pal8 = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
  ];
  const rle8Stream = [
    3, 0, // repeat 3 black
    0, 2, 1, 0, // delta: x+=1, y+=0 (skips 1 px — stays palette-0 = black)
    0, 0, // EOL
    2, 2, // repeat 2 red
    0, 4, 1, 3, 3, 255, 3, // absolute: 4 bytes [1,3,3,255] even → no pad
    0, 0, // EOL
    0, 1, // EOB
  ];
  const r7 = decodeBmp(buildBmpRle8(4, 2, pal8, rle8Stream));
  check("RLE8 repeat run (bottom row)", px(r7, 0, 1).slice(0, 3).join() === "0,0,0");
  check("RLE8 delta hole keeps palette-0", px(r7, 3, 1).slice(0, 3).join() === "0,0,0");
  check("RLE8 top row repeat red", px(r7, 0, 0).slice(0, 3).join() === "255,0,0");
  check("RLE8 absolute bytes → palette 1 white", px(r7, 2, 0).slice(0, 3).join() === "255,255,255");

  // RLE4: 4×2 — stream row 0 = image bottom (y=1): (3, 0x01) → 0,1,0; EOL;
  // stream row 1 = image top (y=0): absolute (0,4, 0x23, pad)
  const pal4b = Array.from({ length: 16 }, (_, i) => [i * 16, i * 8, i * 4]);
  const rle4Stream = [
    3, 0x01, // repeat: alternating nibbles 0,1,0
    0, 0,
    0, 4, 0x23, 0, // absolute 4 pixels: 2,3,2,3 (1 byte data + 1 pad byte)
    0, 1,
  ];
  const r8 = decodeBmp(buildBmpRle4(4, 2, pal4b, rle4Stream));
  check("RLE4 repeat alternates nibbles", px(r8, 0, 1).slice(0, 3).join() === "0,0,0" && px(r8, 1, 1).slice(0, 3).join() === "16,8,4");
  check("RLE4 absolute nibbles", px(r8, 0, 0).slice(0, 3).join() === "32,16,8" && px(r8, 1, 0).slice(0, 3).join() === "48,24,12");

  // honest refusals
  const expectCode = (label: string, err: unknown, code: string): void => {
    check(label, err instanceof BmpDecodeError && err.code === code, String(err));
  };
  // BI_JPEG embedded payload
  {
    const b = buildBmp24(1, 1, [1, 2, 3]);
    dv(b).setUint32(30, 4, true);
    try {
      decodeBmp(b);
      expectCode("BI_JPEG refused unsupported", new Error("no throw"), "unsupported");
    } catch (err) {
      expectCode("BI_JPEG refused unsupported", err, "unsupported");
    }
  }
  // truncated pixel data
  {
    const b = buildBmp24(3, 2, rgb).slice(0, 14 + 40 + 3);
    try {
      decodeBmp(b);
      expectCode("truncated rows refused corrupt", new Error("no throw"), "corrupt");
    } catch (err) {
      expectCode("truncated rows refused corrupt", err, "corrupt");
    }
  }
  // over 40 MP
  {
    const b = buildBmp24(1, 1, [0, 0, 0]);
    dv(b).setInt32(18, 8000, true);
    dv(b).setInt32(22, 8000, true);
    try {
      decodeBmp(b);
      expectCode(">40 MP refused too-large", new Error("no throw"), "too-large");
    } catch (err) {
      expectCode(">40 MP refused too-large", err, "too-large");
    }
  }
  // bad signature
  {
    const b = buildBmp24(1, 1, [0, 0, 0]);
    b[0] = 0x00;
    try {
      decodeBmp(b);
      expectCode("bad signature refused corrupt", new Error("no throw"), "corrupt");
    } catch (err) {
      expectCode("bad signature refused corrupt", err, "corrupt");
    }
  }
  check("MAX_RASTER_PIXELS is 40,000,000", MAX_RASTER_PIXELS === 40_000_000);
}

function isPsdBytesAsBmp(): boolean {
  return isBmpBytes(Uint8Array.from([0x38, 0x42, 0x50, 0x53]));
}

/* ─── 2. PSD engine ──────────────────────────────────────────────────────── */

console.log("── 2. PSD engine ─────────────────────────────────────────");
{
  check("isPsdBytes positive", isPsdBytes(Uint8Array.from([0x38, 0x42, 0x50, 0x53])));
  check("isPsdBytes negative", !isPsdBytes(Uint8Array.from([0x42, 0x4d])));

  // raw RGB 3×2
  const rP = Uint8Array.from([255, 0, 10, 20, 200, 0]);
  const gP = Uint8Array.from([0, 255, 30, 40, 0, 220]);
  const bP = Uint8Array.from([0, 0, 50, 60, 0, 240]);
  const p1 = decodePsd(buildPsd({ width: 3, height: 2, mode: 3, compression: 0, planes: [rP, gP, bP] }));
  check("PSD raw geometry", p1.width === 3 && p1.height === 2 && p1.channels === 3);
  check("PSD raw (0,0) RGB", px(p1, 0, 0).join() === "255,0,0,255");
  check("PSD raw (2,0) RGB", px(p1, 2, 0).join() === "10,30,50,255");
  check("PSD raw (1,1) RGB", px(p1, 1, 1).join() === "200,0,0,255");
  check("PSD raw (2,1) RGB", px(p1, 2, 1).join() === "0,220,240,255");
  check("PSD raw opaque", p1.hasAlpha === false && p1.gray === false);

  // RLE RGB + alpha (4 channels)
  const aP = Uint8Array.from([255, 128, 128, 255, 0, 255]);
  const p2 = decodePsd(
    buildPsd({ width: 3, height: 2, mode: 3, compression: 1, planes: [rP, gP, bP, aP] }),
  );
  check("PSD RLE matches raw", px(p2, 2, 0).join() === "10,30,50,128");
  check("PSD RLE alpha 0 honoured", px(p2, 1, 1).slice(3).join() === "0");
  check("PSD RLE hasAlpha", p2.hasAlpha === true && p2.channels === 4);

  // grayscale
  const gray = Uint8Array.from([0, 64, 128, 255, 255, 200]);
  const p3 = decodePsd(buildPsd({ width: 3, height: 2, mode: 1, compression: 1, planes: [gray] }));
  check("PSD gray pixel", px(p3, 1, 1).join() === "255,255,255,255");
  check("PSD gray flag", p3.gray === true && p3.channels === 1);

  // PSB v2 (8-byte layer section length)
  const p4 = decodePsd(
    buildPsd({ width: 3, height: 2, mode: 3, compression: 0, planes: [rP, gP, bP], version: 2 }),
  );
  check("PSB v2 composite decodes", px(p4, 0, 1).join() === "20,40,60,255");

  // honest refusals
  const expectPsdCode = (label: string, err: unknown, code: string): void => {
    check(label, err instanceof PsdDecodeError && err.code === code, String(err));
  };
  {
    const b = buildPsd({ width: 3, height: 2, mode: 3, compression: 0, planes: [rP, gP, bP] });
    dv(b).setUint16(22, 16, false); // depth 16
    try {
      decodePsd(b);
      expectPsdCode("16-bit depth refused unsupported", new Error("no throw"), "unsupported");
    } catch (err) {
      expectPsdCode("16-bit depth refused unsupported", err, "unsupported");
    }
  }
  {
    const b = buildPsd({ width: 3, height: 2, mode: 3, compression: 0, planes: [rP, gP, bP] });
    dv(b).setUint16(24, 4, false); // CMYK
    try {
      decodePsd(b);
      expectPsdCode("CMYK mode refused unsupported", new Error("no throw"), "unsupported");
    } catch (err) {
      expectPsdCode("CMYK mode refused unsupported", err, "unsupported");
    }
  }
  {
    const b = buildPsd({ width: 3, height: 2, mode: 3, compression: 0, planes: [rP, gP, bP] });
    try {
      decodePsd(b.slice(0, 20));
      expectPsdCode("truncated refused corrupt", new Error("no throw"), "corrupt");
    } catch (err) {
      expectPsdCode("truncated refused corrupt", err, "corrupt");
    }
  }
  // RLE row-count table truncated
  {
    const b = buildPsd({ width: 3, height: 2, mode: 3, compression: 1, planes: [rP, gP, bP] });
    try {
      decodePsd(b.slice(0, b.length - 4));
      expectPsdCode("RLE data truncated refused corrupt", new Error("no throw"), "corrupt");
    } catch (err) {
      expectPsdCode("RLE data truncated refused corrupt", err, "corrupt");
    }
  }
}

/* ─── 3. CBZ helpers ─────────────────────────────────────────────────────── */

console.log("── 3. CBZ helpers + zip roundtrip ────────────────────────");
{
  check("natural: page-2 < page-10", naturalCompare("page-2.png", "page-10.png") < 0);
  check("natural: page-10 > page-9", naturalCompare("page-10.png", "page-9.png") > 0);
  check("natural: 002 == 2 stable", naturalCompare("p-002.png", "p-2.png") !== 0);
  check("natural: case-folded", naturalCompare("Page-2.png", "page-10.png") < 0);
  check("natural: folders group", naturalCompare("ch1/p-2.png", "ch2/p-1.png") < 0);
  check("junk: __MACOSX", isJunkEntry("__MACOSX/cover.png") === true);
  check("junk: nested __MACOSX", isJunkEntry("comic/__MACOSX/cover.png") === true);
  check("junk: .DS_Store", isJunkEntry(".DS_Store") === true);
  check("junk: dotfile", isJunkEntry("comic/.hidden.png") === true);
  check("not junk: normal page", isJunkEntry("ch1/page-2.png") === false);
  check("ext: jpg", hasImageExtension("a/b.JPG"));
  check("ext: jpeg", hasImageExtension("page.jpeg"));
  check("ext: bmp", hasImageExtension("p.bmp"));
  check("ext: txt not an image", hasImageExtension("notes.txt") === false);
  check("ext: no dot", hasImageExtension("README") === false);

  const sorted = filterAndSortImageEntries([
    "page-10.png",
    "page-2.png",
    "cover.jpg",
    "__MACOSX/junk.png",
    ".DS_Store",
    "notes.txt",
    "ch1/p-2.png",
    "ch1/p-10.png",
    "ch2/p-1.png",
    "page-1.bmp",
  ]);
  check(
    "filter + natural sort",
    JSON.stringify(sorted) ===
      JSON.stringify([
        "ch1/p-2.png",
        "ch1/p-10.png",
        "ch2/p-1.png",
        "cover.jpg",
        "page-1.bmp",
        "page-2.png",
        "page-10.png",
      ]),
    JSON.stringify(sorted),
  );

  // own zip roundtrip (the CBZ open path)
  const archive = zipSync({
    "cover.jpg": Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    "page-2.bmp": buildBmp24(1, 1, [7, 8, 9]),
    "page-10.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 5]),
  });
  const opened = unzipSync(archive);
  check("zip roundtrip entries", Object.keys(opened).length === 3);
  check("zip roundtrip bytes", opened["cover.jpg"]!.length === 7 && opened["page-10.png"]![3] === 0x47);
  const paths = filterAndSortImageEntries(Object.keys(opened));
  check("cbz page order", JSON.stringify(paths) === JSON.stringify(["cover.jpg", "page-2.bmp", "page-10.png"]));
}

/* ─── 4. EML engine ──────────────────────────────────────────────────────── */

console.log("── 4. EML engine ─────────────────────────────────────────");
{
  const qp = (bytes: Uint8Array): string => {
    let out = "";
    for (const b of bytes) {
      if (b === 0x3d) out += "=3D";
      else if (b < 0x7f && b >= 0x20) out += String.fromCharCode(b);
      else out += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
  };

  // 1. basic + folded header + RFC 2047 Hindi subject + QP Devanagari body
  const bodyText = "नमस्ते Meera,\nयह एक परीक्षण है।\n\nअंत।";
  const hindiSubject = "नमस्ते — परीक्षण";
  const b64Subject = btoa(String.fromCharCode(...enc.encode(hindiSubject)));
  const eml1 = [
    "From: Ravi Sharma <ravi@example.com>",
    "To: Meera Joshi <meera@example.com>,",
    "\tVikram <vikram@example.com>",
    `Subject: =?utf-8?B?${b64Subject}?=`,
    "Date: Thu, 12 Mar 2026 14:30:00 +0530",
    "Message-ID: <test-1@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp(enc.encode(bodyText)),
  ].join("\r\n");
  const doc1 = parseEml(enc.encode(eml1));
  check("from parsed", doc1.from === "Ravi Sharma <ravi@example.com>");
  check("folded To header", doc1.to === "Meera Joshi <meera@example.com>, Vikram <vikram@example.com>");
  check("RFC 2047 B Hindi subject", doc1.subject === hindiSubject, doc1.subject);
  check("date kept raw", doc1.date === "Thu, 12 Mar 2026 14:30:00 +0530");
  check("QP Devanagari body roundtrip", doc1.body === bodyText);
  check("no attachments", doc1.attachments.length === 0);
  check("body not html", doc1.bodyWasHtml === false);

  // 2. RFC 2047 Q word + latin-1
  const eml2 = [
    "From: =?utf-8?Q?R=C3=A9sum=C3=A9?= <r@example.com>",
    "Subject: =?iso-8859-1?Q?Caf=E9?=",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=E9 corner",
  ].join("\n");
  const doc2 = parseEml(enc.encode(eml2));
  check("2047 Q word decoded", doc2.from.startsWith("Résumé"));
  check("latin-1 subject decoded", doc2.subject === "Café");
  check("latin-1 body decoded", doc2.body === "Café corner");

  // 3. base64 body
  const b64Body = btoa("Hello from base64!\nSecond line.");
  const eml3 = [
    "From: a@b.c",
    "Subject: base64 test",
    "Content-Type: text/plain; charset=us-ascii",
    "Content-Transfer-Encoding: base64",
    "",
    b64Body.split(/(.{10})/).filter(Boolean).join("\n"),
  ].join("\r\n");
  const doc3 = parseEml(enc.encode(eml3));
  check("base64 body decoded across lines", doc3.body === "Hello from base64!\nSecond line.");

  // 4. multipart/alternative — plain preferred
  const eml4 = [
    "From: news@corp.example",
    "Subject: Weekly digest",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The plain truth.",
    "--B1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>The <b>HTML</b>&nbsp;truth.</p></body></html>",
    "--B1--",
  ].join("\r\n");
  const doc4 = parseEml(enc.encode(eml4));
  check("alternative prefers text/plain", doc4.body === "The plain truth." && doc4.bodyWasHtml === false);

  // 5. multipart/mixed — body + attachment (base64) + RFC 2231 filename*
  const attBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5]);
  const attB64 = btoa(String.fromCharCode(...attBytes));
  const eml5 = [
    "From: sender@example.com",
    "To: rcpt@example.com",
    "Subject: With attachment",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="MX"',
    "",
    "--MX",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Body with attached file.",
    "--MX",
    "Content-Type: application/pdf; name=\"x.pdf\"",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename=\"invoice.pdf\"",
    "",
    attB64,
    "--MX",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*=utf-8''%E0%A4%A8.pdf",
    "",
    attB64,
    "--MX--",
  ].join("\r\n");
  const doc5 = parseEml(enc.encode(eml5));
  check("mixed body kept", doc5.body === "Body with attached file.");
  check("attachment count", doc5.attachments.length === 2, String(doc5.attachments.length));
  check("attachment 1 filename", doc5.attachments[0]?.filename === "invoice.pdf");
  check("attachment 1 size = decoded bytes", doc5.attachments[0]?.size === attBytes.length);
  check("attachment 1 mime", doc5.attachments[0]?.mime === "application/pdf");
  check("RFC 2231 filename* decoded", doc5.attachments[1]?.filename === "न.pdf");

  // 6. HTML-only → fallback
  const eml6 = [
    "From: html@x.y",
    "Subject: html only",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><head><style>p{color:red}</style></head><body>",
    "<h1>Heading</h1>",
    "<p>First &amp; foremost &lt;tag&gt; caf&eacute; &#8212; done.</p>",
    "<ul><li>one</li><li>two</li></ul>",
    "</body></html>",
  ].join("\r\n");
  const doc6 = parseEml(enc.encode(eml6));
  check("html-only bodyWasHtml", doc6.bodyWasHtml === true);
  check("html entities decoded", doc6.body.includes("First & foremost <tag> café — done."));
  check("html lists flattened", doc6.body.includes("• one") && doc6.body.includes("• two"));
  check("style/script stripped", !doc6.body.includes("color:red"));

  // 7. not an email — honest refusal
  let refused = false;
  try {
    parseEml(enc.encode("hello world\nthis is just text\n\nno headers at all"));
  } catch (err) {
    refused = err instanceof EmlParseError;
  }
  check("plain text refused as not-email", refused);

  // 8. QP soft break joins lines
  const qpSoft = decodeQuotedPrintable(enc.encode("line one=\r\nline two"));
  check("QP soft break removed", new TextDecoder().decode(qpSoft) === "line oneline two");
  check("decodeRfc2047 passthrough", decodeRfc2047("plain subject") === "plain subject");
  check("htmlToPlainText <br>", htmlToPlainText("a<br>b") === "a\nb");
}

/* ─── 5. render integration ──────────────────────────────────────────────── */

console.log("── 5. Render integration (own engine + pdf-lib oracle) ───");
{
  // placement geometry
  const fit = computeImagePlacement(100, 50, { pageSize: "fit", orientation: "auto", margin: "none" });
  check("fit placement exact page", fit.pageW === 100 && fit.pageH === 50 && fit.x === 0 && fit.w === 100);
  const fitM = computeImagePlacement(100, 50, { pageSize: "fit", orientation: "auto", margin: "small" });
  check("fit placement + margin", fitM.pageW === 136 && fitM.pageH === 86 && fitM.x === 18 && fitM.w === 100);
  const a4auto = computeImagePlacement(100, 50, { pageSize: "a4", orientation: "auto", margin: "small" });
  check("a4 auto = landscape for wide image", a4auto.pageW === 841.89 && a4auto.pageH === 595.28);
  check("a4 contain-fit math", Math.abs(a4auto.w - 805.89) < 0.01 && Math.abs(a4auto.h - 402.95) < 0.01);
  const a4p = computeImagePlacement(100, 50, { pageSize: "a4", orientation: "portrait", margin: "none" });
  check("a4 forced portrait", a4p.pageW === 595.28 && a4p.pageH === 841.89 && Math.abs(a4p.w - 595.28) < 0.01);

  // BMP raster → hand-built PNG → own engine → pdf-lib reload
  const rgbFix = [
    255, 0, 0, 0, 255, 0, 0, 0, 255,
    255, 255, 0, 128, 64, 32, 16, 16, 16,
  ];
  const raster = decodeBmp(buildBmp24(3, 2, rgbFix));
  const png = buildPng(raster);
  check("hand-built PNG signature", png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
  const doc = CreateContext.create();
  const img = doc.embedPng(png);
  check("own engine embedPng dims", img.width === 3 && img.height === 2);
  const place = computeImagePlacement(img.width, img.height, {
    pageSize: "fit",
    orientation: "auto",
    margin: "small",
  });
  const page = doc.addPage(place.pageW, place.pageH);
  page.drawImage(img, { x: place.x, y: place.y, width: place.w, height: place.h });
  doc.setProducer("DocoPDF");
  const pdfBytes = doc.write();
  const reloaded = await PDFDocument.load(pdfBytes);
  check("pdf-lib reload: 1 page", reloaded.getPageCount() === 1);
  const rp = reloaded.getPage(0);
  check(
    "pdf-lib reload: page = image + 2×small margin",
    Math.abs(rp.getWidth() - (3 + 36)) < 0.01 && Math.abs(rp.getHeight() - (2 + 36)) < 0.01,
    `${rp.getWidth()}×${rp.getHeight()}`,
  );
  const embedded = await reloaded.save();
  check("pdf-lib reload: save roundtrip clean", embedded.length > 100);

  // email painter: pagination oracle (long body → 2 pages)
  const emailDoc = {
    subject: "Pagination test",
    from: "a@b.c",
    to: "d@e.f",
    cc: "",
    date: "Thu, 12 Mar 2026 14:30:00 +0530",
    body: Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog again and again for good measure.`).join("\n\n"),
    bodyWasHtml: false,
    attachments: [
      { filename: "report.pdf", size: 2048, mime: "application/pdf" },
    ],
  };
  const edoc = CreateContext.create();
  const face: ConvertFace = { std: "helvetica" };
  const pages = renderEmail(edoc, emailDoc, face, "helveticaBold", "a4", true, true);
  edoc.setProducer("DocoPDF");
  const emailBytes = edoc.write();
  const ereloaded = await PDFDocument.load(emailBytes);
  check("email painter: pages counted = pdf-lib page count", pages === ereloaded.getPageCount() && pages >= 2, String(pages));
  check("email painter: A4 geometry", Math.abs(ereloaded.getPage(0).getWidth() - 595.28) < 0.01);

  // multi-file sections: second email starts a fresh page
  const edoc2 = CreateContext.create();
  const p1 = renderEmail(edoc2, { ...emailDoc, body: "short body" }, face, "helveticaBold", "a4", true, false);
  const p2 = renderEmail(edoc2, { ...emailDoc, subject: "Second", body: "second body" }, face, "helveticaBold", "a4", true, false);
  check("second email = fresh page (page counts add)", p1 >= 1 && p2 >= 1 && edoc2.pageCount === p1 + p2);
}

/* ─── 6. worker discipline ───────────────────────────────────────────────── */

console.log("── 6. Worker discipline ───────────────────────────────────");
{
  for (const id of ["bmp-to-pdf", "psd-to-pdf", "cbz-to-pdf", "email-to-pdf"]) {
    const src = read(`tools/${id}/worker.ts`);
    check(`${id}: no network calls`, !/fetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(|require\s*\(/.test(src));
    check(`${id}: honest error codes`, src.includes('code: "tool.error'));
    check(`${id}: posts progress`, src.includes('type: "progress"'));
  }
  const bmpSrc = read("tools/bmp-to-pdf/worker.ts");
  check("bmp worker: signature gate before decode", bmpSrc.includes("isBmpBytes"));
  check("bmp worker: OWN decoder import", bmpSrc.includes("decodeBmp"));
  const cbzSrc = read("tools/cbz-to-pdf/worker.ts");
  check("cbz worker: OWN zip engine import", cbzSrc.includes("unzipSync"));
  check("cbz worker: honest archive refusal", cbzSrc.includes("errorNotArchive"));
  const emailSrc = read("tools/email-to-pdf/worker.ts");
  check("email worker: honest not-email refusal", emailSrc.includes("errorNotEmail"));
  const dropSrc = read("src/components/doco/tool/drop-zone.tsx");
  check("DropZone sniffs BMP magic", dropSrc.includes("0x42, 0x4d"));
  check("DropZone sniffs PSD magic", dropSrc.includes("0x38, 0x42, 0x50, 0x53"));
}

/* ─── summary ────────────────────────────────────────────────────────────── */

console.log("");
console.log(`P3-c smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
