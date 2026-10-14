/**
 * QA fixture: synthetic "document photo" PNG (dev-only, not shipped).
 * Writes public/qa-scan-photo.png — a desk scene with a tilted white
 * page and text bars, for the Scan to PDF gallery-upload E2E path.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const PHOTO_W = 960;
const PHOTO_H = 720;
const PAGE_W = 200;
const PAGE_H = 260;

type Point = { x: number; y: number };
type Quad = [Point, Point, Point, Point];

const TRUE_QUAD: Quad = [
  { x: 180, y: 86 },
  { x: 840, y: 138 },
  { x: 783, y: 642 },
  { x: 138, y: 597 },
];

/** Independent 4-pair DLT (textbook form) — fixture oracle. */
function solveH(src: Quad, dst: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: xs, y: ys } = src[i];
    const { x: xd, y: yd } = dst[i];
    A.push([xd, yd, 1, 0, 0, 0, -xd * xs, -yd * xs]);
    b.push(xs);
    A.push([0, 0, 0, xd, yd, 1, -xd * ys, -yd * ys]);
    b.push(ys);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = A[row][col] / A[col][col];
      if (f === 0) continue;
      for (let k = col; k < 8; k++) A[row][k] -= f * A[col][k];
      b[row] -= f * b[col];
    }
  }
  const h = new Array(9).fill(0);
  for (let i = 0; i < 8; i++) h[i] = b[i] / A[i][i];
  h[8] = 1;
  return h;
}

function pageTexture(u: number, v: number): [number, number, number] {
  const inMargin = u > 24 && u < 176 && v > 14 && v < 246;
  const onTextLine = ((v - 18) % 24) < 8;
  if (inMargin && onTextLine && u % 7 !== 6) return [34, 33, 38];
  return [236, 233, 226];
}

const img = new Uint8ClampedArray(PHOTO_W * PHOTO_H * 4);
let seed = 42;
const rand = () => {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
};
const rect: Quad = [
  { x: 0, y: 0 },
  { x: PAGE_W - 1, y: 0 },
  { x: PAGE_W - 1, y: PAGE_H - 1 },
  { x: 0, y: PAGE_H - 1 },
];
const h = solveH(rect, TRUE_QUAD);
for (let y = 0; y < PHOTO_H; y++) {
  for (let x = 0; x < PHOTO_W; x++) {
    const w3 = h[6] * x + h[7] * y + h[8];
    const u = (h[0] * x + h[1] * y + h[2]) / w3;
    const v = (h[3] * x + h[4] * y + h[5]) / w3;
    const i = (y * PHOTO_W + x) * 4;
    if (u >= 0 && v >= 0 && u < PAGE_W && v < PAGE_H) {
      const [r, g, b] = pageTexture(Math.floor(u), Math.floor(v));
      img[i] = r;
      img[i + 1] = g;
      img[i + 2] = b;
    } else {
      const g = 62 + rand() * 26;
      img[i] = g;
      img[i + 1] = g;
      img[i + 2] = g;
    }
    img[i + 3] = 255;
  }
}

/* ---------------- PNG encode (RGBA, filter 0) ---------------- */

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const stride = 1 + PHOTO_W * 4;
const raw = Buffer.alloc(PHOTO_H * stride);
for (let y = 0; y < PHOTO_H; y++) {
  raw[y * stride] = 0;
  Buffer.from(img.buffer, y * PHOTO_W * 4, PHOTO_W * 4).copy(
    raw,
    y * stride + 1
  );
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(PHOTO_W, 0);
ihdr.writeUInt32BE(PHOTO_H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 6 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("public/qa-scan-photo.png", png);
console.log(`public/qa-scan-photo.png — ${PHOTO_W}×${PHOTO_H}, ${(png.length / 1024).toFixed(0)} KB`);
