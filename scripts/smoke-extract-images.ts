/**
 * PRE-BUILD smoke test for the Extract PDF images tool (P4.1).
 *
 * bun has NO OffscreenCanvas and pdf.js's document loader does not settle
 * there, so this smoke is PURE by construction: the real pdf.js extraction
 * path (loader + operator-list decode + OffscreenCanvas encode) is verified
 * in-browser by the orchestrator's agent-browser QA. Everything else is
 * proven here BEFORE any browser runs:
 *
 *  1. Pure engine: minSize filter boundaries, option normalization,
 *     selection keys, selected-set parse/serialize round-trips,
 *     GRAYSCALE_1BPP / RGB_24BPP / RGBA expansion math, output naming,
 *     error classification.
 *  2. The collectImages() WALK itself — driven against a synthetic document
 *     that honors the exact pdf.js contract collect.ts expects (operator
 *     lists + objs/commonObjs pools with callback-form get). This pins the
 *     dedupe, ordinal counting, page attribution, pool routing (g_ prefix),
 *     null/invalid/oversized payload skipping, probe caps and cancel hooks
 *     — i.e. the probe ⇄ worker key contract — without pdf.js.
 *  3. minSize filtering + the selection-set logic against the real keys
 *     minted by the walk (exactly how the worker filters).
 *  4. i18n.json key-tree parity (en ↔ hi) for the exi section.
 *
 * Run: bun scripts/smoke-extract-images.ts   (fast, exits 0 on green)
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

import {
  classifyExtractError,
  EXI_IDS,
  expandGray1ToRGBA,
  expandRgb24ToRGBA,
  expandToRGBA,
  IMAGE_KIND,
  imageKey,
  makeImageName,
  normalizeRgba,
  parseSelectedSet,
  passesMinSize,
  resolveExiOptions,
  sanitizeExiBase,
  serializeSelectedSet,
} from "../tools/extract-images/engine";
import {
  collectImages,
  type ObjsPool,
  type RawImage,
} from "../tools/extract-images/collect";
import i18n from "../tools/extract-images/i18n.json";

let passed = 0;
let failed = 0;
let checkNo = 0;

function check(ok: boolean, label: string): void {
  checkNo += 1;
  if (ok) {
    passed += 1;
    console.log(`${checkNo}. PASS ${label}`);
  } else {
    failed += 1;
    console.error(`${checkNo}. FAIL ${label}`);
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

/* ------------------------------------------------------------------ */
/* 1. Pure engine                                                     */
/* ------------------------------------------------------------------ */

// minSize: longer-side rule + boundaries.
eq(passesMinSize(127, 200, 0), true, "minSize 0 keeps everything");
eq(passesMinSize(127, 128, 128), true, "exactly 128 passes (>= boundary)");
eq(passesMinSize(200, 127, 128), true, "longer side counts (200x127)");
eq(passesMinSize(127, 127, 128), false, "127x127 fails the 128 filter");
eq(passesMinSize(256, 100, 256), true, "256x100 passes the 256 filter");
eq(passesMinSize(255, 200, 256), false, "255x200 fails the 256 filter (both sides short)");
eq(passesMinSize(512, 400, 512), true, "512x400 passes the 512 filter (>= boundary)");
eq(passesMinSize(511, 400, 512), false, "511x400 fails the 512 filter");
eq(passesMinSize(513, 513, 512), true, "513x513 passes the 512 filter");

// Option normalization.
eq(resolveExiOptions({ [EXI_IDS.minSize]: "256", [EXI_IDS.format]: "jpg" }), {
  minSize: 256,
  format: "jpg",
  selected: "",
}, "resolveExiOptions normalizes select strings");
eq(resolveExiOptions({}), {
  minSize: 128,
  format: "png",
  selected: "",
}, "resolveExiOptions defaults (128/png/all)");
eq(resolveExiOptions({ [EXI_IDS.minSize]: "banana", [EXI_IDS.format]: 7 }), {
  minSize: 128,
  format: "png",
  selected: "",
}, "resolveExiOptions falls back on garbage");

