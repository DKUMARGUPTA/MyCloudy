/**
 * Smoke: rotate-pdf-pages batch multi-file (ENH-2 feature 3) — the
 * PageGrid family's first multi-file member.
 *
 * House conventions (smoke-pdf-to-pdfa / smoke-split): the REAL shared
 * worker (tools/pagegrid/worker.ts) runs through a self-shimmed
 * globalThis; fixtures are pdf-lib docs whose page i has the unique width
 * 100*(i+1) so outputs are verifiable page-by-page; rotations are read
 * back structurally via pdf-lib /Rotate angles.
 *
 *  0. Wiring sanity: rotate config maxFiles = 20, the grid surface ships
 *     the batch list + add-more DropZone + per-file gate, the worker
 *     parses the per-file grids map, rearrange/remove/extract stay
 *     maxFiles 1 (only rotate goes multi-file).
 *  1. Model vectors: grid serialization round-trip.
 *  2. REAL E2E through the worker:
 *     - single-file legacy path unchanged (options.grid only),
 *     - batch: each file rebuilt from ITS OWN grid (different page
 *       counts!), grids follow workspace FILE IDS (not positions) across
 *       reorderings, one output per file with clean per-file names,
 *     - same-base-name collisions get the ZIP-style "-2" dedup,
 *     - malformed / partial / empty grids maps are hard errors (never a
 *       silent fall-back to one grid for all files),
 *     - a valid `grids` option must NOT hijack the other family presets,
 *     - extract one-per-page + remove naming unchanged,
 *     - encrypted input, non-run messages ignored, progress beats,
 *       result detail {files, pages} summed across the batch.
 *
 * Run: bun scripts/smoke-rotate.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  createInitialGrid,
  parseGridOption,
  serializeGrid,
} from "../tools/pagegrid/model";
import { config as rotateConfig } from "../tools/rotate-pdf-pages/config";
import { config as rearrangeConfig } from "../tools/rearrange-pdf-pages/config";
import { config as removeConfig } from "../tools/remove-pdf-pages/config";
import { config as extractConfig } from "../tools/extract-pdf-pages/config";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "../src/lib/workers/protocol";

type RunEnd = Extract<WorkerResponse, { type: "result" | "error" }>;

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

/* ================================================================== */
console.log("── 0. Wiring sanity ──────────────────────────────────");
/* ================================================================== */
{
  const surface = readFileSync("tools/pagegrid/grid-surface.tsx", "utf8");
  const workerSrc = readFileSync("tools/pagegrid/worker.ts", "utf8");

  check(
    "rotate config: maxFiles is 20 (batch)",
    rotateConfig.maxFiles === 20 && rotateConfig.minFiles === 1
  );
  check(
    "family: only rotate is multi-file (rearrange/remove/extract stay 1)",
    rearrangeConfig.maxFiles === 1 &&
      removeConfig.maxFiles === 1 &&
      extractConfig.maxFiles === 1
  );
  check(
    "surface: rotate batch drives the per-file grid store",
    surface.includes("gridsByFileRef") &&
      surface.includes('onChange("grids"') &&
      surface.includes("syncBatchBlocked")
  );
  check(
    "surface: batch file list + add-more DropZone rendered for rotate",
    surface.includes("showBatchList") &&
      surface.includes("removeBatchFile") &&
      surface.includes('labelKey="grid.addMore"') &&
      surface.includes("ROTATE_MAX_FILES = 20")
  );
  check(
    "surface: batch CTA gate blocks while a file is undetected/empty",
    surface.includes('"grid.detecting"') &&
      surface.includes('"grid.ctaAllRemoved"')
  );
  check(
    "worker: parses the per-file grids map (rotate-gated)",
    workerSrc.includes("parseGridsOption") &&
      workerSrc.includes('toolId === "rotate-pdf-pages"')
  );
  check(
    "worker: partial/missing per-file grids are hard errors",
    workerSrc.includes("gridMap.get(fileId)") &&
      workerSrc.includes("tool.errorInvalidPages")
  );
  check(
    "worker: output names deduped with the ZIP-style -2 pattern",
    workerSrc.includes("makeUniqueNamer") &&
      workerSrc.includes("lastIndexOf(\".\")")
  );
}

