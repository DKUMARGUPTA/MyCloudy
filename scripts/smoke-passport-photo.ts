/**
 * PRE-BUILD smoke test for Passport photo maker (RB6, tool id "passport-photo").
 *
 * Part 1 (model, pure): the India photo size table (mm→px at 300 DPI, custom
 * clamps 15–100), the sheet grid packing math (4×6 + A4, independent floor
 * formula: cols/rows from raw mm→pt constants, centred offsets, info strip),
 * crop/zoom/pan rect math, the smart-white edge-seeded flood fill on
 * synthetic RGBA arrays (corner-mean seed, connectivity, tolerance stops),
 * brightness/contrast math (clamps, alpha untouched, rounding), the wire
 * option sanitizer/parser, localized output names, the info line, and the
 * JFIF APP0 density surgery (insert + patch branches, byte layout,
 * idempotency, pdf-lib embedJpg round trip).
 *
 * Part 2 (render engine): drawPhotoCrop / dimOutside / drawCropFrame /
 * drawHeadGuide / drawSheetPreview against a recording ctx — the exact op
 * sequences the live preview paints, tied to the model's SheetPlan geometry.
 *
 * Part 3 (worker, REAL module): bun runs the actual worker with a
 * self/postMessage shim PLUS a sharp-backed OffscreenCanvas /
 * createImageBitmap shim (bun has no canvas stack — pixels are
 * software-composited with nearest-neighbour resampling; the worker's REAL
 * control flow runs end to end: option parse → decode → crop → wash →
 * adjust → JPEG + JFIF tag → pdf-lib sheet). The sheet PDF is re-opened
 * with pdf-lib: /MediaBox == 288×432 / 595.28×841.89, ONE embedded
 * DCTDecode XObject drawn `copies` times (Do op count), dashed cut guides
 * ([2 2] 0 d, no NaN coords), the info line hex token, plus the honest
 * error taxonomy (no file, non-image, SVG, corrupt JPEG, sheet-too-small).
 *
 * Run: bun scripts/smoke-passport-photo.ts
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  PDFArray,
  PDFContentStream,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";

import {
  ADJUST_MAX,
  CELL_GAP_PT,
  COUNTRY_SPECS,
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  DEFAULT_STYLE,
  HEAD_GUIDE,
  INFO_STRIP_PT,
  JPEG_QUALITY,
  MAX_ZOOM,
  MIN_ZOOM,
  MM_PER_INCH,
  PHOTO_DPI,
  PHOTO_SIZES,
  PT_PER_INCH,
  SHEET_PAD_PT,
  SHEETS,
  WHITE_TOLERANCE_MAX,
  applyBrightnessContrast,
  applyWhiteBackground,
  clampCustomMM,
  clampZoom,
  complianceReport,
  computeCropRect,
  computeSheetPlan,
  countryById,
  infoLineText,
  isCountryId,
  isPhotoSizeId,
  mmToPt,
  mmToPx,
  parsePassportOption,
  photoOutputName,
  photoPixelSize,
  resolveSize,
  sanitizeCountry,
  serializePassport,
  setJpegDpi,
  sheetById,
  sheetCellRect,
  sheetOutputName,
  sizeAspect,
  sizeById,
  sizeMatchesCountry,
  suggestedSizeForCountry,
  toleranceDistanceSq,
  type CountryId,
  type PassportStyle,
} from "../tools/passport-photo/model";
import {
  dimOutside,
  drawCropFrame,
  drawHeadGuide,
  drawPhotoCrop,
  drawSheetPreview,
} from "../tools/passport-photo/render";
import { config as passportConfig } from "../tools/passport-photo/config";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string, detail?: unknown): void {
  failed += 1;
  console.log(`FAIL ${message}`);
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

function assert(condition: boolean, message: string, detail?: unknown): void {
  if (condition) pass(message);
  else fail(message, detail);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(message);
  else fail(message, { actual, expected });
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

/* ================================================================== */
/* Part 0 — wiring sanity (source text; React files are not node-safe) */
/* ================================================================== */

function part0(): void {
  const configs = readFileSync("src/lib/tools/configs.ts", "utf8");
  assert(
    configs.includes('import { config as passportPhoto } from "../../../tools/passport-photo/config"'),
    "configs.ts imports the passport-photo config"
  );
  assert(
    configs.includes("[passportPhoto.toolId]: passportPhoto"),
    "configs.ts maps the passport-photo config"
  );

  const surfaces = readFileSync("src/lib/tools/surfaces.tsx", "utf8");
  assert(
    surfaces.includes('import { PassportPhotoSurface } from "../../../tools/passport-photo/surface"'),
    "surfaces.tsx imports the PassportPhotoSurface"
  );
  assert(
    surfaces.includes('"passport-photo": PassportPhotoSurface'),
    "surfaces.tsx maps the passport-photo surface"
  );

  const registry = readFileSync("src/lib/tools/registry.ts", "utf8");
  const defMatch = /id:\s*"passport-photo"[\s\S]{0,600}?\}\),/.exec(registry);
  assert(defMatch !== null, "registry.ts has a passport-photo def");
  if (defMatch) {
    assert(defMatch[0].includes("enabled: true"), "registry def: enabled true");
    assert(defMatch[0].includes('mode: "D"'), "registry def: on-device mode D");
    assert(
      defMatch[0].includes('accepts: "image"'),
      "registry def: accepts image"
    );
  }

  const protocol = readFileSync("src/lib/workers/protocol.ts", "utf8");
  assert(
    protocol.includes("copies?: number") &&
      protocol.includes("(passport-photo)"),
    "protocol.ts RunDetail carries the copies field for passport-photo"
  );

  /* config shape */
  assertEqual(passportConfig.toolId, "passport-photo", "config toolId");
  assertEqual(passportConfig.minFiles, 1, "config minFiles = 1");
  assertEqual(passportConfig.maxFiles, 1, "config maxFiles = 1");
  assertEqual(passportConfig.outputKind, "image", "config outputKind image");
  assertEqual(passportConfig.fullWidthSurface, true, "config fullWidthSurface");
  assertEqual(passportConfig.options, [], "config: no schema options");
  assertEqual(
    passportConfig.howKeys,
    ["pp.how1", "pp.how2", "pp.how3"],
    "config howKeys pp.how1-3"
  );
  assert(
    (passportConfig.chainToolIds ?? []).includes("images-to-pdf"),
    "config chains to images-to-pdf",
    passportConfig.chainToolIds
  );

  /* tool i18n: en/hi leaf parity, no empty values, tight namespace */
  const i18n = JSON.parse(
    readFileSync("tools/passport-photo/i18n.json", "utf8")
  ) as { en: { pp: Record<string, string> }; hi: { pp: Record<string, string> } };
  const enKeys = Object.keys(i18n.en.pp).sort();
  const hiKeys = Object.keys(i18n.hi.pp).sort();
  const enPp = enKeys.map((k) => `pp.${k}`);
  assertEqual(enPp, hiKeys.map((k) => `pp.${k}`).sort(), "tool i18n: en/hi key parity");
  assert(
    enKeys.length >= 40,
    "tool i18n: full key set present",
    enKeys.length
  );
  assert(
    enKeys.every((key) => i18n.en.pp[key] !== "" && i18n.hi.pp[key] !== ""),
    "tool i18n: no empty values"
  );
  assert(
    ["pp.how1", "pp.how2", "pp.how3", "pp.errorSheetTooSmall"].every((key) =>
      enPp.includes(key)
    ),
    "tool i18n: howKeys + worker error key present"
  );
  /* every pp.* key the surface references exists in the tool catalog */
  const surfaceSrc = readFileSync("tools/passport-photo/surface.tsx", "utf8");
  const used = [...new Set([...surfaceSrc.matchAll(/t\("((?:pp|tool)\.[a-zA-Z0-9.]+)"/g)].map((m) => m[1]))];
  const missing = used.filter(
    (key) => key.startsWith("pp.") && !enPp.includes(key)
  );
  assert(missing.length === 0, "tool i18n: surface keys all present", missing);

  /* R4-c: country compliance wiring — surface uses the model + the keys */
  assert(
    surfaceSrc.includes("COUNTRY_SPECS") &&
      surfaceSrc.includes("complianceReport") &&
      surfaceSrc.includes("useStandard"),
    "surface: country selector + compliance chip wired"
  );
  const countryKeys = [
    "pp.countryLabel",
    "pp.complianceSize",
    "pp.complianceFace",
    "pp.complianceBgLabel",
    "pp.sizeMismatch",
    "pp.useStandard",
    "pp.countryNote",
  ];
  const missingCountry = countryKeys.filter((key) => !enPp.includes(key));
  assert(
    missingCountry.length === 0,
    "tool i18n: country compliance keys present",
    missingCountry
  );
  assert(
    countryKeys.every((key) => hiKeys.includes(key.slice(3))),
    "tool i18n: country compliance keys in HI too"
  );
  assert(
    /no face detection/i.test(i18n.en.pp.countryNote),
    "tool i18n: countryNote is honest about no-verification"
  );
  assert(
    /face|देखें|जाँच/.test(i18n.hi.pp.sizeMismatch) &&
      i18n.hi.pp.countryNote.length > 40,
    "tool i18n: HI compliance copy is a real translation"
  );

  /* R4-c config copy: the guidance feature + honest FAQ (EN + real HI) */
  const countryFeature = passportConfig.features.find((f) =>
    /7 countries/i.test(f.en)
  );
  assert(
    countryFeature !== undefined &&
      /never analyses/i.test(countryFeature.en) &&
      countryFeature.hi.includes("मार्गदर्शन") &&
      countryFeature.hi.includes("विश्लेषण"),
    "config: country-guidance feature EN+HI (honest no-analysis copy)"
  );
  const countryFaq = passportConfig.faq.find((f) =>
    /target-country selector/i.test(f.q.en)
  );
  assert(
    countryFaq !== undefined &&
      /no face detection/i.test(countryFaq.a.en) &&
      countryFaq.a.hi.includes("फ़ेस-डिटेक्शन"),
    "config: target-country FAQ states no face detection (EN+HI)"
  );

  /* shared error codes exist in the central catalog (read-only check) */
  const centralEn = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
  const centralLookup = (key: string): unknown =>
    key.split(".").reduce<unknown>((node, part) =>
      node !== null && typeof node === "object" && part in (node as Record<string, unknown>)
        ? (node as Record<string, unknown>)[part]
        : undefined,
    centralEn);
  assert(
    ["tool.images.errorNoImages", "tool.images.errorUnsupported", "tool.images.errorDecode", "tool.errorGeneric"].every(
      (key) => typeof centralLookup(key) === "string"
    ),
    "central catalog carries the shared tool.images.* error codes"
  );
  /* NOTE (not a check): the pp.* namespace is merged into src/i18n by the
     orchestrator's central i18n step (house batch protocol) — intentionally
     NOT asserted here and NOT touched by this smoke. */
}

