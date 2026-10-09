/**
 * Sign PDF engine smoke (bun) — verifies the placement geometry that the
 * QA golden paths then confirm end-to-end in the browser:
 *
 *   1. displayFracToUserPoint corner invariants for every /Rotate
 *   2. placementToDrawBox round-trips the CENTER for every rotation and
 *      on-screen rotation (anchor + rotation must describe a box whose
 *      center is the requested display point)
 *   3. sizes: w fraction is honored in user points (display units = pts)
 *   4. placementTargets for this/all/odd/even/range + invalid range
 *   5. parsePlacementsOption defensive behavior
 *
 * Run: bun scripts/smoke-sign.ts
 */

import {
  displayFracToUserPoint,
  displaySizeOf,
  parsePlacementsOption,
  placementTargets,
  placementToDrawBox,
  type SignPlacement,
} from "../tools/sign-pdf/engine";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------------------
console.log("displaySizeOf:");
check(
  "R0 keeps media box",
  displaySizeOf(0, 612, 792).w === 612 && displaySizeOf(0, 612, 792).h === 792
);
check(
  "R90 swaps axes",
  displaySizeOf(90, 612, 792).w === 792 && displaySizeOf(90, 612, 792).h === 612
);
check(
  "R270 swaps axes (and normalizes 450)",
  displaySizeOf(450, 612, 792).w === 792 && displaySizeOf(450, 612, 792).h === 612
);

// ---------------------------------------------------------------------------
console.log("displayFracToUserPoint corner invariants:");
{
  const W = 600;
  const H = 800;
  const cases: {
    rot: number;
    // fx, fy (display fractions, top-left origin) -> expected user point
    tl: [number, number];
    tr: [number, number];
    br: [number, number];
    bl: [number, number];
  }[] = [
    // R=0: display TL = user (0,H), TR = (W,H), BR = (W,0), BL = (0,0)
    { rot: 0, tl: [0, H], tr: [W, H], br: [W, 0], bl: [0, 0] },
    // R=90: display TL = user BL(0,0), TR = (0,H), BR = (W,H), BL = (W,0)
    { rot: 90, tl: [0, 0], tr: [0, H], br: [W, H], bl: [W, 0] },
    // R=180: display TL = user BR(W,0), TR = (W,H)? no: TR = BL(0,0)…
    // corners rotate CW: TL→TR so displayTL = user BL… recompute:
    // display TL = original BR (W,0), TR = original BL (0,0),
    // BR = original TL (0,H), BL = original TR (W,H)
    { rot: 180, tl: [W, 0], tr: [0, 0], br: [0, H], bl: [W, H] },
    // R=270: display TL = user TR(W,H), TR = BR(W,0), BR = BL(0,0), BL = TL(0,H)
    { rot: 270, tl: [W, H], tr: [W, 0], br: [0, 0], bl: [0, H] },
  ];
  for (const { rot, tl, tr, br, bl } of cases) {
    const p = (fx: number, fy: number) => displayFracToUserPoint(fx, fy, rot, W, H);
    const TL = p(0, 0);
    const TR = p(1, 0);
    const BR = p(1, 1);
    const BL = p(0, 1);
    check(
      `R${rot} corners`,
      near(TL.x, tl[0]) && near(TL.y, tl[1]) &&
        near(TR.x, tr[0]) && near(TR.y, tr[1]) &&
        near(BR.x, br[0]) && near(BR.y, br[1]) &&
        near(BL.x, bl[0]) && near(BL.y, bl[1]),
      `TL${JSON.stringify(TL)} TR${JSON.stringify(TR)} BR${JSON.stringify(BR)} BL${JSON.stringify(BL)}`
    );
    const C = p(0.5, 0.5);
    check(`R${rot} center maps to page center`, near(C.x, W / 2) && near(C.y, H / 2));
  }
}

