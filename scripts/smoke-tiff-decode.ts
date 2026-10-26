/**
 * Smoke tests for the clean-room TIFF reader (P3.20, TIFF to PDF).
 *
 * Four layers of verification:
 * 1. Round-trip: our own writer's output (LZW + None, multi-page, DPI)
 *    decodes back to byte-exact RGBA — including the strict-GIF width
 *    rhythm via the writer's test-only lzwGifFlavor flag.
 * 2. Oracle: real libvips (sharp) ENCODES TIFFs in the flavours real
 *    files use — lzw, lzw+predictor, none, packbits, deflate, grayscale,
 *    ccittfax4 (G4), tiled — and our decoder must match sharp's own
 *    decode of the same pixels.
 * 3. White-box: hand-built IFDs for MM (big-endian), palette, 16-bit
 *    gray, Orientation 6 — the variants sharp cannot produce.
 * 4. Error paths: BigTIFF, JPEG-in-TIFF, truncated files — clean
 *    tiff-unsupported / tiff-corrupt markers, never a crash.
 *
 * Usage: bun scripts/smoke-tiff-decode.ts
 */
import sharp from "sharp";
import {
  decodeTiffPages,
  isTiffBytes,
  TiffFile,
  TiffError,
} from "../tools/imgconv/tiff";
import { encodeTiff } from "../tools/pdf-to-images/tiff-writer";
import { inflateSync } from "../src/lib/own/zip/index";

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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Colored gradient + noise page in RGBA. */
function makeRgba(
  width: number,
  height: number,
  seed: number,
  noise = false
): Uint8ClampedArray {
  const rand = mulberry32(seed);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      rgba[at] = (x * 255) / Math.max(1, width - 1);
      rgba[at + 1] = (y * 255) / Math.max(1, height - 1);
      rgba[at + 2] = noise ? rand() * 256 : 160 - (x + y) * 0.3;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

function rgbaEqualsRgb(rgba: Uint8ClampedArray, rgb: Uint8Array, pixels: number): boolean {
  if (rgba.length !== pixels * 4) return false;
  for (let p = 0, s = 0, d = 0; p < pixels; p += 1, s += 3, d += 4) {
    if (rgba[d] !== rgb[s] || rgba[d + 1] !== rgb[s + 1] || rgba[d + 2] !== rgb[s + 2]) {
      return false;
    }
  }
  return true;
}

console.log("TIFF reader smoke — round-trip + sharp oracle + white-box + errors\n");

/* ---------------- 1. Round-trip with our writer ---------------- */
function rgbaToRgb(rgba: Uint8ClampedArray): Uint8Array {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0, s = 0, d = 0; p < pixels; p += 1, s += 4, d += 3) {
    rgb[d] = rgba[s];
    rgb[d + 1] = rgba[s + 1];
    rgb[d + 2] = rgba[s + 2];
  }
  return rgb;
}

{
  console.log("round-trip (own writer)");
  const pages = [
    { width: 64, height: 48, rgba: makeRgba(64, 48, 1) },
    { width: 80, height: 30, rgba: makeRgba(80, 30, 2, true) },
    { width: 17, height: 23, rgba: makeRgba(17, 23, 3) },
  ];
  for (const compression of ["lzw", "none"] as const) {
    const bytes = encodeTiff(pages, { compression, dpi: 300 });
    const decoded = decodeTiffPages(bytes);
    const allExact =
      decoded.length === 3 &&
      decoded.every(
        (p, i) =>
          p.width === pages[i].width &&
          p.height === pages[i].height &&
          p.dpi === 300 &&
          rgbaEqualsRgb(
            p.rgba,
            rgbaToRgb(pages[i].rgba),
            pages[i].width * pages[i].height
          )
      );
    check(`${compression}: byte-exact 3-page round-trip + dpi`, allExact);
  }
}