/* ================================================================== */
/* Part 1 — pure model                                                 */
/* ================================================================== */

/** Independent spec formula: expected grid count from raw constants. */
function expectedGrid(
  wMM: number,
  hMM: number,
  sheetId: string,
  infoLine: boolean
): { cols: number; rows: number; copies: number } {
  const pageW = sheetId === "a4" ? 595.28 : 288;
  const pageH = sheetId === "a4" ? 841.89 : 432;
  const padX = 9;
  const padTop = 9;
  const padBottom = infoLine ? 9 + 20 : 9;
  const gap = 4;
  const cellW = (wMM / 25.4) * 72;
  const cellH = (hMM / 25.4) * 72;
  const usableW = pageW - padX * 2 + gap;
  const usableH = pageH - padTop - padBottom + gap;
  const cols = Math.floor(usableW / (cellW + gap));
  const rows = Math.floor(usableH / (cellH + gap));
  return { cols, rows, copies: cols * rows };
}

function part1(): void {
  /* ---- unit constants + conversions ---- */
  assertEqual(MM_PER_INCH, 25.4, "MM_PER_INCH = 25.4");
  assertEqual(PT_PER_INCH, 72, "PT_PER_INCH = 72");
  assertEqual(PHOTO_DPI, 300, "PHOTO_DPI = 300");
  assertEqual(JPEG_QUALITY, 0.92, "JPEG_QUALITY = 0.92 (house policy)");
  assertEqual(SHEET_PAD_PT, 9, "SHEET_PAD_PT = 9");
  assertEqual(CELL_GAP_PT, 4, "CELL_GAP_PT = 4");
  assertEqual(INFO_STRIP_PT, 20, "INFO_STRIP_PT = 20");
  assertEqual(CUSTOM_MM_MIN, 15, "CUSTOM_MM_MIN = 15");
  assertEqual(CUSTOM_MM_MAX, 100, "CUSTOM_MM_MAX = 100");
  assertEqual(MIN_ZOOM, 1, "MIN_ZOOM = 1");
  assertEqual(MAX_ZOOM, 6, "MAX_ZOOM = 6");
  assertEqual(ADJUST_MAX, 60, "ADJUST_MAX = 60");
  assertEqual(WHITE_TOLERANCE_MAX, 100, "WHITE_TOLERANCE_MAX = 100");
  assert(near(mmToPx(25.4, 600), 600), "mmToPx(25.4, 600) = 600");
  assert(near(mmToPt(25.4), 72), "mmToPt(25.4) = 72");
  assertEqual(mmToPx(0), 0, "mmToPx(0) = 0 (degenerate)");
  assertEqual(mmToPx(-5), 0, "mmToPx(-5) = 0 (degenerate)");
  assertEqual(mmToPx(Number.NaN), 0, "mmToPx(NaN) = 0 (degenerate)");
  assertEqual(mmToPx(35, 0), 0, "mmToPx(dpi 0) = 0 (degenerate)");

  /* ---- size table ---- */
  assertEqual(PHOTO_SIZES.length, 5, "5 size presets shipped");
  assertEqual(
    PHOTO_SIZES.map((s) => [s.id, s.wMM, s.hMM]),
    [
      ["india-passport", 35, 45],
      ["india-visa-pan", 25, 35],
      ["us-visa", 51, 51],
      ["china-visa", 33, 48],
      ["custom", 35, 45],
    ],
    "size table: India 35×45, PAN/visa 25×35, US 51×51, China 33×48, custom default"
  );
  assert(sizeById("india-passport") !== undefined, "sizeById resolves");
  assertEqual(sizeById("nope"), undefined, "sizeById unknown → undefined");
  assert(isPhotoSizeId("us-visa") && !isPhotoSizeId("nope"), "isPhotoSizeId");

  /* mm→px at 300 DPI for every preset (hard literals, hand-checked) */
  const pxExpected: Array<[string, number, number]> = [
    ["india-passport", 413, 531],
    ["india-visa-pan", 295, 413],
    ["us-visa", 602, 602],
    ["china-visa", 390, 567],
  ];
  for (const [id, w, h] of pxExpected) {
    const px = photoPixelSize(resolveSize(id, 0, 0));
    assertEqual(
      px,
      { w, h },
      `photoPixelSize(${id}) = ${w}×${h} at 300 DPI`
    );
  }
  assert(
    near(sizeAspect(resolveSize("india-passport", 0, 0)), 35 / 45),
    "sizeAspect = wMM/hMM"
  );

  /* ---- clampCustomMM + resolveSize ---- */
  assertEqual(clampCustomMM(42.7, 35), 42.7, "clampCustomMM keeps in-range");
  assertEqual(clampCustomMM(-5, 35), 15, "clampCustomMM low → 15");
  assertEqual(clampCustomMM(200, 45), 100, "clampCustomMM high → 100");
  assertEqual(clampCustomMM("x", 35), 35, "clampCustomMM junk → fallback");
  assertEqual(clampCustomMM(Number.NaN, 45), 45, "clampCustomMM NaN → fallback");

  assertEqual(
    resolveSize("unknown-id", 60, 70),
    { sizeId: "india-passport", wMM: 35, hMM: 45 },
    "resolveSize: unknown id honestly falls back to India passport"
  );
  assertEqual(
    resolveSize(null, 60, 70),
    { sizeId: "india-passport", wMM: 35, hMM: 45 },
    "resolveSize: null id → India passport"
  );
  assertEqual(
    resolveSize("us-visa", 60, 70),
    { sizeId: "us-visa", wMM: 51, hMM: 51 },
    "resolveSize: preset ignores custom mm"
  );
  assertEqual(
    resolveSize("custom", "junk", "junk"),
    { sizeId: "custom", wMM: 35, hMM: 45 },
    "resolveSize: custom junk → 35/45 fallback"
  );
  assertEqual(
    resolveSize("custom", 5, 500),
    { sizeId: "custom", wMM: 15, hMM: 100 },
    "resolveSize: custom clamps to 15–100"
  );
  assertEqual(
    resolveSize("custom", 51.5, 63.2),
    { sizeId: "custom", wMM: 51.5, hMM: 63.2 },
    "resolveSize: custom keeps in-range decimals"
  );

  /* ---- sheet presets ---- */
  assertEqual(
    SHEETS.map((s) => [s.id, s.wPt, s.hPt]),
    [
      ["photo4x6", 288, 432],
      ["a4", 595.28, 841.89],
    ],
    "sheet presets: 4×6 = 288×432pt, A4 = 595.28×841.89pt"
  );
  assertEqual(sheetById("a4").id, "a4", "sheetById resolves");
  assertEqual(sheetById("nope").id, "photo4x6", "sheetById unknown → 4×6");

  /* ---- grid packing: every preset × sheet × infoLine vs the INDEPENDENT
     floor formula (cols = floor((pageW − 2·pad + gap) / (cellW + gap)), …) */
  const ids: Array<[string, number, number]> = [
    ["india-passport", 35, 45],
    ["india-visa-pan", 25, 35],
    ["us-visa", 51, 51],
    ["china-visa", 33, 48],
  ];
  for (const [id, wMM, hMM] of ids) {
    for (const sheet of ["photo4x6", "a4"] as const) {
      for (const infoLine of [true, false]) {
        const size = resolveSize(id, 0, 0);
        const plan = computeSheetPlan(size, sheet, { infoLine });
        const exp = expectedGrid(wMM, hMM, sheet, infoLine);
        assert(
          plan.cols === exp.cols && plan.rows === exp.rows,
          `grid ${id} ${sheet}${infoLine ? " info" : ""}: cols=${exp.cols} rows=${exp.rows} (independent formula)`,
          { model: [plan.cols, plan.rows], expected: [exp.cols, exp.rows] }
        );
        assert(
          plan.copies === exp.copies,
          `grid ${id} ${sheet}${infoLine ? " info" : ""}: copies=${exp.copies}`,
          plan.copies
        );
      }
    }
  }
  /* hand-pinned literals (the India passport comment's own example) */
  const india = resolveSize("india-passport", 0, 0);
  assertEqual(
    computeSheetPlan(india, "photo4x6", { infoLine: true }).copies,
    6,
    "India passport on 4×6 = 6 copies (the model's documented example)"
  );
  assertEqual(
    computeSheetPlan(india, "a4", { infoLine: true }).copies,
    30,
    "India passport on A4 = 30 copies"
  );
  assertEqual(
    computeSheetPlan(resolveSize("india-visa-pan", 0, 0), "photo4x6", {
      infoLine: true,
    }).copies,
    9,
    "PAN 25×35 on 4×6 with info strip = 9 copies"
  );
  assertEqual(
    computeSheetPlan(resolveSize("india-visa-pan", 0, 0), "photo4x6", {
      infoLine: false,
    }).copies,
    12,
    "PAN 25×35 on 4×6 WITHOUT info strip = 12 copies (strip reserve bites)"
  );
  assertEqual(
    computeSheetPlan(resolveSize("us-visa", 0, 0), "photo4x6", {
      infoLine: true,
    }).copies,
    2,
    "US 51×51 on 4×6 = 2 copies"
  );
  assertEqual(
    computeSheetPlan(resolveSize("china-visa", 0, 0), "a4", {
      infoLine: true,
    }).copies,
    25,
    "China 33×48 on A4 = 25 copies"
  );
  assertEqual(
    computeSheetPlan(resolveSize("custom", 15, 15), "photo4x6", {
      infoLine: true,
    }).copies,
    40,
    "custom 15×15 on 4×6 = 40 copies"
  );

  /* custom 100×100: 4×6 impossible (0 columns — honest 0), A4 fits 4 */
  const big = resolveSize("custom", 100, 100);
  const big46 = computeSheetPlan(big, "photo4x6", { infoLine: true });
  assertEqual(
    [big46.cols, big46.rows, big46.copies],
    [0, 1, 0],
    "custom 100×100 on 4×6: zero columns → honest 0 copies (never shrink)"
  );
  const bigA4 = computeSheetPlan(big, "a4", { infoLine: true });
  assertEqual([bigA4.cols, bigA4.rows, bigA4.copies], [2, 2, 4], "custom 100×100 on A4 = 4 copies");
  assertEqual(
    photoPixelSize(big),
    { w: 1181, h: 1181 },
    "custom 100×100 pixel size = 1181×1181"
  );

  /* ---- plan geometry: centring, gutters, in-page, info strip ---- */
  const plan = computeSheetPlan(india, "photo4x6", { infoLine: true });
  assert(near(plan.cellW, mmToPt(35)) && near(plan.cellH, mmToPt(45)), "plan cell = mm→pt");
  assert(plan.pageW === 288 && plan.pageH === 432, "plan page dims");
  assert(plan.infoLine === true, "plan infoLine flag");
  assert(
    plan.padBottom === SHEET_PAD_PT + INFO_STRIP_PT,
    "info-line plan reserves padBottom = pad + strip"
  );
  assertEqual(
    computeSheetPlan(india, "photo4x6", { infoLine: false }).padBottom,
    SHEET_PAD_PT,
    "no-info plan padBottom = plain pad"
  );
  for (let row = 0; row < plan.rows; row += 1) {
    for (let col = 0; col < plan.cols; col += 1) {
      const cell = sheetCellRect(plan, row, col);
      assert(
        cell.x >= 0 && cell.y >= 0 && cell.x + cell.w <= plan.pageW + 1e-6 && cell.y + cell.h <= plan.pageH + 1e-6,
        `cell (${row},${col}) stays inside the page`,
        cell
      );
      assert(
        cell.y + cell.h <= plan.pageH - plan.padBottom + 1e-6,
        `cell (${row},${col}) leaves the info strip free`,
        { bottom: cell.y + cell.h, limit: plan.pageH - plan.padBottom }
      );
      if (col > 0) {
        const left = sheetCellRect(plan, row, col - 1);
        assert(
          near(cell.x - (left.x + left.w), CELL_GAP_PT, 1e-6),
          `gutter between (${row},${col-1}) and (${row},${col}) = ${CELL_GAP_PT}pt`
        );
      }
    }
  }
  const c00 = sheetCellRect(plan, 0, 0);
  assert(
    near(c00.x, plan.offsetX, 1e-9) && near(c00.y, plan.offsetY, 1e-9),
    "cell (0,0) sits at the grid block origin"
  );
  assert(plan.offsetX >= SHEET_PAD_PT - CELL_GAP_PT / 2 - 1e-9, "grid block horizontally centred with margin");
  assert(plan.offsetY >= plan.padTop - 1e-9, "grid starts at/below the top pad");

  /* ---- crop math ---- */
  const landscape = computeCropRect(400, 200, 35 / 45, 1, 0, 0);
  assert(
    near(landscape.sy, 0) &&
      near(landscape.sh, 200) &&
      near(landscape.sw, (200 * 35) / 45) &&
      near(landscape.sx, (400 - (200 * 35) / 45) / 2),
    "crop: landscape source → height-limited centred 35:45 window",
    landscape
  );
  const portrait = computeCropRect(200, 400, 35 / 45, 1, 0, 0);
  assert(
    near(portrait.sx, 0) &&
      near(portrait.sw, 200) &&
      near(portrait.sh, 200 / (35 / 45)) &&
      near(portrait.sy, (400 - 200 / (35 / 45)) / 2),
    "crop: portrait source → width-limited centred window",
    portrait
  );
  const zoomed = computeCropRect(400, 200, 35 / 45, 2, 0, 0);
  assert(
    near(zoomed.sw, landscape.sw / 2) &&
      near(zoomed.sx, (400 - landscape.sw / 2) / 2),
    "crop: zoom 2 halves the window, re-centred",
    zoomed
  );
  const panRight = computeCropRect(400, 200, 35 / 45, 2, 1, 0);
  assert(
    near(panRight.sx, 400 - panRight.sw),
    "crop: panX +1 slides flush right",
    panRight
  );
  const panLeft = computeCropRect(400, 200, 35 / 45, 2, -1, 0);
  assert(near(panLeft.sx, 0), "crop: panX −1 slides flush left", panLeft);
  const panClamped = computeCropRect(400, 200, 35 / 45, 2, 5, -9);
  assert(
    near(panClamped.sx, 400 - panClamped.sw) && near(panClamped.sy, 0),
    "crop: pan clamps to ±1",
    panClamped
  );
  assertEqual(
    computeCropRect(0, 100, 1, 1, 0, 0),
    { sx: 0, sy: 0, sw: 0, sh: 0 },
    "crop: degenerate source → zero rect"
  );
  assertEqual(
    computeCropRect(100, 100, 0, 1, 0, 0),
    { sx: 0, sy: 0, sw: 0, sh: 0 },
    "crop: degenerate aspect → zero rect"
  );
  assertEqual(clampZoom(0.5), 1, "clampZoom low → 1");
  assertEqual(clampZoom(10), 6, "clampZoom high → 6");
  assertEqual(clampZoom("x"), 1, "clampZoom junk → 1");
  assert(near(HEAD_GUIDE.bottom - HEAD_GUIDE.top, 0.7), "head guide band = 70% of frame");

  /* ---- smart white: tolerance math ---- */
  assertEqual(toleranceDistanceSq(0), 0, "tolerance 0 → distance² 0");
  assert(
    near(toleranceDistanceSq(100), 3 * 255 * 255, 1e-3),
    "tolerance 100 → (√3·255)² (any colour)",
    toleranceDistanceSq(100)
  );
  assert(
    near(toleranceDistanceSq(50), 0.25 * 3 * 255 * 255, 1e-3),
    "tolerance 50 → quarter of max",
    toleranceDistanceSq(50)
  );
  assertEqual(toleranceDistanceSq(-5), 0, "tolerance clamps low");
  assert(
    near(toleranceDistanceSq(150), toleranceDistanceSq(100), 1e-9),
    "tolerance clamps high"
  );

  /* ---- smart white: flood fill on synthetic RGBA ---- */
  const BG: [number, number, number] = [120, 170, 210];
  const FACE: [number, number, number] = [230, 120, 90];
  const W = 24;
  const H = 18;
  const makePhoto = (): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) {
      data[i * 4] = BG[0];
      data[i * 4 + 1] = BG[1];
      data[i * 4 + 2] = BG[2];
      data[i * 4 + 3] = 255;
    }
    return data;
  };
  const paint = (
    data: Uint8ClampedArray,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: [number, number, number]
  ): void => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const o = (y * W + x) * 4;
        data[o] = color[0];
        data[o + 1] = color[1];
        data[o + 2] = color[2];
      }
    }
  };
  const pxAt = (data: Uint8ClampedArray, x: number, y: number): [number, number, number] => [
    data[(y * W + x) * 4],
    data[(y * W + x) * 4 + 1],
    data[(y * W + x) * 4 + 2],
  ];

  /* A: plain background + centre face */
  const a = makePhoto();
  paint(a, 8, 6, 16, 12, FACE); // 8×6 = 48 face pixels
  const washedA = applyWhiteBackground(a, W, H, 30);
  assertEqual(washedA, W * H - 48, "wash A: everything but the 48 face pixels (384)");
  assertEqual(pxAt(a, 0, 0), [255, 255, 255], "wash A: corner bg washed to pure white");
  assertEqual(pxAt(a, 23, 17), [255, 255, 255], "wash A: opposite corner washed");
  assertEqual(pxAt(a, 12, 9), FACE, "wash A: centre face pixel preserved");
  assert(a[3] === 255, "wash A: alpha untouched");

  /* B: tolerance 0 with an exact-match bg still floods */
  const b = makePhoto();
  paint(b, 8, 6, 16, 12, FACE);
  const washedB = applyWhiteBackground(b, W, H, 0);
  assertEqual(washedB, W * H - 48, "wash B: tolerance 0 floods the exact seed colour");

  /* C: connectivity — a bg-coloured core INSIDE the face is NOT washed */
  const c = makePhoto();
  paint(c, 8, 6, 16, 12, FACE);
  paint(c, 11, 8, 13, 10, BG); // 2×2 core of seed colour, behind the face moat
  const washedC = applyWhiteBackground(c, W, H, 30);
  assertEqual(washedC, W * H - 48, "wash C: fill is connectivity-based — the cored face still costs exactly 48");
  assertEqual(pxAt(c, 12, 9), BG, "wash C: the unwashed core keeps its original colour (not white)");

  /* D: seed = the corner MEAN, not the first corner */
  const d = makePhoto();
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      const v = y < H / 2 ? 250 : 240;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
    }
  }
  const washedD0 = applyWhiteBackground(d, W, H, 0);
  assertEqual(washedD0, 0, "wash D: tolerance 0 with seed (245,245,245) matches NEITHER half");
  const washedD30 = applyWhiteBackground(d, W, H, 30);
  assertEqual(washedD30, W * H, "wash D: tolerance 30 floods both halves from the mean seed");

  /* E: gradient background — the flood stops at the tolerance ring */
  const GW = 10;
  const GH = 21;
  const g = new Uint8ClampedArray(GW * GH * 4);
  for (let y = 0; y < GH; y += 1) {
    for (let x = 0; x < GW; x += 1) {
      const o = (y * GW + x) * 4;
      const v = 200 - 3 * y; // 200 … 140
      g[o] = v;
      g[o + 1] = v;
      g[o + 2] = v;
      g[o + 3] = 255;
    }
  }
  const washedE = applyWhiteBackground(g, GW, GH, 10);
  // seed = 170; |v−170| ≤ √(maxDistSq/3) ⇒ v ∈ [145,195] ⇒ rows 2..18 wash.
  assertEqual(washedE, 17 * GW, "wash E: tolerance 10 stops the gradient at the ring (17 middle rows)");
  const gRow = (data: Uint8ClampedArray, y: number): number => data[(y * GW) * 4];
  assert(gRow(g, 0) === 200 && gRow(g, 20) === 140, "wash E: extreme rows keep the original");
  assert(gRow(g, 10) === 255, "wash E: middle row washed white");

  /* F: tolerance 100 washes ANY colour (the docstring's √3·255 claim) */
  const f = makePhoto();
  paint(f, 8, 6, 16, 12, FACE);
  const washedF = applyWhiteBackground(f, W, H, 100);
  assertEqual(washedF, W * H, "wash F: tolerance 100 washes everything (face included)");
  assertEqual(pxAt(f, 12, 9), [255, 255, 255], "wash F: face pixel itself washed");

  /* G: degenerate inputs */
  assertEqual(applyWhiteBackground(new Uint8ClampedArray(16), 0, 0, 30), 0, "wash: zero dims → 0");
  assertEqual(
    applyWhiteBackground(new Uint8ClampedArray(10), 4, 4, 30),
    0,
    "wash: short data → 0"
  );

  /* ---- brightness / contrast ---- */
  const ramp = new Uint8ClampedArray([
    10, 128, 250, 255,
    200, 60, 0, 255,
    0, 255, 128, 200,
  ]);
  const identity = new Uint8ClampedArray(ramp);
  applyBrightnessContrast(identity, 0, 0);
  assert(
    identity.every((v, i) => v === ramp[i]),
    "adjust (0,0): exact identity (early return)"
  );
  /** Independent textbook implementation for expectations. */
  const expectedAdjust = (
    source: Uint8ClampedArray,
    bRaw: number,
    cRaw: number
  ): Uint8ClampedArray => {
    const b = Math.min(60, Math.max(-60, bRaw));
    const c = Math.min(60, Math.max(-60, cRaw));
    const factor = (259 * (c + 255)) / (255 * (259 - c));
    const out = new Uint8ClampedArray(source.length);
    for (let i = 0; i < source.length; i += 4) {
      for (let ch = 0; ch < 3; ch += 1) {
        const v = (source[i + ch] - 128) * factor + 128 + b;
        out[i + ch] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
      out[i + 3] = source[i + 3];
    }
    return out;
  };
  const adjustCase = (b: number, c: number, label: string): void => {
    const data = new Uint8ClampedArray(ramp);
    applyBrightnessContrast(data, b, c);
    const exp = expectedAdjust(ramp, b, c);
    assert(
      data.every((v, i) => v === exp[i]),
      `adjust ${label}: matches the textbook formula (clamp+round)`,
      { got: Array.from(data), want: Array.from(exp) }
    );
  };
  adjustCase(25, 0, "brightness +25");
  adjustCase(-25, 0, "brightness −25");
  adjustCase(0, 40, "contrast +40");
  adjustCase(0, -40, "contrast −40");
  adjustCase(0, 60, "contrast +60 (max)");
  adjustCase(0, -60, "contrast −60 (min)");
  adjustCase(10, -20, "brightness +10 with contrast −20");
  adjustCase(999, 0, "brightness 999 clamps to +60");
  adjustCase(-999, 0, "brightness −999 clamps to −60");
  adjustCase(0, 999, "contrast 999 clamps to +60");
  const junkAdjust = new Uint8ClampedArray(ramp);
  applyBrightnessContrast(junkAdjust, Number.NaN, Number.NaN);
  assert(
    junkAdjust.every((v, i) => v === ramp[i]),
    "adjust: NaN inputs clamp to identity (never a destructive −60)"
  );
  const keepAlpha = new Uint8ClampedArray([100, 100, 100, 77, 200, 200, 200, 33]);
  applyBrightnessContrast(keepAlpha, 30, 30);
  assert(
    keepAlpha[3] === 77 && keepAlpha[7] === 33,
    "adjust: alpha channel untouched"
  );
  const pivot = new Uint8ClampedArray([128, 128, 128, 255]);
  applyBrightnessContrast(pivot, 0, 55);
  assert(
    pivot[0] === 128 && pivot[1] === 128 && pivot[2] === 128,
    "adjust: mid-grey 128 is the contrast pivot (stays 128)"
  );

  /* ---- wire format ---- */
  assertEqual(
    sanitizeStyleDeep(null),
    DEFAULT_STYLE,
    "sanitizeStyle: null → defaults"
  );
  assertEqual(
    sanitizeStyleDeep("garbage"),
    DEFAULT_STYLE,
    "sanitizeStyle: junk type → defaults"
  );
  const garbageStyle = sanitizeStyleDeep({
    sizeId: "mars-rover",
    customW: 5000,
    customH: "x",
    sheet: "a5",
    zoom: 99,
    panX: 42,
    panY: -42,
    background: "transparent",
    whiteTolerance: 9999,
    brightness: -500,
    contrast: 500,
    cutGuides: 0,
    infoLine: 1,
  });
  assert(
    garbageStyle.sizeId === "india-passport" &&
      garbageStyle.customW === 100 &&
      garbageStyle.customH === 45 &&
      garbageStyle.sheet === "photo4x6" &&
      garbageStyle.zoom === 6 &&
      garbageStyle.panX === 1 &&
      garbageStyle.panY === -1 &&
      garbageStyle.background === "white" &&
      garbageStyle.whiteTolerance === 100 &&
      garbageStyle.brightness === -60 &&
      garbageStyle.contrast === 60 &&
      garbageStyle.cutGuides === true &&
      garbageStyle.infoLine === true,
    "sanitizeStyle: every garbage field falls back / clamps",
    garbageStyle
  );

  assertEqual(
    parsePassportOption(undefined),
    { style: { ...DEFAULT_STYLE }, locale: "en" },
    "parsePassportOption: missing → defaults + en"
  );
  assertEqual(
    parsePassportOption("{not json"),
    { style: { ...DEFAULT_STYLE }, locale: "en" },
    "parsePassportOption: corrupt JSON → defaults"
  );
  assertEqual(
    parsePassportOption(null),
    { style: { ...DEFAULT_STYLE }, locale: "en" },
    "parsePassportOption: null object → defaults"
  );
  const roundTrip = parsePassportOption(
    serializePassport({
      style: {
        ...DEFAULT_STYLE,
        sizeId: "china-visa",
        sheet: "a4",
        zoom: 2.5,
        panX: -0.5,
        panY: 0.25,
        background: "original",
        whiteTolerance: 55,
        brightness: -12,
        contrast: 34,
        cutGuides: false,
        infoLine: false,
      },
      locale: "hi",
    })
  );
  assert(
    roundTrip.locale === "hi" &&
      roundTrip.style.sizeId === "china-visa" &&
      roundTrip.style.sheet === "a4" &&
      roundTrip.style.zoom === 2.5 &&
      roundTrip.style.panX === -0.5 &&
      roundTrip.style.panY === 0.25 &&
      roundTrip.style.background === "original" &&
      roundTrip.style.whiteTolerance === 55 &&
      roundTrip.style.brightness === -12 &&
      roundTrip.style.contrast === 34 &&
      roundTrip.style.cutGuides === false &&
      roundTrip.style.infoLine === false,
    "parsePassportOption: serialize → parse round trip keeps every field",
    roundTrip
  );
  assertEqual(
    parsePassportOption(JSON.stringify({ locale: "fr" })).locale,
    "en",
    "parsePassportOption: unknown locale → en"
  );

  /* ---- country compliance (R4-c) ---- */
  assert(COUNTRY_SPECS.length === 7, "country table: 7 target countries");
  assert(COUNTRY_SPECS[0]?.id === "india", "country table: India first (default)");
  const countryIds = COUNTRY_SPECS.map((c) => c.id);
  assert(
    new Set(countryIds).size === countryIds.length,
    "country table: unique ids"
  );
  assert(
    COUNTRY_SPECS.every(
      (c) =>
        c.wMM >= CUSTOM_MM_MIN &&
        c.wMM <= CUSTOM_MM_MAX &&
        c.hMM >= CUSTOM_MM_MIN &&
        c.hMM <= CUSTOM_MM_MAX &&
        c.faceMinPct > 0 &&
        c.faceMinPct < c.faceMaxPct &&
        c.faceMaxPct <= 100 &&
        c.label.en !== "" &&
        c.label.hi !== "" &&
        c.bg.en !== "" &&
        c.bg.hi !== "",
    ),
    "country table: sane mm + face band + localized labels/hints"
  );
  assert(isCountryId("canada") && !isCountryId("mars"), "isCountryId");
  assertEqual(sanitizeCountry("uk"), "uk", "sanitizeCountry: valid kept");
  assertEqual(
    sanitizeCountry("atlantis"),
    "india",
    "sanitizeCountry: garbage → india"
  );
  assertEqual(sanitizeCountry(42), "india", "sanitizeCountry: non-string → india");
  assertEqual(DEFAULT_STYLE.country, "india", "DEFAULT_STYLE.country = india");

  /* size suggestions: preset reuse where the mm match exactly, else custom */
  assertEqual(
    suggestedSizeForCountry(countryById("india") as NonNullable<ReturnType<typeof countryById>>),
    { sizeId: "india-passport", wMM: 35, hMM: 45 },
    "suggestion: india → india-passport preset"
  );
  assertEqual(
    suggestedSizeForCountry(countryById("us") as NonNullable<ReturnType<typeof countryById>>),
    { sizeId: "us-visa", wMM: 51, hMM: 51 },
    "suggestion: us → us-visa preset"
  );
  assertEqual(
    suggestedSizeForCountry(countryById("china") as NonNullable<ReturnType<typeof countryById>>),
    { sizeId: "china-visa", wMM: 33, hMM: 48 },
    "suggestion: china → china-visa preset"
  );
  assertEqual(
    suggestedSizeForCountry(countryById("canada") as NonNullable<ReturnType<typeof countryById>>),
    { sizeId: "custom", wMM: 50, hMM: 70 },
    "suggestion: canada → custom 50×70 (no preset)"
  );
  assertEqual(
    suggestedSizeForCountry(countryById("uk") as NonNullable<ReturnType<typeof countryById>>),
    { sizeId: "custom", wMM: 35, hMM: 45 },
    "suggestion: uk → custom (no India-labelled preset reuse)"
  );

  /* match / mismatch — honest 0.75 mm tolerance */
  const canadaSpec = countryById("canada") as NonNullable<ReturnType<typeof countryById>>;
  assert(
    sizeMatchesCountry({ sizeId: "custom", wMM: 50, hMM: 70 }, canadaSpec),
    "match: exact 50×70"
  );
  assert(
    sizeMatchesCountry({ sizeId: "custom", wMM: 50.5, hMM: 69.5 }, canadaSpec),
    "match: within 0.75 mm tolerance"
  );
  assert(
    !sizeMatchesCountry(india, canadaSpec),
    "mismatch: 35×45 vs Canada 50×70"
  );

  /* the report — switching the COUNTRY flips the suggestion + warns */
  assertEqual(
    complianceReport(india, "india").matches,
    true,
    "report: india default matches the india preset"
  );
  const repCanada = complianceReport(india, "canada");
  assert(
    repCanada.matches === false &&
      repCanada.spec.id === "canada" &&
      repCanada.suggestion.wMM === 50 &&
      repCanada.suggestion.hMM === 70 &&
      repCanada.spec.faceMinPct === 44 &&
      repCanada.spec.faceMaxPct === 51,
    "report: same photo size + Canada spec → honest mismatch + new suggestion",
    repCanada
  );
  assert(
    complianceReport({ sizeId: "custom", wMM: 50, hMM: 70 }, "canada").matches,
    "report: canada 50×70 → match"
  );
  const repUS = complianceReport(india, "us");
  assert(
    repUS.matches === false && repUS.suggestion.sizeId === "us-visa",
    "report: 35×45 vs US → mismatch + us-visa suggestion"
  );
  assertEqual(
    complianceReport(india, "atlantis" as unknown as CountryId).country,
    "india",
    "report: garbage country id falls back to india"
  );

  /* sanitizeStyle carries + sanitizes the country field */
  assertEqual(
    sanitizeStyleDeep({ country: "canada" }).country,
    "canada",
    "sanitizeStyle: country kept"
  );
  assertEqual(
    sanitizeStyleDeep({ country: "nope" }).country,
    "india",
    "sanitizeStyle: bad country → india"
  );
  assertEqual(
    sanitizeStyleDeep({}).country,
    "india",
    "sanitizeStyle: missing country → india (legacy drafts)"
  );
  assertEqual(
    parsePassportOption(
      serializePassport({
        style: { ...DEFAULT_STYLE, country: "schengen" },
        locale: "en",
      })
    ).style.country,
    "schengen",
    "option round-trip keeps the country"
  );

  /* ---- output names + info line ---- */
  assertEqual(photoOutputName("en"), "passport-photo.jpg", "photo output name en");
  assertEqual(photoOutputName("hi"), "पासपोर्ट-फ़ोटो.jpg", "photo output name hi (Devanagari)");
  assertEqual(sheetOutputName("en"), "passport-photo-sheet.pdf", "sheet output name en");
  assertEqual(sheetOutputName("hi"), "पासपोर्ट-फ़ोटो-शीट.pdf", "sheet output name hi (Devanagari)");
  const infoPlan = computeSheetPlan(india, "photo4x6", { infoLine: true });
  assertEqual(
    infoLineText(india, infoPlan),
    "35x45mm - 300 DPI - 6 copies - DocoPDF",
    "info line: exact ASCII text"
  );
  assert(
    infoLineText(india, infoPlan).length <= 80,
    "info line: capped at 80 chars"
  );
  const single = { ...india, wMM: 100, hMM: 100 };
  assertEqual(
    infoLineText(single, computeSheetPlan(single, "a4", { infoLine: true })),
    "100x100mm - 300 DPI - 4 copies - DocoPDF",
    "info line: 4 copies on A4 custom"
  );
  const one = resolveSize("custom", 50, 75);
  assertEqual(
    computeSheetPlan(one, "photo4x6", { infoLine: true }).copies,
    1,
    "custom 50×75 on 4×6 = exactly 1 copy"
  );
  assertEqual(
    infoLineText(one, computeSheetPlan(one, "photo4x6", { infoLine: true })),
    "50x75mm - 300 DPI - 1 copy - DocoPDF",
    "info line: singular 'copy' when copies === 1"
  );
}

