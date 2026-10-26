/**
 * DocoPDF own QR engine — renderers (PNG data-URL + SVG string).
 * The PNG is encoded by our own pipeline (8-bit RGB, filter 0, zlib via
 * our own DEFLATE engine) — no external image libraries.
 */

import { createMatrix, type BitMatrix, type EccLevel } from "./encoder";
import { zlibSync } from "../zip/index";
import { crc32 } from "../zip/index";

export interface QrRenderOptions {
  errorCorrectionLevel?: EccLevel;
  margin?: number;
  width?: number;
  color?: { dark?: string; light?: string };
}

function parseHex(color: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!color) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Build the module matrix (public surface mirroring `qrcode`). */
export function create(payload: string | Uint8Array, opts: QrRenderOptions = {}): BitMatrix {
  return createMatrix(payload, opts.errorCorrectionLevel ?? "M");
}

/** Render as a PNG data URL. */
export function toDataURL(payload: string, opts: QrRenderOptions = {}): Promise<string> {
  const level = opts.errorCorrectionLevel ?? "M";
  const margin = Math.max(0, Math.min(10, opts.margin ?? 4));
  const targetWidth = Math.max(1, opts.width ?? 0);
  const dark = parseHex(opts.color?.dark, [0, 0, 0]);
  const light = parseHex(opts.color?.light, [255, 255, 255]);

  const matrix = createMatrix(payload, level);
  const total = matrix.size + margin * 2;
  // Integer scale that reaches at least the target (never 0).
  const scale = Math.max(1, Math.ceil(targetWidth / total));
  const px = total * scale;

  // Raw RGB rows with PNG filter byte 0 per scanline.
  const rowBytes = px * 3;
  const raw = new Uint8Array((rowBytes + 1) * px);
  for (let y = 0; y < px; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter: None
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - margin;
      const inMatrix = my >= 0 && my < matrix.size && mx >= 0 && mx < matrix.size;
      const isDark = inMatrix && matrix.data[my * matrix.size + mx] === 1;
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
  dv.setUint32(0, px); // width
  dv.setUint32(4, px); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: Uint8Array): void => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
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

  let bin = "";
  for (let i = 0; i < png.length; i++) bin += String.fromCharCode(png[i]);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(png).toString("base64");
  return Promise.resolve(`data:image/png;base64,${b64}`);
}

/** Render as an SVG string. */
export function toSVGString(payload: string, opts: QrRenderOptions = {}): Promise<string> {
  const level = opts.errorCorrectionLevel ?? "M";
  const margin = Math.max(0, Math.min(10, opts.margin ?? 4));
  const dark = (opts.color?.dark ?? "#000000").replace(/"/g, "");
  const light = (opts.color?.light ?? "#ffffff").replace(/"/g, "");

  const matrix = createMatrix(payload, level);
  const total = matrix.size + margin * 2;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="${light}"/>`,
    `<path fill="${dark}" d="`,
  ];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.data[r * matrix.size + c] === 1) {
        parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
      }
    }
  }
  parts.push(`"/></svg>`);
  return Promise.resolve(parts.join(""));
}
