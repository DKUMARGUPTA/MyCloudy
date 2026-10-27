/**
 * PRE-BUILD smoke test for Resize image to KB (57th tool, PRD §7.10).
 *
 * The engine (tools/resize-image-kb/engine.ts) is pure — bun verifies the
 * REAL module directly: target clamps, pixel presets, cover-crop math,
 * the downscale ladder floor, the generator-driven quality search (sync
 * AND the async-driver protocol the worker uses), and output naming
 * (engine.outputBaseName + imgconv allocateOutputName integration).
 *
 * Run: bun scripts/smoke-resize-kb.ts
 */
import {
  coverCrop,
  nextDownscale,
  outputBaseName,
  pickQuality,
  qualitySearchSteps,
  resolveDims,
  resolveTargetBytes,
  Q_MAX,
  Q_MIN,
  TARGET_KB_MAX,
  TARGET_KB_MIN,
} from "../tools/resize-image-kb/engine";
import { allocateOutputName } from "../tools/imgconv/naming";

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

/* ---------- 1. resolveTargetBytes ---------- */
assertEqual(
  resolveTargetBytes({ target: "100" }).bytes,
  100 * 1024,
  "target 100 preset → 102400 bytes"
);
assertEqual(
  resolveTargetBytes({ target: "20" }).kb,
  20,
  "target 20 preset → 20 kb"
);
assertEqual(
  resolveTargetBytes({}).kb,
  100,
  "missing target → default 100"
);
assertEqual(
  resolveTargetBytes({ target: "custom", targetKb: 333 }).bytes,
  333 * 1024,
  "custom 333 → 341504 bytes"
);
assertEqual(
  resolveTargetBytes({ target: "custom", targetKb: 1 }).kb,
  TARGET_KB_MIN,
  "custom 1 clamps to 5"
);
assertEqual(
  resolveTargetBytes({ target: "custom", targetKb: 99999 }).kb,
  TARGET_KB_MAX,
  "custom 99999 clamps to 2000"
);
assertEqual(
  resolveTargetBytes({ target: "custom", targetKb: Number.NaN }).kb,
  100,
  "custom NaN → 100"
);
assertEqual(
  resolveTargetBytes({ target: "custom" }).kb,
  100,
  "custom missing field → 100"
);

/* ---------- 2. resolveDims ---------- */
assertEqual(resolveDims({}), null, "default keep → null");
assertEqual(resolveDims({ preset: "keep" }), null, "keep → null");
assertEqual(
  resolveDims({ preset: "photo200x230" }),
  { w: 200, h: 230 },
  "photo 200×230 preset"
);
assertEqual(
  resolveDims({ preset: "photo350x350" }),
  { w: 350, h: 350 },
  "photo 350×350 preset"
);
assertEqual(
  resolveDims({ preset: "sign140x60" }),
  { w: 140, h: 60 },
  "signature 140×60 preset"
);
assertEqual(
  resolveDims({ preset: "custom", customW: 250.4, customH: 330.6 }),
  { w: 250, h: 331 },
  "custom dims round"
);
assertEqual(
  resolveDims({ preset: "custom", customW: 5, customH: 99999 }),
  { w: 20, h: 8000 },
  "custom dims clamp [20, 8000]"
);
assertEqual(
  resolveDims({ preset: "custom" }),
  { w: 200, h: 200 },
  "custom missing fields → 200×200"
);
assertEqual(
  resolveDims({ preset: "garbage" }),
  null,
  "unknown preset → null (keep)"
);

/* ---------- 3. coverCrop ---------- */
{
  // Landscape 4000×3000 into portrait 200×230: crops width, keeps aspect.
  const r = coverCrop({ w: 4000, h: 3000 }, { w: 200, h: 230 });
  assert(r.sx >= 0 && r.sy >= 0, "crop origin non-negative", r);
  assert(
    r.sw <= 4000 + 1e-6 && r.sh <= 3000 + 1e-6,
    "crop box inside source",
    r
  );
  assert(
    Math.abs(r.sw / r.sh - 200 / 230) < 1e-3,
    "crop box matches destination aspect",
    r
  );
  assert(
    Math.abs(r.sx * 2 - (4000 - r.sw)) < 1e-6,
    "crop is centered horizontally",
    r
  );
  // Square source smaller than destination (cover upscales + crops).
  const u = coverCrop({ w: 100, h: 100 }, { w: 200, h: 230 });
  assert(
    Math.abs(u.sw / u.sh - 200 / 230) < 1e-3 && u.sx >= 0 && u.sy >= 0,
    "cover works when upscaling",
    u
  );
  // Same aspect: no crop at all.
  const s = coverCrop({ w: 2000, h: 2300 }, { w: 200, h: 230 });
  assert(
    Math.abs(s.sx) < 1e-6 && Math.abs(s.sy) < 1e-6,
    "same aspect → full source, no crop",
    s
  );
}

