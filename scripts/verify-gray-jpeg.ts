/**
 * gray-jpeg encoder verification (needs Python/PIL on the host):
 *   1. bun  scripts/verify-gray-jpeg.ts   — encodes test patterns
 *   2. python3 scripts/check-gray-jpeg.py — PIL-decodes + PSNR asserts
 *
 * Patterns: flat 128 (must round-trip exactly), smooth gradient, seeded
 * noise (lossy but structurally valid), and a non-multiple-of-8 size
 * (edge-replication path).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { encodeGrayJpeg, rgbaToGrayPlane } from "../tools/compress-pdf/gray-jpeg";

await mkdir("download/gray-qa", { recursive: true });

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cases: { name: string; w: number; h: number; q: number; make: (i: number, x: number, y: number) => number }[] = [
  { name: "flat", w: 96, h: 64, q: 75, make: () => 128 },
  { name: "gradient", w: 320, h: 200, q: 75, make: (i, x, y) => (x * 255) / 319 * 0.7 + (y * 255) / 199 * 0.3 },
  { name: "noise", w: 173, h: 131, q: 75, make: (i) => Math.floor(mulberry32(42 + i)() * 256) },
  { name: "odd", w: 61, h: 45, q: 90, make: (i, x, y) => ((x + y) % 2 === 0 ? 200 : 60) + (x % 7) },
];

for (const c of cases) {
  const rand = mulberry32(c.name.length * 7919);
  const gray = new Uint8Array(c.w * c.h);
  for (let y = 0; y < c.h; y += 1) {
    for (let x = 0; x < c.w; x += 1) {
      gray[y * c.w + x] = Math.max(0, Math.min(255, Math.round(c.make(y * c.w + x, x, y) + (c.name === "noise" ? 0 : (rand() - 0.5) * 0.01))));
    }
  }
  // Noise needs its own deterministic source per pixel — rebuild properly.
  if (c.name === "noise") {
    const r = mulberry32(4242);
    for (let i = 0; i < gray.length; i += 1) gray[i] = Math.floor(r() * 256);
  }
  const jpeg = encodeGrayJpeg(gray, c.w, c.h, c.q);
  await writeFile(`download/gray-qa/${c.name}.jpg`, jpeg);
  await writeFile(`download/gray-qa/${c.name}.bin`, gray);
  console.log(`${c.name}: ${c.w}x${c.h} q${c.q} → ${jpeg.length} bytes (starts ${[...jpeg.slice(0, 3)].map((b) => b.toString(16)).join(" ")})`);
}

// rgbaToGrayPlane sanity: pure red → 76, pure green → 150, pure blue → 29 (Rec.601).
const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
const plane = rgbaToGrayPlane(rgba, 3, 1);
console.log(`rgbaToGrayPlane: red=${plane[0]} green=${plane[1]} blue=${plane[2]} (expect 76/150/29)`);
if (plane[0] !== 76 || plane[1] !== 150 || plane[2] !== 29) {
  console.error("FAIL: rgbaToGrayPlane luminance is wrong");
  process.exit(1);
}
console.log("encoded all patterns → download/gray-qa/");
