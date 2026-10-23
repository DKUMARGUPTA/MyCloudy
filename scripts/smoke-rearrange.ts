/**
 * Smoke: rearrange-pdf-pages batch multi-file (R2-a) — the PageGrid
 * family's reorder member went multi-file after rotate set the pattern.
 *
 * House conventions (smoke-rotate): the REAL shared worker
 * (tools/pagegrid/worker.ts) runs through a self-shimmed globalThis;
 * fixtures are pdf-lib docs whose page i has the unique width 100*(i+1)
 * so outputs are verifiable page-by-page (order read back by width).
 *
 *  0. Wiring sanity: rearrange config maxFiles = 20 (batch), the shared
 *     surface ships the per-file grid store for the whole family, the
 *     worker parses the per-file grids map, moved-badge i18n leaves
 *     exist in BOTH catalogs.
 *  1. Model vectors: reorder math (moveEntry / moveSelectionByOne).
 *  2. REAL E2E through the worker:
 *     - single-file legacy path unchanged (options.grid only, no map),
 *     - batch: each file rebuilt from ITS OWN order (different page
 *       counts!), grids follow workspace FILE IDS (not positions) across
 *       reorderings, one output per file with clean per-file names,
 *     - same-base-name collisions get the ZIP-style "-2" dedup,
 *     - malformed / partial / empty grids maps are hard errors,
 *     - encrypted input in a batch, progress beats, result detail
 *       {files, pages} summed across the batch.
 *
 * Run: bun scripts/smoke-rearrange.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  moveEntry,
  moveSelectionByOne,
} from "../tools/pagegrid/model";
import { config as rearrangeConfig } from "../tools/rearrange-pdf-pages/config";
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
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));

  check(
    "rearrange config: maxFiles is 20 (batch)",
    rearrangeConfig.maxFiles === 20 && rearrangeConfig.minFiles === 1
  );
  check(
    "surface: batch cap mirrored from the family configs",
    surface.includes("GRID_MAX_FILES = 20")
  );
  check(
    "surface: per-file badge for rearrange counts moved positions",
    surface.includes('"grid.batchMoved"') &&
      surface.includes("page.source !== i")
  );
  check(
    "i18n: grid.batchMoved / batchMovedTitle present in BOTH catalogs",
    typeof en.grid?.batchMoved === "string" &&
      typeof en.grid?.batchMovedTitle === "string" &&
      typeof hi.grid?.batchMoved === "string" &&
      typeof hi.grid?.batchMovedTitle === "string"
  );
  check(
    "worker: parses the per-file grids map (no rotate gating)",
    workerSrc.includes("parseGridsOption") &&
      !workerSrc.includes('toolId === "rotate-pdf-pages"')
  );
  check(
    "worker: partial/missing per-file grids are hard errors",
    workerSrc.includes("gridMap.get(fileId)") &&
      workerSrc.includes("tool.errorInvalidPages")
  );
  check(
    "worker: output names deduped with the ZIP-style -2 pattern",
    workerSrc.includes("makeUniqueNamer") &&
      workerSrc.includes('lastIndexOf(".")')
  );
}

/* ================================================================== */
console.log("── 1. Model vectors ──────────────────────────────────");
/* ================================================================== */
{
  const ident = [0, 1, 2].map((source) => ({ uid: source + 1, source, rotation: 0 }));
  const moved = moveEntry(ident, 0, 2); // page 1 → slot 3
  check(
    "moveEntry: drag page 1 to the end",
    moved.map((p) => p.source).join(",") === "1,2,0"
  );
  check(
    "moveEntry: out-of-bounds is a no-op",
    moveEntry(ident, 0, 9) === ident
  );
  const byKeys = moveSelectionByOne(ident, [0], 1);
  check(
    "moveSelectionByOne: selected page shifts right",
    byKeys.map((p) => p.source).join(",") === "1,0,2"
  );
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

  /** Source page numbers (by width) of an output blob. */
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

  /** gridA: reverse a 3-page document (3,2,1). */
  const gridA = JSON.stringify([
    [2, 0],
    [1, 0],
    [0, 0],
  ]);
  /** gridB: swap a 2-page document (2,1). */
  const gridB = JSON.stringify([
    [1, 0],
    [0, 0],
  ]);
  /** gridC: untouched 3-page identity. */
  const gridC = JSON.stringify([
    [0, 0],
    [1, 0],
    [2, 0],
  ]);

  let runId = 1;

  /* --- single-file legacy path (must be the old flow) ------------------- */
  {
    const r = await drive(runId++, "rearrange-pdf-pages", [
      { name: "solo.pdf", bytes: a3, id: "s1" },
    ], {
      grid: gridA,
    });
    check("single-file: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      check(
        "single-file: name stays <base>-rearranged.pdf",
        namesOf(r).join() === "solo-rearranged.pdf",
        namesOf(r)
      );
      const info = await inspectOutput(r.outputs[0].blob);
      check(
        "single-file: order from options.grid (no grids map)",
        info.pages.join(",") === "3,2,1" && info.angles.join(",") === "0,0,0",
        info
      );
    }
  }

  /* --- batch: each file from ITS OWN order ------------------------------ */
  {
    const r = await drive(runId++, "rearrange-pdf-pages", [
      { name: "alpha.pdf", bytes: a3, id: "f1" },
      { name: "beta.pdf", bytes: b2, id: "f2" },
      { name: "gamma.pdf", bytes: a3, id: "f3" },
    ], {
      grid: gridA, // active file's grid (summary panel keeps working)
      grids: JSON.stringify({ f1: gridA, f2: gridB, f3: gridC }),
    });
    check("batch: result (3 outputs)", r.type === "result" && r.outputs.length === 3, codeOf(r));
    if (r.type === "result") {
      check(
        "batch: one clean per-file name each",
        namesOf(r).join(" | ") ===
          "alpha-rearranged.pdf | beta-rearranged.pdf | gamma-rearranged.pdf",
        namesOf(r)
      );
      const alpha = await inspectOutput(r.outputs[0].blob);
      const beta = await inspectOutput(r.outputs[1].blob);
      const gamma = await inspectOutput(r.outputs[2].blob);
      check(
        "batch: alpha reversed (3,2,1)",
        alpha.pages.join(",") === "3,2,1",
        alpha
      );
      check(
        "batch: beta swapped (2,1) — NOT alpha's 3-entry grid",
        beta.pages.join(",") === "2,1",
        beta
      );
      check(
        "batch: gamma untouched (1,2,3) — identity grid survives the round trip",
        gamma.pages.join(",") === "1,2,3",
        gamma
      );
      check(
        "batch: result detail sums pages across files (3 + 2 + 3)",
        r.detail?.files === 3 && r.detail?.pages === 8,
        r.detail
      );
    }
  }

  /* --- grids follow file IDS, not positions (reorder) ------------------ */
  {
    const r = await drive(runId++, "rearrange-pdf-pages", [
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
        "reorder: grids tracked by id (beta 2,1 — alpha 3,2,1)",
        first.pages.join(",") === "2,1" &&
          second.pages.join(",") === "3,2,1",
        { first, second }
      );
    }
  }

  /* --- same base name → ZIP-style -2 dedup ------------------------------ */
  {
    const r = await drive(runId++, "rearrange-pdf-pages", [
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
        namesOf(r).join(" | ") === "scan-rearranged.pdf | scan-rearranged-2.pdf",
        namesOf(r)
      );
    }
  }

  /* --- honesty vectors: malformed / partial / empty maps ---------------- */
  {
    const malformed = await drive(runId++, "rearrange-pdf-pages", [
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

    const partial = await drive(runId++, "rearrange-pdf-pages", [
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

    const emptyGrid = await drive(runId++, "rearrange-pdf-pages", [
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

  /* --- encrypted input in a batch --------------------------------------- */
  {
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const locked = await CantooDoc.load(b2);
    await locked.encrypt({ userPassword: "pw", ownerPassword: "pw" });
    const lockedBytes = await locked.save();
    const r = await drive(runId++, "rearrange-pdf-pages", [
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
    const r = await drive(runId++, "rearrange-pdf-pages", [
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
console.log(`rearrange batch smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