{
  // GIF-flavour LZW (one-code-later width switch) must decode via retry.
  const page = { width: 200, height: 90, rgba: makeRgba(200, 90, 7, true) };
  const bytes = encodeTiff([page], { compression: "lzw", lzwGifFlavor: true, dpi: 72 });
  const decoded = decodeTiffPages(bytes);
  check(
    "lzw gif-flavour decodes via verify+retry",
    decoded.length === 1 &&
      rgbaEqualsRgb(decoded[0].rgba, rgbaToRgb(page.rgba), 200 * 90)
  );

  // Table-full stress: noise forces Clear+reset cycles.
  const big = { width: 220, height: 220, rgba: makeRgba(220, 220, 11, true) };
  const bigBytes = encodeTiff([big], { compression: "lzw" });
  const bigDecoded = decodeTiffPages(bigBytes);
  check(
    "lzw table-full stress",
    rgbaEqualsRgb(bigDecoded[0].rgba, rgbaToRgb(big.rgba), 220 * 220)
  );

  // Empty-strip page (0-byte image is illegal in the writer, 1x1 minimal):
  const tiny = { width: 1, height: 1, rgba: new Uint8ClampedArray([9, 8, 7, 255]) };
  const tinyDecoded = decodeTiffPages(encodeTiff([tiny], { compression: "lzw" }));
  check("1×1 lzw", tinyDecoded[0].rgba[0] === 9 && tinyDecoded[0].rgba[2] === 7);
}