// Selection keys.
eq(imageKey(0, 3, 2), "F0-P3-I2", "imageKey format");
eq(parseSelectedSet(""), null, "empty selected = all");
eq(parseSelectedSet(undefined), null, "missing selected = all");
eq(parseSelectedSet("F0-P1-I1"), new Set(["F0-P1-I1"]), "single key parses");
eq(
  parseSelectedSet("F0-P1-I2, F0-P1-I9,F2-P3-I1"),
  new Set(["F0-P1-I2", "F0-P1-I9", "F2-P3-I1"]),
  "multi key parses (whitespace tolerated)"
);
eq(parseSelectedSet("nonsense,,F0-P1-I1"), new Set(["F0-P1-I1"]), "garbage entries dropped");
eq(serializeSelectedSet(["F0-P1-I2", "F0-P1-I1"]), "F0-P1-I1,F0-P1-I2", "serialize is sorted + stable");
eq(
  [...(parseSelectedSet(serializeSelectedSet(["F0-P2-I3", "F0-P1-I1"])) ?? [])],
  ["F0-P1-I1", "F0-P2-I3"],
  "serialize → parse round-trip"
);

// GRAYSCALE_1BPP: 8x1, bits 10110010 → W B W W B B W B (MSB first).
{
  const src = new Uint8Array([0b10110010]);
  const rgba = expandGray1ToRGBA(src, 8, 1);
  const expected = [255, 0, 255, 255, 0, 0, 255, 0];
  const got: number[] = [];
  for (let x = 0; x < 8; x += 1) got.push(rgba[x * 4]);
  eq(got, expected, "gray1 MSB-first expansion (8px row)");
  const alpha = rgba[3];
  eq(alpha, 255, "gray1 alpha opaque");
}
// GRAYSCALE_1BPP: 5px wide → 1 byte per row, padding bits ignored.
{
  const src = new Uint8Array([0b11111000, 0b00000101]);
  const rgba = expandGray1ToRGBA(src, 5, 2);
  const row0 = [rgba[0], rgba[4], rgba[8], rgba[12], rgba[16]];
  const row1 = [rgba[20], rgba[24], rgba[28], rgba[32], rgba[36]];
  eq(row0, [255, 255, 255, 255, 255], "gray1 5px row 0 (padding ignored)");
  eq(row1, [0, 0, 0, 0, 0], "gray1 5px row 1 (all black bits)");
}
// RGB_24BPP → RGBA.
{
  const src = new Uint8Array([10, 20, 30, 40, 50, 60]);
  const rgba = expandRgb24ToRGBA(src, 2, 1);
  eq([...rgba], [10, 20, 30, 255, 40, 50, 60, 255], "rgb24 expansion + opaque alpha");
}
// RGBA normalize: Uint8Array in → fresh Uint8ClampedArray out, truncation safe.
{
  const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const rgba = normalizeRgba(src, 1, 1);
  eq(rgba instanceof Uint8ClampedArray, true, "normalizeRgba returns Uint8ClampedArray");
  eq([...rgba], [1, 2, 3, 4], "normalizeRgba truncates overlong input");
  // ImageData-compatible buffer (the worker/surface putImageData contract).
  eq(rgba.buffer instanceof ArrayBuffer, true, "normalizeRgba buffer is a plain ArrayBuffer");
}
// expandToRGBA guards.
eq(expandToRGBA(new Uint8Array(4), IMAGE_KIND.RGBA_32BPP, 2, 1), null, "short RGBA rejected");
eq(expandToRGBA(new Uint8Array(9), IMAGE_KIND.RGB_24BPP, 3, 1) !== null, true, "exact RGB accepted");
eq(expandToRGBA(new Uint8Array(1), 77, 8, 8), null, "unknown kind rejected");

// Naming + sanitize.
eq(sanitizeExiBase("report.pdf"), "report", "base strips .pdf");
eq(sanitizeExiBase("my/file*2024?.pdf"), "my_file_2024_", "base sanitizes hostile chars");
eq(sanitizeExiBase(".pdf"), "document", "base falls back to document");
eq(makeImageName("report", 3, 2, "png"), "report_p3_2.png", "png name");
eq(makeImageName("report", 12, 5, "jpg"), "report_p12_5.jpg", "jpg name");

