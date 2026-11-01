/**
 * PRE-BUILD smoke for PHASE-7 R38 (deskew-pdf). Everything drives the
 * pure engine + the own-engine compose half in Node/bun — the raster
 * probe (pdf.js + OffscreenCanvas) is browser-E2E turf, per the
 * invert/greyscale precedent.
 *
 *  1. deskewSheetOps math: identity, keep-centre rotation, grow bbox,
 *     /Rotate norm handling (identity ONLY when norm=0).
 *  2. correctionFromDetection gates: noise band, skew bound, samples.
 *  3. rotateNorm + resolveDeskewOptions.
 *  4. detectSkewAngle on synthetic tilted gray planes (the reused
 *     ocr-pdf engine, through the deskew gate): +3° tilt, −2.5° tilt,
 *     blank page.
 *  5. applyDeskew end-to-end on a pdf-lib fixture: corrections
 *     [2.5, 0] → sheet sizes, decoded content ops, straightened count,
 *     grow-mode dims.
 *  6. runDeskewPdf honest error: invalid pages spec.
 *  7. Registry: 138 live tools; config wired; i18n parity.
 *
 * Run: bun scripts/smoke-p7a.ts
 */
import { PDFDocument, degrees } from "pdf-lib";

import {
  correctionFromDetection,
  deskewSheetOps,
  resolveDeskewOptions,
  rotateNorm,
} from "../tools/deskew-pdf/engine";
import { applyDeskew, runDeskewPdf } from "../tools/deskew-pdf/worker";
import { detectSkewAngle } from "../tools/ocr-pdf/engine";
import {
  decodeStreamBytes,
  latin1,
  listPages,
  parsePdf,
  resolve,
} from "../src/lib/own/pdf";
import { liveToolCount } from "../src/lib/tools/registry";
import { config as deskewConfig } from "../tools/deskew-pdf/config";
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const latin1All = (b: Uint8Array) => latin1(b, 0, b.length);