/* ---------- 4. nextDownscale ladder ---------- */
assertEqual(
  nextDownscale({ w: 1000, h: 800 }),
  { w: 850, h: 680 },
  "1000×800 → 850×680"
);
assertEqual(
  nextDownscale({ w: 100, h: 100 }),
  null,
  "at 100px floor → null"
);
assertEqual(
  nextDownscale({ w: 101, h: 101 }),
  null,
  "101px shrinks below floor → null"
);
{
  // Ladder from 1600px reaches the floor and stops there.
  let dims = { w: 1600, h: 1200 };
  let steps = 0;
  for (;;) {
    const next = nextDownscale(dims);
    if (!next) break;
    dims = next;
    steps += 1;
  }
  assert(
    Math.max(dims.w, dims.h) >= 100 &&
      Math.max(dims.w, dims.h) < 118,
    "ladder terminates in [100, 118) on the longest side",
    { dims, steps }
  );
  assert(steps > 10, "ladder takes many rungs from 1600px", { steps });
}

/* ---------- 5. quality search (sync driver) ---------- */
{
  // Immediate fit at ceiling.
  const a = pickQuality(() => 10_000, 100 * 1024);
  assertEqual(a, { q: Q_MAX, hit: true }, "fits at ceiling → Q_MAX");
}
{
  // Linear monotonic curve: highest q with size ≤ target.
  const target = 40 * 1024;
  const sizeAt = (q: number) => (50 * q + 10) * 1024;
  const a = pickQuality(sizeAt, target);
  assert(
    a.hit && a.q > 0.59 && a.q <= 0.61,
    "binary search finds q≈0.6 on linear curve",
    a
  );
}
{
  // Even the floor overshoots → miss verdict.
  const a = pickQuality((q) => (500 * q) * 1024, 100 * 1024);
  assertEqual(a, { q: Q_MIN, hit: false }, "floor overshoots → miss");
}
{
  // Floor exactly fits → hit at floor.
  const a = pickQuality((q) => q * 100 * 1024, Q_MIN * 100 * 1024);
  assert(a.hit && a.q === Q_MIN, "floor exactly fits → hit at floor", a);
}
{
  // Monotonicity invariant: verdict quality's size really fits, next
  // step up really doesn't (on a realistic concave curve).
  const sizeAt = (q: number) =>
    Math.round(300_000 * Math.pow(q, 0.8) + 4_000);
  const target = 120_000;
  const a = pickQuality(sizeAt, target);
  assert(a.hit, "concave curve → hit", a);
  assert(sizeAt(a.q) <= target, "winning quality fits", a);
  assert(
    sizeAt(Math.min(Q_MAX, a.q + 0.02)) > target,
    "a notch above the winner overflows",
    a
  );
}

/* ---------- 6. quality search — the async generator protocol ---------- */
{
  // The worker drives the SAME generator with awaitable probes; verify
  // the protocol yields numbers and consumes sizes identically.
  const sizeAt = (q: number) => (50 * q + 10) * 1024;
  const target = 40 * 1024;
  const steps = qualitySearchSteps(target);
  let probe = steps.next();
  let sawQuality = false;
  while (!probe.done) {
    assert(
      typeof probe.value === "number" && probe.value >= Q_MIN && probe.value <= Q_MAX,
      "generator yields a bounded quality",
      probe.value
    );
    sawQuality = true;
    probe = steps.next(sizeAt(probe.value));
  }
  assert(sawQuality, "generator drove at least one probe");
  const verdict = probe.value;
  const sync = pickQuality(sizeAt, target);
  assertEqual(
    verdict,
    sync,
    "async-driven generator matches the sync driver"
  );
}

/* ---------- 7. naming ---------- */
assertEqual(
  outputBaseName("photo.jpg", 100),
  "photo-100kb",
  "photo.jpg → photo-100kb"
);
assertEqual(
  outputBaseName("my.signature.png", 20),
  "my.signature-20kb",
  "extension strip keeps inner dots"
);
assertEqual(
  outputBaseName('a/b\\c:d*e?f"g<h>|i.jpg', 50),
  "a_b_c_d_e_f_g_h__i-50kb",
  "hostile name sanitized (9 specials → 9 underscores)"
);
assertEqual(
  outputBaseName(".jpg", 100),
  "image-100kb",
  "extension-only name → image-100kb"
);
assert(
  outputBaseName("x".repeat(300) + ".jpg", 100).length <= 120,
  "long names stay bounded"
);
{
  // Multi-file dedupe through the shared allocateOutputName.
  const used = new Map<string, number>();
  assertEqual(
    allocateOutputName(outputBaseName("photo.jpg", 100), "jpg", used),
    "photo-100kb.jpg",
    "first output keeps the plain name"
  );
  assertEqual(
    allocateOutputName(outputBaseName("photo.jpg", 100), "jpg", used),
    "photo-100kb-2.jpg",
    "second same-named output deduped"
  );
}

/* ---------- verdict ---------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || passed === 0) {
  process.exit(1);
}
process.exit(0);
