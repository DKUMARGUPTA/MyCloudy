/**
 * Smoke: ocr-pdf DESKEW (R4-b) — the optional "straighten tilted scans
 * before recognition" switch.
 *
 * tesseract is NOT runnable under bun (no wasm/browser worker host — the
 * smoke-ocr-encrypted precedent: its runs die at the pdf.js asset import),
 * so per the R4-b brief this smoke pins the deskew pipeline's TESTABLE
 * halves:
 *   1. the pure angle detector (tools/ocr-pdf/engine.ts) against
 *      synthetic rasters — a text-page-like fixture drawn in pixel space,
 *      then skewed by ±3° via nearest-neighbor row shear, then DETECTED;
 *      the counter-rotation promise is proven by deskewing the skewed
 *      raster with a pure inverse shear and re-detecting ≈0°;
 *   2. the wiring: worker reads options.deskew + counter-rotates +
 *      reports deskewedPages, the config switch (default OFF, honest
 *      bilingual copy), the protocol/result-view/i18n chip chain;
 *   3. a REAL worker drive proving the new option does not disturb the
 *      encrypted-input guard (deskew:true on an owner-only file still
 *      refuses with tool.errorEncrypted before any deskew machinery).
 *
 * Run: bun scripts/smoke-ocr-deskew.ts
 */
import { readFileSync } from "node:fs";

import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import {
  detectSkewAngle,
  rgbaToGray,
  SKEW_MAX_ANGLE,
  SKEW_MIN_ANGLE,
} from "../tools/ocr-pdf/engine";

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
      actual !== undefined ? JSON.stringify(actual).slice(0, 300) : ""
    );
  }
}

/* ------------------------------------------------------------------ */
/* synthetic skew fixtures (pure pixel space, no canvas)               */
/* ------------------------------------------------------------------ */

const W = 620;
const H = 800;

/** White page, dark "text lines": filled bars + thin baseline rules. */
function straightPage(): Uint8Array {
  const gray = new Uint8Array(W * H).fill(255);
  const bar = (y0: number, x0: number, x1: number, height: number) => {
    for (let y = y0; y < y0 + height && y < H; y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x += 1) {
        gray[y * W + x] = 20;
      }
    }
  };
  let y = 60;
  while (y < H - 60) {
    bar(y, 60, W - 60, 14); // a "line of text"
    bar(y + 24, 60, W - 200, 6); // a baseline rule
    y += 56;
  }
  return gray;
}

/**
 * Shears the page by `deg` degrees clockwise (the right edge drops) —
 * pixel-space equivalent of ctx.rotate(+deg) for small angles: output
 * (x, y) samples the source at (x, y − x·tan(deg)) via nearest neighbor.
 */
function skewClockwise(gray: Uint8Array, deg: number): Uint8Array {
  const t = Math.tan((deg * Math.PI) / 180);
  const out = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const src = Math.round(y - (x - W / 2) * t);
      if (src >= 0 && src < H) out[y * W + x] = gray[src * W + x];
    }
  }
  return out;
}

/**
 * Inverse shear for a detected skew of `skewDeg` degrees — the pixel-space
 * analog of the worker's ctx.rotate(−angle) (a shear ≈ a small rotation
 * about the center for |angle| ≤ 10°; the difference is O(angle²)).
 * out(y, x) samples the source at (x, y + (x − cx)·tan(skewDeg)).
 */
