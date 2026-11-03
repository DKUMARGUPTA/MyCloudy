/**
 * DocoPDF own barcode engine — renderers (SVG string + PNG data URL).
 *
 * SVG is the primary export (crisp vectors, text as real glyphs via the
 * viewer's fonts). PNG rides our own zlib pipeline exactly like the QR
 * engine (8-bit RGB, filter 0) with integer module scaling so every bar
 * lands on whole pixels — no anti-aliased edges for scanners to trip on.
 *
 * The PNG stays text-free on purpose: rasterizing glyphs needs a font
 * engine, and the surface composes print output (PDF) natively with the
 * PDF's own Helvetica instead. PNG is the code itself + quiet zone.
 */

import { zlibSync, crc32 } from "../zip/index";
import type { BarcodeEncodeOk } from "./encoder";

export interface BarcodeRenderOptions {
  /** Bar height in px (SVG) / px (PNG). Default 90. */
  height?: number;
  /** Px per module unit. Default 3. */
  modulePx?: number;
  /** Include the quiet zone in the render. Default true. */
  quietZone?: boolean;
  /** Include the human-readable text (SVG only). Default true. */
  showText?: boolean;
  /** Text size in px (SVG only). Default 15. */
  fontPx?: number;
  color?: { dark?: string; light?: string };
}

function parseHex(
  color: string | undefined,
  fallback: [number, number, number]
): [number, number, number] {
  if (!color) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Geometry shared by both renderers: [x, width] per bar, in module units. */
export function barGeometry(result: BarcodeEncodeOk): {
  bars: { x: number; w: number }[];
  total: number;
} {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  result.elements.forEach((w, idx) => {
    if (idx % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return { bars, total: x };
}

/** Render as a standalone SVG string (bars + optional human text). */
export function barcodeToSvg(
  result: BarcodeEncodeOk,
  opts: BarcodeRenderOptions = {}
): string {
  const height = Math.max(20, opts.height ?? 90);
  const modulePx = Math.max(0.5, opts.modulePx ?? 3);
  const withQuiet = opts.quietZone !== false;
  const showText = opts.showText !== false;
  const fontPx = Math.max(8, opts.fontPx ?? 15);
  const dark = opts.color?.dark ?? "#000000";
  const light = opts.color?.light ?? "#ffffff";

  const { bars, total } = barGeometry(result);
  const quietUnits = withQuiet ? result.quiet : 0;
  const textH = showText ? Math.round(fontPx * 1.9) : 0;
  const barTop = 0;
  const wSvg = (total + quietUnits * 2) * modulePx;
  const hSvg = height + textH;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wSvg}" height="${hSvg}" viewBox="0 0 ${wSvg} ${hSvg}" role="img" aria-label="${escapeXml(result.humanText)}">`
  );
  parts.push(
    `<rect width="${wSvg}" height="${hSvg}" fill="${light}"/>`
  );
  const barGroup: string[] = [];
  for (const b of bars) {
    barGroup.push(
      `<rect x="${((b.x + quietUnits) * modulePx).toFixed(2)}" y="${barTop}" width="${(b.w * modulePx).toFixed(2)}" height="${height}" fill="${dark}"/>`
    );
  }
  parts.push(barGroup.join(""));
  if (showText) {
    const baseline = height + fontPx * 1.15;
    if (result.textAnchors.length > 0) {
      for (const anchor of result.textAnchors) {
        const x = (anchor.x + quietUnits) * modulePx;
        const align =
          anchor.align === "center"
            ? "middle"
            : anchor.align === "right"
              ? "end"
              : "start";
        parts.push(
          `<text x="${x.toFixed(2)}" y="${baseline.toFixed(2)}" text-anchor="${align}" font-family="monospace" font-size="${fontPx}" letter-spacing="${(fontPx * 0.08).toFixed(1)}" fill="${dark}">${escapeXml(anchor.text)}</text>`
        );
      }
    } else {
      parts.push(
        `<text x="${(wSvg / 2).toFixed(2)}" y="${baseline.toFixed(2)}" text-anchor="middle" font-family="monospace" font-size="${fontPx}" fill="${dark}">${escapeXml(result.humanText)}</text>`
      );
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Render as a PNG data URL (own zlib; integer module scale, no text). */
export function barcodeToPngDataUrl(
  result: BarcodeEncodeOk,
  opts: BarcodeRenderOptions = {}
): string {
  const height = Math.max(20, Math.round(opts.height ?? 90));
  const withQuiet = opts.quietZone !== false;
  const dark = parseHex(opts.color?.dark, [0, 0, 0]);
  const light = parseHex(opts.color?.light, [255, 255, 255]);

  const { bars, total } = barGeometry(result);
  const quietUnits = withQuiet ? result.quiet : 0;
  // Integer scale: 1 module = N px so bars stay pixel-sharp.
  const targetWidth = Math.max(1, opts.modulePx ?? 3);
  const scale = Math.max(1, Math.round(targetWidth));
  const pxW = (total + quietUnits * 2) * scale;
  const pxH = height;

  // Boolean row of dark modules (compressed geometry → module map).
  const darkModules = new Uint8Array(total);
  for (const b of bars) {
    for (let m = b.x; m < b.x + b.w; m += 1) darkModules[m] = 1;
  }

  const rowBytes = pxW * 3;
  const raw = new Uint8Array((rowBytes + 1) * pxH);
  for (let y = 0; y < pxH; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < pxW; x += 1) {
      const m = Math.floor(x / scale) - quietUnits;
      const isDark = m >= 0 && m < total && darkModules[m] === 1;
      const [r, g, b] = isDark ? dark : light;
      const o = rowStart + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }

  const idat = zlibSync(raw, 6);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, pxW);
  dv.setUint32(4, pxH);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: Uint8Array): void => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(head.subarray(4));
    crcInput.set(data, 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(crcInput));
    const out = new Uint8Array(12 + data.length);
    out.set(head);
    out.set(data, 8);
    out.set(crc, 8 + data.length);
    chunks.push(out);
  };
  chunk("IHDR", ihdr);
  chunk("IDAT", idat);
  chunk("IEND", new Uint8Array(0));

  const totalLen = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(totalLen);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let p = 8;
  for (const c of chunks) {
    png.set(c, p);
    p += c.length;
  }

  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < png.length; i += CHUNK) {
    binary += String.fromCharCode(...png.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
