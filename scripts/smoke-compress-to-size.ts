/**
 * Compress-to-target-size — PURE LADDER smoke.
 *
 * Verifies the strategy without any canvas:
 *   - resolveTargetBytes: presets map exactly, custom clamps, junk falls
 *     back to 200 KB
 *   - TARGET_LADDER invariants: quality + maxDim strictly non-increasing,
 *     10+ rungs, floors we can defend
 *   - compressToTarget with a simulated size oracle: first rung that fits
 *     wins / smallest kept when none fit / best tracked across plateaus /
 *     every rung actually attempted in order / async contract holds
 *
 * Run: bun scripts/smoke-compress-to-size.ts
 */
import {
  TARGET_LADDER,
  TARGET_MAX_KB,
  TARGET_MIN_KB,
  TARGET_PRESET_BYTES,
  compressToTarget,
  resolveTargetBytes,
} from "../tools/compress-pdf-to-size/ladder";

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

/* ---------------- presets ---------------- */
console.log("resolveTargetBytes:");
for (const preset of TARGET_PRESET_BYTES) {
  const bytes = resolveTargetBytes({ target: preset });
  check(
    `preset ${preset} maps exactly`,
    bytes === Number(preset),
    `${bytes} bytes`
  );
}
check(
  "custom 1000 KB → 1024000 bytes",
  resolveTargetBytes({ target: "custom", targetKb: 1000 }) === 1024000
);
check(
  "custom clamps below the floor (5 KB → 20 KB)",
  resolveTargetBytes({ target: "custom", targetKb: 5 }) === TARGET_MIN_KB * 1024
);
check(
  "custom clamps above the ceiling (999999 KB → 50 MB)",
  resolveTargetBytes({ target: "custom", targetKb: 999999 }) ===
    TARGET_MAX_KB * 1024
);
check(
  "fractional custom rounds (150.7 → 151 KB)",
  resolveTargetBytes({ target: "custom", targetKb: 150.7 }) === 151 * 1024
);
check(
  "garbage preset falls back to 200 KB via the KB path",
  resolveTargetBytes({ target: "nope" }) === 204800
);
check(
  "no options at all → 200 KB default",
  resolveTargetBytes({}) === 204800
);

/* ---------------- ladder invariants ---------------- */
console.log("\nTARGET_LADDER invariants:");
check("at least 10 rungs", TARGET_LADDER.length >= 10, String(TARGET_LADDER.length));
let monotone = true;
for (let i = 1; i < TARGET_LADDER.length; i += 1) {
  if (
    TARGET_LADDER[i].quality > TARGET_LADDER[i - 1].quality ||
    TARGET_LADDER[i].maxDim > TARGET_LADDER[i - 1].maxDim
  ) {
    monotone = false;
    break;
  }
}
check("quality + maxDim never increase going down", monotone);
check(
  "first rung = the compress recommended recipe (0.65 / 1600)",
  TARGET_LADDER[0].quality === 0.65 && TARGET_LADDER[0].maxDim === 1600
);
check(
  "passes through the strong recipe (0.45 / 1200)",
  TARGET_LADDER.some((r) => r.quality === 0.45 && r.maxDim === 1200)
);
check(
  "floor stays at or above 0.08 / 500",
  TARGET_LADDER[TARGET_LADDER.length - 1].quality >= 0.08 &&
    TARGET_LADDER[TARGET_LADDER.length - 1].maxDim >= 500
);

/* ---------------- search behavior (simulated oracle) ---------------- */
console.log("\ncompressToTarget (simulated sizes):");

// Oracle 1: every rung fits the generous target → rung 0 must win.
const seen1: number[] = [];
const out1 = await compressToTarget(1_000_000, async (rung, index) => {
  seen1.push(index);
  return 100_000; // always fits
});
check("first fitting rung wins (rung 0)", out1.fitsTarget && out1.rungIndex === 0);
check("stops after the first fit (1 attempt)", seen1.length === 1);

// Oracle 2: sizes shrink monotonically; target between rung 3 and 4.
const seen2: number[] = [];
const out2 = await compressToTarget(70_000, async (rung, index) => {
  seen2.push(index);
  return 120_000 - index * 15_000; // 120k, 105k, 90k, 75k, 60k…
});
check(
  "stops at the first rung under the target (index 4)",
  out2.fitsTarget && out2.rungIndex === 4 && out2.achievedBytes === 60_000,
  `rung ${out2.rungIndex} @ ${out2.achievedBytes}`
);
check("tried exactly 5 rungs in order", seen2.join(",") === "0,1,2,3,4");

// Oracle 3: nothing ever fits → smallest result kept + reported honestly.
const seen3: number[] = [];
const out3 = await compressToTarget(10_000, async (rung, index) => {
  seen3.push(index);
  return 90_000 + (index % 2) * 5_000 - index * 2_000; // dips + plateaus
});
check("no fit reported honestly", !out3.fitsTarget);
check(
  "smallest attempt tracked across plateaus",
  out3.achievedBytes === Math.min(...seen3.map((i) => 90_000 + (i % 2) * 5_000 - i * 2_000)) &&
    out3.rungIndex === TARGET_LADDER.length - 1,
  `rung ${out3.rungIndex} @ ${out3.achievedBytes}`
);
check("all rungs attempted when nothing fits", seen3.length === TARGET_LADDER.length);

// Oracle 4: exact boundary — achieved == target counts as fitting.
const out4 = await compressToTarget(50_000, async () => 50_000);
check("achieved == target counts as a fit", out4.fitsTarget);

// Oracle 5: the attempt callback receives the rung it advertises.
let rungParamsOk = true;
await compressToTarget(1, async (rung) => {
  if (TARGET_LADDER.indexOf(rung) === -1) rungParamsOk = false;
  return 999_999;
});
check("callback receives actual TARGET_LADDER rung objects", rungParamsOk);

// Oracle 6: async resolution respected (awaits inside callbacks).
let asyncOk = true;
const out6 = await compressToTarget(60_000, async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return 55_000;
});
if (!out6.fitsTarget) asyncOk = false;
check("awaits async attempt work", asyncOk);

console.log(
  `\n${passed} passed, ${failed} failed${failed === 0 ? " — ALL PASS" : ""}`
);
if (failed > 0) process.exit(1);