/** sanitizeStyle on a deep-garbage object (kept out of part1 for clarity). */
function sanitizeStyleDeep(value: unknown): PassportStyle {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return parsePassportOption(JSON.stringify({ style: raw })).style;
}

/* ================================================================== */
/* Part 2 — render engine (recording ctx)                               */
/* ================================================================== */

type RecordedOp = { op: string; args: unknown[] };

class RecordingCtx {
  canvas: { width: number; height: number };
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  font = "16px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  imageSmoothingEnabled = true;
  imageSmoothingQuality: "high" | "low" | "medium" = "high";
  ops: RecordedOp[] = [];

  constructor(width: number, height: number) {
    this.canvas = { width, height };
  }
  setLineDash(dash: number[]): void {
    this.ops.push({ op: "setLineDash", args: [dash] });
  }
  save(): void {
    this.ops.push({ op: "save", args: [] });
  }
  restore(): void {
    this.ops.push({ op: "restore", args: [] });
  }
  beginPath(): void {
    this.ops.push({ op: "beginPath", args: [] });
  }
  moveTo(x: number, y: number): void {
    this.ops.push({ op: "moveTo", args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ op: "lineTo", args: [x, y] });
  }
  closePath(): void {
    this.ops.push({ op: "closePath", args: [] });
  }
  stroke(): void {
    this.ops.push({ op: "stroke", args: [] });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: "fillRect", args: [x, y, w, h, this.fillStyle] });
  }
  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: "fillText", args: [text, x, y, this.fillStyle] });
  }
  measureText(text: string): { width: number } {
    const size = /(\d+(?:\.\d+)?)px/.exec(this.font);
    return { width: [...text].length * Number(size ? size[1] : 16) * 0.55 };
  }
  drawImage(source: unknown, ...args: number[]): void {
    this.ops.push({ op: "drawImage", args: [source, ...args] });
  }
}