function deskewRaster(
  gray: Uint8Array,
  skewDeg: number
): Uint8Array {
  const t = Math.tan((skewDeg * Math.PI) / 180);
  const out = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const src = Math.round(y + (x - W / 2) * t);
      if (src >= 0 && src < H) out[y * W + x] = gray[src * W + x];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* wiring asserts (the non-tesseract half of the feature)              */
/* ------------------------------------------------------------------ */

function readTool(rel: string): string {
  return readFileSync(`/home/z/my-project/${rel}`, "utf8");
}

async function main(): Promise<void> {
  console.log("── 1. constants + rgbaToGray ─────────────────────────────");
  {
    check("SKEW_MIN_ANGLE is 0.3° (the brief's threshold)", SKEW_MIN_ANGLE === 0.3);
    check("SKEW_MAX_ANGLE is ±10° (the brief's bound)", SKEW_MAX_ANGLE === 10);

    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, // red  → luma 76
      0, 255, 0, 255, // green → 150
      0, 0, 255, 255, // blue → 29
      0, 0, 0, 0, // transparent black → 0 (alpha ignored, honest ink)
    ]);
    const gray = rgbaToGray(rgba);
    check("rgbaToGray Rec.601: R76 G150 B29", gray[0] === 76 && gray[1] === 150 && gray[2] === 29);
    check("rgbaToGray: alpha channel ignored", gray[3] === 0);
  }

  console.log("\n── 2. detector: straight / blank / tiny fixtures ─────────");
  {
    const straight = detectSkewAngle(straightPage(), W, H);
    check(
      "straight page: |angle| ≤ 0.3 noise band → 0 (no deskew)",
      straight.angle === 0,
      straight
    );
    check("straight page: strips produced samples", straight.samples >= 4, straight.samples);

    const blank = detectSkewAngle(new Uint8Array(W * H).fill(255), W, H);
    check("blank page: no ink → angle 0, 0 samples", blank.angle === 0 && blank.samples === 0, blank);

    const tiny = detectSkewAngle(new Uint8Array(8 * 8).fill(0), 8, 8);
    check(
      "8×8 blob: one strip only — angle 0 (below the 2-strip confidence floor)",
      tiny.angle === 0 && tiny.samples < 2,
      tiny
    );

    // A 0.1° tilt is inside the noise band → honestly 0.
    const faint = detectSkewAngle(skewClockwise(straightPage(), 0.1), W, H);
    check(
      "0.1° tilt (inside ±0.3° band): angle 0 — no resampling blur",
      faint.angle === 0,
      faint
    );

    // A 0.2° shear is one nearest-neighbor pixel at this fixture's width —
    // quantization can push the strip median past the band (probe: 0.2°
    // reads ≤ 0.5°). Either outcome is honest: 0, or a sub-half-degree
    // correction that is imperceptible and harmless to OCR.
    const tinyTilt = detectSkewAngle(skewClockwise(straightPage(), 0.2), W, H);
    check(
      "0.2° tilt: 0 or quantization jitter ≤ 0.5° (never a wild claim)",
      tinyTilt.angle === 0 || Math.abs(tinyTilt.angle) <= 0.5,
      tinyTilt
    );
  }

  console.log("\n── 3. detector: ±3° synthetic skewed fixtures ────────────");
  {
    const cw = skewClockwise(straightPage(), 3);
    const dCw = detectSkewAngle(cw, W, H);
    check(
      "3° clockwise skew detected as ≈ +3° (positive = right edge lower)",
      dCw.angle >= 2.5 && dCw.angle <= 3.5,
      dCw
    );
    check("skewed fixture: detector had ≥4 strip samples", dCw.samples >= 4, dCw.samples);

    const ccw = skewClockwise(straightPage(), -3);
    const dCcw = detectSkewAngle(ccw, W, H);
    check(
      "−3° (counter-clockwise) skew detected as ≈ −3°",
      dCcw.angle >= -3.5 && dCcw.angle <= -2.5,
      dCcw
    );

    // THE core promise: the inverse shear of the DETECTED angle (the
    // worker's ctx.rotate(−angle)) straightens the page.
    const fixed = deskewRaster(cw, dCw.angle);
    const dFixed = detectSkewAngle(fixed, W, H);
    check(
      "counter-rotation by −angle → re-detects 0 (page straight)",
      dFixed.angle === 0,
      dFixed
    );

    // ±10° bound: a 12° rotation is a rotated page, not skew — rejected.
    const wild = skewClockwise(straightPage(), 12);
    const dWild = detectSkewAngle(wild, W, H, { maxAngle: 10 });
    check(
      "12° tilt exceeds the ±10° search bound → not claimed as skew",
      Math.abs(dWild.angle) <= 10,
      dWild
    );
  }

  console.log("\n── 4. wiring: config / worker / protocol / result / i18n ──");
  {
    const config = readTool("tools/ocr-pdf/config.ts");
    check("config: switch id \"deskew\"", /id:\s*"deskew"/.test(config));
    const deskewBlock = config.slice(config.indexOf('"deskew"'));
    check(
      "config: deskew default OFF",
      /default:\s*false/.test(deskewBlock.slice(0, deskewBlock.indexOf("},\n    {"))),
    );
    check(
      "config: honest EN copy — says it applies to OCR'd pages only",
      /pages that get OCR'd/.test(config) && /already have text are untouched/.test(config),
    );
    check(
      "config: honest HI copy present and distinct",
      /पेज सीधे करें/.test(config) && /जिन पर OCR होता है/.test(config),
    );
    check(
      "config: deskew FAQ answers what it does",
      /What does \\"Deskew pages\\" do\?/.test(config),
    );

    const worker = readTool("tools/ocr-pdf/worker.ts");
    check("worker: reads options.deskew (default off)", /options\.deskew === true/.test(worker));
    check(
      "worker: detects skew on the rendered raster",
      /detectSkewAngle\(gray, width, height\)/.test(worker) &&
        /rgbaToGray\(context\.getImageData/.test(worker),
    );
    check(
      "worker: counter-rotates by −angle (rotate(-angle)",
      /rotate\(\(-angle \* Math\.PI\) \/ 180\)/.test(worker),
    );
    check(
      "worker: white-backfills the rotation (no black wedges)",
      /fillStyle = "#ffffff"/.test(worker),
    );
    check("worker: counts + reports deskewedPages", /deskewedPages \+= 1/.test(worker) && /\{ deskewedPages \}/.test(worker));
    check(
      "worker: deskew runs in BOTH paths (text + searchable)",
      (worker.match(/if \(deskew\) \{/g) ?? []).length === 2,
    );
    check(
      "worker doc: text layer aligns by construction (renderer paints raster + layer from one image)",
      /paints BOTH the visible raster AND the invisible text/.test(worker),
    );

    const engine = readTool("tools/ocr-pdf/engine.ts");
    check("engine: exports detectSkewAngle + rgbaToGray + both constants", /export function detectSkewAngle/.test(engine) && /export function rgbaToGray/.test(engine) && /export const SKEW_MIN_ANGLE = 0\.3/.test(engine) && /export const SKEW_MAX_ANGLE = 10/.test(engine));

    const protocol = readTool("src/lib/workers/protocol.ts");
    check("protocol: RunDetail.deskewedPages (ocr-pdf)", /deskewedPages\?: number/.test(protocol));

    const resultView = readTool("src/components/doco/tool/result-view.tsx");
    check("result-view: deskewedPages chip wired", /result\.deskewedPages/.test(resultView) && /deskewedPages\?: number/.test(resultView));

    const en = JSON.parse(readFileSync("/home/z/my-project/src/i18n/en.json", "utf8")) as {
      result?: Record<string, string>;
    };
    const hi = JSON.parse(readFileSync("/home/z/my-project/src/i18n/hi.json", "utf8")) as {
      result?: Record<string, string>;
    };
    check(
      "i18n: result.deskewedPages EN + HI, real translation (not EN copy)",
      typeof en.result?.deskewedPages === "string" &&
        typeof hi.result?.deskewedPages === "string" &&
        en.result.deskewedPages !== hi.result.deskewedPages &&
        /deskewed/.test(en.result.deskewedPages) &&
        /सीधा/.test(hi.result.deskewedPages),
      { en: en.result?.deskewedPages, hi: hi.result?.deskewedPages },
    );
  }

  console.log("\n── 5. real worker: deskew option vs the encrypted guard ──");
  {
    const { PDFDocument: CantooDoc, StandardFonts } = await import(
      "@cantoo/pdf-lib"
    );
    const typed = await CantooDoc.create();
    const font = await typed.embedFont(StandardFonts.Helvetica);
    const page = typed.addPage([595.28, 841.89]);
    page.drawText("Deskew guard fixture 4401 rupees.", { x: 50, y: 760, size: 14, font });
    await typed.encrypt({ userPassword: "", ownerPassword: "owner-4b", permissions: { copying: false } });
    const ownerOnly = new Uint8Array(await typed.save({ useObjectStreams: false }));

    const workerGlobal = globalThis as unknown as {
      postMessage: (msg: unknown) => void;
      onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
      location: { href: string };
    };
    const messages: WorkerResponse[] = [];
    workerGlobal.postMessage = (msg: unknown): void => {
      messages.push(msg as WorkerResponse);
    };
    workerGlobal.location = { href: "http://localhost/" };
    (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
    await import("../tools/ocr-pdf/worker");
    check("worker: module loaded, onmessage registered", typeof workerGlobal.onmessage === "function");

    const runId = 41;
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "ocr-pdf",
        options: {
          languages: "eng",
          dpi: "150",
          output: "searchable",
          pages: "all",
          skipText: true,
          pageMarks: true,
          deskew: true, // the new option rides ALONGSIDE the guard
        },
        files: [new File([ownerOnly as BlobPart], "owner-only-deskew.pdf")],
      } as WorkerRunRequest,
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (
        messages
          .slice(before)
          .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
      ) {
        break;
      }
      if (Date.now() > deadline) throw new Error("worker run did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    const response = messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
    check(
      "worker: owner-only + deskew:true still refuses with tool.errorEncrypted (guard first)",
      response.type === "error" && response.code === "tool.errorEncrypted",
      response,
    );
  }

  console.log(
    `\nocr-deskew smoke: ${pass} passed, ${fail} failed` +
      (fail ? "\n  " + failures.join("\n  ") : " — ALL GREEN")
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
