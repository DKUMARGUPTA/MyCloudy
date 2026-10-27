/**
 * Generates public/scan-fixture.png — a synthetic "photo of a page on a
 * desk" for end-to-end QA of the Scan to PDF auto-detection:
 * dark desk with vignette + noise, slightly rotated bright page,
 * black letterhead + text lines + a signature-ish blob.
 * Run: bun scripts/make-scan-photo2.ts
 */
import { writeFileSync } from "node:fs";

const W = 1600;
const H = 1200;
const data = Buffer.alloc(W * H * 4);

// True page corners (slightly rotated + perspective).
const page = [
  [340, 240],
  [1290, 210],
  [1320, 1000],
  [310, 1040],
];

const inTri = (px: number, py: number, a, b, c) => {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const inside = (x: number, y: number) =>
  inTri(x + 0.5, y + 0.5, page[0], page[1], page[2]) ||
  inTri(x + 0.5, y + 0.5, page[0], page[2], page[3]);

const minX = Math.min(...page.map((p) => p[0]));
const maxX = Math.max(...page.map((p) => p[0]));
const minY = Math.min(...page.map((p) => p[1]));
const maxY = Math.max(...page.map((p) => p[1]));

// Soft page-hugging shadow on the desk (physical: perpendicular to edges).
const distToPage = (x: number, y: number): number => {
  let best = Infinity;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = page[i];
    const [xj, yj] = page[j];
    const ex = xj - xi;
    const ey = yj - yi;
    const t = Math.max(0, Math.min(1, ((x - xi) * ex + (y - yi) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - (xi + t * ex), y - (yi + t * ey)));
  }
  return best;
};

const noise = (x: number, y: number) => {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (v - Math.floor(v));
};

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const vign = 1 - 0.3 * Math.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2)) ** 2;
    const n = noise(x, y) * 12 - 6;
    let r: number;
    let g: number;
    let b: number;
    if (inside(x, y)) {
      const u = (x - minX) / (maxX - minX);
      const v = (y - minY) / (maxY - minY);
      let base = 238;
      if (v < 0.13) base = 38; // black letterhead
      else {
        const lp = ((y - minY) % 44) / 44;
        if (lp > 0.22 && lp < 0.44 && u > 0.09 && u < 0.91 && noise(x * 1.7, y * 0.9) > 0.34) base = 42;
      }
      // "paper" tint + lighting falloff on the page itself
      const lit = 0.94 + 0.06 * (1 - Math.abs(v - 0.5));
      r = base * lit * vign + n * 0.4;
      g = r;
      b = r - 2;
    } else {
      // desk (dark wood-ish) + shadow
      const d = distToPage(x, y);
      let desk = 88 * vign + n;
      if (d < 34) desk -= (34 - d) * 0.85;
      r = desk;
      g = desk * 0.96;
      b = desk * 0.9;
    }
    const o = (y * W + x) * 4;
    data[o] = Math.max(0, Math.min(255, r));
    data[o + 1] = Math.max(0, Math.min(255, g));
    data[o + 2] = Math.max(0, Math.min(255, b));
    data[o + 3] = 255;
  }
}

// --- Encode PNG (no deps: minimal zlib via node:zlib) ---
import { deflateSync } from "node:zlib";
function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typeB = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeB, body])));
  return Buffer.concat([len, typeB, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  data.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 6 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("public/scan-fixture.png", png);
console.log(`wrote public/scan-fixture.png (${(png.length / 1024).toFixed(0)} KB), page corners:`, JSON.stringify(page));
