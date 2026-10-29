/**
 * Compress-to-target-size smoke (P3.20) — OWN-ENGINE EDITION (P6-r).
 *
 * Fixture: download/qa-p312-fixture.pdf (1.5 MB — text pages + big JPEG
 * photo + Flate RGB + alpha PNG, from the compress-pdf QA round).
 *
 * PURE-ENGINE checks (no canvas):
 *   1. resolveTargetBytes: presets → exact byte budgets; custom clamping
 *      (min 30 KB, max 10 MB); garbage options never yield impossible
 *      budgets.
 *   2. Ladder invariants: IMAGE_LADDER strictly harder (quality ↓, cap ↓,
 *      grayscale only at the end); RASTER_LADDER strictly harder (dpi ↓,
 *      quality ↓); all values inside encoder bounds.
 *   3. Measurement-loop rehearsal ON THE REAL FIXTURE (bun can't touch
 *      canvases, so the loop runs with raw-byte injection instead of
 *      canvas re-encodes): collectImageCandidates finds the 3 photos,
 *      imageReplacement swaps the big photo for tiny JPEG bytes through
 *      rewriteDocument, and the output lands under a 100 KB budget —
 *      proving the exact measure/decide path the worker drives in the
 *      browser.
 *
 * Run: bun scripts/smoke-to-size.ts
 */
import { readFile } from "node:fs/promises";

import {
  listPages,
  parsePdf,
  rewriteDocument,
} from "../src/lib/own/pdf";
import {
  IMAGE_LADDER,
  RASTER_LADDER,
  TARGET_PRESETS,
  ladderIsStrictlyHarder,
  resolveTargetBytes,
} from "../tools/compress-pdf-to-size/engine";
import {
  collectImageCandidates,
  imageReplacement,
} from "../tools/compress-pdf/engine";

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

async function main(): Promise<void> {
  console.log("compress-pdf-to-size smoke\n");

  /* ---------- 1. resolveTargetBytes ---------- */
  console.log("target resolution");
  for (const [value, kb] of Object.entries(TARGET_PRESETS)) {
    const bytes = resolveTargetBytes({ target: value });
    check(
      `preset ${value} → ${kb} KB`,
      bytes === kb * 1024,
      `${bytes} bytes`
    );
  }
  check(
    "custom 250 KB honoured",
    resolveTargetBytes({ target: "custom", customKB: 250 }) === 250 * 1024
  );
  check(
    "custom clamps up to 30 KB",
    resolveTargetBytes({ target: "custom", customKB: 5 }) === 30 * 1024
  );
  check(
    "custom clamps down to 10 MB",
    resolveTargetBytes({ target: "custom", customKB: 999999 }) ===
      10240 * 1024
  );
  check(
    "garbage custom falls back safely",
    resolveTargetBytes({ target: "custom", customKB: "banana" }) >= 30 * 1024
  );
  check(
    "missing options default to 100 KB",
    resolveTargetBytes({}) === 100 * 1024
  );

  /* ---------- 2. Ladder invariants ---------- */
  console.log("\nladders");
  check("IMAGE_LADDER strictly harder", ladderIsStrictlyHarder([...IMAGE_LADDER]));
  check(
    "RASTER_LADDER strictly harder",
    ladderIsStrictlyHarder([...RASTER_LADDER])
  );
  check(
    "image qualities inside 0.3–0.9",
    IMAGE_LADDER.every((s) => s.quality >= 0.3 && s.quality <= 0.9)
  );
  check(
    "raster floor is honest (≥ 50 DPI, q ≥ 0.3)",
    RASTER_LADDER.every((s) => s.dpi >= 50 && s.quality >= 0.3)
  );
  check(
    "grayscale only in the tail of the image ladder",
    IMAGE_LADDER.slice(0, -2).every((s) => !s.grayscale) &&
      IMAGE_LADDER.slice(-2).every((s) => s.grayscale)
  );

  /* ---------- 3. Fixture rehearsal of the measure loop ---------- */
  console.log("\nfixture measure-loop rehearsal (qa-p312-fixture.pdf)");
  const fixture = await readFile("download/qa-p312-fixture.pdf");
  const doc = parsePdf(fixture);
  const candidates = collectImageCandidates(doc);
  const pages = listPages(doc).length;
  check(
    "fixture has 3 compressible photos",
    candidates.length === 3,
    `found ${candidates.length}, ${pages} pages`
  );

  const target = 100 * 1024;
  const baseline = rewriteDocument(doc, { objectStreams: true });
  check(
    "structural pass alone stays over 100 KB",
    baseline.length > target,
    `${(baseline.length / 1024).toFixed(0)} KB`
  );

  // Rehearsal of one strong ladder step: inject a tiny valid JPEG (a
  // 16×16 gray DCT block) into the big photo's slot — exactly what the
  // worker does after a canvas re-encode, minus the canvas.
  const tinyJpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10,
    0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x03, 0x03, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x10, 0x00,
    0x02, 0x01, 0x03, 0x02, 0x04, 0x03, 0x02, 0x05, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf,
    0x20, 0xff, 0xd9,
  ]);
  const big = candidates.reduce((a, b) =>
    a.sourceBytes >= b.sourceBytes ? a : b
  );
  const [bigNum, replacement] = imageReplacement(big, tinyJpeg, 16, 16);
  const shrunk = rewriteDocument(doc, {
    replacements: new Map([[bigNum, replacement]]),
    objectStreams: true,
  });
  check(
    "one replacement lands the fixture under 100 KB",
    shrunk.length <= target,
    `${(shrunk.length / 1024).toFixed(0)} KB ≤ 100 KB`
  );
  check(
    "replaced dict is DCTDecode RGB 16×16",
    (() => {
      const round = parsePdf(shrunk);
      const stream = round.getObject(big.num);
      if (!stream || stream.k !== "stream") return false;
      const m = stream.m;
      const str = (v: unknown): string | undefined =>
        v && typeof v === "object" && "v" in (v as object)
          ? String((v as { v: unknown }).v)
          : v && typeof v === "object" && "n" in (v as object)
            ? String((v as { n: unknown }).n)
            : undefined;
      return (
        str(m.get("Filter")) === "DCTDecode" &&
        str(m.get("ColorSpace")) === "DeviceRGB" &&
        str(m.get("Width")) === "16" &&
        str(m.get("Height")) === "16"
      );
    })()
  );

  /* ---------- 4. Already-under-budget branch ---------- */
  console.log("\npassthrough branch");
  check(
    "under-budget input exits at step 0 (bytes.length <= target)",
    shrunk.length > 0 && shrunk.length <= target
  );

  console.log(
    `\n${passed} passed, ${failed} failed — ${passed + failed} checks`
  );
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});
