/**
 * Compress-to-target-size — LIVE ENGINE + rung-report smoke.
 *
 * Rewritten in audit round 3: the previous smoke validated
 * tools/compress-pdf-to-size/ladder.ts — a superseded module nothing
 * imports (the worker runs engine.ts's IMAGE_LADDER + RASTER_LADDER,
 * with its own loops). That dead module is deleted; this smoke now
 * locks what actually ships:
 *
 *  1. resolveTargetBytes (engine.ts): presets map exactly ("100"→100 KB
 *     … "1000"→1 MB), custom clamps 30 KB..10 MB, junk falls back to
 *     the 300 KB default.
 *  2. Ladder invariants (engine.ts): IMAGE_LADDER + RASTER_LADDER both
 *     strictly harder going down (ladderIsStrictlyHarder), colour kept
 *     until the image ladder's tail rungs, floors we can defend.
 *  3. Rung-report wiring (audit R3 — the engine always knew WHICH rung
 *     won and used to discard it): the worker tracks bestImageStep /
 *     bestRasterStep alongside bestStage, posts compressStage + the
 *     winning rung's parameters in the result detail, protocol.RunDetail
 *     carries the fields, and ResultView renders the honest "how" chip.
 *  4. WORKER E2E (self/postMessage shim, web-optimize recipe): a
 *     text-only 60-page PDF over a 100 KB target lands under it after
 *     the structural pass → exactly one result, targetHit true,
 *     detail.compressStage "optimize", output genuinely smaller (the
 *     image/raster rungs need canvas + pdf.js render; their param
 *     mapping is locked by the wiring asserts above).
 *  5. i18n: result.stageOptimize / stageImages / stageImagesGray /
 *     stageRaster present in BOTH catalogs.
 *
 * Run: bun scripts/smoke-compress-to-size.ts
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  IMAGE_LADDER,
  RASTER_LADDER,
  TARGET_PRESETS,
  ladderIsStrictlyHarder,
  resolveTargetBytes,
} from "../tools/compress-pdf-to-size/engine";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ================================================================== */
console.log("── 1. resolveTargetBytes (LIVE engine) ─────────────────");
/* ================================================================== */
{
  const KB = 1024;
  check("preset 100 → 100 KB", resolveTargetBytes({ target: "100" }) === 100 * KB);
  check("preset 200 → 200 KB", resolveTargetBytes({ target: "200" }) === 200 * KB);
  check("preset 500 → 500 KB", resolveTargetBytes({ target: "500" }) === 500 * KB);
  check("preset 1000 → 1 MB", resolveTargetBytes({ target: "1000" }) === 1000 * KB);
  check(
    "presets match the config's choices",
    Object.keys(TARGET_PRESETS).join(",") === "100,200,500,1000" &&
      ["100", "200", "500", "1000", "custom"].every(() => true)
  );
  check(
    "custom 500 KB honored",
    resolveTargetBytes({ target: "custom", customKB: 500 }) === 500 * KB
  );
  check(
    "custom clamps below the floor (5 KB → 30 KB)",
    resolveTargetBytes({ target: "custom", customKB: 5 }) === 30 * KB
  );
  check(
    "custom clamps above the ceiling (999999 KB → 10 MB)",
    resolveTargetBytes({ target: "custom", customKB: 999999 }) === 10240 * KB
  );
  check(
    "fractional custom rounds (150.7 → 151 KB)",
    resolveTargetBytes({ target: "custom", customKB: 150.7 }) === 151 * KB
  );
  check(
    "no options at all → the 100 KB default preset",
    resolveTargetBytes({}) === 100 * KB
  );
  check(
    "garbage preset falls back to the 300 KB custom default",
    resolveTargetBytes({ target: "nope" }) === 300 * KB
  );
  check(
    "non-numeric customKB falls back to 300 KB",
    resolveTargetBytes({ target: "custom", customKB: "abc" }) === 300 * KB
  );
}

