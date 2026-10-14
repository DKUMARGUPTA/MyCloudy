/**
 * PRE-BUILD smoke test for the PRD §7.10 P1 image converters (Task 1-b).
 * bun has NO OffscreenCanvas, so this proves everything that must be true
 * BEFORE the browser worker runs: the pure engine (HEIC sniff, output
 * naming, quality clamps, alpha math) and the REAL libheif decode path —
 * driven through the production function decodeHeicWithModule with the
 * very bundle deployed at /heic/libheif-bundle.mjs.
 *
 *  1.  HEIC magic sniff: real fixture heads pass; PNG / JPEG / WEBP /
 *      non-HEIC ftyp / short buffers fail.
 *  2.  baseName sanitizing (extension strip, hostile chars, fallback).
 *  3.  Collision suffixes are deterministic (photo, photo-2, photo-3 …).
 *  4.  Quality clamps at every boundary.
 *  5.  rgb→rgba and rgba→rgb on synthetic data (incl. stride + alpha mix).
 *  6.  libheif REAL decode of both QA fixtures (96x64 + 320x240
 *      gradients): dims, plane→RGBA layout, exact spot pixels, determinism.
 *  7.  Decode failures map to the honest error (non-HEIC bytes, truncated
 *      HEIC, empty buffer).
 *  8.  i18n.json key-tree parity (en ↔ hi) for the imgconv section.
 *
 * Run: bun scripts/smoke-imgconvert.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clampQualityPercent,
  decodeAppliesOrientation,
  rgbToRgba,
  rgbaToRgb,
  sanitizeBaseName,
  sniffIsHeic,
  uniqueOutputName,
} from "../tools/imgconvert/engine";
import {
  decodeHeicWithModule,
  type HeifModule,
} from "../tools/imgconvert/heif";
import i18n from "../tools/imgconvert/i18n.json";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = new URL(
  `file://${join(ROOT, "public", "heic", "libheif-bundle.mjs")}`
).href;

let passed = 0;
let failed = 0;
let checkNo = 0;

function check(ok: boolean, label: string): void {
  checkNo += 1;
  if (ok) {
    passed += 1;
    console.log(`${checkNo}. ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`${checkNo}. ✗ ${label}`);
  }
}

function eq(
  actual: unknown,
  expected: unknown,
  label: string
): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    ok,
    ok ? label : `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

function bytes(numbers: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(numbers.length));
  out.set(numbers);
  return out;
}

/** ftyp head builder: size, "ftyp", brand, 0 minor version. */
function ftypHead(brand: string): Uint8Array {
  const out = new Uint8Array(12);
  out[0] = 0x00;
  out[1] = 0x00;
  out[2] = 0x00;
  out[3] = 0x18;
  out.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  for (let i = 0; i < 4; i += 1) out[8 + i] = brand.charCodeAt(i);
  return out;
}

async function loadHeif(): Promise<HeifModule> {
  const mod = (await import(BUNDLE)) as {
    default: () => Promise<HeifModule> | HeifModule;
  };
  const maybe = mod.default();
  return maybe && typeof (maybe as { then?: unknown }).then === "function"
    ? ((await maybe) as HeifModule)
    : maybe;
}

function pixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number
): [number, number, number, number] {
  const o = (y * width + x) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

async function main(): Promise<void> {
  /* ---- 1. HEIC magic sniff ------------------------------------------- */
  // readFile Buffers are pooled views — copy into exact-size ArrayBuffers
  // so .buffer arithmetic below can never read the wrong bytes.
  const fixture = new Uint8Array(
    await readFile(join(ROOT, "download", "qa-p315-heic-fixture.heic"))
  );
  const large = new Uint8Array(
    await readFile(join(ROOT, "download", "qa-p315-heic-large.heic"))
  );
  check(
    sniffIsHeic(fixture.subarray(0, 12)),
    "sniff accepts real heic fixture head (brand heic)"
  );
  check(
    sniffIsHeic(large.subarray(0, 12)),
    "sniff accepts large fixture head"
  );
  for (const brand of ["heix", "hevc", "mif1", "msf1"]) {
    check(
      sniffIsHeic(ftypHead(brand)),
      `sniff accepts ftyp brand ${brand}`
    );
  }
  check(
    !sniffIsHeic(
      bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    ),
    "sniff rejects PNG magic"
  );
  check(
    !sniffIsHeic(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])),
    "sniff rejects JPEG magic"
  );
  check(
    !sniffIsHeic(bytes([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])),
    "sniff rejects WEBP (RIFF....WEBP)"
  );
  check(!sniffIsHeic(ftypHead("isom")), "sniff rejects ftyp brand isom");
  check(
    !sniffIsHeic(bytes([0x66, 0x74, 0x79, 0x70])),
    "sniff rejects short buffer"
  );

  /* ---- 2. baseName sanitizing --------------------------------------- */
  eq(sanitizeBaseName("photo.heic"), "photo", "baseName strips .heic");
  eq(sanitizeBaseName("IMG_2043.HEIC"), "IMG_2043", "baseName strips .HEIC (case-insensitive)");
  eq(sanitizeBaseName("holiday pic.jpeg"), "holiday pic", "baseName strips .jpeg");
  eq(
    sanitizeBaseName("weird/name*with:chars?.webp"),
    "weird_name_with_chars_",
    "baseName replaces hostile characters"
  );
  eq(sanitizeBaseName(".heic"), "image", "baseName falls back when nothing is left");
  eq(sanitizeBaseName("noextension"), "noextension", "baseName keeps extensionless names");
  eq(
    sanitizeBaseName(`${"x".repeat(130)}.png`).length,
    120,
    "baseName caps length at 120"
  );

  /* ---- 3. collision suffixes ---------------------------------------- */
  const taken = new Set<string>();
  const seq = ["photo.heic", "photo.webp", "photo.jpeg"].map((name) =>
    uniqueOutputName(sanitizeBaseName(name), "jpg", taken)
  );
  eq(seq, ["photo.jpg", "photo-2.jpg", "photo-3.jpg"], "collision sequence photo/-2/-3 is deterministic");
  const takenB = new Set<string>();
  eq(
    [uniqueOutputName("a", "png", takenB), uniqueOutputName("b", "png", takenB)],
    ["a.png", "b.png"],
    "distinct bases never collide"
  );
  const takenC = new Set<string>(["A.jpg", "A-2.jpg"]);
  eq(
    uniqueOutputName("A", "jpg", takenC),
    "A-3.jpg",
    "suffix continues after pre-taken names"
  );
  const takenD = new Set<string>();
  uniqueOutputName("photo", "jpg", takenD);
  eq(uniqueOutputName("photo-2", "jpg", takenD), "photo-2.jpg", "literal -2 base coexists with suffixed output");

  /* ---- 4. quality clamps -------------------------------------------- */
  eq(clampQualityPercent(40), 40, "quality 40 stays 40");
  eq(clampQualityPercent(95), 95, "quality 95 stays 95");
  eq(clampQualityPercent(39), 40, "quality 39 clamps up to 40");
  eq(clampQualityPercent(96), 95, "quality 96 clamps down to 95");
  eq(clampQualityPercent(undefined), 90, "missing quality becomes 90 (PNG tools)");
  eq(clampQualityPercent("abc"), 90, "garbage quality becomes 90");
  eq(clampQualityPercent("75"), 75, "numeric string quality parses");
  eq(clampQualityPercent(72.6), 73, "fractional quality rounds");

  /* ---- 5. rgb→rgba / rgba→rgb ---------------------------------------- */
  const rgba = rgbToRgba(bytes([10, 20, 30, 40, 50, 60]), 2, 1);
  eq(
    Array.from(rgba),
    [10, 20, 30, 255, 40, 50, 60, 255],
    "rgbToRgba expands with alpha 255"
  );
  // stride-padded plane: 1px wide, stride 6 (3 used + 3 padding)
  const padded = rgbToRgba(
    bytes([10, 20, 30, 99, 99, 99, 40, 50, 60, 99, 99, 99]),
    1,
    2,
    6
  );
  eq(
    Array.from(padded),
    [10, 20, 30, 255, 40, 50, 60, 255],
    "rgbToRgba honors padded stride"
  );
  // alpha mix: opaque passes through, 0 takes background, 128 composites
  const rgb = rgbaToRgb(
    bytes([10, 20, 30, 255, 200, 100, 50, 0, 10, 20, 30, 128]),
    1,
    3
  );
  eq(
    Array.from(rgb),
    [10, 20, 30, 255, 255, 255, 132, 137, 142],
    "rgbaToRgb flattens opaque/transparent/50% over white"
  );
  const rgbBlack = rgbaToRgb(bytes([10, 20, 30, 128]), 1, 1, {
    background: [0, 0, 0],
  });
  eq(Array.from(rgbBlack), [5, 10, 15], "rgbaToRgb composites over custom background");
  // stride-padded RGBA: 1px wide, stride 8 (4 used + 4 padding)
  const rgbStride = rgbaToRgb(
    bytes([10, 20, 30, 255, 9, 9, 9, 9, 200, 100, 50, 0, 9, 9, 9, 9]),
    1,
    2,
    { stride: 8 }
  );
  eq(Array.from(rgbStride), [10, 20, 30, 255, 255, 255], "rgbaToRgb honors padded stride");
  // round-trip: rgba → rgb → rgba equals flatten-over-white with alpha 255
  const flat = rgbToRgba(
    rgbaToRgb(bytes([10, 20, 30, 128, 40, 50, 60, 0]), 2, 1),
    2,
    1
  );
  eq(
    Array.from(flat),
    [132, 137, 142, 255, 255, 255, 255, 255],
    "worker JPG pipeline: rgba→rgb→rgba is opaque flatten over white"
  );
  check(
    decodeAppliesOrientation("bitmap") && decodeAppliesOrientation("heif-wasm"),
    "orientation note helper: both decode paths bake orientation in"
  );

  /* ---- 6. libheif REAL decode ---------------------------------------- */
  const libheif = await loadHeif();
  const small = decodeHeicWithModule(libheif, fixture.buffer);
  eq(small.width, 96, "fixture decodes to width 96");
  eq(small.height, 64, "fixture decodes to height 64");
  eq(small.data.length, 96 * 64 * 4, "fixture plane becomes RGBA ImageData layout");
  eq(pixel(small.data, 96, 0, 0), [0, 0, 0, 255], "fixture px(0,0) is (0,0,0,255)");
  eq(
    pixel(small.data, 96, 95, 63),
    [252, 251, 159, 255],
    "fixture px(95,63) is (252,251,159,255) — gradient end"
  );
  eq(
    pixel(small.data, 96, 48, 32),
    [126, 128, 79, 255],
    "fixture px(48,32) mid-gradient matches"
  );
  check(
    small.data.every((_b, i) => i % 4 !== 3 || small.data[i] === 255),
    "fixture alpha plane is fully opaque"
  );
  const largeDecoded = decodeHeicWithModule(libheif, large.buffer);
  eq(largeDecoded.width, 320, "large fixture decodes to width 320");
  eq(largeDecoded.height, 240, "large fixture decodes to height 240");
  eq(largeDecoded.data.length, 320 * 240 * 4, "large fixture plane length exact");
  eq(pixel(largeDecoded.data, 320, 0, 0), [0, 0, 0, 255], "large px(0,0)");
  eq(pixel(largeDecoded.data, 320, 319, 239), [129, 183, 125, 255], "large px(319,239)");
  eq(pixel(largeDecoded.data, 320, 160, 120), [82, 83, 211, 255], "large px(160,120)");
  const smallAgain = decodeHeicWithModule(libheif, fixture.slice().buffer);
  check(
    Buffer.compare(Buffer.from(small.data), Buffer.from(smallAgain.data)) === 0,
    "decode is deterministic (two runs byte-identical)"
  );

  /* ---- 7. failure paths map to the honest error --------------------- */
  let threw = "";
  try {
    decodeHeicWithModule(libheif, bytes([0x89, 0x50, 0x4e, 0x47]).buffer);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  eq(threw, "imgconv:heic", "PNG bytes fail with imgconv:heic");
  threw = "";
  try {
    decodeHeicWithModule(
      libheif,
      fixture.slice(0, 40).buffer
    );
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  eq(threw, "imgconv:heic", "truncated HEIC fails with imgconv:heic");
  threw = "";
  try {
    decodeHeicWithModule(libheif, new ArrayBuffer(0));
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  eq(threw, "imgconv:heic", "empty buffer fails with imgconv:heic");
  // A failing decode must not poison the next one (contexts are released).
  const after = decodeHeicWithModule(libheif, fixture.buffer);
  eq(after.width, 96, "decode still works after failures (cleanup held)");

  /* ---- 8. i18n parity ------------------------------------------------ */
  const enKeys = Object.keys(i18n.en.imgconv).sort();
  const hiKeys = Object.keys(i18n.hi.imgconv).sort();
  eq(
    enKeys,
    hiKeys,
    `imgconv i18n key parity en↔hi (${enKeys.join(", ")})`
  );
  check(
    enKeys.includes("errCorrupt") && enKeys.includes("errHeic"),
    "both worker error keys exist in i18n.json"
  );

  console.log(
    `\n${passed}/${passed + failed} checks passed${failed > 0 ? ` — ${failed} FAILED` : ""}`
  );
  if (failed > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error("SMOKE CRASHED:", error);
  process.exit(1);
});