function part2(): void {
  /* drawPhotoCrop */
  const pctx = new RecordingCtx(100, 130);
  drawPhotoCrop(
    pctx as unknown as Parameters<typeof drawPhotoCrop>[0],
    { width: 10, height: 10 } as unknown as Parameters<typeof drawPhotoCrop>[1],
    { sx: 5, sy: 6, sw: 30, sh: 40 },
    10, 20, 80, 100
  );
  assertEqual(pctx.ops.length, 2, "drawPhotoCrop: exactly 2 ops");
  assertEqual(
    pctx.ops[0],
    { op: "fillRect", args: [10, 20, 80, 100, "#ffffff"] },
    "drawPhotoCrop: white flatten rect first"
  );
  assertEqual(
    pctx.ops[1].op,
    "drawImage",
    "drawPhotoCrop: then the crop"
  );
  assertEqual(
    pctx.ops[1].args.slice(1),
    [5, 6, 30, 40, 10, 20, 80, 100],
    "drawPhotoCrop: 9-arg crop (sx,sy,sw,sh,dx,dy,dw,dh)"
  );
  const degenerate = new RecordingCtx(10, 10);
  drawPhotoCrop(
    degenerate as unknown as Parameters<typeof drawPhotoCrop>[0],
    { width: 10, height: 10 } as unknown as Parameters<typeof drawPhotoCrop>[1],
    { sx: 0, sy: 0, sw: 10, sh: 10 },
    0, 0, 0, 10
  );
  assertEqual(degenerate.ops.length, 0, "drawPhotoCrop: degenerate dest → no ops");

  /* dimOutside */
  const dctx = new RecordingCtx(100, 100);
  dimOutside(dctx as unknown as Parameters<typeof dimOutside>[0], { x: 10, y: 10, w: 80, h: 80 }, 100, 100);
  assertEqual(dctx.ops.length, 4, "dimOutside: interior rect → 4 veil rects");
  assertEqual(
    dctx.ops.map((o) => o.args.slice(0, 4)),
    [
      [0, 0, 100, 10],
      [0, 90, 100, 10],
      [0, 10, 10, 80],
      [90, 10, 10, 80],
    ],
    "dimOutside: top, bottom, left, right veils"
  );
  assert(
    dctx.ops.every((o) => o.args[4] === "rgba(28, 25, 23, 0.52)"),
    "dimOutside: the dark veil colour"
  );
  const full = new RecordingCtx(100, 100);
  dimOutside(full as unknown as Parameters<typeof dimOutside>[0], { x: 0, y: 0, w: 100, h: 100 }, 100, 100);
  assertEqual(full.ops.length, 0, "dimOutside: full-canvas rect → nothing dimmed");

  /* drawCropFrame */
  const fctx = new RecordingCtx(200, 200);
  drawCropFrame(fctx as unknown as Parameters<typeof drawCropFrame>[0], { x: 10, y: 20, w: 100, h: 150 });
  const dash = fctx.ops.find((o) => o.op === "setLineDash");
  assertEqual(dash?.args[0], [7, 5], "drawCropFrame: dashed [7,5]");
  assert(fctx.strokeStyle === "#e11d48", "drawCropFrame: accent stroke colour");
  assert(fctx.lineWidth === 2, "drawCropFrame: 2px line");
  assert(
    fctx.ops.some((o) => o.op === "closePath") && fctx.ops.some((o) => o.op === "stroke"),
    "drawCropFrame: closed path + stroke"
  );
  const zero = new RecordingCtx(10, 10);
  drawCropFrame(zero as unknown as Parameters<typeof drawCropFrame>[0], { x: 0, y: 0, w: 0, h: 5 });
  assertEqual(zero.ops.length, 0, "drawCropFrame: degenerate rect → no ops");

  /* drawHeadGuide */
  const hctx = new RecordingCtx(200, 200);
  drawHeadGuide(hctx as unknown as Parameters<typeof drawHeadGuide>[0], { x: 10, y: 20, w: 100, h: 150 });
  const band = hctx.ops.find((o) => o.op === "fillRect");
  assert(
    band !== undefined &&
      (band.args[0] as number) === 10 &&
      (band.args[1] as number) === 20 + 150 * HEAD_GUIDE.top &&
      (band.args[2] as number) === 100 &&
      near(band.args[3] as number, 150 * (HEAD_GUIDE.bottom - HEAD_GUIDE.top)),
    "drawHeadGuide: band rect at the guide fractions",
    band?.args
  );
  const label = hctx.ops.find((o) => o.op === "fillText");
  assert(
    label !== undefined && label.args[0] === "~70%",
    "drawHeadGuide: '~70%' label chip",
    label?.args
  );

  /* drawSheetPreview — tied to the real model plan */
  const india = resolveSize("india-passport", 0, 0);
  const plan = computeSheetPlan(india, "photo4x6", { infoLine: true });
  const SHEET_W = 240;
  const SHEET_H = Math.round((SHEET_W * plan.pageH) / plan.pageW);
  const sctx = new RecordingCtx(SHEET_W, SHEET_H);
  const photo = { width: 413, height: 531 } as unknown as Parameters<typeof drawSheetPreview>[2];
  drawSheetPreview(sctx as unknown as Parameters<typeof drawSheetPreview>[0], plan, photo, {
    infoText: infoLineText(india, plan),
  });
  const scale = SHEET_W / plan.pageW;
  const images = sctx.ops.filter((o) => o.op === "drawImage");
  assertEqual(images.length, plan.copies, `sheet preview: ${plan.copies} photo draws`);
  let cellsOk = true;
  for (let row = 0; row < plan.rows; row += 1) {
    for (let col = 0; col < plan.cols; col += 1) {
      const cell = sheetCellRect(plan, row, col);
      const want = [
        cell.x * scale,
        cell.y * scale,
        cell.w * scale,
        cell.h * scale,
      ];
      const got = images[row * plan.cols + col]?.args.slice(1, 5);
      if (JSON.stringify(got) !== JSON.stringify(want)) cellsOk = false;
    }
  }
  assert(cellsOk, "sheet preview: every drawImage sits on its model cell (scaled)", images.map((o) => o.args.slice(1, 5)));
  const pageFill = sctx.ops[0];
  assertEqual(
    [pageFill.op, pageFill.args[0], pageFill.args[1], pageFill.args[4]],
    ["fillRect", 0, 0, "#ffffff"],
    "sheet preview: white page painted first"
  );
  const cutDash = sctx.ops.filter((o) => o.op === "setLineDash");
  assertEqual(cutDash.length, 1, "sheet preview: one dash setup for the guide pass");
  assert(
    cutDash.every((o) => JSON.stringify(o.args[0]) === JSON.stringify([4, 3])),
    "sheet preview: cut-guide dash [4,3]"
  );
  assertEqual(
    sctx.ops.filter((o) => o.op === "stroke").length,
    plan.copies,
    `sheet preview: ${plan.copies} stroked cut-guide rects`
  );
  const info = sctx.ops.find((o) => o.op === "fillText");
  assert(
    info !== undefined && info.args[0] === "35x45mm - 300 DPI - 6 copies - DocoPDF" && near(info.args[1] as number, SHEET_W / 2),
    "sheet preview: info line centred",
    info?.args
  );

  /* cutGuides off + empty info text */
  const plain = new RecordingCtx(SHEET_W, SHEET_H);
  drawSheetPreview(plain as unknown as Parameters<typeof drawSheetPreview>[0], plan, photo, {
    cutGuides: false,
    infoText: "",
  });
  assertEqual(
    plain.ops.filter((o) => o.op === "drawImage").length,
    plan.copies,
    "sheet preview (no guides): photos still drawn"
  );
  assertEqual(
    plain.ops.filter((o) => o.op === "setLineDash").length,
    0,
    "sheet preview (no guides): no dashed rects"
  );
  assertEqual(
    plain.ops.filter((o) => o.op === "fillText").length,
    0,
    "sheet preview (no info): no text op"
  );

  /* a zero-copy plan paints only the page */
  const big = resolveSize("custom", 100, 100);
  const zeroPlan = computeSheetPlan(big, "photo4x6", { infoLine: true });
  const zctx = new RecordingCtx(SHEET_W, Math.round((SHEET_W * zeroPlan.pageH) / zeroPlan.pageW));
  drawSheetPreview(zctx as unknown as Parameters<typeof drawSheetPreview>[0], zeroPlan, photo, {
    infoText: infoLineText(big, zeroPlan),
  });
  assertEqual(zctx.ops.filter((o) => o.op === "drawImage").length, 0, "sheet preview (0 copies): no photos");
  assertEqual(zctx.ops.filter((o) => o.op === "setLineDash").length, 0, "sheet preview (0 copies): no cut guides");
}

