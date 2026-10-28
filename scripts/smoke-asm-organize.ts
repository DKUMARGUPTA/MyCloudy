/**
 * Smoke test: assemble-pdf R14 organize parity — per-page rotation
 * (±90° offset, never flattening a source page's own /Rotate) and
 * duplicate. Locks the model ops, the wire v2 format (backward-
 * compatible 2-tuples), and the real worker's /Rotate math:
 *
 *   1. model vectors — rotatePage wrap/reset semantics, duplicatePage
 *      (new uid, rotation copied, 2000-page cap no-op), offset helpers,
 *      plan threading (merge/zipper/reverse/separate), asmStats.rotated
 *   2. wire v2 — 3-tuples only for TURNED pages; legacy 2-tuple
 *      payloads parse forever; garbage rotations snap to 0 (R13 rule)
 *   3. real worker (pdf-lib bytes) — /Rotate offsets add to the source
 *      page's own rotation; untouched refs keep it byte-for-byte;
 *      duplicates rotate independently; the 45° damaged source still
 *      exports (quadrant snap, never a dead run)
 *   4. wiring locks + i18n (new asm.* keys in en + hi)
 *
 * Run: bun scripts/smoke-asm-organize.ts
 */
import { readFileSync } from "node:fs";
import { degrees, PDFDocument } from "pdf-lib";

import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { ALL_TOOLS } from "../src/lib/tools/registry";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";
import {
  asmStats,
  duplicatePage,
  movePageWithinDoc,
  nextRotationOffset,
  pageRotateOffset,
  parseAssembleOption,
  planAssemble,
  quadrantRotation,
  reverseDocPages,
  rotatePage,
  serializeAssemble,
  transferPage,
  MAX_WORKSPACE_PAGES,
  type AsmDoc,
  type AsmPageRef,
} from "../tools/assemble-pdf/model";

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

const read = (rel: string): string =>
  readFileSync(`/home/z/my-project/${rel}`, "utf8");

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** n pages, plain portrait, optional per-page /Rotate (quadrants). */
async function makePdf(
  rotations: number[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rot of rotations) {
    const page = doc.addPage([300, 400]);
    if (rot !== 0) page.setRotation(degrees(rot));
  }
  return doc.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ */
/* worker drive (self-shim, smoke-assemble recipe)                    */
/* ------------------------------------------------------------------ */

const workerGlobal = globalThis as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((event: { data: WorkerRunRequest }) => void) | null;
};
const inbox: (WorkerResponse & { runId?: number })[] = [];
workerGlobal.postMessage = (msg: unknown): void => {
  inbox.push(msg as WorkerResponse & { runId?: number });
};
(globalThis as unknown as Record<string, unknown>).self = workerGlobal;
await import("../tools/assemble-pdf/worker");