/** Every page's decoded content stream, joined (smoke-p3b3 pattern). */
function allContent(bytes: Uint8Array): string {
  const doc = parsePdf(bytes);
  const parts: string[] = [];
  const walk = (o: unknown): void => {
    if ((o as { k?: string })?.k === "ref") {
      walk(doc.getObject((o as { num: number }).num));
      return;
    }
    if ((o as { k?: string })?.k === "stream") {
      const st = o as { raw: Uint8Array; m: Map<string, unknown> };
      try {
        const dec = decodeStreamBytes(st.raw, st.m as Map<never, never>);
        parts.push(latin1All(dec));
      } catch {
        // undecodable — skip
      }
      return;
    }
    if ((o as { k?: string })?.k === "arr") {
      for (const item of (o as { items: unknown[] }).items) walk(item);
    }
  };
  for (const page of listPages(doc)) {
    walk(resolve(doc, page.dict.get("Contents")));
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
console.log("1. deskewSheetOps — geometry math");

const form = { key: "Pg1", width: 400, height: 600 };

const identity = deskewSheetOps(form, { w: 400, h: 600, rotate: 0 }, 0, "keep");
check(
  "identity (correction 0, norm 0): same-size sheet + plain draw",
  identity.w === 400 && identity.h === 600 && identity.ops === "q\n/Pg1 Do\nQ",
  JSON.stringify(identity)
);

/** Parse the 6 numbers of a `a b c d e f cm` line. */
function cmNumbers(line: string): number[] {
  return line
    .replace(" cm", "")
    .trim()
    .split(/\s+/)
    .map(Number);
}

const keep = deskewSheetOps(form, { w: 400, h: 600, rotate: 0 }, 3, "keep");
const keepLines = keep.ops.split("\n");
check(
  "keep: sheet keeps the visual size",
  Math.round(keep.w) === 400 && Math.round(keep.h) === 600,
  `${keep.w}×${keep.h}`
);
check(
  "keep: centre translate (200 300) leads the rotation",
  keepLines[1] === "1 0 0 1 200 300 cm",
  keepLines[1] ?? ""
);
const keepM = cmNumbers(keepLines[2]!);
const rad3 = (3 * Math.PI) / 180;
check(
  "keep: rotation matrix is CCW 3° (cos/sin ±0.001)",
  Math.abs(keepM[0]! - Math.cos(rad3)) < 1e-3 &&
    Math.abs(keepM[1]! - Math.sin(rad3)) < 1e-3 &&
    Math.abs(keepM[2]! + Math.sin(rad3)) < 1e-3 &&
    Math.abs(keepM[3]! - Math.cos(rad3)) < 1e-3,
  keepLines[2] ?? ""
);
check(
  "keep: back-translate to the form origin (-200 -300)",
  keepLines[3] === "1 0 0 1 -200 -300 cm",
  keepLines[3] ?? ""
);
check(
  "keep: form drawn inside q…Q",
  keepLines[0] === "q" && keepLines[4] === "/Pg1 Do" && keepLines[5] === "Q",
  keep.ops
);

const grow = deskewSheetOps(form, { w: 400, h: 600, rotate: 0 }, 3, "grow");
const expGrowW = 400 * Math.cos((3 * Math.PI) / 180) + 600 * Math.sin((3 * Math.PI) / 180);
const expGrowH = 400 * Math.sin((3 * Math.PI) / 180) + 600 * Math.cos((3 * Math.PI) / 180);
check(
  "grow: sheet = rotated bounding box",
  Math.abs(grow.w - expGrowW) < 0.05 && Math.abs(grow.h - expGrowH) < 0.05,
  `${grow.w}×${grow.h} vs ${expGrowW.toFixed(2)}×${expGrowH.toFixed(2)}`
);
check(
  "grow: translate + rotate + Do (rotate-custom shape)",
  grow.ops.split("\n").length === 5 && grow.ops.includes("cm") && grow.ops.includes("/Pg1 Do"),
  grow.ops
);

const rot90Identity = deskewSheetOps(form, { w: 400, h: 600, rotate: 90 }, 0, "keep");
check(
  "/Rotate 90 page with 0 correction does NOT take the identity path",
  rot90Identity.w === 600 && rot90Identity.h === 400 && rot90Identity.ops.includes("1 0 0 1 300 200 cm"),
  `${rot90Identity.w}×${rot90Identity.h} :: ${rot90Identity.ops.split("\n")[1]}`
);
const rot90Lines = rot90Identity.ops.split("\n");
check(
  "/Rotate 90 identity: totalTheta 90 (cos 0 sin 1)",
  rot90Lines[2]!.startsWith("0 1 -1 0 0 0 cm"),
  rot90Lines[2] ?? ""
);

const negKeep = deskewSheetOps(form, { w: 400, h: 600, rotate: 0 }, -2.5, "keep");
const negM = cmNumbers(negKeep.ops.split("\n")[2]!);
const rad25 = (2.5 * Math.PI) / 180;
check(
  "negative correction (CCW tilt): rotation matrix flips sign",
  Math.abs(negM[0]! - Math.cos(rad25)) < 1e-3 &&
    Math.abs(negM[1]! + Math.sin(rad25)) < 1e-3 &&
    Math.abs(negM[2]! - Math.sin(rad25)) < 1e-3 &&
    Math.abs(negM[3]! - Math.cos(rad25)) < 1e-3,
  negKeep.ops.split("\n")[2] ?? ""
);

/* ------------------------------------------------------------------ */
console.log("2. correctionFromDetection — honest gates");

check("samples 1 → 0", correctionFromDetection(3, 1) === 0);
check("angle 0.2 (< 0.3 noise band) → 0", correctionFromDetection(0.2, 5) === 0);
check("angle 11 (> 10 sane bound) → 0", correctionFromDetection(11, 5) === 0);
check("angle NaN → 0", Number.isNaN(correctionFromDetection(NaN, 5)) === false && correctionFromDetection(NaN, 5) === 0);
check(
  "angle 2.46 samples 4 → 2.46 (2-decimal round)",
  correctionFromDetection(2.456789, 4) === 2.46
);
check("angle -3 samples 4 → -3", correctionFromDetection(-3.0001, 4) === -3);

/* ------------------------------------------------------------------ */
console.log("3. rotateNorm + resolveDeskewOptions");

check("rotateNorm 0→0", rotateNorm(0) === 0);
check("rotateNorm 90→90", rotateNorm(90) === 90);
check("rotateNorm -90→270", rotateNorm(-90) === 270);
check("rotateNorm 450→90", rotateNorm(450) === 90);
check("rotateNorm 360→0", rotateNorm(360) === 0);

const defaults = resolveDeskewOptions({});
check("options default: all pages, keep sizing", defaults.pages === "all" && defaults.sizing === "keep");
const growOpts = resolveDeskewOptions({ pages: " 2-4 ", sizing: "grow" });
check("options: trimmed pages + grow", growOpts.pages === "2-4" && growOpts.sizing === "grow");
const junkSizing = resolveDeskewOptions({ sizing: "diagonal" });
check("options: unknown sizing falls back to keep", junkSizing.sizing === "keep");

/* ------------------------------------------------------------------ */
console.log("4. detectSkewAngle on synthetic tilted planes (deskew gate)");

/**
 * A gray plane of "text rows" tilted by `deg` (ocr-pdf convention:
 * positive = content tilted CLOCKWISE, right edge lower → in a y-down
 * raster the row's y GROWS with x).
 */
function tiltedPlane(
  width: number,
  height: number,
  deg: number,
  opts: { rowGap?: number; thickness?: number } = {}
): Uint8Array {
  const { rowGap = 60, thickness = 5 } = opts;
  const gray = new Uint8Array(width * height).fill(255);
  const tan = Math.tan((deg * Math.PI) / 180);
  const cx = width / 2;
  for (let base = 80; base < height - 60; base += rowGap) {
    for (let x = 30; x < width - 30; x += 1) {
      const y0 = Math.round(base + (x - cx) * tan);
      for (let t = 0; t < thickness; t += 1) {
        const y = y0 + t;
        if (y >= 0 && y < height) gray[y * width + x] = 0;
      }
    }
  }
  return gray;
}

const cw3 = detectSkewAngle(tiltedPlane(600, 800, 3), 600, 800);
check(
  "+3° CW tilt detected ≈ 3° (±0.2)",
  cw3.samples >= 2 && Math.abs(cw3.angle - 3) <= 0.2,
  `angle=${cw3.angle} samples=${cw3.samples}`
);
const ccw25 = detectSkewAngle(tiltedPlane(600, 800, -2.5), 600, 800);
check(
  "−2.5° CCW tilt detected ≈ −2.5° (±0.2)",
  ccw25.samples >= 2 && Math.abs(ccw25.angle + 2.5) <= 0.2,
  `angle=${ccw25.angle} samples=${ccw25.samples}`
);
const blank = detectSkewAngle(new Uint8Array(600 * 800).fill(255), 600, 800);
check(
  "blank plane: no confident skew (angle 0 / samples < 2)",
  blank.angle === 0 || blank.samples < 2,
  `angle=${blank.angle} samples=${blank.samples}`
);
const gate = correctionFromDetection(cw3.angle, cw3.samples);
check(
  "gate passes the +3° detection through",
  Math.abs(gate - 3) <= 0.2,
  `gate=${gate}`
);

/* ------------------------------------------------------------------ */
console.log("5. applyDeskew — own-engine rebuild (pdf-lib fixture)");

async function makeFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([400, 600]);
  p1.drawText("Tilted scan page one", { x: 40, y: 550, size: 12 });
  const p2 = doc.addPage([400, 600]);
  p2.drawText("Straight page two", { x: 40, y: 550, size: 12 });
  const bytes = await doc.save();
  return new Uint8Array(bytes);
}

const fixture = await makeFixture();

const applied = applyDeskew(fixture, [2.5, 0], "keep");
const outPages = listPages(parsePdf(applied.bytes));
check(
  "output keeps every page (2 sheets)",
  outPages.length === 2,
  `${outPages.length} pages`
);
check(
  "keep mode: page sizes unchanged",
  Math.round(outPages[0]!.mediaBox[2] - outPages[0]!.mediaBox[0]) === 400 &&
    Math.round(outPages[0]!.mediaBox[3] - outPages[0]!.mediaBox[1]) === 600,
  `${outPages[0]!.mediaBox.join(",")}`
);
check(
  "straightened count = 1, corrections recorded",
  applied.straightened === 1 && applied.corrections.length === 2 && applied.corrections[0] === 2.5 && applied.corrections[1] === 0,
  `straightened=${applied.straightened} corrections=${JSON.stringify(applied.corrections)}`
);
const outContent = allContent(applied.bytes);
check(
  "sheet 1 ops present in decoded content (cm rotation + Pg Do)",
  outContent.includes(" cm") && outContent.includes("Do"),
  outContent.slice(0, 120)
);
check(
  "sheet 2 identity ops present (plain q /Pg Do Q)",
  /q\n\/Pg\d Do\nQ/.test(outContent),
  outContent.slice(0, 200)
);
check(
  "output is a parseable PDF (%PDF header)",
  latin1All(applied.bytes).startsWith("%PDF-"),
);

const grown = applyDeskew(fixture, [2.5, 0], "grow");
const grownPages = listPages(parsePdf(grown.bytes));
const expW = 400 * Math.cos((2.5 * Math.PI) / 180) + 600 * Math.sin((2.5 * Math.PI) / 180);
check(
  "grow mode: sheet 1 grows to the rotated bbox",
  Math.abs(grownPages[0]!.mediaBox[2] - grownPages[0]!.mediaBox[0] - expW) < 0.1,
  `${grownPages[0]!.mediaBox[2] - grownPages[0]!.mediaBox[0]} vs ${expW.toFixed(2)}`
);
check(
  "grow mode: sheet 2 stays 400×600 (identity)",
  Math.round(grownPages[1]!.mediaBox[2]) === 400 && Math.round(grownPages[1]!.mediaBox[3]) === 600,
  grownPages[1]!.mediaBox.join(",")
);

/* ------------------------------------------------------------------ */
console.log("6. runDeskewPdf — honest pages-spec error (pre-raster)");

let invalidPages = "";
try {
  await runDeskewPdf(fixture, { pages: "not-a-spec" });
} catch (error) {
  invalidPages = error instanceof Error ? error.message : String(error);
}
check(
  "invalid pages spec → tool.errorInvalidPages (no raster work)",
  invalidPages === "tool.errorInvalidPages",
  invalidPages
);

/* ------------------------------------------------------------------ */
console.log("7. Registry + config + i18n parity");

const live = liveToolCount;
check("live tool count = 138 (137 + deskew-pdf)", live === 138, `got ${live}`);
check(
  "config registered under deskew-pdf",
  TOOL_CONFIGS["deskew-pdf"]?.toolId === "deskew-pdf",
);
check(
  "config options: pages + sizing select",
  deskewConfig.options.length === 2 &&
    deskewConfig.options[0]!.kind === "pages" &&
    deskewConfig.options[1]!.kind === "select" &&
    deskewConfig.options[1]!.choices.length === 2,
);
check(
  "output pdf + single file",
  deskewConfig.outputKind === "pdf" && deskewConfig.minFiles === 1 && deskewConfig.maxFiles === 1,
);

const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8")) as Record<string, unknown>;
const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8")) as Record<string, unknown>;
const enResult = en["result"] as Record<string, unknown>;
const hiResult = hi["result"] as Record<string, unknown>;
check(
  "i18n result.straightenedPages EN + HI",
  typeof enResult["straightenedPages"] === "string" && typeof hiResult["straightenedPages"] === "string",
);

function leafCount(o: unknown): number {
  if (typeof o !== "object" || o === null) return 1;
  return Object.values(o).reduce((sum: number, v) => sum + leafCount(v), 0);
}
check(
  "i18n flat-leaf parity EN = HI",
  leafCount(en) === leafCount(hi),
  `EN ${leafCount(en)} vs HI ${leafCount(hi)}`
);

/* ------------------------------------------------------------------ */
console.log("");
console.log(`deskew-pdf smoke: ${pass} PASS, ${fail} FAIL (of ${pass + fail})`);
if (fail > 0) process.exit(1);
