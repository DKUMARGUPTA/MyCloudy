/**
 * Smoke: split-pdf (ENH-2 feature 1) — output parts named after their
 * content.
 *
 * House conventions (smoke-pdf-to-pdfa / smoke-halve): relative imports
 * WITHOUT .ts extensions, plain check() helper, process.exit(0/1) at the
 * end, count every check. The REAL worker runs through a self-shimmed
 * globalThis (postMessage capture + onmessage dispatch) — no browser APIs
 * needed: the split worker is pure pdf-lib.
 *
 *  0. Wiring sanity (source-text checks — React files are not node-safe):
 *     content-named outputs present in the worker, legacy generic names
 *     gone, config feature text no longer promises "part1, part2".
 *  1. Plan vectors (the pure module the panel + worker share): parseRangeList
 *     edge cases, chunking, partsFromCuts, bookmarks/blanks separators,
 *     odd/even, one-file-per-range union.
 *  2. REAL E2E through the worker — ALL 7 modes with the NEW naming:
 *     range (per-range names, single page, merged scattered → legacy
 *     -split, merged contiguous, duplicate ranges → "-2" dedup), every N
 *     (even chunks + a short tail), bookmarks (stale-detection guard, no
 *     bookmarks), size (light single chunk + heavy multi-chunk + a
 *     single over-limit page that must stay alone), visual cuts, odd/even
 *     (both + odd-only), blanks (separators removed), error vectors
 *     (invalid ranges, encrypted), progress beats, non-run messages
 *     ignored. Page CONTENT is verified structurally: every fixture page
 *     i has a unique width 100*(i+1), so each output part is checked to
 *     contain exactly the source pages its name claims.
 *
 * Run: bun scripts/smoke-split.ts
 */
import { readFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  computeSplitPlan,
  fileKey,
  parseRangeList,
  rangesOverlap,
} from "../tools/split-pdf/plan";
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
  const workerSrc = readFileSync("tools/split-pdf/worker.ts", "utf8");
  const configSrc = readFileSync("tools/split-pdf/config.ts", "utf8");

  check(
    "worker: content-named outputs (pages- / part-N-pages-)",
    workerSrc.includes("`-pages-`") ||
      (workerSrc.includes("-pages-") && workerSrc.includes("-part-"))
  );
  check(
    "worker: pageSpan helper rejects scattered runs",
    workerSrc.includes("function pageSpan") &&
      workerSrc.includes("prev + 1")
  );
  check(
    "worker: collision dedup mirrors the ZIP bundler (-2 before the dot)",
    workerSrc.includes("lastIndexOf(\".\")") &&
      workerSrc.includes("counter += 1")
  );
  check(
    "worker: range/chunk naming branches exist (pages- and part-N-pages-)",
    workerSrc.includes("`${base}-pages-${span}.pdf`") &&
      workerSrc.includes("`${base}-part-${index + 1}-pages-${span}.pdf`") &&
      workerSrc.includes("`${base}-split.pdf`") // scattered-union fallback
  );
  check(
    "config: feature text promises content-based names",
    configSrc.includes("named after the pages it holds") &&
      !configSrc.includes("(part1, part2…)")
  );
}