async function drive(
  runId: number,
  options: Record<string, unknown>,
  files: File[],
  fileIds?: string[]
): Promise<WorkerResponse[]> {
  const before = inbox.length;
  workerGlobal.onmessage!({
    data: {
      type: "run",
      runId,
      toolId: "assemble-pdf",
      options: options as WorkerRunRequest["options"],
      files,
      fileIds,
    },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const terminal = inbox
      .slice(before)
      .some((m) => m.type === "result" || m.type === "error");
    if (terminal) return inbox.slice(before);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`worker run ${runId} did not finish`);
}

async function rotationsOf(
  blob: Blob,
  expectedPages: number
): Promise<number[]> {
  const doc = await PDFDocument.load(
    new Uint8Array(await blob.arrayBuffer()),
    { ignoreEncryption: true }
  );
  check(`output page count ${expectedPages}`, doc.getPageCount() === expectedPages, doc.getPageCount());
  const out: number[] = [];
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    out.push(doc.getPage(i).getRotation().angle);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. model vectors                                                   */
/* ------------------------------------------------------------------ */

console.log("\n── 1. model: rotate / duplicate / helpers ───────────────");
{
  const ref = (fileId: string, page: number, rotate?: number): AsmPageRef => ({
    uid: Math.floor(Math.random() * 1e9),
    fileId,
    page,
    ...(rotate !== undefined ? { rotate } : {}),
  });
  const doc = (pages: AsmPageRef[], id = 1): AsmDoc => ({
    id,
    name: `Doc ${id}`,
    pages,
  });

  // quadrantRotation
  check("quadrantRotation(90) === 90", quadrantRotation(90) === 90);
  check("quadrantRotation(450) === 90", quadrantRotation(450) === 90);
  check("quadrantRotation(-90) === 270", quadrantRotation(-90) === 270);
  check("quadrantRotation(-450) === 270", quadrantRotation(-450) === 270);
  check("quadrantRotation(45) === 0 (non-quadrant snaps to 0)", quadrantRotation(45) === 0);
  check("quadrantRotation(360) === 0", quadrantRotation(360) === 0);
  check("quadrantRotation(90.9) === 90 (trunc)", quadrantRotation(90.9) === 90);

  // pageRotateOffset
  check("offset of untouched ref is 0", pageRotateOffset(ref("f", 0)) === 0);
  check("offset of turned ref", pageRotateOffset(ref("f", 0, 180)) === 180);
  check("offset of garbage 45 snaps to 0", pageRotateOffset(ref("f", 0, 45)) === 0);

  // nextRotationOffset
  check(
    "next: 0 + 90 === 90",
    nextRotationOffset(ref("f", 0), 90) === 90
  );
  check(
    "next: 270 + 90 wraps to 0 (honest reset)",
    nextRotationOffset(ref("f", 0, 270), 90) === 0
  );
  check(
    "next: 0 - 90 === 270",
    nextRotationOffset(ref("f", 0), -90) === 270
  );

  // rotatePage — signature: (docs, docId, index, delta)
  const d0 = [doc([ref("f", 0), ref("f", 1), ref("f", 2)])];
  const d1 = rotatePage(d0, 1, 1, 90);
  check("rotatePage sets offset 90", pageRotateOffset(d1[0].pages[1]) === 90);
  check("rotatePage leaves siblings untouched", d1[0].pages[0].rotate === undefined && d1[0].pages[2].rotate === undefined);
  check("rotatePage keeps uid (no re-key)", d1[0].pages[1].uid === d0[0].pages[1].uid);
  const d2 = rotatePage(d1, 1, 1, 90);
  check("second turn stacks (180)", pageRotateOffset(d2[0].pages[1]) === 180);
  const d3 = rotatePage(d2, 1, 1, 90);
  check("third turn stacks (270)", pageRotateOffset(d3[0].pages[1]) === 270);
  const d4 = rotatePage(d3, 1, 1, 90);
  check(
    "fourth turn wraps — rotate field REMOVED (honest reset)",
    d4[0].pages[1].rotate === undefined
  );
  check("zero delta is an identity", rotatePage(d0, 1, 0, 0) === d0);
  check("zero delta (360) is an identity", rotatePage(d0, 1, 0, 360) === d0);
  check("bad index is an identity", rotatePage(d0, 1, 9, 90) === d0);
  check("missing doc is an identity", rotatePage(d0, 77, 0, 90) === d0);
  const d5 = rotatePage(d0, 1, 0, -90);
  check("negative turn lands on 270", pageRotateOffset(d5[0].pages[0]) === 270);

  // duplicatePage
  const e0 = [doc([ref("f", 0), ref("f", 1)])];
  const e1 = duplicatePage(e0, 1, 0);
  check("duplicatePage grows the column", e1[0].pages.length === 3);
  check("duplicatePage inserts AFTER the original", e1[0].pages[1].page === 0 && e1[0].pages[2].page === 1);
  check("duplicatePage mints a fresh uid", e1[0].pages[0].uid !== e1[0].pages[1].uid);
  check("duplicatePage keeps the source ref", e1[0].pages[1].fileId === "f" && e1[0].pages[1].page === 0);
  check("duplicate of a bad index is an identity", duplicatePage(e0, 1, 9) === e0);
  const er = [doc([ref("f", 3, 90), ref("f", 4)])];
  const er1 = duplicatePage(er, 1, 0);
  check("duplicate copies the rotation", pageRotateOffset(er1[0].pages[1]) === 90);
  const er2 = rotatePage(er1, 1, 1, 90);
  check(
    "the copy rotates independently of its original",
    pageRotateOffset(er2[0].pages[0]) === 90 && pageRotateOffset(er2[0].pages[1]) === 180
  );
  const en = [doc([ref("f", 9)])];
  const en1 = duplicatePage(en, 1, 0);
  check("duplicate of an untouched ref stays rotation-free", en1[0].pages[1].rotate === undefined);

  // cap: a workspace already at MAX_WORKSPACE_PAGES no-ops
  const big: AsmPageRef[] = Array.from({ length: MAX_WORKSPACE_PAGES }, (_, i) =>
    ref("f", i)
  );
  const capDoc = doc(big);
  const capState = [capDoc];
  check(
    `duplicate at the ${MAX_WORKSPACE_PAGES}-page cap is an identity`,
    duplicatePage(capState, 1, 0) === capState
  );

  // rides along: transfer / move / reverse / delete keep the offset
  const twoDocs = [doc([ref("fa", 0, 90), ref("fa", 1)]), doc([ref("fb", 0)], 2)];
  const moved = transferPage(twoDocs, 1, 0, 2, -1);
  check("transferPage carries the rotation", moved[1].pages.length === 2 && pageRotateOffset(moved[1].pages[1]) === 90);
  const movedBack = transferPage(moved, 2, 1, 1, 0);
  check("transfer back keeps it", pageRotateOffset(movedBack[0].pages[0]) === 90);
  const within = movePageWithinDoc(movedBack, 1, 0, 1);
  check("movePageWithinDoc keeps the rotation", pageRotateOffset(within[0].pages[1]) === 90);
  const rev = reverseDocPages(within, 1);
  check("reverseDocPages keeps the rotation", pageRotateOffset(rev[0].pages[0]) === 90);

  // asmStats.rotated
  const stats = asmStats([
    doc([ref("fa", 0, 90), ref("fa", 1)]),
    doc([ref("fb", 0, 270), ref("fb", 1, 180)], 2),
  ]);
  check("asmStats.rotated counts turned pages", stats.rotated === 3, stats);
  check("asmStats.rotated ignores snapped-to-0 garbage", asmStats([doc([ref("fa", 0, 45)])]).rotated === 0);
}

/* ------------------------------------------------------------------ */
/* 2. wire v2 + planning                                              */
/* ------------------------------------------------------------------ */

console.log("\n── 2. wire v2: 3-tuples for turned pages only ──────────");
{
  const ref = (fileId: string, page: number, rotate?: number): AsmPageRef => ({
    uid: 1,
    fileId,
    page,
    ...(rotate !== undefined ? { rotate } : {}),
  });
  const docs: AsmDoc[] = [
    {
      id: 1,
      name: "Alpha",
      pages: [ref("fa", 0, 90), ref("fa", 1), ref("fa", 2, 270)],
    },
  ];

  const wire = serializeAssemble(docs);
  check(
    "wire: turned pages serialize as 3-tuples",
    wire === JSON.stringify([["Alpha", [["fa", 0, 90], ["fa", 1], ["fa", 2, 270]]]]),
    wire
  );
  const parsed = parseAssembleOption(wire);
  check("wire: round-trips through parse", parsed !== null && parsed[0].pages[0][2] === 90 && parsed[0].pages[2][2] === 270, parsed ?? undefined);
  check("wire: untouched page stays a 2-tuple after parse", parsed !== null && parsed[0].pages[1].length === 2);

  // legacy payloads parse forever (pre-R14 shapes)
  const legacy = parseAssembleOption('[["Old", [["fa", 0], ["fa", 1]]]]');
  check("legacy 2-tuple payload parses", legacy !== null && legacy[0].pages.length === 2);

  // garbage handling
  check("4-tuple ref is rejected", parseAssembleOption('[["A", [["fa", 0, 90, 1]]]]') === null);
  check("non-number page is rejected", parseAssembleOption('[["A", [["fa", "0"]]]]') === null);
  check("negative page is rejected", parseAssembleOption('[["A", [["fa", -1]]]]') === null);
  const garbageRot = parseAssembleOption('[["A", [["fa", 0, 45]]]]');
  check(
    "garbage rotate (45) snaps to 0 — page as-shipped (R13 rule)",
    garbageRot !== null && garbageRot[0].pages[0].length === 2,
    garbageRot ?? undefined
  );
  const strRot = parseAssembleOption('[["A", [["fa", 0, "90"]]]]');
  check(
    "non-number rotate degrades to no-rotation",
    strRot !== null && strRot[0].pages[0].length === 2,
    strRot ?? undefined
  );

  // planning threads rotation through every mode
  const plan = planAssemble(docs, { mode: "merge", zipper: false, reverse: false });
  check(
    "plan merge: rotation rides the order",
    plan[0].pages[0][2] === 90 && plan[0].pages[2][2] === 270 && plan[0].pages[1].length === 2,
    plan
  );
  const zipped = planAssemble(
    [docs[0], { id: 2, name: "Beta", pages: [ref("fb", 0)] }],
    { mode: "merge", zipper: true, reverse: false }
  );
  check(
    "plan zipper: rotated slot interleaves in place",
    JSON.stringify(zipped[0].pages) === JSON.stringify([["fa", 0, 90], ["fb", 0], ["fa", 1], ["fa", 2, 270]]),
    zipped
  );
  const reversed = planAssemble(docs, { mode: "merge", zipper: false, reverse: true });
  check(
    "plan reverse: rotation rides the reversal",
    reversed[0].pages[0][2] === 270 && reversed[0].pages[2][2] === 90,
    reversed
  );
  const separate = planAssemble(
    [docs[0], { id: 2, name: "Beta", pages: [ref("fb", 0, 180)] }],
    { mode: "separate", zipper: false, reverse: false }
  );
  check(
    "plan separate: per-column rotations",
    separate.length === 2 && separate[1].pages[0][2] === 180 && separate[0].pages[0][2] === 90,
    separate
  );
}

/* ------------------------------------------------------------------ */
/* 3. real worker — /Rotate math on real bytes                         */
/* ------------------------------------------------------------------ */

console.log("\n── 3. worker: offsets add, sources survive ──────────────");
{
  // W1 — plain source, one turned page
  {
    const bytes = await makePdf([0, 0, 0]);
    const msgs = await drive(
      7101,
      {
        assemble: JSON.stringify([["A", [["fa", 0], ["fa", 1, 90], ["fa", 2]]]]),
        outputMode: "merge",
      },
      [new File([bytes as BlobPart], "plain.pdf")],
      ["fa"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W1: one result, no errors", Boolean(result) && !msgs.some((m) => m.type === "error"));
    const rots = await rotationsOf(result.outputs[0].blob, 3);
    check("W1: /Rotate [0, 90, 0] — only the turned page", JSON.stringify(rots) === "[0,90,0]", rots);
    check("W1: detail stays honest", result.detail?.pages === 3);
  }

  // W2 — source page ships /Rotate 90: offset ADDS (never flattens)
  {
    const bytes = await makePdf([90, 90, 0]);
    const msgs = await drive(
      7102,
      {
        assemble: JSON.stringify([["A", [["fa", 0, 90], ["fa", 1], ["fa", 2]]]]),
        outputMode: "merge",
      },
      [new File([bytes as BlobPart], "shipped.pdf")],
      ["fa"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W2: one result", Boolean(result) && !msgs.some((m) => m.type === "error"));
    const rots = await rotationsOf(result.outputs[0].blob, 3);
    check(
      "W2: 90+90 → 180 (offset ADDS to the source turn) and untouched 90 SURVIVES",
      JSON.stringify(rots) === "[180,90,0]",
      rots
    );
  }

  // W3 — legacy 2-tuple payload: byte-honest, sources untouched
  {
    const bytes = await makePdf([90, 0, 0]);
    const msgs = await drive(
      7103,
      {
        assemble: JSON.stringify([["A", [["fa", 0], ["fa", 1], ["fa", 2]]]]),
        outputMode: "merge",
      },
      [new File([bytes as BlobPart], "legacy.pdf")],
      ["fa"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W3: one result", Boolean(result));
    const rots = await rotationsOf(result.outputs[0].blob, 3);
    check("W3: legacy payload keeps the source /Rotate exactly", JSON.stringify(rots) === "[90,0,0]", rots);
  }

  // W4 — duplicated refs rotate independently
  {
    const bytes = await makePdf([0]);
    const msgs = await drive(
      7104,
      {
        assemble: JSON.stringify([["A", [["fa", 0, 90], ["fa", 0, 180], ["fa", 0]]]]),
        outputMode: "merge",
      },
      [new File([bytes as BlobPart], "dup.pdf")],
      ["fa"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W4: one result with 3 pages", Boolean(result) && result.outputs.length === 1);
    const rots = await rotationsOf(result.outputs[0].blob, 3);
    check("W4: copies rotate independently [90, 180, 0]", JSON.stringify(rots) === "[90,180,0]", rots);
  }

  // W5 — separate mode keeps per-column rotations
  {
    const bytesA = await makePdf([0, 0]);
    const bytesB = await makePdf([0]);
    const msgs = await drive(
      7105,
      {
        assemble: JSON.stringify([
          ["Front", [["fa", 0, 90], ["fa", 1]]],
          ["Back", [["fb", 0, 270]]],
        ]),
        outputMode: "separate",
      },
      [
        new File([bytesA as BlobPart], "a.pdf"),
        new File([bytesB as BlobPart], "b.pdf"),
      ],
      ["fa", "fb"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W5: two outputs", result?.outputs.length === 2);
    const rotsA = await rotationsOf(result.outputs[0].blob, 2);
    const rotsB = await rotationsOf(result.outputs[1].blob, 1);
    check(
      "W5: per-column rotations [90,0] + [270]",
      JSON.stringify(rotsA) === "[90,0]" && JSON.stringify(rotsB) === "[270]",
      [rotsA, rotsB]
    );
  }

  // W6 — zipper merge with a rotated slot lands in the interleaved order
  {
    const bytesA = await makePdf([0, 0]);
    const bytesB = await makePdf([0]);
    const msgs = await drive(
      7106,
      {
        assemble: JSON.stringify([
          ["Fronts", [["fa", 0], ["fa", 1]]],
          ["Backs", [["fb", 0, 90]]],
        ]),
        outputMode: "merge",
        zipper: true,
      },
      [
        new File([bytesA as BlobPart], "fronts.pdf"),
        new File([bytesB as BlobPart], "backs.pdf"),
      ],
      ["fa", "fb"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W6: one merged result", result?.outputs.length === 1);
    const rots = await rotationsOf(result.outputs[0].blob, 3);
    check("W6: rotated slot interleaves in place [0, 90, 0]", JSON.stringify(rots) === "[0,90,0]", rots);
  }

  // W7 — a damaged /Rotate 45 source: quadrant snap, never a dead run
  {
    const base = await makePdf([90, 0]);
    const damaged = new Uint8Array(base);
    const text = new TextDecoder().decode(damaged);
    const at = text.indexOf("/Rotate 90");
    check("W7: fixture contains /Rotate 90 to damage", at >= 0);
    if (at >= 0) {
      damaged.set(new TextEncoder().encode("/Rotate 45"), at);
      const msgs = await drive(
        7107,
        {
          assemble: JSON.stringify([["A", [["fa", 0, 90], ["fa", 1]]]]),
          outputMode: "merge",
        },
        [new File([damaged as BlobPart], "damaged.pdf")],
        ["fa"]
      );
      const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
      const errors = msgs.filter((m) => m.type === "error");
      check(
        "W7: damaged 45° source still exports (no dead run)",
        Boolean(result) && errors.length === 0,
        errors.map((e) => (e as { code?: string }).code)
      );
      if (result) {
        const rots = await rotationsOf(result.outputs[0].blob, 2);
        check(
          "W7: non-quadrant base snaps to 0, offset applies → [90, 0]",
          JSON.stringify(rots) === "[90,0]",
          rots
        );
      }
    }
  }

  // W8 — reverse + rotated ref rides the reversal
  {
    const bytes = await makePdf([0, 0, 0]);
    const msgs = await drive(
      7108,
      {
        assemble: JSON.stringify([["A", [["fa", 0], ["fa", 1, 90], ["fa", 2]]]]),
        outputMode: "merge",
        reverse: true,
      },
      [new File([bytes as BlobPart], "rev.pdf")],
      ["fa"]
    );
    const result = msgs.find((m) => m.type === "result") as Extract<WorkerResponse, { type: "result" }>;
    check("W8: one result", Boolean(result));
    const rots = await rotationsOf(result.outputs[0].blob, 3);
    check("W8: rotation rides the reversal [0, 90, 0]", JSON.stringify(rots) === "[0,90,0]", rots);
  }
}

/* ------------------------------------------------------------------ */
/* 4. wiring locks + i18n                                             */
/* ------------------------------------------------------------------ */

console.log("\n── 4. wiring locks + i18n ────────────────────────────────");
{
  check("TOOL_CONFIGS still has assemble-pdf", TOOL_CONFIGS["assemble-pdf"] !== undefined);
  check("registry still has assemble-pdf, enabled", ALL_TOOLS.find((t) => t.id === "assemble-pdf")?.enabled === true);

  const surface = read("tools/assemble-pdf/surface.tsx");
  check("surface wires rotate buttons (⟲/⟳)", surface.includes("asm.cellRotateLeft") && surface.includes("asm.cellRotateRight"));
  check("surface wires duplicate", surface.includes("asm.cellDuplicate"));
  check("surface renders the amber offset badge", surface.includes("bg-amber-600"));
  check("surface cell ops are 44×44", surface.includes("size-11"));
  check("surface passes rotateOffset to thumbnails", surface.includes("rotateOffset: rotate"));
  check("model exports rotatePage + duplicatePage", read("tools/assemble-pdf/model.ts").includes("export function rotatePage") && read("tools/assemble-pdf/model.ts").includes("export function duplicatePage"));
  const workerSrc = read("tools/assemble-pdf/worker.ts");
  check(
    "worker adds the offset to the effective /Rotate (R14 quadrant rule)",
    workerSrc.includes("baseQ + rotate") && workerSrc.includes("norm360")
  );
  check(
    "worker never writes /Rotate for untouched refs",
    workerSrc.includes("if (rotate === undefined || rotate === 0) return undefined;")
  );
  check("thumbnails helper has the R14 offset mode", read("src/lib/pdf/thumbnails.ts").includes("rotateOffset"));

  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, Record<string, string>>;
  const hi = JSON.parse(read("src/i18n/hi.json")) as Record<string, Record<string, string>>;
  for (const key of [
    "cellRotateLeft",
    "cellRotateRight",
    "cellDuplicate",
    "cellRotated",
    "pageRotatedToast",
    "pageDuplicatedToast",
    "dupCapToast",
    "statRotated",
  ]) {
    check(`asm.${key} in en`, typeof en.asm?.[key] === "string");
    check(`asm.${key} in hi`, typeof hi.asm?.[key] === "string");
  }
  // placeholder hygiene for the new keys (param sets must match en↔hi)
  const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of ["cellRotateLeft", "cellDuplicate", "cellRotated", "pageRotatedToast", "statRotated"]) {
    check(
      `asm.${key} placeholders match en↔hi`,
      JSON.stringify(params(en.asm[key])) === JSON.stringify(params(hi.asm[key])),
      [en.asm[key], hi.asm[key]]
    );
  }
}

/* ------------------------------------------------------------------ */

console.log(`\nsmoke-asm-organize: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILED:", ...failures);
}
process.exit(fail === 0 ? 0 : 1);