/* ---------------- 2. sharp oracle ---------------- */
{
  console.log("sharp oracle (real encoders)");
  const width = 96;
  const height = 64;
  const rgba = makeRgba(width, height, 21);
  const png = await sharp(Buffer.from(rgbaToRgb(rgba).buffer as ArrayBuffer), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();

  const variants: { name: string; tiff: Record<string, unknown>; }[] = [
    { name: "lzw", tiff: { compression: "lzw" } },
    { name: "lzw+predictor", tiff: { compression: "lzw", predictor: "horizontal" } },
    { name: "none", tiff: { compression: "none" } },
    { name: "packbits", tiff: { compression: "packbits" } },
    { name: "deflate", tiff: { compression: "deflate" } },
  ];
  for (const variant of variants) {
    const tiffBuffer = await sharp(png).tiff(variant.tiff).toBuffer();
    const decoded = decodeTiffPages(new Uint8Array(tiffBuffer));
    const oracle = await sharp(tiffBuffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgb = rgbaToRgb(decoded[0].rgba);
    const ok =
      decoded.length === 1 &&
      decoded[0].width === width &&
      decoded[0].height === height &&
      rgb.length === oracle.data.length &&
      new Uint8Array(oracle.data).every((v, i) => v === rgb[i]);
    check(`${variant.name}: pixel-exact vs sharp decode`, ok);
  }

  // Grayscale.
  {
    const tiffBuffer = await sharp(png)
      .toColourspace("b-w")
      .tiff({ compression: "lzw" })
      .toBuffer();
    const decoded = decodeTiffPages(new Uint8Array(tiffBuffer));
    const oracle = await sharp(tiffBuffer)
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const data = new Uint8Array(oracle.data);
    const ok =
      decoded[0].width === width &&
      decoded[0].height === height &&
      decoded[0].rgba.length / 4 === data.length &&
      data.every((v, i) => v === decoded[0].rgba[i * 4]);
    check("grayscale lzw (+predictor)", ok);
  }

  // Fax (G4 + G3 1D/2D) — PIL/libtiff is the oracle for real CCITT files.
  // (sharp cannot write 1-bit TIFFs; Python PIL writes them via libtiff.)
  // The oracle writes under /tmp/tiffwork — create it (the smoke used to
  // only pass on machines where some earlier run had left the dir behind).
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/tiffwork", { recursive: true });
  for (const compression of ["group4", "group3"] as const) {
    const { spawnSync } = await import("node:child_process");
    const script = `
from PIL import Image
import io, sys
W, H = ${width}, ${height}
# Same thresholded gradient as below: deterministic bilevel pattern.
img = Image.new("1", (W, H))
px = img.load()
for y in range(H):
    for x in range(W):
        g = (x * 255) // (W - 1) if (y % 3 != 1) else 255 - (x * 255) // (W - 1)
        px[x, y] = 1 if g >= 128 else 0
${compression === "group3" ? "img.save(sys.argv[1], compression='group3')" : "img.save(sys.argv[1], compression='group4')"}
img2 = Image.open(sys.argv[1]).convert("L")
img2.save(sys.argv[2])
`;
    const tmp = "/tmp/tiffwork/fax-" + compression;
    const result = spawnSync("python3", ["-c", script, tmp + ".tif", tmp + ".png"], {
      encoding: "buffer",
    });
    if (result.status !== 0) {
      check(`${compression} PIL oracle`, false, String(result.stderr).slice(0, 80));
      continue;
    }
    const { readFile } = await import("node:fs/promises");
    const tiffBytes = new Uint8Array(await readFile(tmp + ".tif"));
    const decoded = decodeTiffPages(tiffBytes);
    const pilPng = await sharp(await readFile(tmp + ".png"))
      .toColourspace("b-w")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const data = new Uint8Array(pilPng.data);
    const ok =
      decoded.length === 1 &&
      decoded[0].width === width &&
      decoded[0].height === height &&
      decoded[0].preferPng === true &&
      decoded[0].rgba.length / 4 === data.length &&
      data.every((v, i) => v === decoded[0].rgba[i * 4]);
    check(
      `${compression === "group4" ? "G4 (T.6 2D)" : "G3 (T.4)"} pixel-exact vs PIL/libtiff`,
      ok,
      `${tiffBytes.length} bytes`
    );
  }

  // Tiled TIFF.
  {
    const tiffBuffer = await sharp(png)
      .tiff({ compression: "lzw", tile: true, tileWidth: 32, tileHeight: 32 })
      .toBuffer();
    const decoded = decodeTiffPages(new Uint8Array(tiffBuffer));
    const oracle = await sharp(tiffBuffer).raw().toBuffer({ resolveWithObject: true });
    const rgb = rgbaToRgb(decoded[0].rgba);
    const data = new Uint8Array(oracle.data);
    const ok =
      decoded[0].width === width &&
      rgb.length === data.length &&
      data.every((v, i) => v === rgb[i]);
    check("tiled lzw (32×32 tiles, padded edges)", ok);
  }

  // DPI write/readback via sharp (xres is pixels per MM in sharp/libvips).
  {
    const tiffBuffer = await sharp(png)
      .tiff({ compression: "lzw", xres: 10, yres: 10 })
      .toBuffer();
    const decoded = decodeTiffPages(new Uint8Array(tiffBuffer));
    check("dpi readback (254)", Math.round(decoded[0].dpi ?? 0) === 254, `got ${decoded[0].dpi}`);
  }
}

/* ---------------- 3. White-box hand-built IFDs ---------------- */
{
  console.log("white-box (hand-built IFDs)");

  // --- MM (big-endian) uncompressed RGB ---
  {
    const width = 6;
    const height = 4;
    const rgb = new Uint8Array(width * height * 3);
    for (let p = 0; p < width * height; p += 1) {
      rgb[p * 3] = p * 7;
      rgb[p * 3 + 1] = 255 - p * 3;
      rgb[p * 3 + 2] = p;
    }
    const dataAt = 8;
    const bpsAt = dataAt + rgb.length + (rgb.length & 1); // 3 SHORTs out of line
    const ifdAt = bpsAt + 6;
    const out = new Uint8Array(ifdAt + 2 + 9 * 12 + 4);
    const view = new DataView(out.buffer);
    out[0] = 0x4d;
    out[1] = 0x4d;
    view.setUint16(2, 42, false);
    view.setUint32(4, ifdAt, false);
    out.set(rgb, dataAt);
    view.setUint16(bpsAt, 8, false);
    view.setUint16(bpsAt + 2, 8, false);
    view.setUint16(bpsAt + 4, 8, false);
    const entries: [number, number, number, number][] = [
      [256, 4, 1, width], // LONG width
      [257, 4, 1, height],
      [258, 3, 3, bpsAt], // BitsPerSample 8,8,8 out of line
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, dataAt],
      [277, 3, 1, 3],
      [278, 4, 1, height],
      [279, 4, 1, rgb.length],
    ];
    view.setUint16(ifdAt, entries.length, false);
    let at = ifdAt + 2;
    for (const [tag, type, count, value] of entries) {
      view.setUint16(at, tag, false);
      view.setUint16(at + 2, type, false);
      view.setUint32(at + 4, count, false);
      view.setUint32(at + 8, value, false);
      at += 12;
    }
    view.setUint32(at, 0, false);
    const decoded = decodeTiffPages(out);
    const ok =
      decoded.length === 1 &&
      decoded[0].width === 6 &&
      rgbaEqualsRgb(decoded[0].rgba, rgb, width * height);
    check("MM big-endian uncompressed RGB", ok);
  }

  // --- Palette (spp 1, bps 4) ---
  {
    const width = 16;
    const height = 2;
    const indices = new Uint8Array((width * height) / 2); // packed nibbles
    for (let i = 0; i < width * height; i += 2) {
      indices[i >> 1] = ((i & 0x0f) << 4) | ((i + 1) & 0x0f);
    }
    // ColorMap: 3 planes × 16 entries of 16-bit values (0..65535).
    const colormap = new Uint16Array(3 * 16);
    for (let i = 0; i < 16; i += 1) {
      colormap[i] = i * 4369;
      colormap[16 + i] = 65535 - i * 4369;
      colormap[32 + i] = 32768;
    }
    const dataAt = 8;
    const cmapAt = dataAt + indices.length;
    const ifdAt = cmapAt + colormap.length * 2;
    const out = new Uint8Array(ifdAt + 2 + 10 * 12 + 4);
    const view = new DataView(out.buffer);
    out[0] = 0x49;
    out[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdAt, true);
    out.set(indices, dataAt);
    for (let i = 0; i < colormap.length; i += 1) {
      view.setUint16(cmapAt + i * 2, colormap[i], true);
    }
    const entries: [number, number, number, number][] = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 4], // bps 4 (single SHORT inline)
      [259, 3, 1, 1],
      [262, 3, 1, 3], // palette
      [273, 4, 1, dataAt],
      [320, 3, 48, cmapAt], // ColorMap
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, indices.length],
    ];
    view.setUint16(ifdAt, entries.length, true);
    let at = ifdAt + 2;
    for (const [tag, type, count, value] of entries) {
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      view.setUint32(at + 8, value, true);
      at += 12;
    }
    view.setUint32(at, 0, true);
    const decoded = decodeTiffPages(out);
    let ok =
      decoded.length === 1 &&
      decoded[0].width === 16 &&
      decoded[0].preferPng;
    if (ok) {
      for (let y = 0; y < height && ok; y += 1) {
        for (let x = 0; x < width && ok; x += 1) {
          const index = (x + y * width) & 0x0f;
          const at3 = (y * width + x) * 4;
          ok =
            decoded[0].rgba[at3] === Math.round(colormap[index] / 257) &&
            decoded[0].rgba[at3 + 1] === Math.round(colormap[16 + index] / 257) &&
            decoded[0].rgba[at3 + 2] === Math.round(colormap[32 + index] / 257);
        }
      }
    }
    check("palette bps-4 with ColorMap", ok);
  }

  // --- 16-bit gray + predictor 2 (LE) ---
  {
    const width = 5;
    const height = 3;
    const gray = new Uint16Array(width * height);
    for (let i = 0; i < gray.length; i += 1) gray[i] = (i * 4681) & 0xffff;
    // Predictor 2 = HORIZONTAL differencing: stored[x] = raw[x] − raw[x−1]
    // per row (first sample of each row is absolute).
    const data = new Uint8Array(width * height * 2);
    const dataView = new DataView(data.buffer);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const rawValue = gray[y * width + x];
        const left = x === 0 ? 0 : gray[y * width + x - 1];
        dataView.setUint16((y * width + x) * 2, (rawValue - left) & 0xffff, true);
      }
    }
    const dataAt = 8;
    const ifdAt = dataAt + data.length;
    const out = new Uint8Array(ifdAt + 2 + 11 * 12 + 4);
    const view = new DataView(out.buffer);
    out[0] = 0x49;
    out[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdAt, true);
    out.set(data, dataAt);
    const entries: [number, number, number, number][] = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 16], // bps 16: one SHORT, INLINE (lower-order bytes)
      [259, 3, 1, 1],
      [262, 3, 1, 1], // BlackIsZero
      [273, 4, 1, dataAt],
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, data.length],
      [317, 3, 1, 2], // Predictor: horizontal
      [339, 3, 1, 1], // SampleFormat: uint
    ];
    view.setUint16(ifdAt, entries.length, true);
    let at = ifdAt + 2;
    for (const [tag, type, count, value] of entries) {
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      view.setUint32(at + 8, value, true);
      at += 12;
    }
    view.setUint32(at, 0, true);
    const decoded = decodeTiffPages(out);
    let ok = decoded.length === 1 && decoded[0].width === 5;
    if (ok) {
      for (let i = 0; i < width * height && ok; i += 1) {
        const want = gray[i] >> 8;
        ok =
          decoded[0].rgba[i * 4] === want &&
          decoded[0].rgba[i * 4 + 1] === want &&
          decoded[0].rgba[i * 4 + 2] === want;
      }
    }
    check("16-bit gray + predictor 2", ok);
  }

  // --- Orientation 6 (rotate 90 CW) ---
  {
    const width = 4;
    const height = 2;
    const rgb = new Uint8Array([
      10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0,
      50, 0, 0, 60, 0, 0, 70, 0, 0, 80, 0, 0,
    ]);
    const dataAt = 8;
    const ifdAt = dataAt + rgb.length;
    const out = new Uint8Array(ifdAt + 2 + 11 * 12 + 4);
    const view = new DataView(out.buffer);
    out[0] = 0x49;
    out[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdAt, true);
    out.set(rgb, dataAt);
    const bpsAt = ifdAt - 6;
    view.setUint16(bpsAt, 8, true);
    view.setUint16(bpsAt + 2, 8, true);
    view.setUint16(bpsAt + 4, 8, true);
    const entries: [number, number, number, number][] = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 3, bpsAt],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, dataAt],
      [274, 3, 1, 6], // Orientation: rotate 90 CW
      [277, 3, 1, 3],
      [278, 4, 1, height],
      [279, 4, 1, rgb.length],
      [284, 3, 1, 1],
    ];
    view.setUint16(ifdAt, entries.length, true);
    let at = ifdAt + 2;
    for (const [tag, type, count, value] of entries) {
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      view.setUint32(at + 8, value, true);
      at += 12;
    }
    view.setUint32(at, 0, true);
    const decoded = decodeTiffPages(out);
    // 90° CW of the 4×2 grid: new dims 2×4; first column (10,50) becomes
    // the last row… verify by spot pixels instead of the full matrix.
    const got = decoded[0];
    const ok =
      decoded.length === 1 &&
      got.width === 2 &&
      got.height === 4 &&
      got.rgba[0] === 50 && // top-left after CW = bottom-left before (50)
      got.rgba[4] === 10 &&
      got.rgba[(2 * 4 - 1) * 4] === 40; // bottom-right after = top-right before (40)
    check("orientation 6 (90° CW + swapped dims)", ok);
  }
}

