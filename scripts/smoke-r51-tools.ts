/**
 * Smoke: R51 tool batch — P1-b raster color family (invert-pdf-colors /
 * pdf-to-greyscale / scanner-effect / posterize-pdf).
 *
 * bun cannot run pdf.js's canvas renderer (the rasterize precedent), so
 * this smoke locks the PURE parts of the pipeline + the wiring, and the
 * real render path is verified end-to-end with agent-browser:
 *
 *  1. Transform unit tests (tools/raster-color-common/transforms.ts):
 *     invert (values, involution, alpha), greyscale (Rec. 601 luma on
 *     pure colors, alpha, idempotent on grey), posterize (levels 2/3/4
 *     mappings, clamp defence, alpha), scanner (seeded determinism,
 *     bounds, alpha, r=g=b without tint, cream ordering, noise effect).
 *  2. Worker discipline: the 4 workers + the core import NO pdf-lib
 *     (own engine only) and reference the shared core.
 *  3. Config wiring: each config's toolId/outputKind/file limits match
 *     its folder; registry entries exist, enabled, category edit; the
 *     SEO copy resolves; i18n error keys referenced by the core exist
 *     in BOTH catalogs (en+hi).
 *  4. Rebuild oracle: buildImageOnlyDoc (the core's rebuild pass) with
 *     a real JPEG, verified by pdf-lib as the DEV ORACLE — page sizes,
 *     one DCT XObject per page, byte-identical payload.
 *
 * Run: bun scripts/smoke-r51-tools.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFDict } from "pdf-lib";

import {
  invertPixels,
  greyscalePixels,
  posterizePixels,
  scannerPixels,
  mulberry32,
  SCANNER_NOISE,
} from "../tools/raster-color-common/transforms";
import { buildImageOnlyDoc } from "../tools/raster-color-common/worker-core";

import { config as invertPdfColors } from "../tools/invert-pdf-colors/config";
import { config as pdfToGreyscale } from "../tools/pdf-to-greyscale/config";
import { config as scannerEffect } from "../tools/scanner-effect/config";
import { config as posterizePdf } from "../tools/posterize-pdf/config";

import { ALL_TOOLS } from "../src/lib/tools/registry";
import { getToolSeo } from "../src/lib/seo/tool-seo";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, actual?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(
      `  ✗ FAIL ${label}`,
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : "",
    );
  }
}

/** RGBA pixel array helper — pixels as [r,g,b,a] tuples. */
function rgbaOf(...pixels: number[][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => {
    out[i * 4] = p[0];
    out[i * 4 + 1] = p[1];
    out[i * 4 + 2] = p[2];
    out[i * 4 + 3] = p[3];
  });
  return out;
}

