/**
 * Decode-oracle artifacts for the imgconv round (P3.17): decodes the
 * HEIC fixtures with the same libheif path the worker uses and writes
 * them as PNGs so a VLM can confirm real, correct image content.
 *
 * Usage: bun scripts/make-imgconv-artifacts.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import {
  decodeHeifRgba,
  injectLibheifFactory,
} from "../tools/imgconv/libheif";

type Factory = (options?: Record<string, unknown>) => unknown;
injectLibheifFactory(
  (await import("../public/vendor/libheif/libheif-bundle.mjs")).default as Factory
);

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

function writePng(path: string, width: number, height: number, rgba: Uint8ClampedArray): void {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  console.log(`${path} — ${width}×${height}, ${(png.length / 1024).toFixed(0)} KB`);
}

const jobs: { src: string; out: string }[] = [
  { src: "/home/z/my-project/download/qa-icv-example.heic", out: "/home/z/my-project/download/qa-icv-example-decode.png" },
  { src: "/home/z/my-project/download/qa-icv-autumn.heic", out: "/home/z/my-project/download/qa-icv-autumn-decode.png" },
];

for (const job of jobs) {
  const bytes = new Uint8Array(readFileSync(job.src));
  const image = await decodeHeifRgba(bytes);
  writePng(job.out, image.width, image.height, image.data);
}
