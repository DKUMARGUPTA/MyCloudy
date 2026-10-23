/**
 * Smoke: extract-pdf-pages batch multi-file (R2-a) — the PageGrid family's
 * picker went multi-file after rotate set the pattern. THE delicate one:
 * batch extract needs a per-file SELECTION (not just per-file grids).
 *
 * House conventions (smoke-rotate): the REAL shared worker
 * (tools/pagegrid/worker.ts) runs through a self-shimmed globalThis;
 * fixtures are pdf-lib docs whose page i has the unique width 100*(i+1)
 * so outputs are verifiable page-by-page (extracted pages read back by
 * width).
 *
 *  0. Wiring sanity: extract config maxFiles = 20 (batch) + onePerPage
 *     switch, the shared surface ships the per-file selection store
 *     (selectionsByFileRef) + the per-file extract CTA gate, the worker
 *     parses the per-file selections map, selected-badge i18n leaves
 *     exist in BOTH catalogs.
 *  1. Model vectors: selection serialization / parse round-trip.
 *  2. REAL E2E through the worker:
 *     - single-file legacy path unchanged (options.selected only),
 *     - single-file legacy one-per-page names unchanged (_pageN),
 *     - batch: each file extracted from ITS OWN selection (different
 *       page counts!), selections follow workspace FILE IDS (not
 *       positions) across reorderings, one output per file,
 *     - batch one-per-page: per-file _pageN outputs with ZIP-style dedup,
 *     - honesty: malformed selections map, partial map, per-file empty
 *       selection, and a grids map WITHOUT selections are ALL hard
 *       errors — never a silent fall-back to one file's selection,
 *     - out-of-range selection indices drop silently (legacy semantics),
 *     - encrypted input in a batch, progress beats, result detail
 *       {files, pages} summed across the batch.
 *
 * Run: bun scripts/smoke-extract.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  parseNumberListOption,
} from "../tools/pagegrid/model";
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
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));

  check(
    "extract config: maxFiles is 20 (batch)",
    extractConfig.maxFiles === 20 && extractConfig.minFiles === 1
  );
  check(
    "extract config: onePerPage switch still declared",
    extractConfig.options.some((o) => o.id === "onePerPage")
  );
  check(
    "surface: batch cap mirrored from the family configs",
    surface.includes("GRID_MAX_FILES = 20")
  );
  check(
    "surface: per-file selection store mirrors the grids pattern",
    surface.includes("selectionsByFileRef") &&
      surface.includes('onChange("selections"') &&
      surface.includes("syncActiveSelection")
  );
  check(
    "surface: batch extract gate = every file has ≥1 selected page",
    surface.includes('"grid.ctaSelectPages"') &&
      surface.includes("selectionsByFileRef.current[item.id]")
  );
  check(
    "surface: per-file badge for extract counts selected pages",
    surface.includes('"grid.batchSelected"')
  );
  check(
    "i18n: grid.batchSelected / batchSelectedTitle present in BOTH catalogs",
    typeof en.grid?.batchSelected === "string" &&
      typeof en.grid?.batchSelectedTitle === "string" &&
      typeof hi.grid?.batchSelected === "string" &&
      typeof hi.grid?.batchSelectedTitle === "string"
  );
  check(
    "worker: parses the per-file selections map",
    workerSrc.includes("parseSelectionsOption") &&
      workerSrc.includes("options.selections")
  );
  check(
    "worker: batch extract filters each file's grid by ITS selection",
    workerSrc.includes("filterBySelection") &&
      workerSrc.includes("selectionMap.get(fileId)")
  );
  check(
    "worker: missing/empty per-file selection is a hard error",
    workerSrc.includes("fileSelected === undefined") &&
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
  const wire = JSON.stringify([0, 2]);
  check(
    "selection wire round-trip (sorted indices)",
    parseNumberListOption(wire).join(",") === "0,2"
  );
  check(
    "selection parse: values pass through untouched (dedup/sort at filter time)",
    parseNumberListOption(JSON.stringify([2, 0, 2])).join(",") === "2,0,2"
  );
  check(
    "selection parse: malformed JSON / negative → empty",
    parseNumberListOption("{nope").length === 0 &&
      parseNumberListOption("[-1]").length === 0
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

  const gridA = JSON.stringify([
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  const gridB = JSON.stringify([
    [0, 0],
    [1, 0],
  ]);
  /** selA: pages 1 + 3 of a 3-page doc. */
  const selA = JSON.stringify([0, 2]);
  /** selB: page 2 of a 2-page doc. */
  const selB = JSON.stringify([1]);
  /** selAll: everything of a 3-page doc. */
  const selAll = JSON.stringify([0, 1, 2]);

  let runId = 1;

  /* --- single-file legacy path (options.selected only) ------------------- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "solo.pdf", bytes: a3, id: "s1" },
    ], {
      grid: gridA,
      selected: selA,
    });
    check("single-file legacy: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      check(
        "single-file legacy: name stays <base>-extracted.pdf",
        namesOf(r).join() === "solo-extracted.pdf",
        namesOf(r)
      );
      const info = await inspectOutput(r.outputs[0].blob);
      check(
        "single-file legacy: selection honored (pages 1 and 3)",
        info.pages.join(",") === "1,3",
        info
      );
    }
  }

  /* --- single-file legacy one-per-page ----------------------------------- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "pick.pdf", bytes: a3, id: "s2" },
    ], {
      grid: gridA,
      selected: selA,
      onePerPage: true,
    });
    check("single-file one-per-page: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      check(
        "single-file one-per-page names unchanged (_pageN)",
        namesOf(r).join(" | ") === "pick_page1.pdf | pick_page2.pdf",
        namesOf(r)
      );
      const first = await inspectOutput(r.outputs[0].blob);
      const second = await inspectOutput(r.outputs[1].blob);
      check(
        "single-file one-per-page: each output is exactly one selected page",
        first.pages.join(",") === "1" && second.pages.join(",") === "3",
        { first, second }
      );
    }
  }

  /* --- batch: each file from ITS OWN selection --------------------------- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "alpha.pdf", bytes: a3, id: "f1" },
      { name: "beta.pdf", bytes: b2, id: "f2" },
      { name: "gamma.pdf", bytes: a3, id: "f3" },
    ], {
      grid: gridA, // active file's state (summary panel keeps working)
      selected: selA,
      grids: JSON.stringify({ f1: gridA, f2: gridB, f3: gridA }),
      selections: JSON.stringify({ f1: selA, f2: selB, f3: selAll }),
    });
    check("batch: result (3 outputs)", r.type === "result" && r.outputs.length === 3, codeOf(r));
    if (r.type === "result") {
      check(
        "batch: one clean per-file name each",
        namesOf(r).join(" | ") ===
          "alpha-extracted.pdf | beta-extracted.pdf | gamma-extracted.pdf",
        namesOf(r)
      );
      const alpha = await inspectOutput(r.outputs[0].blob);
      const beta = await inspectOutput(r.outputs[1].blob);
      const gamma = await inspectOutput(r.outputs[2].blob);
      check(
        "batch: alpha from selA (pages 1,3)",
        alpha.pages.join(",") === "1,3",
        alpha
      );
      check(
        "batch: beta from selB (page 2) — NOT alpha's selection",
        beta.pages.join(",") === "2",
        beta
      );
      check(
        "batch: gamma from selAll (pages 1,2,3)",
        gamma.pages.join(",") === "1,2,3",
        gamma
      );
      check(
        "batch: result detail sums EXTRACTED pages across files (2 + 1 + 3)",
        r.detail?.files === 3 && r.detail?.pages === 6,
        r.detail
      );
    }
  }

  /* --- selections follow file IDS, not positions (reorder) ---------------- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "beta.pdf", bytes: b2, id: "f2" }, // reordered: beta first
      { name: "alpha.pdf", bytes: a3, id: "f1" },
    ], {
      grid: gridB,
      selected: selB,
      grids: JSON.stringify({ f1: gridA, f2: gridB }),
      selections: JSON.stringify({ f1: selA, f2: selB }),
    });
    check("reorder: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      const first = await inspectOutput(r.outputs[0].blob);
      const second = await inspectOutput(r.outputs[1].blob);
      check(
        "reorder: selections tracked by id (beta 2 — alpha 1,3)",
        first.pages.join(",") === "2" &&
          second.pages.join(",") === "1,3",
        { first, second }
      );
    }
  }

  /* --- batch one-per-page: per-file _pageN with dedup -------------------- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "scan.pdf", bytes: a3, id: "d1" },
      { name: "scan.pdf", bytes: b2, id: "d2" },
    ], {
      grid: gridA,
      selected: selA,
      onePerPage: true,
      grids: JSON.stringify({ d1: gridA, d2: gridB }),
      selections: JSON.stringify({ d1: selA, d2: selB }),
    });
    check("batch one-per-page: result (3 outputs)", r.type === "result" && r.outputs.length === 3, codeOf(r));
    if (r.type === "result") {
      check(
        "batch one-per-page: _pageN (position in the selection) + ZIP-style -2 across files",
        namesOf(r).join(" | ") ===
          "scan_page1.pdf | scan_page2.pdf | scan_page1-2.pdf",
        namesOf(r)
      );
      const third = await inspectOutput(r.outputs[2].blob);
      check(
        "batch one-per-page: third output is beta's selected page 2",
        third.pages.join(",") === "2",
        third
      );
    }
  }

  /* --- honesty vectors ---------------------------------------------------- */
  {
    const malformed = await drive(runId++, "extract-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ f1: gridA }),
      selections: "not-json{",
    });
    check(
      "malformed selections map → tool.errorCorrupt (no silent fallback)",
      malformed.type === "error" && malformed.code === "tool.errorCorrupt",
      codeOf(malformed)
    );

    const badEntry = await drive(runId++, "extract-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ f1: gridA }),
      selections: JSON.stringify({ f1: "nope" }),
    });
    check(
      "malformed per-file selection value → tool.errorCorrupt",
      badEntry.type === "error" && badEntry.code === "tool.errorCorrupt",
      codeOf(badEntry)
    );

    const partial = await drive(runId++, "extract-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
      { name: "b.pdf", bytes: b2, id: "f2" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ f1: gridA, f2: gridB }),
      selections: JSON.stringify({ f1: selA }), // f2 missing
    });
    check(
      "partial selections map (file 2 uncovered) → tool.errorInvalidPages",
      partial.type === "error" && partial.code === "tool.errorInvalidPages",
      codeOf(partial)
    );

    const noSelections = await drive(runId++, "extract-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
      { name: "b.pdf", bytes: b2, id: "f2" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ f1: gridA, f2: gridB }),
      // selections ABSENT in batch mode — must not fall back to options.selected
    });
    check(
      "grids map without selections → tool.errorInvalidPages (no global-selection fallback)",
      noSelections.type === "error" &&
        noSelections.code === "tool.errorInvalidPages",
      codeOf(noSelections)
    );

    const emptySel = await drive(runId++, "extract-pdf-pages", [
      { name: "a.pdf", bytes: a3, id: "f1" },
      { name: "b.pdf", bytes: b2, id: "f2" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ f1: gridA, f2: gridB }),
      selections: JSON.stringify({ f1: selA, f2: "[]" }),
    });
    check(
      "empty per-file selection → tool.errorInvalidPages (CTA parity)",
      emptySel.type === "error" && emptySel.code === "tool.errorInvalidPages",
      codeOf(emptySel)
    );
  }

  /* --- out-of-range selection indices drop silently (legacy semantics) --- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "weird.pdf", bytes: a3, id: "w1" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ w1: gridA }),
      selections: JSON.stringify({ w1: JSON.stringify([0, 5, 2]) }),
    });
    check("out-of-range: result", r.type === "result", codeOf(r));
    if (r.type === "result") {
      const info = await inspectOutput(r.outputs[0].blob);
      check(
        "out-of-range selection index dropped, in-range kept (1,3)",
        info.pages.join(",") === "1,3",
        info
      );
    }
  }

  /* --- encrypted input in a batch --------------------------------------- */
  {
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const locked = await CantooDoc.load(b2);
    await locked.encrypt({ userPassword: "pw", ownerPassword: "pw" });
    const lockedBytes = await locked.save();
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "open.pdf", bytes: a3, id: "o1" },
      { name: "locked.pdf", bytes: lockedBytes, id: "o2" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ o1: gridA, o2: gridB }),
      selections: JSON.stringify({ o1: selA, o2: selB }),
    });
    check(
      "encrypted file in batch → tool.errorEncrypted",
      r.type === "error" && r.code === "tool.errorEncrypted",
      codeOf(r)
    );
  }

  /* --- protocol behaviour ------------------------------------------------- */
  {
    const r = await drive(runId++, "extract-pdf-pages", [
      { name: "p1.pdf", bytes: a3, id: "g1" },
      { name: "p2.pdf", bytes: b2, id: "g2" },
    ], {
      grid: gridA,
      selected: selA,
      grids: JSON.stringify({ g1: gridA, g2: gridB }),
      selections: JSON.stringify({ g1: selA, g2: selB }),
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
console.log(`extract batch smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