// Error classification.
eq(classifyExtractError("PasswordException: No password given"), "tool.errorEncrypted", "password → encrypted");
eq(classifyExtractError("canvas-2d-unavailable"), "tool.errorGeneric", "canvas → generic");
eq(classifyExtractError("Invalid PDF structure"), "tool.errorCorrupt", "parse → corrupt");

/* ------------------------------------------------------------------ */
/* 2. The collectImages walk against a synthetic document             */
/* ------------------------------------------------------------------ */

/** Walk-lib stub: distinct op codes, same shape pdf.js exposes. */
const OPS = {
  paintImageXObject: 85,
  paintImageXObjectRepeat: 86,
  paintInlineImageXObject: 87,
  paintInlineImageXObjectGroup: 88,
} as const;
const OP_OTHER = 99;

type PoolEntry = {
  width?: number;
  height?: number;
  kind?: number;
  data?: Uint8Array;
} | null;

/** Callback-form pool; `late` entries resolve on a macrotask like pdf.js. */
function makePool(entries: Record<string, PoolEntry>, late?: string[]): ObjsPool {
  return {
    get(objId: string, callback: (data: unknown) => void): null {
      const value = entries[objId] ?? null;
      if (late?.includes(objId)) {
        setTimeout(() => callback(value), 0);
      } else {
        callback(value);
      }
      return null;
    },
  };
}

interface FakePage {
  fnArray: number[];
  argsArray: unknown[][];
  objsEntries: Record<string, PoolEntry>;
  commonEntries: Record<string, PoolEntry>;
}

function fakeDoc(pages: FakePage[]): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: async (pageNumber: number) => {
      const page = pages[pageNumber - 1];
      return {
        objs: makePool(page.objsEntries, ["img_late"]),
        commonObjs: makePool(page.commonEntries),
        getOperatorList: async () => ({
          fnArray: page.fnArray,
          argsArray: page.argsArray,
        }),
      };
    },
    destroy: async () => undefined,
  } as unknown as PDFDocumentProxy;
}

function imageOp(
  fn: number,
  arg: unknown
): { fn: number; args: unknown[] } {
  return { fn, args: [arg] };
}

/**
 * The fixture mirrors the classic extraction shape:
 *  page 1 — text op, PNG(named), red(named), green(named), late(named)
 *  page 2 — red AGAIN (dedupe), big("g_" global via commonObjs), inline data
 *  page 3 — text only
 */
function fixturePages(): FakePage[] {
  return [
    {
      fnArray: [
        OP_OTHER,
        OPS.paintImageXObject,
        OPS.paintImageXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintImageXObject,
      ],
      argsArray: [
        ["draw text"],
        ["img_png"],
        ["img_red"],
        ["img_green"],
        ["img_late"],
      ],
      objsEntries: {
        img_png: { width: 8, height: 8, kind: 3, data: new Uint8Array(8 * 8 * 4) },
        img_red: { width: 16, height: 16, kind: 2, data: new Uint8Array(16 * 16 * 3) },
        img_green: { width: 24, height: 16, kind: 2, data: new Uint8Array(24 * 16 * 3) },
        img_late: { width: 12, height: 12, kind: 2, data: new Uint8Array(12 * 12 * 3) },
      },
      commonEntries: {},
    },
    {
      fnArray: [
        OPS.paintImageXObject, // red again → dedupe (counted ordinal, no emit)
        OPS.paintImageXObject, // g_big → resolves from commonObjs
        OPS.paintInlineImageXObject, // inline payload in the args
        OPS.paintImageXObject, // img_null → decode failure, skipped
      ],
      argsArray: [
        ["img_red"],
        ["g_big"],
        [{ width: 6, height: 4, kind: 3, data: new Uint8Array(6 * 4 * 4) }],
        ["img_null"],
      ],
      objsEntries: {
        img_null: null,
      },
      commonEntries: {
        g_big: { width: 300, height: 200, kind: 2, data: new Uint8Array(300 * 200 * 3) },
      },
    },
    {
      fnArray: [OP_OTHER],
      argsArray: [["draw text"]],
      objsEntries: {},
      commonEntries: {},
    },
  ];
}

