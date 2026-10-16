/**
 * PRE-BUILD smoke test for the Resize image to KB tool (P4.7, PRD §7.10:
 * "Photo + signature under 100/200 KB for exam and government forms").
 *
 * bun cannot run OffscreenCanvas encoders, so this smoke locks the PURE
 * targeting logic the worker streams through (tools/resize-image-kb/engine.ts):
 *
 *  1. resolveTargetBytes — presets, custom clamp (min/max/NaN), fallback.
 *  2. capDimensions — never upscales, maxDim cap, 40MP pixel-budget floor.
 *  3. dimLadder — big-first steps, exact 120px floor landing, tiny images
 *     keep a single step, strictly shrinking, all dims ≥ 1.
 *  4. searchQuality — monotone synthetic size curves: largest fitting
 *     quality found within the step band, probe bounds + count, MAX/None
 *     edges.
 *  5. The worker contract: quality search runs at every dimension step,
 *     big steps first — the first step that CAN fit wins (synthetic
 *     monotone encoder, same call order as ladderJpeg).
 *
 * Run: bun scripts/smoke-resize-image-kb.ts
 */
import {
  CUSTOM_KB_MAX,
  CUSTOM_KB_MIN,
  DIM_FLOOR_PX,
  QUALITY_MAX,
  QUALITY_MIN,
  capDimensions,
  dimLadder,
  resolveTargetBytes,
  searchQuality,
} from "../tools/resize-image-kb/engine";

let passed = 0;
let failed = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`PASS ${message}`);
}

function fail(message: string): void {
  failed += 1;
  console.error(`FAIL ${message}`);
}