/* ================================================================== */
console.log("── 1. Model vectors ──────────────────────────────────");
/* ================================================================== */
{
  const grid = createInitialGrid(3);
  grid[0].rotation = 90;
  const wire = serializeGrid(grid);
  check(
    "serializeGrid → parseGridOption round-trip keeps sources + deltas",
    wire === "[[0,90],[1,0],[2,0]]" &&
      parseGridOption(wire)!.length === 3 &&
      parseGridOption(wire)![0].rotation === 90
  );
  check("parseGridOption: malformed JSON → null", parseGridOption("{nope") === null);
  check("parseGridOption: empty string → null", parseGridOption("") === null);
}

/* ================================================================== */
console.log("── 2. REAL E2E through the shared worker ─────────────");
/* ================================================================== */
{
  /* --- the worker shim -------------------------------------------------- */
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
  await import("../tools/pagegrid/worker");
  check(
    "worker: module loaded, onmessage registered",
    typeof workerGlobal.onmessage === "function"
  );

  type DriveOptions = Record<string, string | number | boolean>;

  const drive = async (
    runId: number,
    toolId: string,
    files: { name: string; bytes: Uint8Array; id: string }[],
    options: DriveOptions
  ): Promise<RunEnd> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId,
        options,
        files: files.map(
          (f) => new File([f.bytes as BlobPart], f.name)
        ),
        fileIds: files.map((f) => f.id),
      } as WorkerRunRequest,
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (
        messages
          .slice(before)
          .some((m) => m.runId === runId && (m.type === "result" || m.type === "error"))
      ) {
        break;
      }
      if (Date.now() > deadline) throw new Error(`worker run ${runId} did not finish`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const finished = messages
      .slice(before)
      .find((m) => m.runId === runId && (m.type === "result" || m.type === "error"))!;
    return finished as RunEnd;
  };

  /** Page i has the unique width 100*(i+1); returns [bytes, pageCount]. */
  const makeDoc = async (pageCount: number): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i += 1) {
      const page = doc.addPage([100 * (i + 1), 200]);
      page.drawText(`Page ${i + 1}`, { x: 8, y: 100, size: 10, font });
    }
    return doc.save();
  };

  /** Source page numbers (by width) + /Rotate angles of an output blob. */
  const inspectOutput = async (
    blob: Blob
  ): Promise<{ pages: number[]; angles: number[] }> => {
    const doc = await PDFDocument.load(
      new Uint8Array(await blob.arrayBuffer()),
      { ignoreEncryption: true }
    );
    const pages: number[] = [];
    const angles: number[] = [];
    for (const page of doc.getPages()) {
      pages.push(Math.round(page.getWidth()) / 100);
      angles.push(page.getRotation().angle);
    }
    return { pages, angles };
  };

  const codeOf = (r: RunEnd): string =>
    r.type === "error" ? r.code : "<result>";
  const namesOf = (r: RunEnd): string[] =>
    r.type === "result" ? r.outputs.map((o) => o.name) : [`<error ${r.code}>`];

  const a3 = await makeDoc(3); // pages 1,2,3 — widths 100,200,300
  const b2 = await makeDoc(2); // pages 1,2 — widths 100,200

  /** gridA: rotate page 1 by 90, page 3 by 180. */
  const gridA = JSON.stringify([
    [0, 90],
    [1, 0],
    [2, 180],
  ]);
  /** gridB: rotate only page 2 by 270. */
  const gridB = JSON.stringify([
    [0, 0],
    [1, 270],
  ]);

  let runId = 1;

  /* --- single-file legacy path (must be byte-for-byte the old flow) ---- */
  {
    const r = await drive(runId++, "rotate-pdf-pages", [
      { name: "solo.pdf", bytes: a3, id: "s1" },
    ], {
      grid: gridA,
    });
    check("single-file: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      check(
        "single-file: name stays <base>-rotated.pdf",
        namesOf(r).join() === "solo-rotated.pdf",
        namesOf(r)
      );
      const info = await inspectOutput(r.outputs[0].blob);
      check(
        "single-file: rotations from options.grid",
        info.pages.join(",") === "1,2,3" &&
          info.angles.join(",") === "90,0,180",
        info
      );
    }
  }

  /* --- batch: each file from ITS OWN grid ------------------------------ */
  {
    const r = await drive(runId++, "rotate-pdf-pages", [
      { name: "alpha.pdf", bytes: a3, id: "f1" },
      { name: "beta.pdf", bytes: b2, id: "f2" },
    ], {
      grid: gridA, // active file's grid (summary panel keeps working)
      grids: JSON.stringify({ f1: gridA, f2: gridB }),
    });
    check("batch: result (2 outputs)", r.type === "result" && r.outputs.length === 2, codeOf(r));
    if (r.type === "result") {
      check(
        "batch: one clean per-file name each (no numeric span noise)",
        namesOf(r).join(" | ") === "alpha-rotated.pdf | beta-rotated.pdf",
        namesOf(r)
      );
      const alpha = await inspectOutput(r.outputs[0].blob);
      const beta = await inspectOutput(r.outputs[1].blob);
      check(
        "batch: alpha rebuilt from gridA (3 pages, 90/0/180)",
        alpha.pages.join(",") === "1,2,3" &&
          alpha.angles.join(",") === "90,0,180",
        alpha
      );
      check(
        "batch: beta rebuilt from gridB — NOT alpha's 3-entry grid",
        beta.pages.join(",") === "1,2" &&
          beta.angles.join(",") === "0,270",
        beta
      );
      check(
        "batch: result detail sums pages across files (3 + 2)",
        r.detail?.files === 2 && r.detail?.pages === 5,
        r.detail
      );
    }
  }

  /* --- grids follow file IDS, not positions (reorder) ------------------ */
  {
    const r = await drive(runId++, "rotate-pdf-pages", [
      { name: "beta.pdf", bytes: b2, id: "f2" }, // reordered: beta first
      { name: "alpha.pdf", bytes: a3, id: "f1" },
    ], {
      grid: gridB,
      grids: JSON.stringify({ f1: gridA, f2: gridB }),
    });
    check("reorder: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      const first = await inspectOutput(r.outputs[0].blob);
      const second = await inspectOutput(r.outputs[1].blob);
      check(
        "reorder: grids tracked by id (beta 0/270, alpha 90/0/180)",
        first.pages.join(",") === "1,2" &&
          first.angles.join(",") === "0,270" &&
          second.pages.join(",") === "1,2,3" &&
          second.angles.join(",") === "90,0,180",
        { first, second }
      );
    }
  }

  /* --- same base name → ZIP-style -2 dedup ------------------------------ */
  {
    const r = await drive(runId++, "rotate-pdf-pages", [
      { name: "scan.pdf", bytes: a3, id: "d1" },
      { name: "scan.pdf", bytes: b2, id: "d2" },
    ], {
      grid: gridA,
      grids: JSON.stringify({ d1: gridA, d2: gridB }),
    });
    check("same name: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      check(
        "same name: second output gets -2 before the extension",
        namesOf(r).join(" | ") === "scan-rotated.pdf | scan-rotated-2.pdf",
        namesOf(r)
      );
    }
  }

  /* --- honesty vectors: malformed / partial / empty maps ---------------- */
  {
    const malformed = await drive(runId++, "rotate-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
    ], {
      grid: gridA,
      grids: "not-json{",
    });
    check(
      "malformed grids map → tool.errorCorrupt (no silent fallback)",
      malformed.type === "error" && malformed.code === "tool.errorCorrupt",
      codeOf(malformed)
    );

    const partial = await drive(runId++, "rotate-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
      { name: "b.pdf", bytes: b2, id: "f2" },
    ], {
      grid: gridA,
      grids: JSON.stringify({ f1: gridA }), // f2 missing
    });
    check(
      "partial grids map (file 2 uncovered) → tool.errorInvalidPages",
      partial.type === "error" && partial.code === "tool.errorInvalidPages",
      codeOf(partial)
    );

    const emptyGrid = await drive(runId++, "rotate-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
      { name: "b.pdf", bytes: b2, id: "f2" },
    ], {
      grid: gridA,
      grids: JSON.stringify({ f1: gridA, f2: "[]" }),
    });
    check(
      "empty per-file grid → tool.errorInvalidPages",
      emptyGrid.type === "error" && emptyGrid.code === "tool.errorInvalidPages",
      codeOf(emptyGrid)
    );
  }

  /* --- a valid grids option must NOT hijack the other presets ----------- */
  {
    const r = await drive(runId++, "rearrange-pdf-pages", [
      { name: "order.pdf", bytes: b2, id: "r1" },
    ], {
      grid: JSON.stringify([
        [1, 0],
        [0, 0],
      ]), // swap pages 1↔2
      grids: JSON.stringify({ r1: JSON.stringify([[0, 90]]) }),
    });
    check("rearrange ignores grids: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      const info = await inspectOutput(r.outputs[0].blob);
      check(
        "rearrange uses options.grid (pages swapped, no rotation)",
        namesOf(r).join() === "order-rearranged.pdf" &&
          info.pages.join(",") === "2,1" &&
          info.angles.join(",") === "0,0",
        { names: namesOf(r), info }
      );
    }
  }

  /* --- remove + extract single-file naming unchanged --------------------- */
  {
    const r = await drive(runId++, "remove-pdf-pages", [
      { name: "cut.pdf", bytes: a3, id: "x1" },
    ], {
      grid: JSON.stringify([
        [0, 0],
        [2, 0],
      ]), // drop page 2
    });
    check("remove: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      const info = await inspectOutput(r.outputs[0].blob);
      check(
        "remove: name + page set unchanged",
        namesOf(r).join() === "cut-pages-removed.pdf" &&
          info.pages.join(",") === "1,3",
        { names: namesOf(r), info }
      );
    }

    const e = await drive(runId++, "extract-pdf-pages", [
      { name: "pick.pdf", bytes: a3, id: "x2" },
    ], {
      grid: JSON.stringify([
        [0, 0],
        [1, 0],
        [2, 0],
      ]),
      selected: JSON.stringify([0, 2]),
      onePerPage: true,
    });
    check("extract one-per-page: result", e.type === "result", codeOf(e));
    if (e.type === "result") {
      check(
        "extract one-per-page names unchanged (_pageN)",
        namesOf(e).join(" | ") === "pick_page1.pdf | pick_page2.pdf",
        namesOf(e)
      );
      const first = await inspectOutput(e.outputs[0].blob);
      check(
        "extract one-per-page: selection honored (pages 1 and 3)",
        first.pages.join(",") === "1",
        first
      );
    }
  }

  /* --- encrypted input in a batch --------------------------------------- */
  {
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const locked = await CantooDoc.load(b2);
    await locked.encrypt({ userPassword: "pw", ownerPassword: "pw" });
    const lockedBytes = await locked.save();
    const r = await drive(runId++, "rotate-pdf-pages", [
      { name: "open.pdf", bytes: a3, id: "o1" },
      { name: "locked.pdf", bytes: lockedBytes, id: "o2" },
    ], {
      grid: gridA,
      grids: JSON.stringify({ o1: gridA, o2: gridB }),
    });
    check(
      "encrypted file in batch → tool.errorEncrypted",
      r.type === "error" && r.code === "tool.errorEncrypted",
      codeOf(r)
    );
  }

  /* --- protocol behaviour ------------------------------------------------- */
  {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: { type: "nonsense" } as unknown as WorkerRunRequest,
    });
    await new Promise((r) => setTimeout(r, 30));
    check("non-run messages are ignored", messages.length === before);
  }

  {
    const r = await drive(runId++, "rotate-pdf-pages", [
      { name: "p1.pdf", bytes: a3, id: "g1" },
      { name: "p2.pdf", bytes: b2, id: "g2" },
    ], {
      grid: gridA,
      grids: JSON.stringify({ g1: gridA, g2: gridB }),
    });
    void r;
    const run = messages.filter((m) => m.runId === runId - 1);
    check(
      "batch progress: per-file reading beats + processing + result",
      run.some((m) => m.type === "progress" && m.stage === "reading") &&
        run.some((m) => m.type === "progress" && m.stage === "processing") &&
        run.some((m) => m.type === "result")
    );
    check(
      "batch progress: file-by-file counter reaches the second file",
      run.some(
        (m) =>
          m.type === "progress" &&
          m.stage === "reading" &&
          m.detail?.page === 2 &&
          m.detail?.pages === 2
      )
    );
  }
}

/* ================================================================== */
console.log("");
console.log(`rotate batch smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