async function walk(
  pages: FakePage[],
  fileIndex: number,
  hooks: Parameters<typeof collectImages>[3]
): Promise<RawImage[]> {
  const images: RawImage[] = [];
  await collectImages(
    { OPS },
    fakeDoc(pages),
    fileIndex,
    {
      ...hooks,
      onImage: async (image) => {
        images.push(image);
        await hooks.onImage?.(image);
      },
    }
  );
  return images;
}

// Full walk: dedupe + ordinals + page attribution + pool routing.
{
  const images = await walk(fixturePages(), 0, {});
  eq(images.length, 6, "6 detections (repeat deduped, null skipped)");
  eq(
    images.map((image) => image.key),
    ["F0-P1-I1", "F0-P1-I2", "F0-P1-I3", "F0-P1-I4", "F0-P2-I2", "F0-P2-I3"],
    "keys: ordinals count EVERY image op (red's repeat + the null consume one)"
  );
  eq(
    images.map((image) => image.page),
    [1, 1, 1, 1, 2, 2],
    "page attribution = first paint"
  );
  eq(
    images.map((image) => `${image.width}x${image.height}`),
    ["8x8", "16x16", "24x16", "12x12", "300x200", "6x4"],
    "dims resolve from the pools (g_big via commonObjs, inline via args)"
  );
  eq(
    images.every((image) => image.bitmap === null && image.data !== null),
    true,
    "data-form detections carry the raw payload"
  );
  eq(images[4].kind, 2, "big image keeps its pool kind");

  // Ordinals are stable across a fresh walk of the same fixture
  // (the probe ⇄ worker contract).
  const rewalk = await walk(fixturePages(), 0, {});
  eq(
    rewalk.map((image) => image.key),
    images.map((image) => image.key),
    "keys identical on a fresh walk (the probe ⇄ worker contract)"
  );

  // fileIndex mints the F<n> prefix (multi-file runs stay disjoint).
  const secondFile = await walk(fixturePages(), 1, {});
  eq(
    secondFile.map((image) => image.key),
    ["F1-P1-I1", "F1-P1-I2", "F1-P1-I3", "F1-P1-I4", "F1-P2-I2", "F1-P2-I3"],
    "fileIndex prefixes every key"
  );

  // Async sinks are awaited in page order (streaming contract).
  const seen: number[] = [];
  await walk(fixturePages(), 0, {
    onImage: async (image) => {
      await Promise.resolve();
      seen.push(image.page);
    },
  });
  eq(seen, [1, 1, 1, 1, 2, 2], "async onImage awaited in emission order");
}

// Probe caps: maxImages truncates with a prefix of the full walk.
{
  const images = await walk(fixturePages(), 0, { maxImages: 2 });
  eq(images.length, 2, "maxImages caps the accepted detections");
  eq(
    images.map((image) => image.key),
    ["F0-P1-I1", "F0-P1-I2"],
    "capped keys are a prefix of the full walk"
  );
}

// Probe caps: maxPages stops before the later pages.
{
  const images = await walk(fixturePages(), 0, { maxPages: 1 });
  eq(images.length, 4, "maxPages 1 keeps page-1 images only");
  eq(images.every((image) => image.page === 1), true, "maxPages: no page-2 detections");
}

// Cooperative cancel: checked between pages and before each op resolve.
{
  let stop = false;
  const images = await walk(fixturePages(), 0, {
    shouldStop: () => stop,
    onImage: () => {
      stop = true; // halt right after the first accepted detection
    },
  });
  eq(images.length, 1, "shouldStop halts the walk after the first detection");
  eq(images[0].page, 1, "cancelled walk emitted page 1 only");
}