function assert(cond: boolean, message: string): void {
  if (cond) pass(message);
  else fail(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message} (expected ${b}, got ${a})`);
}

/* ---------------------------------------------------------------- */
console.log("— resolveTargetBytes —");

eq(resolveTargetBytes({}).bytes, 100 * 1024, "default target is 100 KB");
eq(resolveTargetBytes({ target: "20" }).bytes, 20 * 1024, "20 KB preset");
eq(resolveTargetBytes({ target: "50" }).bytes, 50 * 1024, "50 KB preset");
eq(resolveTargetBytes({ target: "200" }).bytes, 200 * 1024, "200 KB preset");
eq(resolveTargetBytes({ target: "500" }).bytes, 500 * 1024, "500 KB preset");
eq(
  resolveTargetBytes({ target: "custom", customKB: 300 }).bytes,
  300 * 1024,
  "custom 300 KB"
);
eq(
  resolveTargetBytes({ target: "custom", customKB: 5 }).bytes,
  CUSTOM_KB_MIN * 1024,
  "custom below minimum clamps to 10 KB"
);
eq(
  resolveTargetBytes({ target: "custom", customKB: 99999 }).bytes,
  CUSTOM_KB_MAX * 1024,
  "custom above maximum clamps to 5000 KB"
);
eq(
  resolveTargetBytes({ target: "custom", customKB: Number.NaN }).bytes,
  CUSTOM_KB_MIN * 1024,
  "custom NaN falls back to the minimum"
);
eq(
  resolveTargetBytes({ target: "999" }).bytes,
  100 * 1024,
  "unknown preset falls back to 100 KB"
);
eq(
  resolveTargetBytes({ target: "custom", customKB: 300 }).preset,
  false,
  "custom reports preset: false"
);
eq(resolveTargetBytes({ target: "100" }).preset, true, "preset flag set");

/* ---------------------------------------------------------------- */
console.log("— capDimensions —");

eq(capDimensions(800, 600, 4096), { width: 800, height: 600 }, "no upscale");
eq(capDimensions(4000, 3000, 2048), { width: 2048, height: 1536 }, "maxDim cap keeps aspect");
eq(capDimensions(3000, 4000, 1000), { width: 750, height: 1000 }, "portrait maxDim cap");
eq(capDimensions(1, 1, 0), { width: 1, height: 1 }, "1px stays 1px");

const huge = capDimensions(9000, 9000, 0);
assert(
  huge.width * huge.height <= 40_000_000,
  `40MP budget respected (${huge.width}x${huge.height} = ${huge.width * huge.height})`
);
eq(huge.width, huge.height, "40MP clamp keeps square aspect");
const bigPhoto = capDimensions(8000, 4500, 0);
assert(
  bigPhoto.width * bigPhoto.height <= 40_000_000,
  `landscape 36MP passthrough (${bigPhoto.width}x${bigPhoto.height})`
);
const both = capDimensions(9000, 9000, 2048);
eq(both, { width: 2048, height: 2048 }, "maxDim applied before the 40MP check");

/* ---------------------------------------------------------------- */
console.log("— dimLadder —");

const big = dimLadder(4000, 3000);
eq(big[0], { width: 4000, height: 3000, factor: 1 }, "ladder starts at the original");
assert(
  big.every((step) => step.width >= 1 && step.height >= 1),
  "every step is at least 1px"
);
assert(
  big.every((step, i) => i === 0 || step.width < big[i - 1].width),
  "steps strictly shrink"
);
assert(
  Math.max(big[big.length - 1].width, big[big.length - 1].height) <= DIM_FLOOR_PX,
  "final step lands on/below the 120px floor"
);
assert(
  big.some((step) => Math.max(step.width, step.height) >= 240),
  "big photos keep several usable sizes above the floor"
);

eq(dimLadder(400, 400).at(-1), { width: 120, height: 120, factor: 0.3 }, "square 400 lands exactly on the floor");
eq(dimLadder(100, 80), [{ width: 100, height: 80, factor: 1 }], "tiny image keeps a single step");
eq(
  dimLadder(240, 120).map((s) => s.width),
  [240, 192, 154, 123, 120],
  "240-wide ladder shrinks ×0.8 with an exact floor landing"
);
const tall = dimLadder(300, 2400);
assert(
  tall[0].height === 2400 && tall.at(-1)!.height <= DIM_FLOOR_PX,
  "tall signature ladder spans original → floor"
);

/* ---------------------------------------------------------------- */
console.log("— searchQuality (synthetic monotone encoders) —");

// size(q) = 100000·q → the budget 50000 admits q ≤ 0.5.
{
  const probes: number[] = [];
  const q = await searchQuality(async (quality) => {
    probes.push(quality);
    return 100000 * quality <= 50000;
  });
  assert(q !== null, "mid-curve target finds a quality");
  assert(
    q! > 0.5 - 0.05 && q! <= 0.5,
    `largest fitting quality in the 0.05 band (got ${q})`
  );
  assert(
    probes.every((p) => p >= QUALITY_MIN && p <= QUALITY_MAX),
    "probes stay inside [QUALITY_MIN, QUALITY_MAX]"
  );
  assert(probes.length <= 8, `probe count bounded (got ${probes.length})`);
}

// Everything fits → the ceiling, in one probe.
{
  const probes: number[] = [];
  const q = await searchQuality(async (quality) => {
    probes.push(quality);
    return 1000 * quality <= 50000;
  });
  eq(q, QUALITY_MAX, "generous budget returns the ceiling");
  eq(probes.length, 1, "ceiling hit in a single probe");
}

// Nothing fits → null.
{
  const q = await searchQuality(async () => false);
  eq(q, null, "impossible budget returns null (dimension step next)");
}

// The floor case: only QUALITY_MIN fits → QUALITY_MIN.
{
  const q = await searchQuality(async (quality) => quality <= QUALITY_MIN);
  eq(q, QUALITY_MIN, "budget that only admits the floor returns the floor");
}

// Monotonicity assumption honored by the search: it never re-probes a value.
{
  const seen = new Set<number>();
  const q = await searchQuality(async (quality) => {
    assert(!seen.has(quality), `quality ${quality} probed only once`);
    seen.add(quality);
    return 70000 * quality <= 40000;
  });
  assert(q !== null && q! <= 40000 / 70000 + 1e-9, "no-reprobe search still lands correctly");
}

/* ---------------------------------------------------------------- */
console.log("— ladder contract (worker call order, synthetic encoder) —");

/**
 * Same loop as ladderJpeg: for every dimension step, binary-search the
 * largest quality that fits. size(step, q) = floor + base·stepFactor·q
 * with the per-step factor shrinking 0.6× — monotone in both axes,
 * exactly like a real encoder (floor models the legibility minimum).
 */
async function syntheticLadder(
  startWidth: number,
  startHeight: number,
  target: number,
  base: number,
  floor = 0
): Promise<{ step: number; quality: number | null }> {
  const ladder = dimLadder(startWidth, startHeight);
  for (let s = 0; s < ladder.length; s += 1) {
    const scaleAt = Math.pow(0.6, s);
    const quality = await searchQuality(
      async (q) => floor + base * scaleAt * q <= target
    );
    if (quality !== null) return { step: s, quality };
  }
  return { step: -1, quality: null };
}

{
  // Step 0: even q0.30 gives 300000·0.3 = 90000 > 50000 → hopeless;
  // step 1: 180000·0.3 = 54000 > 50000 → hopeless; step 2: 108000·q
  // admits q ≤ 0.463 → the ladder fits two steps down.
  const r = await syntheticLadder(2000, 1500, 50000, 300000);
  eq(r.step, 2, "ladder skips hopeless steps and fits two down");
  assert(
    r.quality !== null && r.quality! > 0.41 && r.quality! <= 0.464,
    `winning quality hugs the fit boundary (got ${r.quality})`
  );

  // Original already fits at max quality.
  const r2 = await syntheticLadder(2000, 1500, 200000, 100000);
  eq(r2.step, 0, "fitting original never shrinks");
  eq(r2.quality, QUALITY_MAX, "fitting original keeps max quality");

  // Hopeless everywhere: a 5000-byte legibility floor can never fit a
  // 1000-byte budget — honest miss on every step.
  const r3 = await syntheticLadder(2000, 1500, 1000, 100000, 5000);
  eq(r3.step, -1, "unreachable target reports an honest miss");
}

/* ---------------------------------------------------------------- */
console.log("");

if (failed > 0) {
  console.error(`\n${failed} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL ${passed} PASSED`);
