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
 *   6. REAL worker run (self-shimmed): an already-signed input is
 *      refused with tool.errorAlreadySigned — pdf-lib's re-save would
 *      silently break the existing signature (AUD-C FIX); an unsigned
 *      input still stamps normally (guard never false-positives)
 *
 * Run: bun scripts/smoke-sign.ts
 */

import { readFileSync } from "node:fs";

import { PDFDocument } from "pdf-lib";

import { hasExistingSignature } from "../tools/digital-signature/model";
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

// detail widened to unknown (FIX-1b note): the worker-guard checks below
// pass the raw response object for failure output.
function check(name: string, ok: boolean, detail: unknown = ""): void {
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

// ---------------------------------------------------------------------------
console.log("worker guard: already-signed input (self-shimmed real worker):");
{
  const workerGlobal = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  const inbox: (Record<string, unknown> & { type: string })[] = [];
  workerGlobal.postMessage = (msg: unknown): void => {
    inbox.push(msg as Record<string, unknown> & { type: string });
  };
  (globalThis as unknown as Record<string, unknown>).self = workerGlobal;
  await import("../tools/sign-pdf/worker");
  check(
    "worker: module loaded, onmessage registered",
    typeof workerGlobal.onmessage === "function"
  );

  const drive = async (
    runId: number,
    bytes: Uint8Array,
    assets: File[]
  ): Promise<Record<string, unknown> & { type: string }> => {
    const before = inbox.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "sign-pdf",
        options: {
          sigkey: "f1",
          "p:f1": JSON.stringify([
            { id: "p1", sigId: "s1", cx: 0.5, cy: 0.5, w: 0.3, rot: 0, op: 1, pages: "all" },
          ]),
        },
        files: [new File([bytes as BlobPart], "contract.pdf")],
        assets,
      },
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const terminal = inbox
        .slice(before)
        .find((m) => m.type === "result" || m.type === "error");
      if (terminal) return terminal;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`worker run ${runId} did not finish`);
  };

  // The signed fixture: a plain-bytes PPKLite signature dictionary —
  // re-saving it through pdf-lib would shift every byte offset and
  // silently break the /ByteRange (the exact AUD-C bug this guard fixes).
  // Real signed PDFs (and the house digital-signature tool) always carry
  // the sig dict as plain bytes, never inside an object stream.
  const signed = await PDFDocument.create();
  signed.addPage([300, 200]);
  signed.context.register(
    signed.context.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 100, 200, 8],
      Contents: "00",
    })
  );
  const signedBytes = await signed.save({ useObjectStreams: false });
  check(
    "fixture: hasExistingSignature sees the sig dict",
    hasExistingSignature(signedBytes)
  );

  const sigAsset = new File(
    [readFileSync("public/qa/rikb-signature.png")],
    "sig-s1.png",
    { type: "image/png" }
  );

  const res = await drive(1, signedBytes, [sigAsset]);
  check(
    "worker: already-signed input → tool.errorAlreadySigned (no silent re-save)",
    res.type === "error" && res.code === "tool.errorAlreadySigned",
    res
  );

  // Positive control: the same run on an UNSIGNED input still succeeds —
  // the guard must never break the normal visual-signing path.
  const clean = await PDFDocument.create();
  clean.addPage([300, 200]);
  const cleanBytes = await clean.save();
  check("control: unsigned fixture is not flagged", !hasExistingSignature(cleanBytes));
  const okRes = await drive(2, cleanBytes, [sigAsset]);
  check("control: unsigned input still produces a result", okRes.type === "result", okRes);
}

console.log(`\n${pass} passed, ${fail} failed`);
// Explicit exit: importing a worker module keeps bun's event loop alive
// (house convention — every worker-driving smoke force-exits).
process.exit(fail > 0 ? 1 : 0);