// ---------------------------------------------------------------------------
console.log("placementToDrawBox center round-trips:");
{
  const aspect = 0.35; // typical signature height/width
  const base: SignPlacement = {
    id: "p1",
    sigId: "s1",
    cx: 0.5,
    cy: 0.72,
    w: 0.3,
    rot: 0,
    op: 1,
    pages: "this",
    pageIndex: 2,
  };
  for (const rot of [0, 90, 180, 270]) {
    for (const userRot of [0, 15, -30, 90, 180]) {
      const page = { rotation: rot, width: 612, height: 792 };
      const p = { ...base, rot: userRot };
      const box = placementToDrawBox(p, page, aspect);
      // The drawn box: anchor (sx,sy), size (w,h), rotated by `angle` CCW.
      // Its center must equal the display center mapped to user space.
      const disp = displaySizeOf(rot, page.width, page.height);
      const dw = p.w * disp.w;
      const dh = dw * aspect;
      const rad = (box.angle * Math.PI) / 180;
      const cx = box.sx + (Math.cos(rad) * dw - Math.sin(rad) * dh) / 2;
      const cy = box.sy + (Math.sin(rad) * dw + Math.cos(rad) * dh) / 2;
      const want = displayFracToUserPoint(p.cx, p.cy, rot, page.width, page.height);
      check(
        `R${rot} rot${userRot} center`,
        near(cx, want.x, 1e-4) && near(cy, want.y, 1e-4),
        `got (${cx.toFixed(2)}, ${cy.toFixed(2)}) want (${want.x.toFixed(2)}, ${want.y.toFixed(2)})`
      );
      check(
        `R${rot} rot${userRot} size+angle`,
        near(box.w, dw) && near(box.h, dh) && box.angle === rot - userRot
      );
    }
  }
  // The user-space angle formula: pdf-lib angle = R - on-screen rot.
  check(
    "angle formula",
    placementToDrawBox({ ...base, rot: 20 }, { rotation: 90, width: 612, height: 792 }, aspect).angle === 70
  );
  // Full-width placement fills the display box for every rotation.
  for (const rot of [0, 90, 180, 270]) {
    const page = { rotation: rot, width: 612, height: 792 };
    const disp = displaySizeOf(rot, 612, 792);
    const box = placementToDrawBox(
      { ...base, cx: 0.5, cy: 0.5, w: 1 },
      page,
      disp.h / disp.w
    );
    check(`R${rot} full-page box is the whole display box`, near(box.w, disp.w) && near(box.h, disp.h));
  }
}

// ---------------------------------------------------------------------------
console.log("placementTargets:");
{
  const mk = (over: Partial<SignPlacement>): SignPlacement => ({
    id: "p",
    sigId: "s",
    cx: 0.5,
    cy: 0.7,
    w: 0.3,
    rot: 0,
    op: 1,
    pages: "this",
    pageIndex: 0,
    ...over,
  });
  check("this", JSON.stringify(placementTargets(mk({ pageIndex: 2 }), 5)) === "[2]");
  check(
    "all",
    JSON.stringify(placementTargets(mk({ pages: "all" }), 3)) === "[0,1,2]"
  );
  check(
    "odd = 1st, 3rd, 5th pages",
    JSON.stringify(placementTargets(mk({ pages: "odd" }), 5)) === "[0,2,4]"
  );
  check(
    "even = 2nd, 4th pages",
    JSON.stringify(placementTargets(mk({ pages: "even" }), 5)) === "[1,3]"
  );
  check(
    "range parses",
    JSON.stringify(placementTargets(mk({ pages: "range", range: "1-2, 5" }), 5)) === "[0,1,4]"
  );
  check(
    "range open end",
    JSON.stringify(placementTargets(mk({ pages: "range", range: "4-" }), 5)) === "[3,4]"
  );
  check(
    "range invalid -> null",
    placementTargets(mk({ pages: "range", range: "x-y" }), 5) === null
  );
  check(
    "this out of bounds -> null",
    placementTargets(mk({ pageIndex: 9 }), 5) === null
  );
}

// ---------------------------------------------------------------------------
console.log("parsePlacementsOption:");
{
  check("undefined -> []", parsePlacementsOption(undefined).length === 0);
  check("bad JSON -> []", parsePlacementsOption("{oops").length === 0);
  check("non-array -> []", parsePlacementsOption('{"a":1}').length === 0);
  const good = parsePlacementsOption(
    JSON.stringify([
      { id: "a", sigId: "s1", cx: 0.5, cy: 0.5, w: 0.25, rot: 10, op: 0.8, pages: "all" },
      { id: "b", sigId: "s2", cx: "x", cy: 9, w: 99, rot: 999, pages: "bogus" },
      { no: "id" },
    ])
  );
  check("valid rows survive", good.length === 2);
  check("fields clamped", good[1].cx === 0.5 && good[1].cy === 1 && good[1].w === 1.5 && good[1].rot === 180);
  check("unknown pages mode -> this", good[1].pages === "this");
  const many = parsePlacementsOption(
    JSON.stringify(
      Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, sigId: "s", cx: 0.5, cy: 0.5, w: 0.2 }))
    )
  );
  check("capped at 60", many.length === 60);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