/* ================================================================== */
console.log("── 1. Plan vectors (pure module) ─────────────────────");
/* ================================================================== */
{
  const items = parseRangeList("1-5, 8, 10-end", 12);
  check(
    "parseRangeList: 1-5, 8, 10-end (12 pages)",
    items !== null &&
      items.length === 3 &&
      items[0].from === 1 &&
      items[0].to === 5 &&
      items[1].from === 8 &&
      items[1].to === 8 &&
      items[2].from === 10 &&
      items[2].to === 12
  );
  check(
    "parseRangeList: reversed 5-2 normalizes",
    parseRangeList("5-2", 12)?.[0].from === 2
  );
  check("parseRangeList: garbage → null", parseRangeList("abc", 12) === null);
  check("parseRangeList: empty → null", parseRangeList("   ", 12) === null);
  check(
    "parseRangeList: fully out-of-range items are skipped",
    parseRangeList("99, 2", 12)?.length === 1
  );
  check(
    "rangesOverlap: 1-5 + 5-9 overlap",
    rangesOverlap(parseRangeList("1-5, 5-9", 12) ?? [])
  );

  const base = {
    pageCount: 12,
    fileSize: 100_000,
    ranges: "",
    oneFilePerRange: true,
    everyN: 4,
    maxSizeMb: 5,
    cutAfter: [],
    bookmarkCuts: [],
    blankPages: [],
  };
  const rangePlan = computeSplitPlan({
    ...base,
    mode: "range",
    ranges: "1-3, 8, 10-end",
  });
  check(
    "plan range: one file per range",
    rangePlan !== null &&
      rangePlan.parts.length === 3 &&
      rangePlan.parts[0].pages.join() === "0,1,2" &&
      rangePlan.parts[1].pages.join() === "7" &&
      rangePlan.parts[2].pages.join() === "9,10,11"
  );
  const merged = computeSplitPlan({
    ...base,
    mode: "range",
    ranges: "1-3, 8",
    oneFilePerRange: false,
  });
  check(
    "plan range merged: deduped ascending union",
    merged !== null && merged.parts.length === 1 && merged.parts[0].pages.join() === "0,1,2,7"
  );
  const everyN = computeSplitPlan({ ...base, mode: "everyN", everyN: 5 });
  check(
    "plan everyN: 5-page chunks with a short tail",
    everyN !== null &&
      everyN.parts.length === 3 &&
      everyN.parts[2].pages.join() === "10,11"
  );
  const bookmarks = computeSplitPlan({
    ...base,
    mode: "bookmarks",
    bookmarkCuts: [4, 9],
  });
  check(
    "plan bookmarks: part per top-level bookmark",
    bookmarks !== null &&
      bookmarks.parts.length === 3 &&
      bookmarks.parts[0].pages.length === 3 &&
      bookmarks.parts[1].pages.length === 5 &&
      bookmarks.parts[2].pages.length === 4
  );
  const visual = computeSplitPlan({ ...base, mode: "visual", cutAfter: [3, 7] });
  check(
    "plan visual: cuts after 3 and 7",
    visual !== null &&
      visual.parts.length === 3 &&
      visual.parts[0].pages.join() === "0,1,2" &&
      visual.parts[1].pages.join() === "3,4,5,6" &&
      visual.parts[2].pages.join() === "7,8,9,10,11"
  );
  const oddEven = computeSplitPlan({ ...base, mode: "oddEven" });
  check(
    "plan oddEven: labelled odd + even",
    oddEven !== null &&
      oddEven.parts.length === 2 &&
      oddEven.parts[0].label === "odd" &&
      oddEven.parts[0].pages.length === 6 &&
      oddEven.parts[1].label === "even"
  );
  const blanks = computeSplitPlan({
    ...base,
    mode: "blanks",
    blankPages: [4, 8],
  });
  check(
    "plan blanks: separators removed, runs become parts",
    blanks !== null &&
      blanks.parts.length === 3 &&
      blanks.parts[0].pages.join() === "0,1,2" &&
      blanks.parts[1].pages.join() === "4,5,6" &&
      blanks.parts[2].pages.join() === "8,9,10,11"
  );
  check(
    "fileKey: name|size identity",
    fileKey("a.pdf", 10) === "a.pdf|10"
  );
}