// Hostile payloads are skipped without breaking the walk.
{
  const pages: FakePage[] = [
    {
      fnArray: [
        OPS.paintImageXObject,     // missing width → skipped
        OPS.paintImageXObject,     // absurd size → skipped
        OPS.paintInlineImageXObject, // not an object → skipped
        OPS.paintImageXObject,     // good one survives
      ],
      argsArray: [
        ["img_bad"],
        ["img_huge"],
        [null],
        ["img_ok"],
      ],
      objsEntries: {
        img_bad: { height: 8, kind: 3, data: new Uint8Array(8 * 8 * 4) },
        img_huge: { width: 20000, height: 10, kind: 3, data: new Uint8Array(4) },
        img_ok: { width: 10, height: 10, kind: 3, data: new Uint8Array(10 * 10 * 4) },
      },
      commonEntries: {},
    },
  ];
  const images = await walk(pages, 0, {});
  eq(images.map((image) => image.key), ["F0-P1-I4"], "invalid/oversized payloads skipped, ordinals still counted");
  eq(images[0].width, 10, "the good payload survives");
}

/* ---------------- filter + selection against real keys ---------------- */

{
  const images = await walk(fixturePages(), 0, {});
  // Full key list for reference:
  // F0-P1-I2 (8x8), F0-P1-I3 (16x16), F0-P1-I4 (24x16),
  // F0-P1-I5 (12x12), F0-P2-I2 (300x200), F0-P2-I3 (6x4)

  // minSize=256: only the big image survives.
  eq(
    images
      .filter((image) => passesMinSize(image.width, image.height, 256))
      .map((image) => image.key),
    ["F0-P2-I2"],
    "minSize 256 keeps only the big image"
  );

  // minSize=0 keeps all.
  eq(
    images.filter((image) => passesMinSize(image.width, image.height, 0)).length,
    6,
    "minSize 0 keeps all six"
  );

  // Explicit selection restricts file #0 exactly like the worker.
  const selected = parseSelectedSet(
    serializeSelectedSet(["F0-P1-I1", "F0-P1-I3", "F0-P2-I3"])
  );
  eq(
    images
      .filter((image) => selected !== null && selected.has(image.key))
      .map((image) => image.key),
    ["F0-P1-I1", "F0-P1-I3", "F0-P2-I3"],
    "selection picks exactly the chosen keys"
  );

  // A selection below the size filter yields nothing (worker → exi.errorNoImages).
  const tinyOnly = parseSelectedSet("F0-P1-I1");
  eq(
    images.filter(
      (image) =>
        passesMinSize(image.width, image.height, 256) &&
        tinyOnly !== null &&
        tinyOnly.has(image.key)
    ).length,
    0,
    "selected-but-below-filter extracts nothing (honest error path)"
  );
}

// Output naming follows the running output index (the worker's encoder loop).
{
  const images = await walk(fixturePages(), 0, {});
  const base = sanitizeExiBase("annual report.pdf");
  // 128 filter keeps only the 300x200 big image from page 2.
  const named = images
    .filter((image) => passesMinSize(image.width, image.height, 128))
    .map((image, i) => makeImageName(base, image.page, i + 1, "png"));
  eq(named, ["annual report_p2_1.png"], "names: per-file running index + first-paint page (128 filter)");
  // With the filter off, every detection gets its running index.
  const namedAll = images.map((image, i) => makeImageName("r", image.page, i + 1, "jpg"));
  eq(
    namedAll,
    ["r_p1_1.jpg", "r_p1_2.jpg", "r_p1_3.jpg", "r_p1_4.jpg", "r_p2_5.jpg", "r_p2_6.jpg"],
    "names: running index across pages, jpg extension"
  );
}

/* ------------------------------------------------------------------ */
/* 3. i18n parity                                                     */
/* ------------------------------------------------------------------ */

{
  const sections = i18n as {
    en: Record<string, Record<string, string>>;
    hi: Record<string, Record<string, string>>;
  };
  const enKeys = Object.keys(sections.en.exi ?? {}).sort();
  const hiKeys = Object.keys(sections.hi.exi ?? {}).sort();
  eq(enKeys.length > 0, true, "exi.en section exists");
  eq(enKeys, hiKeys, "exi en↔hi key parity");
  eq(
    enKeys.includes("errorNoImages") && enKeys.includes("ctaNothingSelected"),
    true,
    "exi keys cover the error + CTA strings"
  );
}

console.log(`\n${passed} passed, ${failed} failed (of ${checkNo})`);
if (failed > 0) process.exit(1);