/* ---------------- 4. Error paths ---------------- */
{
  console.log("error paths");
  const page = { width: 8, height: 8, rgba: makeRgba(8, 8, 31) };
  const good = encodeTiff([page], { compression: "lzw" });

  check("isTiffBytes true for writer output", isTiffBytes(good.slice(0, 4)));
  check("isTiffBytes false for PNG", !isTiffBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));

  // Truncated file.
  try {
    decodeTiffPages(good.subarray(0, 40));
    check("truncated corrupt", false);
  } catch (error) {
    check("truncated corrupt", error instanceof TiffError && error.kind === "tiff-corrupt");
  }

  // Bad strip offset.
  {
    const bad = good.slice();
    new DataView(bad.buffer).setUint32(8 + 2 + 5 * 12 + 8, 0xfffff0, true); // StripOffsets entry value
    try {
      decodeTiffPages(bad);
      check("bad strip offset corrupt", false);
    } catch (error) {
      check(
        "bad strip offset corrupt",
        error instanceof TiffError && error.kind === "tiff-corrupt"
      );
    }
  }

  // BigTIFF magic.
  {
    const big = new Uint8Array([0x49, 0x49, 43, 0, 0, 0, 0, 0]);
    try {
      TiffFile.parse(big);
      check("BigTIFF unsupported", false);
    } catch (error) {
      check(
        "BigTIFF unsupported",
        error instanceof TiffError && error.kind === "tiff-unsupported"
      );
    }
  }

  // JPEG-in-TIFF compression.
  {
    const jpegish = good.slice();
    const view = new DataView(jpegish.buffer);
    // Walk to the Compression entry (tag 259) and set it to 7.
    const ifdAt = view.getUint32(4, true);
    const count = view.getUint16(ifdAt, true);
    for (let e = 0; e < count; e += 1) {
      const at = ifdAt + 2 + e * 12;
      if (view.getUint16(at, true) === 259) {
        view.setUint16(at + 8, 7, true);
      }
    }
    try {
      decodeTiffPages(jpegish);
      check("JPEG-in-TIFF unsupported", false);
    } catch (error) {
      check(
        "JPEG-in-TIFF unsupported",
        error instanceof TiffError && error.kind === "tiff-unsupported"
      );
    }
  }

  // pageCount + lazy decode API shape.
  {
    const two = encodeTiff(
      [
        { width: 4, height: 4, rgba: makeRgba(4, 4, 41) },
        { width: 4, height: 4, rgba: makeRgba(4, 4, 42) },
      ],
      { compression: "lzw" }
    );
    const file = TiffFile.parse(two);
    check("pageCount = 2", file.pageCount === 2);
    check(
      "pageInfo without decode",
      file.pageInfo(1).width === 4 && file.pageInfo(1).dpi === 150
    );
    const second = file.decodePage(1);
    check("lazy decode page 2", second.rgba.length === 4 * 4 * 4);
  }
}

console.log(
  `\n${passed} passed, ${failed} failed${failures.length ? "\n" + failures.map((f) => "  ✗ " + f).join("\n") : ""}`
);
process.exit(failed === 0 ? 0 : 1);