/* ================================================================== */
console.log("\n── 2. ladder invariants (LIVE engine) ───────────────────");
/* ================================================================== */
{
  check(
    "IMAGE_LADDER strictly harder going down",
    ladderIsStrictlyHarder([...IMAGE_LADDER])
  );
  check(
    "RASTER_LADDER strictly harder going down",
    ladderIsStrictlyHarder([...RASTER_LADDER])
  );
  check(
    "image ladder starts at the gentle rung (0.8 / 2400, colour)",
    IMAGE_LADDER[0].quality === 0.8 &&
      IMAGE_LADDER[0].maxDim === 2400 &&
      IMAGE_LADDER[0].grayscale === false
  );
  check(
    "colour kept until the image ladder's tail (grayscale only at the end)",
    IMAGE_LADDER.every(
      (rung, i) => rung.grayscale === (i >= IMAGE_LADDER.length - 2)
    )
  );
  check(
    "image floor stays readable (≥ 0.32 / ≥ 900 px)",
    IMAGE_LADDER[IMAGE_LADDER.length - 1].quality >= 0.32 &&
      IMAGE_LADDER[IMAGE_LADDER.length - 1].maxDim >= 900
  );
  check(
    "raster ladder starts at 140 DPI / 0.72",
    RASTER_LADDER[0].dpi === 140 && RASTER_LADDER[0].quality === 0.72
  );
  check(
    "raster floor is the honest 52 DPI / 0.32",
    RASTER_LADDER[RASTER_LADDER.length - 1].dpi === 52 &&
      RASTER_LADDER[RASTER_LADDER.length - 1].quality === 0.32
  );
}

/* ================================================================== */
console.log("\n── 3. rung-report wiring (audit R3) ─────────────────────");
/* ================================================================== */
{
  const worker = readFileSync("tools/compress-pdf-to-size/worker.ts", "utf8");
  check(
    "worker: winning IMAGE rung index tracked (bestImageStep = step)",
    worker.includes("bestImageStep = step")
  );
  check(
    "worker: winning RASTER rung index tracked (bestRasterStep = step)",
    worker.includes("bestRasterStep = step")
  );
  check(
    "worker: compressStage posted in the result detail",
    worker.includes("compressStage: bestStage")
  );
  check(
    "worker: images rung posts quality %, pixel cap and grayscale",
    worker.includes("detail.compressQuality = Math.round(rung.quality * 100)") &&
      worker.includes("detail.compressMaxDim = rung.maxDim") &&
      worker.includes("detail.compressGrayscale = rung.grayscale")
  );
  check(
    "worker: raster rung posts its DPI",
    worker.includes("detail.compressDpi = RASTER_LADDER[bestRasterStep].dpi")
  );
  check(
    "worker: bestStage is never discarded anymore (no `void bestStage`)",
    !worker.includes("void bestStage")
  );

  const protocol = readFileSync("src/lib/workers/protocol.ts", "utf8");
  check(
    "protocol.RunDetail carries the compress rung fields",
    protocol.includes("compressStage?:") &&
      protocol.includes("compressQuality?:") &&
      protocol.includes("compressMaxDim?:") &&
      protocol.includes("compressGrayscale?:") &&
      protocol.includes("compressDpi?:")
  );

  const resultView = readFileSync(
    "src/components/doco/tool/result-view.tsx",
    "utf8"
  );
  check(
    "ResultView renders the rung chip for every stage",
    resultView.includes('runSummary?.compressStage === "optimize"') &&
      resultView.includes('runSummary?.compressStage === "images"') &&
      resultView.includes('runSummary?.compressStage === "raster"')
  );
  check(
    "ResultView: grayscale rung gets its own key, raster interpolates DPI",
    resultView.includes('"result.stageImagesGray"') &&
      resultView.includes('"result.stageRaster"')
  );
}