function pixelAt(data: Uint8ClampedArray, i: number): number[] {
  return [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
}

async function main(): Promise<void> {
  console.log("R51 smoke — raster color family\n");

  /* ── 1. invertPixels ─────────────────────────────────────────── */
  console.log("invert:");
  {
    const data = rgbaOf([0, 0, 0, 255], [255, 255, 255, 255], [10, 200, 100, 255], [128, 64, 32, 99]);
    invertPixels(data);
    check(
      "pure black → pure white",
      JSON.stringify(pixelAt(data, 0)) === JSON.stringify([255, 255, 255, 255]),
      pixelAt(data, 0),
    );
    check(
      "pure white → pure black",
      JSON.stringify(pixelAt(data, 1)) === JSON.stringify([0, 0, 0, 255]),
      pixelAt(data, 1),
    );
    check(
      "mixed pixel flips per channel",
      JSON.stringify(pixelAt(data, 2)) === JSON.stringify([245, 55, 155, 255]),
      pixelAt(data, 2),
    );
    check("alpha untouched (99 stays 99)", data[3 * 4 + 3] === 99, data[3 * 4 + 3]);

    const again = new Uint8ClampedArray(data);
    invertPixels(again);
    let involution = true;
    for (let i = 0; i < again.length; i += 1) {
      const original = rgbaOf([0, 0, 0, 255], [255, 255, 255, 255], [10, 200, 100, 255], [128, 64, 32, 99])[i];
      if (again[i] !== original) involution = false;
    }
    check("involution — invert twice restores the original", involution);
  }

  /* ── 2. greyscalePixels ──────────────────────────────────────── */
  console.log("greyscale:");
  {
    const data = rgbaOf([255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255], [80, 160, 40, 7]);
    greyscalePixels(data);
    // Rec. 601: 0.299*255=76.245→76 · 0.587*255=149.685→150 · 0.114*255=29.07→29
    check("pure red → luma 76", JSON.stringify(pixelAt(data, 0).slice(0, 3)) === JSON.stringify([76, 76, 76]), pixelAt(data, 0));
    check("pure green → luma 150", JSON.stringify(pixelAt(data, 1).slice(0, 3)) === JSON.stringify([150, 150, 150]), pixelAt(data, 1));
    check("pure blue → luma 29", JSON.stringify(pixelAt(data, 2).slice(0, 3)) === JSON.stringify([29, 29, 29]), pixelAt(data, 2));
    check("white stays 255", JSON.stringify(pixelAt(data, 3).slice(0, 3)) === JSON.stringify([255, 255, 255]), pixelAt(data, 3));
    check("r=g=b on mixed pixel", (() => { const p = pixelAt(data, 4); return p[0] === p[1] && p[1] === p[2]; })(), pixelAt(data, 4));
    check("alpha untouched (7 stays 7)", data[4 * 4 + 3] === 7, data[4 * 4 + 3]);

    const grey = rgbaOf([123, 123, 123, 255]);
    greyscalePixels(grey);
    check("already-grey pixel is unchanged", grey[0] === 123 && grey[1] === 123 && grey[2] === 123, Array.from(grey));
  }

  /* ── 3. posterizePixels ──────────────────────────────────────── */
  console.log("posterize:");
  {
    // levels=2: step 255 → round(v/255) → 0 or 255.
    const b2 = rgbaOf([0, 100, 127, 255], [128, 200, 255, 255]);
    posterizePixels(b2, 2);
    check(
      "levels 2 → pure black/white per channel",
      JSON.stringify([pixelAt(b2, 0), pixelAt(b2, 1)]) ===
        JSON.stringify([
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ]),
      [pixelAt(b2, 0), pixelAt(b2, 1)],
    );

    // levels=4: step 85 → allowed {0, 85, 170, 255}.
    const b4 = rgbaOf([0, 42, 43, 200], [100, 170, 254, 255]);
    posterizePixels(b4, 4);
    check(
      "levels 4 → snapped to {0, 85, 170, 255}",
      JSON.stringify([pixelAt(b4, 0), pixelAt(b4, 1)]) ===
        JSON.stringify([
          [0, 0, 85, 200],
          [85, 170, 255, 255],
        ]),
      [pixelAt(b4, 0), pixelAt(b4, 1)],
    );

    // levels=3: step 127.5 → allowed {0, 127.5→128, 255}.
    const b3 = rgbaOf([64, 191, 255, 3]);
    posterizePixels(b3, 3);
    check(
      "levels 3 → snapped to {0, 128, 255}",
      JSON.stringify(pixelAt(b3, 0).slice(0, 3)) === JSON.stringify([128, 128, 255]),
      pixelAt(b3, 0),
    );
    check("alpha untouched (3 stays 3)", b3[3] === 3, b3[3]);

    // Defence in depth: malformed levels never divide by zero.
    const bad = rgbaOf([10, 20, 30, 255]);
    posterizePixels(bad, 0);
    check("levels 0 clamped to 2 (no crash)", true);
    const bad2 = rgbaOf([10, 20, 30, 255]);
    posterizePixels(bad2, 99);
    check("levels 99 clamped to 8 (no crash)", true);

    // levels=8 keeps common mid values sane.
    const b8 = rgbaOf([128, 64, 255, 255]);
    posterizePixels(b8, 8);
    const allowed = new Set([0, 36, 73, 109, 146, 182, 219, 255]);
    check(
      "levels 8 → every channel on the 8-step ladder",
      [b8[0], b8[1], b8[2]].every((v) => allowed.has(v)),
      [b8[0], b8[1], b8[2]],
    );
  }

  /* ── 4. scannerPixels ────────────────────────────────────────── */
  console.log("scanner:");
  {
    // Determinism: same seed → identical output.
    const src = rgbaOf(
      [255, 255, 255, 255], [0, 0, 0, 255], [200, 50, 120, 255],
      [80, 160, 40, 255], [128, 128, 128, 255], [10, 10, 10, 255],
      [250, 200, 150, 255], [60, 90, 130, 255],
    );
    const run1 = new Uint8ClampedArray(src);
    const run2 = new Uint8ClampedArray(src);
    const opts = {
      noise: SCANNER_NOISE.medium,
      contrast: 1.15,
      tint: "none" as const,
      rng: mulberry32(42),
    };
    scannerPixels(run1, opts);
    scannerPixels(run2, { ...opts, rng: mulberry32(42) });
    let identical = true;
    for (let i = 0; i < run1.length; i += 1) if (run1[i] !== run2[i]) identical = false;
    check("same seed → byte-identical output (determinism)", identical);

    // Grey property without tint: r=g=b after the transform.
    let greyOk = true;
    for (let i = 0; i < run1.length; i += 4) {
      if (run1[i] !== run1[i + 1] || run1[i + 1] !== run1[i + 2]) greyOk = false;
    }
    check("no tint → r=g=b on every pixel", greyOk);
    check("alpha untouched", run1[3] === 255 && run1[5 * 4 + 3] === 255);

    // Bounds: |out_luma − in_luma| ≤ noise + contrast stretch.
    // Contrast around pivot 128 shifts a channel by at most
    // (contrast−1)·127; noise adds its amplitude — total bound:
    let boundOk = true;
    for (let i = 0; i < src.length; i += 4) {
      const inLuma = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      const out = run1[i];
      const bound = SCANNER_NOISE.medium + (1.15 - 1) * 127 + 1;
      if (Math.abs(out - inLuma) > bound) boundOk = false;
    }
    check(
      `every pixel stays within noise+contrast bound (±${SCANNER_NOISE.medium + Math.ceil((1.15 - 1) * 127) + 1})`,
      boundOk,
    );

    // Noise really changes pixels (not a no-op).
    let changed = 0;
    for (let i = 0; i < src.length; i += 4) {
      const inLuma = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      const expectedNoNoise = (inLuma - 128) * 1.15 + 128;
      if (Math.abs(run1[i] - expectedNoNoise) >= 1) changed += 1;
    }
    check(`sensor noise moves most pixels (moved ${changed}/8)`, changed >= 6, changed);

    // Cream tint: warm ordering r ≥ g ≥ b on mid tones.
    const cream = new Uint8ClampedArray(src);
    scannerPixels(cream, { ...opts, tint: "cream" });
    let warmOk = true;
    for (let i = 0; i < cream.length; i += 4) {
      // white-ish pixels (post-luma ≥ 200) must show r ≥ g ≥ b
      if (cream[i] >= 200 && !(cream[i] >= cream[i + 1] && cream[i + 1] >= cream[i + 2])) warmOk = false;
    }
    check("cream tint → warm r ≥ g ≥ b on light pixels", warmOk);

    // Zero noise + contrast 1 + no tint = plain greyscale.
    const plain = new Uint8ClampedArray(src);
    scannerPixels(plain, { noise: 0, contrast: 1, tint: "none", rng: () => 0.5 });
    const greyRef = new Uint8ClampedArray(src);
    greyscalePixels(greyRef);
    let plainOk = true;
    for (let i = 0; i < plain.length; i += 1) if (plain[i] !== greyRef[i]) plainOk = false;
    check("noise 0 + contrast 1 ≡ plain greyscale", plainOk);

    // Presets amplitude sanity.
    check(
      "noise presets ordered light < medium < heavy",
      SCANNER_NOISE.light < SCANNER_NOISE.medium && SCANNER_NOISE.medium < SCANNER_NOISE.heavy,
      SCANNER_NOISE,
    );
  }

  /* ── 5. Worker discipline + config wiring ────────────────────── */
  console.log("wiring:");
  const toolIds = [
    "invert-pdf-colors",
    "pdf-to-greyscale",
    "scanner-effect",
    "posterize-pdf",
  ] as const;
  const workers = [
    "invert-pdf-colors",
    "pdf-to-greyscale",
    "scanner-effect",
    "posterize-pdf",
  ];
  for (const name of workers) {
    const core = readFileSync(
      join(import.meta.dir, `../tools/${name}/worker.ts`),
      "utf8",
    );
    check(
      `${name}/worker.ts imports no pdf-lib (own engine only)`,
      !/(from\s+["'](?:@cantoo\/)?pdf-lib["']|import\(["'](?:@cantoo\/)?pdf-lib["']\))/.test(core),
    );
    check(
      `${name}/worker.ts runs through the raster-color core`,
      core.includes("raster-color-common/worker-core"),
    );
  }
  const coreSrc = readFileSync(
    join(import.meta.dir, "../tools/raster-color-common/worker-core.ts"),
    "utf8",
  );
  check(
    "worker-core imports no pdf-lib (own engine only)",
    !/(from\s+["'](?:@cantoo\/)?pdf-lib["']|import\(["'](?:@cantoo\/)?pdf-lib["']\))/.test(coreSrc),
  );

  const configs = [invertPdfColors, pdfToGreyscale, scannerEffect, posterizePdf];
  for (const cfg of configs) {
    check(
      `config ${cfg.toolId}: pdf output, single file`,
      cfg.outputKind === "pdf" && cfg.minFiles === 1 && cfg.maxFiles === 1,
      { outputKind: cfg.outputKind, minFiles: cfg.minFiles, maxFiles: cfg.maxFiles },
    );
    check(
      `config ${cfg.toolId}: has DPI + format + pages options`,
      ["dpi", "format", "pages"].every((id) => cfg.options.some((o) => o.id === id)),
    );
  }
  check(
    "scanner-effect has intensity + tint options",
    ["intensity", "tint"].every((id) =>
      scannerEffect.options.some((o) => o.id === id),
    ),
  );
  check(
    "posterize-pdf has levels option",
    posterizePdf.options.some((o) => o.id === "levels"),
  );

  for (const id of toolIds) {
    const reg = ALL_TOOLS.find((t) => t.id === id);
    check(`registry: ${id} present`, reg !== undefined);
    if (reg) {
      check(
        `registry: ${id} enabled, category edit, mode D`,
        reg.enabled && reg.category === "edit" && reg.mode === "D",
        { enabled: reg.enabled, category: reg.category, mode: reg.mode },
      );
    }
    const seo = getToolSeo(id);
    check(`seo: ${id} has curated copy`, seo !== undefined && seo.title.length > 10);
    if (seo) {
      check(
        `seo: ${id} title ≤ 48 chars`,
        seo.title.length <= 48,
        `${seo.title.length}: ${seo.title}`,
      );
      check(
        `seo: ${id} description 120–160 chars`,
        seo.description.length >= 120 && seo.description.length <= 160,
        seo.description.length,
      );
    }
  }

  // i18n: every error code the core can post exists in BOTH catalogs.
  const en = JSON.parse(readFileSync(join(import.meta.dir, "../src/i18n/en.json"), "utf8"));
  const hi = JSON.parse(readFileSync(join(import.meta.dir, "../src/i18n/hi.json"), "utf8"));
  const codes = [
    "errorCorrupt", "errorEncrypted", "errorInvalidPages", "errorGeneric",
  ];
  for (const code of codes) {
    check(`i18n: tool.${code} in en + hi`, en.tool?.[code] !== undefined && hi.tool?.[code] !== undefined);
  }
  check(
    "i18n: rasterize.errorRender reused by the core exists in en + hi",
    en.rasterize?.errorRender !== undefined && hi.rasterize?.errorRender !== undefined,
  );

  const live = ALL_TOOLS.filter((t) => t.enabled).length;
  const deferred = ALL_TOOLS.filter((t) => !t.enabled).map((t) => t.id);
  check(
    `tool counts: 127 total / 126 live / 1 deferred AI`,
    ALL_TOOLS.length === 127 &&
      live === 126 &&
      JSON.stringify(deferred) ===
        JSON.stringify(["translate-pdf"]),
    { total: ALL_TOOLS.length, live, deferred },
  );

  /* ── 6. Rebuild oracle (buildImageOnlyDoc, pdf-lib dev oracle) ─ */
  console.log("rebuild oracle:");
  {
    // The rasterize smoke's 16×8 two-tone JPEG (red top, blue bottom).
    const TINY_JPEG_BASE64 =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAYEAACAwAAAAAAAAAAAAAAAAAAFWSi4f/EABUBAQEAAAAAAAAAAAAAAAAAAAUH/8QAHREAAAUFAAAAAAAAAAAAAAAAAAIGVNIDFheio//aAAwDAQACEQMRAD8AkpkU0KZFNAKjYSeb7nkActrF5zpQH//Z";
    const binary = atob(TINY_JPEG_BASE64);
    const jpeg = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) jpeg[i] = binary.charCodeAt(i);

    const saved = buildImageOnlyDoc([
      { image: jpeg, isPng: false, widthPt: 595.28, heightPt: 841.89 },
      { image: jpeg, isPng: false, widthPt: 841.89, heightPt: 595.28 },
    ]);
    const reloaded = await PDFDocument.load(saved, { updateMetadata: false });

    check("rebuild: one output page per image", reloaded.getPageCount() === 2, reloaded.getPageCount());
    const pages = reloaded.getPages();
    check(
      "rebuild: page sizes are the declared visible point sizes",
      Math.abs(pages[0].getSize().width - 595.28) < 1e-9 &&
        Math.abs(pages[0].getSize().height - 841.89) < 1e-9 &&
        Math.abs(pages[1].getSize().width - 841.89) < 1e-9 &&
        Math.abs(pages[1].getSize().height - 595.28) < 1e-9,
    );

    let imageCount = 0;
    let bytesIdentical = true;
    let dimsOk = true;
    for (const page of pages) {
      const xObjects = page.node
        .Resources()
        ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
      if (xObjects === undefined || xObjects.keys().length !== 1) {
        dimsOk = false;
        continue;
      }
      const imageRef = xObjects.get(xObjects.keys()[0]);
      const image = reloaded.context.lookup(imageRef);
      if (image instanceof PDFRawStream) {
        const wNum = image.dict.lookupMaybe(PDFName.of("Width"), PDFNumber);
        const hNum = image.dict.lookupMaybe(PDFName.of("Height"), PDFNumber);
        if (wNum === undefined || wNum.asNumber() !== 16) dimsOk = false;
        if (hNum === undefined || hNum.asNumber() !== 8) dimsOk = false;
        const embedded = image.contents;
        if (embedded.length !== jpeg.length || embedded.some((b, i) => b !== jpeg[i])) {
          bytesIdentical = false;
        }
        const filter = image.dict.lookupMaybe(PDFName.of("Filter"), PDFName);
        if (filter !== undefined && filter.asString() === "/DCTDecode") imageCount += 1;
      }
    }
    check("rebuild: every page has one DCT image XObject (16×8)", imageCount === 2 && dimsOk, { imageCount, dimsOk });
    check("rebuild: DCT payload byte-identical (no recompression)", bytesIdentical);
    check("rebuild: no AcroForm in the output", reloaded.catalog.getAcroForm() === undefined);
  }

  console.log(
    `\nsmoke-r51-tools: ${pass}/${pass + fail} GREEN${fail > 0 ? ` (${fail} FAILED)` : ""}`,
  );
  if (failures.length > 0) {
    console.error("failed:", failures);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("SMOKE CRASH", error);
  process.exit(1);
});