/* ================================================================== */
/* Canvas shims — sharp-backed rasterizer for bun                       */
/* ================================================================== */

interface ShimBitmap {
  width: number;
  height: number;
  _raw: Buffer;
  close(): void;
}

function isShimBitmap(source: unknown): source is ShimBitmap {
  return (
    typeof source === "object" &&
    source !== null &&
    "_raw" in source &&
    "width" in source
  );
}

function parseCssColor(fill: string): [number, number, number, number] {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(fill.trim());
  if (hex) {
    return [
      Number.parseInt(hex[1].slice(0, 2), 16),
      Number.parseInt(hex[1].slice(2, 4), 16),
      Number.parseInt(hex[1].slice(4, 6), 16),
      255,
    ];
  }
  const rgba = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\)/.exec(fill);
  if (rgba) {
    return [
      Number(rgba[1]),
      Number(rgba[2]),
      Number(rgba[3]),
      rgba[4] === undefined ? 255 : Math.round(Number(rgba[4]) * 255),
    ];
  }
  return [0, 0, 0, 255];
}

/** Eager pixel buffer canvas — drawImage uses nearest-neighbour sampling. */
class PixelCanvas {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  getContext(kind: string): PixelCtx | null {
    return kind === "2d" ? new PixelCtx(this) : null;
  }