/* ================================================================== */
console.log("── 2. REAL E2E through the worker ─────────────────────");
/* ================================================================== */
{
  /* --- the worker shim (smoke-pdf-to-pdfa pattern) ------------------- */
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
  await import("../tools/split-pdf/worker");
  check(
    "worker: module loaded, onmessage registered",
    typeof workerGlobal.onmessage === "function"
  );

  type DriveOptions = Record<string, string | number | boolean>;

  const drive = async (
    runId: number,
    fileName: string,
    fileBytes: Uint8Array,
    options: DriveOptions
  ): Promise<RunEnd> => {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: {
        type: "run",
        runId,
        toolId: "split-pdf",
        options,
        files: [new File([fileBytes as BlobPart], fileName)],
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

  /** Reloads an output blob and returns the sorted source-page numbers
   *  (each fixture page i is identifiable by its unique width 100*(i+1)). */
  const sourcePagesOf = async (blob: Blob): Promise<number[]> => {
    const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), {
      ignoreEncryption: true,
    });
    const out: number[] = [];
    for (const page of doc.getPages()) {
      out.push(Math.round(page.getWidth()) / 100);
    }
    return out;
  };

  const namesOf = (response: RunEnd): string[] =>
    response.type === "result"
      ? response.outputs.map((o) => o.name)
      : [`<error ${response.code}>`];

  const expectResultNames = async (
    label: string,
    response: RunEnd,
    expected: string[],
    expectedPages?: number[][]
  ): Promise<void> => {
    check(
      `${label}: result (not error)`,
      response.type === "result",
      response.type === "error" ? response.code : namesOf(response)
    );
    if (response.type !== "result") return;
    check(
      `${label}: output names`,
      namesOf(response).join(" | ") === expected.join(" | "),
      namesOf(response)
    );
    check(
      `${label}: ${response.outputs.length} outputs, all PDF mime`,
      response.outputs.every((o) => o.mime === "application/pdf")
    );
    if (expectedPages !== undefined) {
      for (let i = 0; i < expectedPages.length; i += 1) {
        const pages = await sourcePagesOf(response.outputs[i].blob);
        check(
          `${label}: part ${i + 1} holds source pages ${expectedPages[i].join(",")}`,
          pages.join(",") === expectedPages[i].join(","),
          pages
        );
      }
    }
  };

  /* --- fixtures: page i has the unique width 100*(i+1) ---------------- */
  const makeDoc = async (
    pageCount: number,
    textPerPage: number
  ): Promise<Uint8Array> => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i += 1) {
      const page = doc.addPage([100 * (i + 1), 200]);
      if (textPerPage > 0) {
        page.drawText(`Page ${i + 1} ${"x".repeat(textPerPage)}`, {
          x: 8,
          y: 100,
          size: 10,
          font,
        });
      }
    }
    return doc.save();
  };

  /** Incompressible noise JPEG (pdf-lib Flate-squeezes long text runs, so
   *  size-mode fixtures need real bytes that refuse to shrink). */
  const noiseJpg = (
    size: number,
    quality: number
  ): Promise<Uint8Array> =>
    import("sharp").then(async (mod) => {
      const sharp = mod.default;
      const buf = await sharp({
        create: {
          width: size,
          height: size,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
          noise: { type: "gaussian", mean: 128, sigma: 60 },
        },
      })
        .jpeg({ quality })
        .toBuffer();
      return new Uint8Array(buf);
    });

  const light12 = await makeDoc(12, 40);

  // 12 pages, each carrying its own ~80 KB noise image → the 0.1 MB size
  // mode must produce one part per page (est = 1 page per chunk).
  const noiseDoc = await PDFDocument.create();
  for (let i = 0; i < 12; i += 1) {
    const img = await noiseDoc.embedJpg(
      await noiseJpg(350 - (i % 3) * 2, 85)
    );
    const page = noiseDoc.addPage([100 * (i + 1), 200]);
    page.drawImage(img, { x: 0, y: 40, width: 90, height: 90 });
  }
  const noise12 = await noiseDoc.save();

  // 11 light pages + one huge (~470 KB) image page at the END — the last
  // estimated chunk (light + huge) must halve down until only the huge
  // page remains alone, over the budget but indivisible.
  const mixedDoc = await PDFDocument.create();
  const mixedFont = await mixedDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 11; i += 1) {
    const page = mixedDoc.addPage([100 * (i + 1), 200]);
    page.drawText(`Page ${i + 1}`, { x: 8, y: 100, size: 10, font: mixedFont });
  }
  const bigImg = await mixedDoc.embedJpg(await noiseJpg(700, 95));
  const bigPage = mixedDoc.addPage([1200, 200]);
  bigPage.drawImage(bigImg, { x: 0, y: 40, width: 300, height: 50 });
  const mixed12 = await mixedDoc.save();

  let runId = 1;

  /* --- range mode ------------------------------------------------------ */
  await expectResultNames(
    "range 1-3, 8, 10-end",
    await drive(runId++, "contract.pdf", light12, {
      mode: "range",
      ranges: "1-3, 8, 10-end",
      oneFilePerRange: true,
    }),
    ["contract-pages-1-3.pdf", "contract-pages-8.pdf", "contract-pages-10-12.pdf"],
    [[1, 2, 3], [8], [10, 11, 12]]
  );

  await expectResultNames(
    "range single page 7",
    await drive(runId++, "contract.pdf", light12, {
      mode: "range",
      ranges: "7",
      oneFilePerRange: true,
    }),
    ["contract-pages-7.pdf"],
    [[7]]
  );

  await expectResultNames(
    "range merged scattered (one file)",
    await drive(runId++, "contract.pdf", light12, {
      mode: "range",
      ranges: "1-3, 8",
      oneFilePerRange: false,
    }),
    ["contract-split.pdf"],
    [[1, 2, 3, 8]]
  );

  await expectResultNames(
    "range merged contiguous keeps the range name",
    await drive(runId++, "contract.pdf", light12, {
      mode: "range",
      ranges: "3-7",
      oneFilePerRange: false,
    }),
    ["contract-pages-3-7.pdf"],
    [[3, 4, 5, 6, 7]]
  );

  await expectResultNames(
    "range duplicate ranges get the -2 dedup",
    await drive(runId++, "contract.pdf", light12, {
      mode: "range",
      ranges: "2-4, 2-4",
      oneFilePerRange: true,
    }),
    ["contract-pages-2-4.pdf", "contract-pages-2-4-2.pdf"],
    [[2, 3, 4], [2, 3, 4]]
  );

  await expectResultNames(
    "range end keyword only",
    await drive(runId++, "contract.pdf", light12, {
      mode: "range",
      ranges: "11-end",
      oneFilePerRange: true,
    }),
    ["contract-pages-11-12.pdf"],
    [[11, 12]]
  );

  /* --- everyN mode ----------------------------------------------------- */
  await expectResultNames(
    "everyN 4 (even chunks)",
    await drive(runId++, "report.pdf", light12, {
      mode: "everyN",
      everyN: 4,
    }),
    [
      "report-part-1-pages-1-4.pdf",
      "report-part-2-pages-5-8.pdf",
      "report-part-3-pages-9-12.pdf",
    ],
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ]
  );

  await expectResultNames(
    "everyN 5 (short tail)",
    await drive(runId++, "report.pdf", light12, {
      mode: "everyN",
      everyN: 5,
    }),
    [
      "report-part-1-pages-1-5.pdf",
      "report-part-2-pages-6-10.pdf",
      "report-part-3-pages-11-12.pdf",
    ],
    [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12],
    ]
  );

  /* --- bookmarks mode --------------------------------------------------- */
  const bmKey = fileKey("guide.pdf", light12.byteLength);
  await expectResultNames(
    "bookmarks cuts at 4 and 9",
    await drive(runId++, "guide.pdf", light12, {
      mode: "bookmarks",
      bookmarkStatus: "done",
      bookmarkFileKey: bmKey,
      bookmarkCuts: JSON.stringify([4, 9]),
    }),
    [
      "guide-part-1-pages-1-3.pdf",
      "guide-part-2-pages-4-8.pdf",
      "guide-part-3-pages-9-12.pdf",
    ],
    [
      [1, 2, 3],
      [4, 5, 6, 7, 8],
      [9, 10, 11, 12],
    ]
  );

  const stale = await drive(runId++, "guide.pdf", light12, {
    mode: "bookmarks",
    bookmarkStatus: "done",
    bookmarkFileKey: "other.pdf|123",
    bookmarkCuts: JSON.stringify([4]),
  });
  check(
    "bookmarks stale fileKey → tool.splitWaitingDetect",
    stale.type === "error" && stale.code === "tool.splitWaitingDetect",
    stale.type === "error" ? stale.code : namesOf(stale)
  );

  const noBookmarks = await drive(runId++, "guide.pdf", light12, {
    mode: "bookmarks",
    bookmarkStatus: "done",
    bookmarkFileKey: bmKey,
    bookmarkCuts: "[]",
  });
  check(
    "bookmarks none detected → tool.splitNoBookmarks",
    noBookmarks.type === "error" && noBookmarks.code === "tool.splitNoBookmarks",
    noBookmarks.type === "error" ? noBookmarks.code : namesOf(noBookmarks)
  );

  /* --- size mode -------------------------------------------------------- */
  const sizeLight = await drive(runId++, "pack.pdf", light12, {
    mode: "size",
    maxSizeMb: 0.1,
  });
  await expectResultNames(
    "size light file fits in one part",
    sizeLight,
    ["pack-pages-1-12.pdf"],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]
  );
  if (sizeLight.type === "result") {
    check(
      "size light: the single part respects the byte budget",
      sizeLight.outputs[0].blob.size <= 0.1 * 1024 * 1024,
      sizeLight.outputs[0].blob.size
    );
  }

  const sizeHeavy = await drive(runId++, "pack.pdf", noise12, {
    mode: "size",
    maxSizeMb: 0.1,
  });
  if (sizeHeavy.type === "result") {
    check(
      "size noise pages: multiple parts, every part within the budget",
      sizeHeavy.outputs.length > 1 &&
        sizeHeavy.outputs.every((o) => o.blob.size <= 0.1 * 1024 * 1024),
      sizeHeavy.outputs.map((o) => `${o.name}:${o.blob.size}`)
    );
    check(
      "size noise pages: every part is named after its real final page range",
      sizeHeavy.outputs.every(
        (o) => /-part-\d+-pages-\d+(-\d+)?\.pdf$/.test(o.name)
      ),
      namesOf(sizeHeavy)
    );
    const allPages: number[] = [];
    for (const output of sizeHeavy.outputs) {
      allPages.push(...(await sourcePagesOf(output.blob)));
    }
    check(
      "size noise pages: parts together cover all 12 pages exactly once",
      allPages.sort((a, b) => a - b).join(",") ===
        Array.from({ length: 12 }, (_, i) => i + 1).join(","),
      allPages
    );
  } else {
    check("size noise pages: result (not error)", false, sizeHeavy.code);
  }

  const sizeHuge = await drive(runId++, "scan.pdf", mixed12, {
    mode: "size",
    maxSizeMb: 0.1,
  });
  if (sizeHuge.type === "result") {
    const budget = 0.1 * 1024 * 1024;
    const oversized = sizeHuge.outputs.filter((o) => o.blob.size > budget);
    const oversizedPages =
      oversized.length === 1 ? await sourcePagesOf(oversized[0].blob) : [];
    check(
      "size mixed: recursive halving leaves exactly the huge page over budget",
      oversized.length === 1 && oversizedPages.join(",") === "12",
      sizeHuge.outputs.map((o) => `${o.name}:${o.blob.size}`)
    );
    check(
      "size mixed: every OTHER part respects the budget",
      sizeHuge.outputs
        .filter((o) => o.blob.size <= budget)
        .every((o) => o.blob.size <= budget) &&
        sizeHuge.outputs.length > oversized.length,
      sizeHuge.outputs.map((o) => `${o.name}:${o.blob.size}`)
    );
    const allMixed: number[] = [];
    for (const output of sizeHuge.outputs) {
      allMixed.push(...(await sourcePagesOf(output.blob)));
    }
    check(
      "size mixed: parts together cover all 12 pages exactly once",
      allMixed.sort((a, b) => a - b).join(",") ===
        Array.from({ length: 12 }, (_, i) => i + 1).join(","),
      allMixed
    );
    check(
      "size mixed: every part is named after its real final page range",
      sizeHuge.outputs.every(
        (o) => /-part-\d+-pages-\d+(-\d+)?\.pdf$/.test(o.name)
      ),
      namesOf(sizeHuge)
    );
  } else {
    check("size mixed: result (not error)", false, sizeHuge.code);
  }

  /* --- visual mode ------------------------------------------------------ */
  await expectResultNames(
    "visual cuts after 3 and 7",
    await drive(runId++, "notes.pdf", light12, {
      mode: "visual",
      cutAfter: JSON.stringify([3, 7]),
    }),
    [
      "notes-part-1-pages-1-3.pdf",
      "notes-part-2-pages-4-7.pdf",
      "notes-part-3-pages-8-12.pdf",
    ],
    [
      [1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11, 12],
    ]
  );

  await expectResultNames(
    "visual single cut",
    await drive(runId++, "notes.pdf", light12, {
      mode: "visual",
      cutAfter: JSON.stringify([5]),
    }),
    ["notes-part-1-pages-1-5.pdf", "notes-part-2-pages-6-12.pdf"],
    [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10, 11, 12],
    ]
  );

  /* --- oddEven mode ------------------------------------------------------ */
  await expectResultNames(
    "oddEven keeps its semantic suffixes",
    await drive(runId++, "ledger.pdf", light12, { mode: "oddEven" }),
    ["ledger_odd.pdf", "ledger_even.pdf"],
    [
      [1, 3, 5, 7, 9, 11],
      [2, 4, 6, 8, 10, 12],
    ]
  );

  await expectResultNames(
    "oddEven on a 1-page doc → odd only",
    await drive(runId++, "one.pdf", await makeDoc(1, 10), { mode: "oddEven" }),
    ["one_odd.pdf"],
    [[1]]
  );

  /* --- blanks mode ------------------------------------------------------- */
  const blankKey = fileKey("slides.pdf", light12.byteLength);
  await expectResultNames(
    "blanks at 4 and 8 (separators removed)",
    await drive(runId++, "slides.pdf", light12, {
      mode: "blanks",
      blankStatus: "done",
      blankFileKey: blankKey,
      blankPages: JSON.stringify([4, 8]),
    }),
    [
      "slides-part-1-pages-1-3.pdf",
      "slides-part-2-pages-5-7.pdf",
      "slides-part-3-pages-9-12.pdf",
    ],
    [
      [1, 2, 3],
      [5, 6, 7],
      [9, 10, 11, 12],
    ]
  );

  const noBlanks = await drive(runId++, "slides.pdf", light12, {
    mode: "blanks",
    blankStatus: "done",
    blankFileKey: blankKey,
    blankPages: "[]",
  });
  check(
    "blanks none detected → tool.splitNoBlanks",
    noBlanks.type === "error" && noBlanks.code === "tool.splitNoBlanks",
    noBlanks.type === "error" ? noBlanks.code : namesOf(noBlanks)
  );

  /* --- error vectors + protocol behaviour -------------------------------- */
  const invalid = await drive(runId++, "bad.pdf", light12, {
    mode: "range",
    ranges: "not-a-range",
  });
  check(
    "invalid range syntax → tool.errorInvalidPages",
    invalid.type === "error" && invalid.code === "tool.errorInvalidPages",
    invalid.type === "error" ? invalid.code : namesOf(invalid)
  );

  const emptyFile = await drive(runId++, "empty.pdf", new Uint8Array(0), {
    mode: "range",
    ranges: "1-2",
  });
  check(
    "0-byte input → corrupt/encrypted error",
    emptyFile.type === "error",
    emptyFile.type === "error" ? emptyFile.code : namesOf(emptyFile)
  );

  {
    const { PDFDocument: CantooDoc } = await import("@cantoo/pdf-lib");
    const locked = await CantooDoc.load(light12);
    await locked.encrypt({ userPassword: "pw", ownerPassword: "pw" });
    const encryptedBytes = await locked.save();
    const encrypted = await drive(runId++, "locked.pdf", encryptedBytes, {
      mode: "range",
      ranges: "1-2",
    });
    check(
      "encrypted input → tool.errorEncrypted",
      encrypted.type === "error" && encrypted.code === "tool.errorEncrypted",
      encrypted.type === "error" ? encrypted.code : namesOf(encrypted)
    );
  }

  {
    const before = messages.length;
    workerGlobal.onmessage!({
      data: { type: "nonsense" } as unknown as WorkerRunRequest,
    });
    await new Promise((r) => setTimeout(r, 30));
    check(
      "non-run messages are ignored",
      messages.length === before
    );
  }

  {
    const before = messages.length;
    await drive(runId++, "progress.pdf", light12, {
      mode: "everyN",
      everyN: 4,
    });
    const run = messages.slice(before).filter((m) => m.runId === runId - 1);
    check(
      "progress beats: reading → processing → saving + result",
      run.some((m) => m.type === "progress" && m.stage === "reading") &&
        run.some((m) => m.type === "progress" && m.stage === "processing") &&
        run.some((m) => m.type === "progress" && m.stage === "saving") &&
        run.some((m) => m.type === "result")
    );
    const withPages = run.find(
      (m) =>
        m.type === "progress" &&
        m.stage === "processing" &&
        m.detail?.pages !== undefined
    );
    check(
      "progress carries the real page count (12)",
      withPages !== undefined && withPages.type === "progress" &&
        (withPages.detail?.pages ?? 0) === 12,
      withPages
    );
  }

  {
    // Sanitized base names: unsafe characters must not leak into outputs.
    const weird = await drive(runId++, 'my "doc": v2.pdf', light12, {
      mode: "everyN",
      everyN: 6,
    });
    check(
      "unsafe file-name characters are sanitized in every part name",
      weird.type === "result" &&
        weird.outputs.every((o) => !/[\\/:*?"<>|\u0000-\u001f]/.test(o.name)) &&
        weird.outputs.length === 2 &&
        weird.outputs[0].name.includes("-part-1-pages-1-6.pdf") &&
        weird.outputs[1].name.includes("-part-2-pages-7-12.pdf"),
      weird.type === "result" ? namesOf(weird) : weird.code
    );
  }
}

/* ================================================================== */
console.log("");
console.log(`split smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES:", failures.join(" | "));
  process.exit(1);
}
process.exit(0);