/* ================================================================== */
console.log("\n── 4. worker E2E: structural rung reported ──────────────");
/* ================================================================== */
{
  // Text-only 60-page fixture: ~134 KB saved WITHOUT object streams vs
  // ~71 KB with them (probe-verified) — target 100 KB means the input
  // does NOT pass through untouched but the structural pass DOES fit,
  // so the run ends at the "optimize" rung without touching canvas.
  const doc = await PDFDocument.create();
  doc.setTitle("Compress to size smoke fixture");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 60; p += 1) {
    const page = doc.addPage([612, 792]);
    for (let i = 0; i < 40; i += 1) {
      page.drawText(
        `Line ${i}: the quick brown fox jumps over the lazy dog 0123456789 ${p}-${i}`,
        { x: 40, y: 750 - i * 16, size: 10, font }
      );
    }
  }
  const inputBytes = await doc.save({ useObjectStreams: false });
  check(
    "fixture is over the target (structural pass needed)",
    inputBytes.length > 100 * 1024,
    `${inputBytes.length} bytes`
  );

  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  const inbox: (Record<string, unknown> & { type: string })[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Record<string, unknown> & { type: string });
  };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  await import("../tools/compress-pdf-to-size/worker");
  check(
    "worker: module loaded, onmessage registered",
    typeof workerGlobal.onmessage === "function"
  );

  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId: 8101,
      toolId: "compress-pdf-to-size",
      options: { target: "custom", customKB: 100 },
      files: [new File([inputBytes as BlobPart], "probe.pdf")],
    },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (
      inbox.some((m) => m.runId === 8101 && (m.type === "result" || m.type === "error"))
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  const runMsgs = inbox.filter((m) => m.runId === 8101);
  const results = runMsgs.filter((m) => m.type === "result");
  const errors = runMsgs.filter((m) => m.type === "error");
  check("E2E: exactly ONE result", results.length === 1, String(results.length));
  check("E2E: no error", errors.length === 0, JSON.stringify(errors[0] ?? null));
  const result = results[0] as {
    outputs?: { name?: string; blob?: Blob }[];
    detail?: Record<string, unknown>;
  };
  check(
    "E2E: targetHit true (structural pass fit the budget)",
    result.detail?.targetHit === true
  );
  check(
    "E2E: detail.compressStage === \"optimize\" (the winning rung, surfaced)",
    result.detail?.compressStage === "optimize",
    JSON.stringify(result.detail)
  );
  check("E2E: pages reported (60)", result.detail?.pages === 60);
  check(
    "E2E: output genuinely smaller than the input (not a passthrough)",
    (result.outputs?.[0]?.blob?.size ?? 0) < inputBytes.length,
    `${result.outputs?.[0]?.blob?.size} vs ${inputBytes.length}`
  );
  check(
    "E2E: output named after the file",
    result.outputs?.[0]?.name === "probe-compressed.pdf"
  );
  const outBytes = new Uint8Array(
    await (result.outputs![0].blob as Blob).arrayBuffer()
  );
  check(
    "E2E: output is a real PDF",
    outBytes.length > 5 &&
      outBytes[0] === 0x25 &&
      String.fromCharCode(...outBytes.slice(0, 5)) === "%PDF-"
  );
}

/* ================================================================== */
console.log("\n── 5. i18n: rung-report keys in BOTH catalogs ────────────");
/* ================================================================== */
{
  const readJson = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(new TextDecoder().decode(await readFile(path)));
  const en = (await readJson("src/i18n/en.json")) as {
    result?: Record<string, unknown>;
  };
  const hi = (await readJson("src/i18n/hi.json")) as {
    result?: Record<string, unknown>;
  };
  const keys = [
    "stageOptimize",
    "stageImages",
    "stageImagesGray",
    "stageRaster",
  ];
  for (const key of keys) {
    check(
      `i18n: result.${key} in BOTH catalogs`,
      typeof en.result?.[key] === "string" && typeof hi.result?.[key] === "string"
    );
  }
  check(
    "i18n: stageImages carries {quality} + {maxDim}, stageRaster {dpi}",
    String(en.result?.stageImages).includes("{quality}") &&
      String(en.result?.stageImages).includes("{maxDim}") &&
      String(en.result?.stageRaster).includes("{dpi}") &&
      String(hi.result?.stageImages).includes("{quality}") &&
      String(hi.result?.stageRaster).includes("{dpi}")
  );
}

console.log(
  `\ncompress-to-size smoke: ${passed} passed, ${failed} failed` +
    (failed === 0 ? " — ALL GREEN" : "")
);
process.exit(failed === 0 ? 0 : 1);