  async convertToBlob(options: {
    type: string;
    quality?: number;
  }): Promise<Blob> {
    const pipeline = sharp(Buffer.from(this.pixels.buffer, this.pixels.byteOffset, this.pixels.length), {
      raw: { width: this.width, height: this.height, channels: 4 },
    });
    const bytes =
      options.type === "image/png"
        ? await pipeline.png().toBuffer()
        : await pipeline
            .jpeg({ quality: Math.round((options.quality ?? 0.92) * 100) })
            .toBuffer();
    return new Blob([new Uint8Array(bytes)], { type: options.type });
  }
}

class PixelCtx {
  canvas: PixelCanvas;
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  font = "16px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  imageSmoothingEnabled = true;
  imageSmoothingQuality: "high" | "low" | "medium" = "high";

  constructor(canvas: PixelCanvas) {
    this.canvas = canvas;
  }
  setLineDash(): void {
    /* recorded paths are cosmetic here */
  }
  save(): void {
    /* no transform state in the shim */
  }
  restore(): void {
    /* no transform state in the shim */
  }
  beginPath(): void {
    /* cosmetic */
  }
  moveTo(): void {
    /* cosmetic */
  }
  lineTo(): void {
    /* cosmetic */
  }
  closePath(): void {
    /* cosmetic */
  }
  stroke(): void {
    /* cosmetic */
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = parseCssColor(this.fillStyle);
    const cv = this.canvas;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(cv.width, Math.ceil(x + w));
    const y1 = Math.min(cv.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        const o = (yy * cv.width + xx) * 4;
        if (a === 255) {
          cv.pixels[o] = r;
          cv.pixels[o + 1] = g;
          cv.pixels[o + 2] = b;
          cv.pixels[o + 3] = 255;
        } else {
          const ai = a / 255;
          cv.pixels[o] = Math.round(cv.pixels[o] * (1 - ai) + r * ai);
          cv.pixels[o + 1] = Math.round(cv.pixels[o + 1] * (1 - ai) + g * ai);
          cv.pixels[o + 2] = Math.round(cv.pixels[o + 2] * (1 - ai) + b * ai);
          cv.pixels[o + 3] = Math.min(255, cv.pixels[o + 3] + a);
        }
      }
    }
  }
  fillText(): void {
    /* the worker never rasterizes text on the photo canvas */
  }
  measureText(text: string): { width: number } {
    const size = /(\d+(?:\.\d+)?)px/.exec(this.font);
    return { width: [...text].length * Number(size ? size[1] : 16) * 0.55 };
  }
  drawImage(source: unknown, ...args: number[]): void {
    if (!isShimBitmap(source) && !(source instanceof PixelCanvas)) return;
    const srcW = source.width;
    const srcH = source.height;
    const src = isShimBitmap(source)
      ? source._raw
      : Buffer.from(source.pixels.buffer, source.pixels.byteOffset, source.pixels.length);
    const cv = this.canvas;
    if (args.length >= 5) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = args.slice(-8);
      for (let v = 0; v < Math.max(0, Math.round(dh)); v += 1) {
        for (let u = 0; u < Math.max(0, Math.round(dw)); u += 1) {
          const sxx = Math.min(
            srcW - 1,
            Math.max(0, Math.floor(sx + ((u + 0.5) * sw) / dw))
          );
          const syy = Math.min(
            srcH - 1,
            Math.max(0, Math.floor(sy + ((v + 0.5) * sh) / dh))
          );
          const si = (syy * srcW + sxx) * 4;
          const di = (Math.round(dy) + v) * cv.width + Math.round(dx) + u;
          const o = di * 4;
          if (Math.round(dx) + u < 0 || Math.round(dx) + u >= cv.width) continue;
          if (Math.round(dy) + v < 0 || Math.round(dy) + v >= cv.height) continue;
          cv.pixels[o] = src[si];
          cv.pixels[o + 1] = src[si + 1];
          cv.pixels[o + 2] = src[si + 2];
          cv.pixels[o + 3] = src[si + 3];
        }
      }
    }
  }
  getImageData(
    x: number,
    y: number,
    w: number,
    h: number
  ): { data: Uint8ClampedArray; width: number; height: number } {
    const cv = this.canvas;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy += 1) {
      for (let xx = 0; xx < w; xx += 1) {
        const si = ((y + yy) * cv.width + (x + xx)) * 4;
        const di = (yy * w + xx) * 4;
        data[di] = cv.pixels[si];
        data[di + 1] = cv.pixels[si + 1];
        data[di + 2] = cv.pixels[si + 2];
        data[di + 3] = cv.pixels[si + 3];
      }
    }
    return { data, width: w, height: h };
  }
  putImageData(
    image: { data: Uint8ClampedArray; width: number; height: number },
    dx: number,
    dy: number
  ): void {
    const cv = this.canvas;
    for (let yy = 0; yy < image.height; yy += 1) {
      for (let xx = 0; xx < image.width; xx += 1) {
        const si = (yy * image.width + xx) * 4;
        const di = (dy + yy) * cv.width + (dx + xx);
        const o = di * 4;
        cv.pixels[o] = image.data[si];
        cv.pixels[o + 1] = image.data[si + 1];
        cv.pixels[o + 2] = image.data[si + 2];
        cv.pixels[o + 3] = image.data[si + 3];
      }
    }
  }
}

/* ---- global shims (collage-smoke pattern) ---- */

type Posted = Record<string, unknown> & { type: string; runId: string | number };
const inbox: Posted[] = [];
const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  location: { href: string };
};

class FakeFile {
  name: string;
  type: string;
  #bytes: Uint8Array;
  constructor(name: string, bytes: Uint8Array, type = "image/jpeg") {
    this.name = name;
    this.type = type;
    this.#bytes = bytes;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
  slice(start: number, end?: number): FakeFile {
    const clipped = end === undefined ? this.#bytes : this.#bytes.slice(start, end);
    return new FakeFile(this.name, clipped, this.type);
  }
}

function installShims(): void {
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Posted);
  };
  workerGlobal.location = { href: "http://localhost/" };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
    PixelCanvas as unknown as typeof OffscreenCanvas;
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (
    source: FakeFile | Blob | PixelCanvas
  ): Promise<ShimBitmap> => {
    const bytes = Buffer.from(await (source as FakeFile).arrayBuffer());
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      _raw: data,
      close(): void {
        /* no-op in the shim */
      },
    };
  };
}

/* ---- harness ---- */

interface RunOutcome {
  result: (Posted & { detail?: Record<string, unknown> }) | null;
  error: (Posted & { code?: string; detail?: string }) | null;
  outputs: { name: string; mime: string; blob: Blob }[];
  progress: Posted[];
}

