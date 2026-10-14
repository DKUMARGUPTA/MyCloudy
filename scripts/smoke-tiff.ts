/**
 * Smoke tests for the clean-room TIFF writer (P3.19, PDF to TIFF).
 *
 * Three layers of verification:
 * 1. Units: header/IFD structure via an independent minimal parser written
 *    inside this script (magic, ascending tags, offsets, rationals,
 *    PageNumber, odd-strip padding, bad-input errors).
 * 2. Oracle: real libvips (sharp) decodes our LZW and uncompressed output
 *    — dimensions, channel count, DPI, and PIXEL-EXACT raw bytes — for
 *    single-page and multi-page files, plus a table-full (Clear+reset)
 *    stress on incompressible noise.
 * 3. Size sanity: LZW must beat None on page-like graphics.
 *
 * Usage: bun scripts/smoke-tiff.ts
 */
import { encodeTiff, lzwCompress } from "../tools/pdf-to-images/tiff-writer";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, note = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${note ? ` — ${note}` : ""}`);
  } else {
    failed += 1;
    failures.push(`${name}${note ? ` — ${note}` : ""}`);
    console.log(`  ✗ ${name}${note ? ` — ${note}` : ""}`);
  }
}

/** Deterministic PRNG so expected bytes are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ParsedIfd {
  entries: Map<number, { type: number; count: number; value: number }>;
  nextIfd: number;
}

/** Minimal independent little-endian TIFF reader (test-only). */
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
    const entries = new Map<number, { type: number; count: number; value: number }>();
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

/** Build an RGBA page from a pixel function; also returns expected RGB. */
function makePage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number]
): { rgba: Uint8ClampedArray; rgb: Uint8Array } {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0, s = 0, d = 0; p < width * height; p += 1, s += 4, d += 3) {
    const [r, g, b] = pixel(p % width, Math.floor(p / width));
    rgba[s] = r;
    rgba[s + 1] = g;
    rgba[s + 2] = b;
    rgba[s + 3] = 255;
    rgb[d] = r;
    rgb[d + 1] = g;
    rgb[d + 2] = b;
  }
  return { rgba, rgb };
}

async function main(): Promise<void> {
  console.log("TIFF writer — units (independent parser)");

  // 2x2 known pixels, both compressions.
  const page = makePage(2, 2, (x, y) => [10 * x, 20 * y, 30]);
  for (const compression of ["none", "lzw"] as const) {
    const tiff = encodeTiff(
      [{ width: 2, height: 2, rgba: page.rgba }],
      { compression, dpi: 150 }
    );
    const { ifds, readShort, readLong } = parseTiff(tiff);
    check(`${compression}: one IFD`, ifds.length === 1);
    check(`${compression}: NextIFD terminates`, ifds[0].nextIfd === 0);
    const e = ifds[0].entries;
    check(`${compression}: 13 entries`, e.size === 13, `got ${e.size}`);
    check(
      `${compression}: tags ascending`,
      [...e.keys()].every((tag, i, arr) => i === 0 || arr[i - 1] < tag)
    );
    check(`${compression}: width 2`, e.get(256)?.value === 2);
    check(`${compression}: height 2`, e.get(257)?.value === 2);
    check(
      `${compression}: BitsPerSample → offset`,
      (() => {
        const at = e.get(258)!.value;
        return (
          readShort(at) === 8 && readShort(at + 2) === 8 && readShort(at + 4) === 8
        );
      })()
    );
    check(
      `${compression}: Compression tag`,
      e.get(259)?.value === (compression === "none" ? 1 : 5)
    );
    check(`${compression}: Photometric RGB`, e.get(262)?.value === 2);
    check(`${compression}: SamplesPerPixel 3`, e.get(277)?.value === 3);
    check(`${compression}: RowsPerStrip = height`, e.get(278)?.value === 2);
    check(
      `${compression}: XResolution = 150/1 inch`,
      (() => {
        const at = e.get(282)!.value;
        return (
          readLong(at) === 150 &&
          readLong(at + 4) === 1 &&
          e.get(296)?.value === 2
        );
      })()
    );
    check(
      `${compression}: PageNumber [0,1] packed`,
      e.get(297)?.value === (0 | (1 << 16))
    );
    // Strip values land at even offsets.
    check(
      `${compression}: strip offset even`,
      (e.get(273)?.value ?? 1) % 2 === 0,
      `offset ${e.get(273)?.value}`
    );
  }

  // Multi-page structure: 3 IFDs chained, PageNumber correct.
  const red = makePage(3, 3, () => [200, 0, 0]);
  const green = makePage(3, 3, () => [0, 200, 0]);
  const blue = makePage(3, 3, () => [0, 0, 200]);
  const multi = encodeTiff(
    [
      { width: 3, height: 3, rgba: red.rgba },
      { width: 3, height: 3, rgba: green.rgba },
      { width: 3, height: 3, rgba: blue.rgba },
    ],
    { compression: "lzw", dpi: 300 }
  );
  {
    const { ifds } = parseTiff(multi);
    check("multi: 3 IFDs chained", ifds.length === 3);
    check("multi: IFD0 → IFD1", ifds[0].nextIfd !== 0);
    check("multi: IFD2 terminates", ifds[2].nextIfd === 0);
    check(
      "multi: PageNumbers",
      ifds[0].entries.get(297)?.value === 0 + (3 << 16) &&
        ifds[1].entries.get(297)?.value === 1 + (3 << 16) &&
        ifds[2].entries.get(297)?.value === 2 + (3 << 16)
    );
    check(
      "multi: distinct strips",
      ifds[0].entries.get(273)?.value !== ifds[1].entries.get(273)?.value
    );
  }

  // Odd strip: 1x1 uncompressed = 3 rgb bytes → padded to 4 (even offset
  // for the following IFD).
  {
    const one = makePage(1, 1, () => [7, 8, 9]);
    const tiff = encodeTiff([{ width: 1, height: 1, rgba: one.rgba }], {
      compression: "none",
    });
    const { ifds } = parseTiff(tiff);
    const counts = ifds[0].entries.get(279)!.value;
    check("odd strip: byte count is true length 3", counts === 3);
    check(
      "odd strip: IFD offset even",
      ifds[0].entries.get(273)!.value % 2 === 0
    );
  }

  // Defensive errors.
  {
    let threw = "";
    try {
      encodeTiff([{ width: 2, height: 2, rgba: new Uint8ClampedArray(3) }]);
    } catch (error) {
      threw = (error as Error).message;
    }
    check("bad rgba length throws", threw === "tiff-bad-page");
    threw = "";
    try {
      encodeTiff([]);
    } catch (error) {
      threw = (error as Error).message;
    }
    check("no pages throws", threw === "tiff-no-pages");
  }

  // LZW pure unit: incompressible noise passes through with overhead only.
  {
    const rand = mulberry32(7);
    const noise = new Uint8Array(10000);
    for (let i = 0; i < noise.length; i += 1) noise[i] = Math.floor(rand() * 256);
    const compressed = lzwCompress(noise);
    check(
      "lzw noise overhead bounded",
      compressed.length < noise.length * 1.5,
      `${noise.length} → ${compressed.length}`
    );
    // Highly repetitive data must compress hard.
    const flat = new Uint8Array(10000).fill(65);
    check(
      "lzw flat compresses >10x",
      lzwCompress(flat).length < 1000,
      `${lzwCompress(flat).length} bytes`
    );
  }

  console.log("\nTIFF writer — libvips (sharp) oracle decode");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require("sharp") as typeof import("sharp");

  // Single page, odd dimensions, gradient content, LZW + None.
  for (const compression of ["lzw", "none"] as const) {
    const { rgba, rgb } = makePage(137, 89, (x, y) => [
      (x * 7) % 256,
      (y * 3) % 256,
      (x + y) % 256,
    ]);
    const tiff = encodeTiff([{ width: 137, height: 89, rgba }], {
      compression,
      dpi: 150,
    });
    const image = sharp(Buffer.from(tiff.buffer, tiff.byteOffset, tiff.byteLength));
    const meta = await image.metadata();
    check(`${compression}: format tiff`, meta.format === "tiff");
    check(`${compression}: size 137x89`, meta.width === 137 && meta.height === 89);
    check(`${compression}: 3 channels`, meta.channels === 3);
    check(
      `${compression}: density 150`,
      Math.round(meta.density ?? 0) === 150,
      `got ${meta.density}`
    );
    const { data } = await image.raw().toBuffer({ resolveWithObject: true });
    let equal = data.length === rgb.length;
    if (equal) {
      for (let i = 0; i < rgb.length; i += 1) {
        if (data[i] !== rgb[i]) {
          equal = false;
          break;
        }
      }
    }
    check(`${compression}: pixels byte-exact`, equal);
  }

  // Multi-page decode: sharp reads pages, page selector, pixel match.
  {
    const p0 = makePage(41, 31, (x) => [(x * 5) % 256, 40, 90]);
    const p1 = makePage(41, 31, (x, y) => [10, (x * 5) % 256, (y * 5) % 256]);
    const p2 = makePage(41, 31, (x, y) => [(x + y) % 256, 0, 128]);
    const tiff = encodeTiff(
      [
        { width: 41, height: 31, rgba: p0.rgba },
        { width: 41, height: 31, rgba: p1.rgba },
        { width: 41, height: 31, rgba: p2.rgba },
      ],
      { compression: "lzw", dpi: 300 }
    );
    const buf = Buffer.from(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const meta = await sharp(buf).metadata();
    check("multi: sharp sees 3 pages", meta.pages === 3, `got ${meta.pages}`);
    const expectations = [p0.rgb, p1.rgb, p2.rgb];
    for (let page = 0; page < 3; page += 1) {
      const { data } = await sharp(buf, { page })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const rgb = expectations[page];
      let equal = data.length === rgb.length;
      if (equal) {
        for (let i = 0; i < rgb.length; i += 1) {
          if (data[i] !== rgb[i]) {
            equal = false;
            break;
          }
        }
      }
      check(`multi: page ${page + 1} pixels byte-exact`, equal);
    }
  }

  // Table-full stress: noise fills the 4096-entry LZW dictionary → Clear +
  // reset path; libvips must still decode byte-exact.
  {
    const rand = mulberry32(99);
    const { rgba, rgb } = makePage(400, 300, () => [
      Math.floor(rand() * 256),
      Math.floor(rand() * 256),
      Math.floor(rand() * 256),
    ]);
    const tiff = encodeTiff([{ width: 400, height: 300, rgba }], {
      compression: "lzw",
      dpi: 72,
    });
    const buf = Buffer.from(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const { data, info } = await sharp(buf)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let equal = data.length === rgb.length && info.width === 400 && info.height === 300;
    if (equal) {
      for (let i = 0; i < rgb.length; i += 1) {
        if (data[i] !== rgb[i]) {
          equal = false;
          break;
        }
      }
    }
    check("table-full: noise decodes byte-exact", equal);
  }

  // LZW beats None on page-like graphics (text/line-art compresses well).
  {
    const { rgba } = makePage(300, 200, (x, y) => {
      const band = Math.floor(y / 10) % 2;
      return band === 0 ? [250, 250, 245] : [(x * 2) % 64 + 30, 30, 40];
    });
    const lzw = encodeTiff([{ width: 300, height: 200, rgba }], {
      compression: "lzw",
    });
    const none = encodeTiff([{ width: 300, height: 200, rgba }], {
      compression: "none",
    });
    check(
      "lzw smaller than none",
      lzw.length < none.length,
      `${lzw.length} < ${none.length} (${Math.round((1 - lzw.length / none.length) * 100)}% saved)`
    );
  }

  console.log(
    `\n${passed} passed, ${failed} failed${failed ? `\nFAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}` : ""}`
  );
  if (failed > 0) process.exit(1);
}

void main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