async function runWorker(
  files: FakeFile[],
  passport: string
): Promise<RunOutcome> {
  inbox.length = 0;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId: 1,
      toolId: "passport-photo",
      options: { passport },
      files,
      assets: [],
    },
  });
  for (let i = 0; i < 4000; i += 1) {
    const terminal = inbox.find((m) => m.type === "result" || m.type === "error");
    if (terminal) {
      await new Promise((r) => setTimeout(r, 0));
      const result = (inbox.find((m) => m.type === "result") as RunOutcome["result"]) ?? null;
      const error = (inbox.find((m) => m.type === "error") as RunOutcome["error"]) ?? null;
      const outputs = (result?.outputs as RunOutcome["outputs"]) ?? [];
      return {
        result,
        error,
        outputs,
        progress: inbox.filter((m) => m.type === "progress"),
      };
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("worker never posted a terminal message");
}

async function bytesOf(outcome: RunOutcome, index: number): Promise<Uint8Array> {
  if (!outcome.result) throw new Error("no result message");
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

/** JFIF APP0 density reader (JFIF 1.02 layout). */
function readJfifDensity(
  bytes: Uint8Array
): { units: number; x: number; y: number } | null {
  if (
    bytes.length > 19 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    bytes[6] === 0x4a
  ) {
    return {
      units: bytes[13],
      x: (bytes[14] << 8) | bytes[15],
      y: (bytes[16] << 8) | bytes[17],
    };
  }
  return null;
}

async function decodeRgba(
  bytes: Uint8Array
): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

async function meanGray(bytes: Uint8Array): Promise<number> {
  const stats = await sharp(Buffer.from(bytes)).stats();
  const [r, g, b] = stats.channels.slice(0, 3).map((c) => c.mean);
  return (r + g + b) / 3;
}

/* ================================================================== */
/* Part 3 — the real worker (shimmed raster backend)                    */
/* ================================================================== */

async function part3(): Promise<void> {
  installShims();
  await import("../tools/passport-photo/worker");
  assert(
    typeof workerGlobal.onmessage === "function",
    "worker registered onmessage"
  );

  /* the JPEG fixture: 900×1200 portrait, plain blue-ish studio background
     with a warm face block in the middle (out of tolerance 30). */
  const BG = "rgb(120,170,210)";
  const FACE = "rgb(230,120,90)";
  const fixtureSvg = Buffer.from(
    `<svg width="900" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="1200" fill="${BG}"/><rect x="300" y="400" width="300" height="400" fill="${FACE}"/></svg>`
  );
  const fixtureBytes = new Uint8Array(await sharp(fixtureSvg).jpeg({ quality: 95 }).toBuffer());
  const photoFile = new FakeFile("studio-portrait.jpg", fixtureBytes, "image/jpeg");

  const style = (partial: Partial<PassportStyle>): string =>
    serializePassport({
      style: { ...DEFAULT_STYLE, ...partial },
      locale: "en",
    });
  const styleHi = (partial: Partial<PassportStyle>): string =>
    serializePassport({
      style: { ...DEFAULT_STYLE, ...partial },
      locale: "hi",
    });

  /* ---- run 1: defaults (India 35×45, 4×6, wash, guides, info) ---- */
  const run1 = await runWorker([photoFile], style({}));
  assert(run1.error === null, "run 1: no error", run1.error);
  assert(run1.result !== null, "run 1: result posted");
  assertEqual(run1.outputs.length, 2, "run 1: BOTH outputs (photo + sheet)");
  assertEqual(run1.outputs[0]?.mime, "image/jpeg", "run 1: photo is JPEG");
  assertEqual(run1.outputs[1]?.mime, "application/pdf", "run 1: sheet is PDF");
  assertEqual(run1.outputs[0]?.name, "passport-photo.jpg", "run 1: photo name");
  assertEqual(run1.outputs[1]?.name, "passport-photo-sheet.pdf", "run 1: sheet name");
  assertEqual(run1.result?.detail?.copies, 6, "run 1: detail copies = 6");
  assertEqual(run1.result?.detail?.files, 1, "run 1: detail files = 1");
  assertEqual(run1.result?.detail?.pages, 1, "run 1: detail pages = 1");
  const stages = new Set(run1.progress.map((m) => m.stage));
  assert(
    stages.has("reading") && stages.has("processing") && stages.has("saving"),
    "run 1: all three progress stages posted",
    [...stages]
  );
  assert(run1.progress.length >= 5, "run 1: 5 progress beats", run1.progress.length);

  const jpeg1 = await bytesOf(run1, 0);
  assert(jpeg1[0] === 0xff && jpeg1[1] === 0xd8, "run 1: JPEG SOI magic");
  const rgba1 = await decodeRgba(jpeg1);
  assertEqual(
    { w: rgba1.width, h: rgba1.height },
    { w: 413, h: 531 },
    "run 1: photo is EXACTLY 35×45mm at 300 DPI (413×531)"
  );
  const jfif1 = readJfifDensity(jpeg1);
  assertEqual(
    jfif1,
    { units: 1, x: 300, y: 300 },
    "run 1: JFIF APP0 density = 300×300 dots per inch"
  );
  const corner1 = (x: number, y: number): [number, number, number] => [
    rgba1.data[(y * rgba1.width + x) * 4],
    rgba1.data[(y * rgba1.width + x) * 4 + 1],
    rgba1.data[(y * rgba1.width + x) * 4 + 2],
  ];
  const c = corner1(2, 2);
  assert(
    c[0] >= 246 && c[1] >= 246 && c[2] >= 246,
    "run 1: corner washed to white through the REAL pipeline",
    c
  );
  const face = corner1(Math.floor(rgba1.width / 2), Math.floor(rgba1.height / 2));
  assert(
    Math.abs(face[0] - 230) <= 18 && Math.abs(face[1] - 120) <= 18 && Math.abs(face[2] - 90) <= 18,
    "run 1: face pixel survives the wash",
    face
  );

  const pdf1 = await bytesOf(run1, 1);
  assert(
    Buffer.from(pdf1.slice(0, 5)).toString("latin1").startsWith("%PDF-"),
    "run 1: sheet PDF magic"
  );
  const reopened1 = await PDFDocument.load(pdf1);
  assertEqual(reopened1.getPageCount(), 1, "run 1: one sheet page");
  const page1 = reopened1.getPage(0);
  assert(
    near(page1.getWidth(), 288, 0.05) && near(page1.getHeight(), 432, 0.05),
    "run 1: MediaBox = 4×6in in points (288×432)",
    { w: page1.getWidth(), h: page1.getHeight() }
  );
  let xobjects1 = 0;
  let imageDims: Array<[number, number]> = [];
  for (const [, obj] of reopened1.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const subtype = String(obj.dict.get(PDFName.of("Subtype")));
      const filter = String(obj.dict.get(PDFName.of("Filter")));
      if (subtype === "/Image" && filter.includes("DCTDecode")) {
        xobjects1 += 1;
        imageDims.push([
          Number(obj.dict.get(PDFName.of("Width"))),
          Number(obj.dict.get(PDFName.of("Height"))),
        ]);
        assert(
          obj.contents[0] === 0xff && obj.contents[1] === 0xd8,
          "run 1: embedded XObject payload is a real JPEG"
        );
      }
    }
  }
  assertEqual(xobjects1, 1, "run 1: photo embedded ONCE (shared XObject)");
  assertEqual(
    imageDims,
    [[413, 531]],
    "run 1: embedded XObject is the 413×531 photo"
  );

  const stream1 = await pageContentText(reopened1, 0);
  const doCount1 = (stream1.match(/\/\S+ Do\b/g) ?? []).length;
  assertEqual(doCount1, 6, "run 1: the XObject drawn exactly 6 times (copies)");
  assert(
    stream1.includes("[2 2] 0 d") && stream1.includes("0.62 0.62 0.62 RG"),
    "run 1: dashed gray cut guides present"
  );
  const strokeCount1 = (stream1.match(/\bh\nS\n/g) ?? []).length;
  assertEqual(strokeCount1, 6, "run 1: one stroke path per copy");
  assert(!stream1.includes("NaN") && !stream1.includes("Infinity"), "run 1: no NaN/Infinity coords");
  const infoHex1 = Buffer.from("35x45mm - 300 DPI - 6 copies - DocoPDF")
    .toString("hex")
    .toUpperCase();
  assert(
    stream1.includes(`<${infoHex1}>`),
    "run 1: info line drawn as the exact hex token"
  );
  /* every drawImage cm lands on a model cell */
  const plan1 = computeSheetPlan(resolveSize("india-passport", 0, 0), "photo4x6", { infoLine: true });
  const imageCm1 = [
    ...stream1.matchAll(
      /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n([\d.]+) 0 0 ([\d.]+) 0 0 cm\n1 0 0 1 0 0 cm\n\/\S+ Do/g
    ),
  ].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  assertEqual(imageCm1.length, 6, "run 1: 6 image placements in the content stream");
  const expectedCells1: Array<[number, number, number, number]> = [];
  for (let row = 0; row < plan1.rows; row += 1) {
    for (let col = 0; col < plan1.cols; col += 1) {
      const cell = sheetCellRect(plan1, row, col);
      expectedCells1.push([
        cell.x,
        plan1.pageH - cell.y - cell.h,
        cell.w,
        cell.h,
      ]);
    }
  }
  let placementsOk = true;
  for (const got of imageCm1) {
    if (
      !expectedCells1.some(([x, y, w, h]) =>
        near(got[0], x, 0.05) && near(got[1], y, 0.05) && near(got[2], w, 0.05) && near(got[3], h, 0.05)
      )
    ) {
      placementsOk = false;
    }
  }
  assert(placementsOk, "run 1: every placement sits on its model cell (y-flipped)", imageCm1);

  /* ---- run 2: PAN size on A4, Hindi locale ---- */
  const run2 = await runWorker(
    [photoFile],
    styleHi({ sizeId: "india-visa-pan", sheet: "a4" })
  );
  assert(run2.error === null, "run 2: no error", run2.error);
  assertEqual(run2.outputs[0]?.name, "पासपोर्ट-फ़ोटो.jpg", "run 2: Hindi photo name");
  assertEqual(run2.outputs[1]?.name, "पासपोर्ट-फ़ोटो-शीट.pdf", "run 2: Hindi sheet name");
  assertEqual(run2.result?.detail?.copies, 49, "run 2: PAN on A4 = 49 copies");
  const jpeg2 = await bytesOf(run2, 0);
  const rgba2 = await decodeRgba(jpeg2);
  assertEqual(
    { w: rgba2.width, h: rgba2.height },
    { w: 295, h: 413 },
    "run 2: photo is EXACTLY 25×35mm at 300 DPI (295×413)"
  );
  const pdf2 = await bytesOf(run2, 1);
  const reopened2 = await PDFDocument.load(pdf2);
  const page2 = reopened2.getPage(0);
  assert(
    near(page2.getWidth(), 595.28, 0.05) && near(page2.getHeight(), 841.89, 0.05),
    "run 2: MediaBox = A4 (595.28×841.89)",
    { w: page2.getWidth(), h: page2.getHeight() }
  );
  const stream2 = await pageContentText(reopened2, 0);
  assertEqual(
    (stream2.match(/\/\S+ Do\b/g) ?? []).length,
    49,
    "run 2: 49 photo placements on the A4 sheet"
  );

  /* ---- run 3: custom 100×100 on 4×6 → honest sheet-too-small ---- */
  const run3 = await runWorker(
    [photoFile],
    style({ sizeId: "custom", customW: 100, customH: 100 })
  );
  assert(run3.result === null, "run 3: no result");
  assertEqual(run3.error?.code, "pp.errorSheetTooSmall", "run 3: honest sheet-too-small error");
  assertEqual(run3.error?.detail, "100x100mm", "run 3: detail names the size");

  /* ---- run 4: custom 100×100 on A4 fits ---- */
  const run4 = await runWorker(
    [photoFile],
    style({ sizeId: "custom", customW: 100, customH: 100, sheet: "a4" })
  );
  assert(run4.error === null, "run 4: no error", run4.error);
  assertEqual(run4.result?.detail?.copies, 4, "run 4: custom 100×100 on A4 = 4 copies");
  const jpeg4 = await bytesOf(run4, 0);
  const rgba4 = await decodeRgba(jpeg4);
  assertEqual(
    { w: rgba4.width, h: rgba4.height },
    { w: 1181, h: 1181 },
    "run 4: custom 100×100 = 1181×1181 px"
  );

  /* ---- run 5: no file ---- */
  const run5 = await runWorker([], style({}));
  assertEqual(run5.error?.code, "tool.images.errorNoImages", "run 5: no file → honest error");

  /* ---- run 6: non-image bytes ---- */
  const run6 = await runWorker(
    [new FakeFile("notes.txt", new Uint8Array(Buffer.from("just some plain text, not an image")), "text/plain")],
    style({})
  );
  assertEqual(run6.error?.code, "tool.images.errorUnsupported", "run 6: non-image → unsupported");

  /* ---- run 7: SVG rejected ---- */
  const run7 = await runWorker(
    [
      new FakeFile(
        "drawing.svg",
        new Uint8Array(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`)),
        "image/svg+xml"
      ),
    ],
    style({})
  );
  assertEqual(run7.error?.code, "tool.images.errorUnsupported", "run 7: SVG → unsupported");

  /* ---- run 8: corrupt JPEG (magic then junk) ---- */
  const run8 = await runWorker(
    [new FakeFile("broken.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xab, 0xcd, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]))],
    style({})
  );
  assertEqual(run8.error?.code, "tool.images.errorDecode", "run 8: corrupt JPEG → honest decode error");

  /* ---- run 9: original bg, no guides, no info strip (PAN 4×6) ---- */
  const run9 = await runWorker(
    [photoFile],
    style({
      sizeId: "india-visa-pan",
      background: "original",
      cutGuides: false,
      infoLine: false,
    })
  );
  assert(run9.error === null, "run 9: no error", run9.error);
  assertEqual(run9.result?.detail?.copies, 12, "run 9: PAN 4×6 WITHOUT info strip = 12 copies");
  const jpeg9 = await bytesOf(run9, 0);
  const rgba9 = await decodeRgba(jpeg9);
  const corner9: [number, number, number] = [
    rgba9.data[(2 * rgba9.width + 2) * 4],
    rgba9.data[(2 * rgba9.width + 2) * 4 + 1],
    rgba9.data[(2 * rgba9.width + 2) * 4 + 2],
  ];
  assert(
    Math.abs(corner9[0] - 120) <= 14 && Math.abs(corner9[1] - 170) <= 14 && Math.abs(corner9[2] - 210) <= 14,
    "run 9: original background kept (no wash)",
    corner9
  );
  const pdf9 = await bytesOf(run9, 1);
  const reopened9 = await PDFDocument.load(pdf9);
  const stream9 = await pageContentText(reopened9, 0);
  assertEqual(
    (stream9.match(/\/\S+ Do\b/g) ?? []).length,
    12,
    "run 9: 12 placements"
  );
  assert(!stream9.includes("[2 2] 0 d"), "run 9: cut guides absent when switched off");
  assert(!stream9.includes("Tj"), "run 9: no info line text");
  const gray9 = await meanGray(jpeg9);

  /* ---- run 10: brightness +40 with contrast +10 ---- */
  const run10 = await runWorker(
    [photoFile],
    style({
      sizeId: "india-visa-pan",
      background: "original",
      brightness: 40,
      contrast: 10,
    })
  );
  assert(run10.error === null, "run 10: no error", run10.error);
  const jpeg10 = await bytesOf(run10, 0);
  const gray10 = await meanGray(jpeg10);
  assert(
    gray10 - gray9 >= 15 && gray10 - gray9 <= 65,
    "run 10: brightness +40 visibly lifts the REAL output",
    { gray9, gray10 }
  );
  const rgba10 = await decodeRgba(jpeg10);
  assertEqual(rgba10.width, rgba9.width, "run 10: size unchanged by adjustments");

  /* ---- run 11: zoom + pan framing, custom 40×55 on A4 ---- */
  const run11 = await runWorker(
    [photoFile],
    style({
      sizeId: "custom",
      customW: 40,
      customH: 55,
      sheet: "a4",
      zoom: 2.5,
      panX: 0.4,
      panY: -0.3,
    })
  );
  assert(run11.error === null, "run 11: no error", run11.error);
  assertEqual(run11.result?.detail?.copies, 20, "run 11: custom 40×55 on A4 = 20 copies");
  const jpeg11 = await bytesOf(run11, 0);
  const rgba11 = await decodeRgba(jpeg11);
  assertEqual(
    { w: rgba11.width, h: rgba11.height },
    { w: 472, h: 650 },
    "run 11: custom 40×55 = 472×650 px"
  );

  /* ---- run 12: non-run messages ignored (worker honesty) ---- */
  inbox.length = 0;
  workerGlobal.onmessage!({ data: { type: "nonsense", runId: 2 } });
  await new Promise((r) => setTimeout(r, 10));
  assertEqual(inbox.length, 0, "run 12: onmessage only reacts to type 'run'");

  /* ---- setJpegDpi byte surgery on REAL pipeline bytes ---- */
  assert(
    fixtureBytes[2] !== 0xe0,
    "fixture: sharp JPEG has no APP0 (insert branch exercised)",
    fixtureBytes.subarray(0, 6)
  );
  const tagged = setJpegDpi(fixtureBytes, 300);
  assertEqual(tagged.length - fixtureBytes.length, 18, "setJpegDpi insert: +18 bytes (spec APP0)");
  assertEqual(
    Array.from(tagged.subarray(2, 20)),
    [
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x01, 0x01, 0x2c, 0x01, 0x2c, 0x00, 0x00,
    ],
    "setJpegDpi insert: exact spec layout (units byte present, 0x0010 length)"
  );
  assert(
    tagged[20] === fixtureBytes[2] && tagged[21] === fixtureBytes[3],
    "setJpegDpi insert: original payload preserved after the APP0"
  );
  /* patch branch on a spec-correct existing APP0 */
  const specApp0 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x02, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ]);
  const canvasStyle = new Uint8Array(
    Buffer.concat([specApp0, fixtureBytes.subarray(2)])
  );
  const patched = setJpegDpi(canvasStyle, 300);
  assertEqual(patched.length, canvasStyle.length, "setJpegDpi patch: length unchanged");
  assertEqual(
    Array.from(patched.subarray(11, 18)),
    [0x01, 0x02, 0x01, 0x01, 0x2c, 0x01, 0x2c],
    "setJpegDpi patch: version kept, units=dpi, densities 300/300"
  );
  assertEqual(patched[19], canvasStyle[19], "setJpegDpi patch: thumbnail bytes kept");
  /* idempotency */
  const twice = setJpegDpi(tagged, 300);
  assert(
    twice.length === tagged.length &&
      twice.every((v, i) => v === tagged[i]),
    "setJpegDpi: idempotent (retag is a patch, byte-stable)"
  );
  /* non-JPEG + dpi clamping */
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  assertEqual(setJpegDpi(pngBytes, 300), pngBytes, "setJpegDpi: non-JPEG returned untouched");
  assertEqual(setJpegDpi(new Uint8Array([0xff, 0xd8]), 300).length, 2, "setJpegDpi: SOI-only stub returned untouched");
  const clampedLow = setJpegDpi(fixtureBytes, 0);
  assertEqual(readJfifDensity(clampedLow), { units: 1, x: 1, y: 1 }, "setJpegDpi: dpi 0 clamps to 1");
  const clampedHigh = setJpegDpi(fixtureBytes, 1_000_000);
  assertEqual(
    readJfifDensity(clampedHigh),
    { units: 1, x: 65535, y: 65535 },
    "setJpegDpi: dpi 1e6 clamps to the u16 max (65535)"
  );
  /* pdf-lib + sharp still accept the tagged bytes (the worker's own path) */
  const doc = await PDFDocument.create();
  const embedded = await doc.embedJpg(tagged);
  assertEqual(
    [embedded.width, embedded.height],
    [900, 1200],
    "setJpegDpi: pdf-lib embedJpg parses the tagged JPEG (the insert fix)"
  );
  const meta = await sharp(Buffer.from(tagged)).metadata();
  assertEqual(
    [meta.width ?? 0, meta.height ?? 0],
    [900, 1200],
    "setJpegDpi: sharp still decodes the tagged JPEG"
  );
}

/** Decoded page content stream text (nup-smoke pattern, object-stream safe). */
async function pageContentText(
  doc: PDFDocument,
  pageIndex: number
): Promise<string> {
  const contents = doc.getPage(pageIndex).node.Contents();
  let text = "";
  const collect = (node: unknown): void => {
    if (node instanceof PDFRawStream) {
      text += Buffer.from(decodePDFRawStream(node).decode()).toString("latin1");
    } else if (node instanceof PDFContentStream) {
      text += Buffer.from(node.getUnencodedContents()).toString("latin1");
    } else if (node instanceof PDFArray) {
      for (let i = 0; i < node.size(); i += 1) collect(node.lookup(i));
    }
  };
  collect(contents);
  return text;
}

/* ================================================================== */

async function main(): Promise<void> {
  part0();
  part1();
  part2();
  await part3();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
